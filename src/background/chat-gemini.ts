/**
 * `chat()` for the Gemini API: `models/{model}:streamGenerateContent?alt=sse`,
 * with function calling. Google's own protocol, as served by Google at
 * `generativelanguage.googleapis.com/v1beta` and by OpenCode for its
 * `gemini-*` models.
 *
 * Request: `systemInstruction`, `contents` of `user` and `model` turns made of
 * parts (text, `inlineData` for images and documents, `functionCall`,
 * `functionResponse`), and `tools: [{functionDeclarations}]` with each tool's
 * JSON Schema as `parametersJsonSchema`. Gemini has no switch for parallel
 * calls: a turn may carry several, and every one is handed out. Tool results
 * go back as `functionResponse` parts in one user turn: the result parsed as
 * JSON when it is an object, else `{result}`, or `{error}` for a failed one.
 *
 * Response: SSE of GenerateContentResponses, each a few parts of candidate 0.
 * Text parts are joined; `functionCall` parts become tool calls (arguments
 * arrive as an object, no JSON to parse). The result counts only once a
 * `finishReason` has arrived; `error` is a failure, and so is a stream that
 * ends before one.
 *
 * Replay: the model turn's parts, `thoughtSignature`s included, are returned
 * as `providerState` and sent back verbatim on the next request, as the API
 * requires for a turn that called a tool. Calls get ids of their own
 * (`call_N`, or the API's `id` when it sends one), and the result is matched
 * to its call by name.
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIStopReason, AIToolCall } from '../types.js';
import type { SseEvent } from './sse.js';

type Part = Record<string, unknown>;
interface Content { role: 'user' | 'model'; parts: Part[] }

export const GEMINI_DEFAULT_MAX_TOKENS = 16000;

function userParts(content: string | AIContentPart[]): Part[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part): Part =>
    part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: part.data } });
}

/** The model turn's parts: the API's own when we have them, else rebuilt. */
function modelParts(message: Extract<AIMessage, { role: 'assistant' }>): Part[] {
  if (Array.isArray(message.providerState)) return message.providerState as Part[];
  const parts: Part[] = [];
  if (message.content) parts.push({ text: message.content });
  for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
  return parts;
}

/** A tool result as the `response` object a functionResponse carries. */
function responseOf(message: Extract<AIMessage, { role: 'tool' }>): Record<string, unknown> {
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
  if (message.isError) return { error: text };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* plain text */ }
  return { result: text };
}

export function geminiContents(messages: AIMessage[]): Content[] {
  const out: Content[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      out.push({ role: 'model', parts: modelParts(message) });
      continue;
    }
    if (message.role === 'tool') {
      const part: Part = { functionResponse: { name: message.name, response: responseOf(message) } };
      // Images and documents in a result follow it, in the same turn.
      const media = typeof message.content === 'string' ? [] : message.content.filter((p) => p.type !== 'text');
      const parts = [part, ...userParts(media)];
      // Every result for one model turn goes in a single user turn.
      const last = out[out.length - 1];
      if (last?.role === 'user' && last.parts.some((p) => 'functionResponse' in p)) last.parts.push(...parts);
      else out.push({ role: 'user', parts });
      continue;
    }
    out.push({ role: 'user', parts: userParts(message.content) });
  }
  return out;
}

export function geminiBody(req: AIChatRequest): Record<string, unknown> {
  const declarations = (req.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema }));
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: geminiContents(req.messages),
    ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    generationConfig: { maxOutputTokens: req.maxTokens ?? GEMINI_DEFAULT_MAX_TOKENS },
  };
}

const STOP: Record<string, AIStopReason> = {
  STOP: 'end', MAX_TOKENS: 'length',
  SAFETY: 'refusal', RECITATION: 'refusal', BLOCKLIST: 'refusal', PROHIBITED_CONTENT: 'refusal', SPII: 'refusal', IMAGE_SAFETY: 'refusal',
};

/** Rebuild the turn from its SSE chunks. Anything short of a finishReason is a failure. */
export async function geminiResult(events: AsyncIterable<SseEvent>): Promise<AIChatResult> {
  const parts: Part[] = [];
  let finishReason: string | undefined;
  let usage: AIChatResult['usage'];

  for await (const { data } of events) {
    let chunk: Record<string, any>;
    try { chunk = JSON.parse(data) as Record<string, any>; } catch { return { ok: false, error: 'Malformed stream chunk.' }; }
    if (chunk['error']) return { ok: false, error: String(chunk['error']['message'] ?? 'the stream reported an error') };
    const meta = chunk['usageMetadata'];
    if (meta && typeof meta['promptTokenCount'] === 'number') {
      usage = {
        inputTokens: meta['promptTokenCount'],
        outputTokens: (meta['candidatesTokenCount'] ?? 0) + (meta['thoughtsTokenCount'] ?? 0),
        ...(typeof meta['cachedContentTokenCount'] === 'number' ? { cacheReadTokens: meta['cachedContentTokenCount'] } : {}),
      };
    }
    const candidate = chunk['candidates']?.[0];
    if (!candidate) continue;
    for (const part of candidate['content']?.['parts'] ?? []) {
      const last = parts[parts.length - 1];
      // Text streams in pieces: join them into one part, unless a signature rides on one.
      if (typeof part['text'] === 'string' && !part['thought'] && !part['thoughtSignature'] && last && typeof last['text'] === 'string' && !last['thoughtSignature'] && !last['thought']) {
        last['text'] = `${last['text']}${part['text']}`;
      } else {
        parts.push({ ...part });
      }
    }
    if (candidate['finishReason']) finishReason = String(candidate['finishReason']);
  }
  if (!finishReason) return { ok: false, error: 'The response stream ended before it finished.' };
  if (finishReason === 'MALFORMED_FUNCTION_CALL') return { ok: false, error: 'The model made a malformed function call.' };

  const text = parts.filter((p) => typeof p['text'] === 'string' && !p['thought']).map((p) => p['text'] as string).join('').trim();
  let n = 0;
  const toolCalls: AIToolCall[] = parts.filter((p) => p['functionCall']).map((p) => {
    const call = p['functionCall'] as { id?: string; name?: string; args?: unknown };
    const id = typeof call.id === 'string' && call.id ? call.id : `call_${n}`;
    n += 1;
    const out: AIToolCall = { id, name: call.name ?? '' };
    if (call.args && typeof call.args === 'object' && !Array.isArray(call.args)) out.args = call.args as Record<string, unknown>;
    else if (call.args === undefined) out.args = {};
    else out.argsError = { raw: JSON.stringify(call.args), message: 'Tool arguments are not a JSON object.' };
    return out;
  });

  const mapped = STOP[finishReason] ?? 'end';
  // A turn cut off by the limit or a filter may carry a truncated call: never hand one out.
  const runnable = mapped === 'end';
  return {
    ok: true,
    ...(text ? { text } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    // The parts come back as sent, signatures included; thought summaries without one are left out.
    ...(runnable && parts.length > 0 ? { providerState: parts.filter((p) => !p['thought'] || p['thoughtSignature']) } : {}),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(usage ? { usage } : {}),
  };
}
