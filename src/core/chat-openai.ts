/**
 * `chat()` for OpenAI-compatible servers: Chat Completions, streamed, with
 * function tools. Covers OpenAI, OpenRouter, Ollama (local and ollama.com)
 * and anything else speaking `/v1/chat/completions`.
 *
 * Request: `tools: [{type: "function", function: {name, description,
 * parameters}}]`, `parallel_tool_calls: false` unless asked otherwise, and
 * `stream_options: {include_usage: true}` for token counts (the caller retries
 * without either field when a server rejects it). OpenAI's own API takes
 * `max_completion_tokens`; everyone else takes `max_tokens`.
 *
 * Response: SSE of `chat.completion.chunk`s. Tool calls arrive as fragments
 * keyed by `index` — some servers send the whole call in one chunk, OpenAI
 * splits `arguments` across many — and are parsed strictly once the stream
 * finishes. The result counts only once a `finish_reason` has arrived; an
 * error chunk or a stream that ends before one is a failure. `[DONE]` closes
 * the stream but is not required: not every server sends it.
 *
 * A tool call's `extra_content` (Gemini puts its `thought_signature` there,
 * and 400s on the next turn without it) is returned in `providerState` and
 * sent back on that call.
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIStopReason, AIToolCall } from '../types.js';
import type { SseEvent } from './sse.js';
import type { ChatEventSink } from './events.js';
import { chatCompletionsState, tagged } from './provider-state.js';
import { streamFailure } from './failure.js';

/** What an assistant turn carries back: each tool call's `extra_content`, by call id. */
interface OpenAiState {
  extraContent: Record<string, unknown>;
}

function extraContentOf(state: unknown): Record<string, unknown> {
  const extra = (state as Partial<OpenAiState> | null | undefined)?.extraContent;
  return extra && typeof extra === 'object' ? extra : {};
}

export const OPENAI_DEFAULT_MAX_TOKENS = 16000;

type ChatMessage = Record<string, unknown>;

function textOf(content: string | AIContentPart[]): string {
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
}

type Media = Exclude<AIContentPart, { type: 'text' }>;

/** Images and documents: what a tool message cannot carry in Chat Completions. */
function mediaOf(content: string | AIContentPart[]): Media[] {
  return typeof content === 'string' ? [] : content.filter((part): part is Media => part.type !== 'text');
}

function userContent(content: string | AIContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'document') return { type: 'file', file: { filename: part.name ?? 'document.pdf', file_data: `data:${part.mediaType};base64,${part.data}` } };
    return { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
  });
}

export function openaiMessages(system: string, messages: AIMessage[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  // Tool messages cannot carry images or documents in Chat Completions: they
  // follow the tool results as one user message instead.
  let pendingImages: Media[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    out.push({ role: 'user', content: userContent(pendingImages) });
    pendingImages = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content) });
      pendingImages.push(...mediaOf(message.content));
      continue;
    }
    flushImages();
    if (message.role === 'user') {
      out.push({ role: 'user', content: userContent(message.content) });
      continue;
    }
    const calls = message.toolCalls ?? [];
    const extra = chatCompletionsState(message.providerState);
    out.push({
      role: 'assistant',
      content: message.content ?? (calls.length > 0 ? null : ''),
      ...(calls.length > 0 ? {
        tool_calls: calls.map((call) => ({ id: call.id, type: 'function',
          function: { name: call.name, arguments: call.argsError ? call.argsError.raw : JSON.stringify(call.args ?? {}) },
          ...(extra[call.id] !== undefined ? { extra_content: extra[call.id] } : {}) })),
      } : {}),
    });
  }
  flushImages();
  return out;
}

/** Optional request fields a server has rejected, to leave out of the retry. */
export type OptionalField = 'parallel_tool_calls' | 'stream_options' | 'prompt_cache_key';

