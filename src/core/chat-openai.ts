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
import { GEMINI_SIGNATURE_PLACEHOLDER, checksSignatures } from './chat-gemini.js';
import { streamFailure } from './failure.js';
import { functionTools, webSearchTool } from './tools.js';

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

/**
 * The history as Chat Completions messages. With `placeholder`, an
 * assistant turn's first call without a kept `thought_signature` gets
 * Google's placeholder in `extra_content`, as the native Gemini path adds
 * it: Gemini 3 over Google's OpenAI-compatible root refuses the replay
 * without one.
 */
export function openaiMessages(system: string, messages: AIMessage[], placeholder = false): ChatMessage[] {
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
      // A failed result is marked as one, as the Responses items mark theirs: Chat Completions has no flag for it.
      const text = textOf(message.content);
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.isError ? `Error: ${text}` : text });
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
    // The placeholder on the first call, merged into whatever extra_content it kept, unless a call of the turn kept a signature of its own.
    const stub = placeholder && !calls.some((call) => hasSignature(extra[call.id]));
    const extraOf = (call: AIToolCall, first: boolean): Record<string, unknown> => {
      const own = extra[call.id];
      if (!stub || !first) return own !== undefined ? { extra_content: own } : {};
      const kept = own && typeof own === 'object' && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
      const google = kept['google'] && typeof kept['google'] === 'object' ? (kept['google'] as Record<string, unknown>) : {};
      return { extra_content: { ...kept, google: { ...google, thought_signature: GEMINI_SIGNATURE_PLACEHOLDER } } };
    };
    out.push({
      role: 'assistant',
      content: message.content ?? (calls.length > 0 ? null : ''),
      ...(calls.length > 0 ? {
        tool_calls: calls.map((call, i) => ({ id: call.id, type: 'function',
          function: { name: call.name, arguments: call.argsError ? call.argsError.raw : JSON.stringify(call.args ?? {}) },
          ...extraOf(call, i === 0) })),
      } : {}),
    });
  }
  flushImages();
  return out;
}

/** Whether a call's `extra_content` carries a thought signature of its own (`google.thought_signature`). */
function hasSignature(extra: unknown): boolean {
  const google = extra && typeof extra === 'object' ? (extra as { google?: unknown }).google : undefined;
  return !!google && typeof google === 'object' && typeof (google as { thought_signature?: unknown }).thought_signature === 'string';
}

/** Optional request fields a server has rejected, to leave out of the retry. */
export type OptionalField = 'parallel_tool_calls' | 'stream_options' | 'prompt_cache_key' | 'reasoning_effort' | 'think';

/**
 * The least reasoning an OpenAI model takes, for `reasoning: 'off'`: `none`
 * from GPT-5.1 on, `minimal` on GPT-5, `low` on the Codex models and the
 * o-series (which take nothing less). Nothing for a model not known to
 * reason, which would refuse the field.
 */
export function lowestEffort(model: string): 'none' | 'minimal' | 'low' | undefined {
  const id = model.toLowerCase();
  // The chat-tuned GPT-5 and the first o1 previews take no effort at all; the Pro models take only their highest levels, so `off` sends nothing there.
  if (/-chat(?:-|$)/.test(id) || /-pro(?:-|$)/.test(id) || /^o1-(?:mini|preview)/.test(id)) return undefined;
  if (/codex/.test(id)) return /^(?:o\d|gpt-5)/.test(id) ? 'low' : undefined;
  if (/^gpt-5\.\d/.test(id) || /^gpt-(?:[6-9]|\d{2})(?:[-.]|$)/.test(id)) return 'none';
  if (/^gpt-5(?:-|$)/.test(id)) return 'minimal';
  if (/^o\d(?:-|$)/.test(id)) return 'low';
  return undefined;
}

/** Ollama, local (port 11434) or ollama.com: the one Chat Completions server that takes `think`. */
function isOllama(base: string): boolean {
  try { const url = new URL(base); return url.hostname === 'ollama.com' || url.port === '11434'; } catch { return false; }
}

