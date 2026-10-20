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

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIReasoning, AIStopReason, AIToolCall } from '../types.js';
import type { SseEvent } from './sse.js';
import type { ChatEventSink } from './events.js';
import { geminiState, tagged } from './provider-state.js';
import { streamFailure } from './failure.js';
import { functionTools, webSearchTool } from './tools.js';

type Part = Record<string, unknown>;
interface Content { role: 'user' | 'model'; parts: Part[] }

export const GEMINI_DEFAULT_MAX_TOKENS = 16000;

function userParts(content: string | AIContentPart[]): Part[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part): Part =>
    part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: part.data } });
}

/** Google's placeholder for a function call that has no thought signature (history from another model, or written by the caller), which Gemini 3 would otherwise reject. */
export const GEMINI_SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';

/** Whether the model checks thought signatures on replayed function calls: Gemini 3 and later. */
export const checksSignatures = (model: string): boolean => /^gemini-(?:[3-9]|\d{2})(?:[-.]|$)/.test(model);

/** The model turn's parts: the API's own when we have them (written under this protocol), else rebuilt — with the placeholder signature on the first call where the model checks. */
function modelParts(message: Extract<AIMessage, { role: 'assistant' }>, placeholder: boolean): Part[] {
  const own = geminiState(message.providerState);
  if (own) return own as Part[];
  const parts: Part[] = [];
  if (message.content) parts.push({ text: message.content });
  (message.toolCalls ?? []).forEach((call, i) => parts.push({ functionCall: { name: call.name, args: call.args ?? {} }, ...(placeholder && i === 0 ? { thoughtSignature: GEMINI_SIGNATURE_PLACEHOLDER } : {}) }));
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

export function geminiContents(messages: AIMessage[], model = ''): Content[] {
  const out: Content[] = [];
  const placeholder = checksSignatures(model);
  for (const message of messages) {
    if (message.role === 'assistant') {
      out.push({ role: 'model', parts: modelParts(message, placeholder) });
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

const BUDGETS: Record<AIReasoning, number> = { off: 0, low: 1024, medium: 8192, high: 24576 };

/**
 * Gemini's thinking config for a level: `thinkingLevel` on Gemini 3 and
 * later, a `thinkingBudget` before that, with the thought summaries asked
 * for when thinking is on. The Pro models cannot stop thinking: Gemini 3 Pro
 * (3.0) takes `LOW` and `HIGH` only (off and low are `LOW`, medium and high
 * `HIGH`; 3.1 Pro and later take every level, with `off` as `LOW`), a 2.5 Pro
 * refuses a zero budget, so `off` sends it nothing. Nothing for a model that
 * is not a Gemini (Gemma, another family), which rejects the field.
 */
export function geminiThinking(reasoning: AIReasoning | undefined, model: string): Record<string, unknown> {
  if (!reasoning || !/^gemini-/.test(model)) return {};
  const third = /^gemini-(?:[3-9]|\d{2})(?:[-.]|$)/.test(model);
  const pro = /-pro(?:-|$)/.test(model);
  const lowHighOnly = /^gemini-3-pro(?:-|$)/.test(model);
  let level: Record<string, unknown>;
  if (third) {
    const name = lowHighOnly ? (reasoning === 'off' || reasoning === 'low' ? 'LOW' : 'HIGH') : reasoning === 'off' ? (pro ? 'LOW' : 'MINIMAL') : reasoning.toUpperCase();
    level = { thinkingLevel: name };
  }
  else if (reasoning === 'off' && pro) return {};
  else level = { thinkingBudget: BUDGETS[reasoning] };
  return { thinkingConfig: { ...level, ...(reasoning !== 'off' ? { includeThoughts: true } : {}) } };
}

export function geminiBody(req: AIChatRequest, model = ''): Record<string, unknown> {
  const declarations = functionTools(req).map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema }));
  // Google Search grounding is Gemini's web search; it takes no domain list or location.
  const tools = [...(declarations.length > 0 ? [{ functionDeclarations: declarations }] : []), ...(webSearchTool(req) ? [{ googleSearch: {} }] : [])];
  return {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: geminiContents(req.messages, model),
    ...(tools.length > 0 ? { tools } : {}),
    ...(declarations.length > 0 ? { toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    generationConfig: { maxOutputTokens: req.maxTokens ?? GEMINI_DEFAULT_MAX_TOKENS, ...geminiThinking(req.reasoning, model) },
  };
}

const STOP: Record<string, AIStopReason> = {
  STOP: 'end', MAX_TOKENS: 'length',
  SAFETY: 'refusal', RECITATION: 'refusal', BLOCKLIST: 'refusal', PROHIBITED_CONTENT: 'refusal', SPII: 'refusal', IMAGE_SAFETY: 'refusal',
};

/** Rebuild the turn from its SSE chunks. Anything short of a finishReason is a failure. */
export async function geminiResult(events: AsyncIterable<SseEvent>, onEvent?: ChatEventSink): Promise<AIChatResult> {
  const parts: Part[] = [];
  let announced = 0;
  let finishReason: string | undefined;
  let usage: AIChatResult['usage'];
  let model: string | undefined;
  const queries: string[] = [];
  const sources = new Map<string, { url: string; title?: string }>();

  for await (const { data } of events) {
    let chunk: Record<string, any>;
    try { chunk = JSON.parse(data) as Record<string, any>; } catch { return streamFailure('Malformed stream chunk.'); }
    if (chunk['error']) return streamFailure(String(chunk['error']['message'] ?? 'the stream reported an error'), chunk['error']['status']);
    if (typeof chunk['modelVersion'] === 'string' && chunk['modelVersion']) model = chunk['modelVersion'];
    const meta = chunk['usageMetadata'];
    if (meta && typeof meta['promptTokenCount'] === 'number') {
      usage = {
        inputTokens: meta['promptTokenCount'],
        outputTokens: (meta['candidatesTokenCount'] ?? 0) + (meta['thoughtsTokenCount'] ?? 0),
        ...(typeof meta['cachedContentTokenCount'] === 'number' ? { cacheReadTokens: meta['cachedContentTokenCount'] } : {}),
        ...(typeof meta['thoughtsTokenCount'] === 'number' ? { reasoningTokens: meta['thoughtsTokenCount'] } : {}),
      };
    }
    const candidate = chunk['candidates']?.[0];
    if (!candidate) continue;
    // Grounding: the queries run and the web sources read, in whichever chunk carries them.
    const grounding = candidate['groundingMetadata'];
    for (const query of Array.isArray(grounding?.['webSearchQueries']) ? grounding['webSearchQueries'] : []) {
      if (typeof query === 'string' && query && !queries.includes(query)) { queries.push(query); onEvent?.({ type: 'search', query }); }
    }
    for (const chunkRef of Array.isArray(grounding?.['groundingChunks']) ? grounding['groundingChunks'] : []) {
      const web = chunkRef?.['web'];
      if (web && typeof web['uri'] === 'string' && !sources.has(web['uri'])) sources.set(web['uri'], { url: web['uri'], ...(typeof web['title'] === 'string' ? { title: web['title'] } : {}) });
    }
    for (const part of candidate['content']?.['parts'] ?? []) {
      if (onEvent) {
        if (typeof part['text'] === 'string' && part['text']) onEvent({ type: part['thought'] ? 'reasoning' : 'text', delta: part['text'] });
        if (part['functionCall']) {
          // Arguments arrive whole: one delta carries them, numbered as the result will number the call.
          const fc = part['functionCall'] as { id?: string; name?: string; args?: unknown };
          const id = typeof fc.id === 'string' && fc.id ? fc.id : `call_${announced}`;
          announced += 1;
          onEvent({ type: 'tool_call_start', id, name: fc.name ?? '' });
          onEvent({ type: 'tool_call_delta', id, argsDelta: fc.args === undefined ? '{}' : JSON.stringify(fc.args) });
          onEvent({ type: 'tool_call_end', id });
        }
      }
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
  if (!finishReason) return streamFailure('The response stream ended before it finished.');
  if (finishReason === 'MALFORMED_FUNCTION_CALL') return streamFailure('The model made a malformed function call.', finishReason);

  const text = parts.filter((p) => typeof p['text'] === 'string' && !p['thought']).map((p) => p['text'] as string).join('').trim();
  const reasoning = parts.filter((p) => typeof p['text'] === 'string' && p['thought']).map((p) => p['text'] as string).join('').trim();
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
  const webSearch = queries.length > 0 || sources.size > 0 ? { queries, sources: [...sources.values()] } : undefined;
  // Gemini 3 and later bill each query; before that, grounding is billed once per prompt. Unknown model, no count.
  if (webSearch && usage && model) usage.webSearchRequests = /^gemini-(?:[3-9]|\d{2})(?:[-.]|$)/.test(model) ? queries.length : 1;
  return {
    ok: true,
    ...(text ? { text } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    // The parts come back as sent, signatures included; thought summaries without one are left out.
    ...(runnable && parts.length > 0 ? { providerState: tagged.gemini(parts.filter((p) => !p['thought'] || p['thoughtSignature'])) } : {}),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}