/** The request body, without the `omit`ted fields. */
export function openaiBody(req: AIChatRequest, model: string, base: string, omit: ReadonlySet<OptionalField> = new Set()): Record<string, unknown> {
  const tools = (req.tools ?? []).map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  const openai = /(^|\.)openai\.com$/i.test(safeHost(base));
  return {
    model,
    stream: true,
    [openai ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens ?? OPENAI_DEFAULT_MAX_TOKENS,
    messages: openaiMessages(req.system, req.messages),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && !omit.has('parallel_tool_calls') ? { parallel_tool_calls: req.parallelToolCalls === true } : {}),
    ...(!omit.has('stream_options') ? { stream_options: { include_usage: true } } : {}),
    // OpenAI's own field; another server that refuses it gets the request again without it.
    ...(req.cacheKey && openai && !omit.has('prompt_cache_key') ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

function safeHost(base: string): string {
  try { return new URL(base).hostname; } catch { return ''; }
}

/** The optional field a 400 complains about, to retry without; undefined for any other error. */
export function rejectedField(status: number, body: string): OptionalField | undefined {
  if (status !== 400) return undefined;
  if (/parallel_tool_calls/i.test(body)) return 'parallel_tool_calls';
  if (/stream_options|include_usage/i.test(body)) return 'stream_options';
  if (/prompt_cache_key/i.test(body)) return 'prompt_cache_key';
  return undefined;
}

const STOP: Record<string, AIStopReason> = {
  stop: 'end', tool_calls: 'tool_use', function_call: 'tool_use', length: 'length', content_filter: 'refusal',
};

/** Strip reasoning some local models emit inline despite instructions. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
}

export async function openaiResult(events: AsyncIterable<SseEvent>, onEvent?: ChatEventSink): Promise<AIChatResult> {
  let text = '';
  const fragments = new Map<number, { id: string; name: string; args: string; extra?: unknown; callId?: string }>();
  // A call's id is settled when its arguments start (the server's, or `call_N`), and announced then — or when
  // the turn ends; the result uses the same id, so an id arriving after the arguments began is not taken up.
  const settle = (index: number, fragment: { id: string; name: string; callId?: string }): string => {
    if (fragment.callId) return fragment.callId;
    fragment.callId = fragment.id || `call_${index}`;
    onEvent?.({ type: 'tool_call_start', id: fragment.callId, name: fragment.name });
    return fragment.callId;
  };
  let finishReason: string | undefined;
  let usage: AIChatResult['usage'];
  let model: string | undefined;

  for await (const { data } of events) {
    if (data.trim() === '[DONE]') break;
    let chunk: Record<string, any>;
    try { chunk = JSON.parse(data) as Record<string, any>; } catch { return streamFailure('Malformed stream chunk.'); }
    if (chunk['error']) {
      const error = chunk['error'];
      return streamFailure(typeof error === 'string' ? error : String(error['message'] ?? 'the stream reported an error'), typeof error === 'object' ? error['code'] ?? error['type'] : undefined);
    }
    if (typeof chunk['model'] === 'string' && chunk['model']) model = chunk['model'];
    if (chunk['usage']) {
      // prompt_tokens counts the whole prompt, cached included; the cached part is in its details (OpenAI, OpenRouter).
      const cached = chunk['usage']['prompt_tokens_details']?.['cached_tokens'];
      usage = {
        inputTokens: chunk['usage']['prompt_tokens'] ?? 0, outputTokens: chunk['usage']['completion_tokens'] ?? 0,
        ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}),
      };
    }
    const choice = chunk['choices']?.[0];
    if (!choice) continue;
    const delta = choice['delta'] ?? {};
    if (typeof delta['content'] === 'string') {
      text += delta['content'];
      if (delta['content']) onEvent?.({ type: 'text', delta: delta['content'] });
    }
    for (const piece of delta['tool_calls'] ?? []) {
      const index = typeof piece['index'] === 'number' ? piece['index'] : fragments.size;
      const current = fragments.get(index) ?? { id: '', name: '', args: '' };
      if (piece['id']) current.id = piece['id'];
      if (piece['function']?.['name']) current.name += piece['function']['name'];
      if (typeof piece['function']?.['arguments'] === 'string') {
        current.args += piece['function']['arguments'];
        // Settled on the first piece of arguments proper: an empty `arguments: ''` opens a call whose name may still be coming.
        if (piece['function']['arguments']) {
          const id = settle(index, current); // observed or not: the result's id is fixed here
          onEvent?.({ type: 'tool_call_delta', id, argsDelta: piece['function']['arguments'] });
        }
      }
      if (piece['extra_content'] !== undefined) current.extra = piece['extra_content'];
      fragments.set(index, current);
    }
    if (choice['finish_reason']) finishReason = choice['finish_reason'];
  }
  if (!finishReason) return streamFailure('The response stream ended before it finished.');
  for (const [index, fragment] of [...fragments.entries()].sort(([a], [b]) => a - b)) {
    const id = settle(index, fragment); // a call that never got arguments is settled, and announced, here
    onEvent?.({ type: 'tool_call_end', id });
  }

  const extraContent: Record<string, unknown> = {};
  const toolCalls: AIToolCall[] = [...fragments.entries()].sort(([a], [b]) => a - b).map(([index, fragment]) => {
    const call: AIToolCall = { id: settle(index, fragment), name: fragment.name };
    if (fragment.extra !== undefined) extraContent[call.id] = fragment.extra;
    try {
      const parsed: unknown = fragment.args.trim() === '' ? {} : JSON.parse(fragment.args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) call.args = parsed as Record<string, unknown>;
      else call.argsError = { raw: fragment.args, message: 'Tool arguments are not a JSON object.' };
    } catch (error) {
      call.argsError = { raw: fragment.args, message: error instanceof Error ? error.message : 'Invalid JSON.' };
    }
    return call;
  });

  const mapped = STOP[finishReason] ?? 'end';
  // A turn cut off by the token limit or a filter may carry a truncated call: never hand one out.
  const runnable = mapped === 'tool_use' || mapped === 'end';
  const cleaned = stripThinking(text);
  return {
    ok: true,
    ...(cleaned ? { text: cleaned } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(runnable && Object.keys(extraContent).length > 0 ? { providerState: tagged.chatCompletions(extraContent) } : {}),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}