/** The request body, without the `omit`ted fields. */
export function openaiBody(req: AIChatRequest, model: string, base: string, omit: ReadonlySet<OptionalField> = new Set()): Record<string, unknown> {
  // A Chat Completions server has no web search of its own: asked for one, the turn fails before any request rather than drop it in silence.
  if (webSearchTool(req)) throw new Error('This server speaks Chat Completions, which has no web search tool: leave the web_search tool out for it.'); // chat() skips the protocol first; this guards a direct caller
  const tools = functionTools(req).map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  const openai = /(^|\.)openai\.com$/i.test(safeHost(base));
  // Google's OpenAI-compatible root serving a model that checks thought signatures: the replay needs the placeholder.
  const google = /(^|\.)(?:generativelanguage|aiplatform)\.googleapis\.com$/i.test(safeHost(base)) && checksSignatures(model);
  return {
    model,
    stream: true,
    [openai ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens ?? OPENAI_DEFAULT_MAX_TOKENS,
    messages: openaiMessages(req.system, req.messages, google),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && !omit.has('parallel_tool_calls') ? { parallel_tool_calls: req.parallelToolCalls === true } : {}),
    ...(!omit.has('stream_options') ? { stream_options: { include_usage: true } } : {}),
    // OpenAI's own fields; another server that refuses one gets the request again without it.
    ...(req.cacheKey && openai && !omit.has('prompt_cache_key') ? { prompt_cache_key: req.cacheKey } : {}),
    ...(effort(req.reasoning, model, openai, omit)),
    // Ollama's own switch: `reasoning: 'off'` turns a thinking model's thinking off there, `'on'` on; its levels have no Ollama equivalent.
    ...((req.reasoning === 'off' || req.reasoning === 'on') && isOllama(base) && !omit.has('think') ? { think: req.reasoning === 'on' } : {}),
  };
}

/** OpenAI's `reasoning_effort`: the level asked for, or for `off` the least the model takes; nothing for `on`, the model's own default. */
function effort(reasoning: AIChatRequest['reasoning'], model: string, openai: boolean, omit: ReadonlySet<OptionalField>): Record<string, unknown> {
  if (!reasoning || reasoning === 'on' || !openai || omit.has('reasoning_effort')) return {};
  const value = reasoning === 'off' ? lowestEffort(model) : reasoning;
  return value ? { reasoning_effort: value } : {};
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
  if (/reasoning_effort/i.test(body)) return 'reasoning_effort';
  if (/\bthink\b/i.test(body)) return 'think';
  return undefined;
}

const STOP: Record<string, AIStopReason> = {
  stop: 'end', tool_calls: 'tool_use', function_call: 'tool_use', length: 'length', content_filter: 'refusal',
};

/**
 * Splits a model's text from the reasoning it writes inline in `<think>`,
 * `<thinking>` or `<reasoning>` tags, as it streams: text inside the tags is
 * reasoning, text outside is text, and a chunk that ends on what may be the
 * start of a tag is held until the next one says. Only a block that opens
 * the answer (whitespace before it allowed) is reasoning: a tag the model
 * quotes partway through its answer is text, as is everything after it —
 * unless `anywhere` says a block may open anywhere.
 */
export class ThinkSplitter {
  private inside = false;
  /** The tag that opened the reasoning; only its own close ends it. */
  private opened = '';
  private held = '';
  /** Whether any text proper has been emitted: a tag after it is literal, unless `anywhere`. */
  private textSeen = false;
  constructor(private readonly emit: (kind: 'text' | 'reasoning', delta: string) => void, private readonly anywhere = false) {}

  push(chunk: string): void {
    let s = this.held + chunk;
    this.held = '';
    for (;;) {
      if (this.literal()) break;
      const tag = /<(\/?)(think|thinking|reasoning)>/i.exec(s);
      if (!tag) break;
      const closing = tag[1] === '/';
      const name = tag[2]!.toLowerCase();
      const before = s.slice(0, tag.index);
      // A close outside, an open inside, a close of the other tag inside, or an open after the answer began: literal text of whatever is current.
      if (closing !== this.inside || (closing && name !== this.opened) || (!closing && !this.anywhere && (this.textSeen || /\S/.test(before)))) {
        this.out(s.slice(0, tag.index + tag[0].length));
        s = s.slice(tag.index + tag[0].length);
        continue;
      }
      this.out(before);
      this.inside = !closing;
      this.opened = closing ? '' : name;
      s = s.slice(tag.index + tag[0].length);
    }
    // Hold back a tail that may be the start of a tag ("<", "</thi"), up to a tag's length — unless no tag can matter any more,
    // the answer having begun (in this very chunk included).
    const tail = this.literal() ? null : /<\/?[a-z]{0,9}$/i.exec(s);
    if (tail && (this.inside || this.anywhere || !/\S/.test(s.slice(0, tail.index)))) { this.held = s.slice(tail.index); s = s.slice(0, tail.index); }
    this.out(s);
  }

  /** Whether tags have stopped mattering: outside a block, after the answer began, with no block allowed anywhere. */
  private literal(): boolean {
    return !this.inside && !this.anywhere && this.textSeen;
  }

  /** The end of the stream: what was held is what it is. */
  end(): void {
    this.out(this.held);
    this.held = '';
  }

  private out(delta: string): void {
    if (!delta) return;
    if (!this.inside && /\S/.test(delta)) this.textSeen = true;
    this.emit(this.inside ? 'reasoning' : 'text', delta);
  }
}

export async function openaiResult(events: AsyncIterable<SseEvent>, onEvent?: ChatEventSink): Promise<AIChatResult> {
  let text = '';
  let reasoning = '';
  const splitter = new ThinkSplitter((kind, delta) => {
    if (kind === 'text') text += delta; else reasoning += delta;
    onEvent?.({ type: kind, delta });
  });
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
      const thought = chunk['usage']['completion_tokens_details']?.['reasoning_tokens'];
      usage = {
        inputTokens: chunk['usage']['prompt_tokens'] ?? 0, outputTokens: chunk['usage']['completion_tokens'] ?? 0,
        ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}),
        ...(typeof thought === 'number' ? { reasoningTokens: thought } : {}),
      };
    }
    const choice = chunk['choices']?.[0];
    if (!choice) continue;
    const delta = choice['delta'] ?? {};
    // Reasoning in its own field (DeepSeek's and OpenRouter's `reasoning_content` / `reasoning`), or inline in the text.
    const thought = typeof delta['reasoning_content'] === 'string' ? delta['reasoning_content'] : typeof delta['reasoning'] === 'string' ? delta['reasoning'] : '';
    if (thought) { reasoning += thought; onEvent?.({ type: 'reasoning', delta: thought }); }
    if (typeof delta['content'] === 'string') splitter.push(delta['content']);
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
  splitter.end();
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
  // A turn cut off by the token limit or a filter may carry a truncated call: never hand one out, but say which it was — the last
  // whose arguments did not come whole (one that parses was complete; the cut then fell in the text after it).
  const runnable = mapped === 'tool_use' || mapped === 'end';
  const broken = runnable ? undefined : [...toolCalls].reverse().find((call) => call.argsError);
  const cut = broken ? { id: broken.id, name: broken.name, raw: broken.argsError!.raw } : undefined;
  const cleaned = text.trim();
  const thoughts = reasoning.trim();
  return {
    ok: true,
    ...(cleaned ? { text: cleaned } : {}),
    ...(thoughts ? { reasoning: thoughts } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(cut ? { truncatedToolCall: cut } : {}),
    ...(runnable && Object.keys(extraContent).length > 0 ? { providerState: tagged.chatCompletions(extraContent) } : {}),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}
