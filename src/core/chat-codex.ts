/**
 * `chat()` for the ChatGPT subscription: OpenAI's Codex backend
 * (`chatgpt.com/backend-api/codex/responses`, the Responses API) with the
 * account's own sign-in, streamed, with function tools.
 *
 * Request: `instructions` is the system prompt; the history becomes Responses
 * input items — messages, and tool calls and results as top-level
 * `function_call` / `function_call_output` items. Tool results carry text
 * only, so their images follow as one user message.
 *
 * Backend quirks:
 *  - `max_output_tokens` is refused, so no output cap is sent;
 *  - `store: false`: nothing is kept server-side, so the turn's output items
 *    (its reasoning with the encrypted content, messages, function calls)
 *    come back as `providerState` and are sent back as the next input;
 *  - the answer always streams.
 *
 * Provider error text is never copied into an error: it can echo the request.
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIServerTool, AIToolCall } from '../types.js';
import type { SseEvent } from './sse.js';
import type { ChatEventSink } from './events.js';
import { streamFailure } from './failure.js';
import { responsesState, tagged } from './provider-state.js';
import { approximateLocation, functionTools, webSearchTool } from './tools.js';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

type Item = Record<string, unknown>;

function userParts(content: string | AIContentPart[]): Item[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image') return { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` };
    return { type: 'input_file', filename: part.name ?? 'document.pdf', file_data: `data:${part.mediaType};base64,${part.data}` };
  });
}

/** The history as Responses input items. */
export function codexInput(messages: AIMessage[]): Item[] {
  const items: Item[] = [];
  // Images and documents from tool results, sent as one user message after them.
  let pending: AIContentPart[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    items.push({ type: 'message', role: 'user', content: userParts(pending) });
    pending = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      const text = typeof message.content === 'string' ? message.content
        : message.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');
      items.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.isError ? `Error: ${text}` : text });
      if (typeof message.content !== 'string') pending.push(...message.content.filter((part) => part.type !== 'text'));
      continue;
    }
    flush();
    if (message.role === 'user') {
      items.push({ type: 'message', role: 'user', content: userParts(message.content) });
      continue;
    }
    // The turn's own output items when we have them (reasoning included), else rebuilt from text and calls.
    const own = responsesState(message.providerState);
    // A reasoning item without its encrypted content cannot be found again under store: false; it is left out.
    if (own) { items.push(...own.filter((item) => item['type'] !== 'reasoning' || typeof item['encrypted_content'] === 'string')); continue; }
    if (message.content) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    for (const call of message.toolCalls ?? []) {
      items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argsError ? call.argsError.raw : JSON.stringify(call.args ?? {}) });
    }
  }
  flush();
  return items;
}

/** The request body. The Codex backend refuses `max_output_tokens`; a standard Responses endpoint takes it. `cacheKey` sends OpenAI's `prompt_cache_key`: for OpenAI itself, not another server. */
export function codexBody(req: AIChatRequest, model: string, { maxOutputTokens = false, cacheKey = false } = {}): Record<string, unknown> {
  return {
    model, store: false, stream: true,
    instructions: req.system || 'You are a helpful assistant.',
    input: codexInput(req.messages),
    ...(maxOutputTokens && req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
    ...(cacheKey && req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    // Nothing is stored server-side, so the reasoning's encrypted content is always asked for, to replay; a level asks for the effort and a summary too.
    include: ['reasoning.encrypted_content'],
    ...(req.reasoning && req.reasoning !== 'off' ? { reasoning: { effort: req.reasoning, summary: 'auto' } } : {}),
    ...(req.tools?.length ? {
      tools: [
        ...functionTools(req).map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
        ...(webSearchTool(req) ? [webSearchItem(webSearchTool(req)!)] : []),
      ],
      tool_choice: 'auto',
      parallel_tool_calls: req.parallelToolCalls === true,
    } : {}),
  };
}

/** The Responses API's web search tool, with the domain list and location given. */
function webSearchItem(tool: AIServerTool): Item {
  const location = approximateLocation(tool);
  return {
    type: 'web_search',
    ...(tool.allowedDomains?.length ? { filters: { allowed_domains: tool.allowedDomains } } : tool.blockedDomains?.length ? { filters: { blocked_domains: tool.blockedDomains } } : {}),
    ...(location ? { user_location: { type: 'approximate', ...location } } : {}),
  };
}

/** An HTTP failure in words, without the provider's own text. */
export function codexHttpError(status: number, body: string): string {
  let code = '';
  let message = '';
  try {
    const data = JSON.parse(body) as Record<string, any>;
    const error = (data['error'] ?? data['detail'] ?? {}) as Record<string, unknown>;
    const c = error['code'] ?? error['type'] ?? data['code'];
    code = typeof c === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(c) ? c : '';
    const m = error['message'] ?? data['detail'] ?? data['message'];
    message = typeof m === 'string' ? m : '';
  } catch { /* the status is enough */ }
  if (/model.{0,200}(not supported|unsupported|not available|does not exist)/i.test(message) && (status === 400 || status === 404)) {
    return 'That model is not available for this ChatGPT account. Pick another model in Settings.';
  }
  if (status === 401 || /invalid_api_key|token_expired|unauthorized/i.test(code)) return 'ChatGPT rejected this sign-in. Sign in again in Settings.';
  if (status === 429 || /usage_limit|rate_limit/i.test(code)) return 'Your ChatGPT plan’s limit is reached. Wait for it to reset.';
  if (/context_length|context_window/i.test(code)) return 'The conversation is longer than this model accepts.';
  if (status >= 500) return `ChatGPT’s backend failed (HTTP ${status}).`;
  return `ChatGPT refused the request (HTTP ${status}${code ? `; ${code}` : ''}).`;
}

/** A failure event's body in words, the ChatGPT way: without the provider's text. */
export const codexFailure = (body: string): string => codexHttpError(0, body).replace(' (HTTP 0)', '');

/**
 * The Responses stream, assembled into one turn. The result counts only once
 * `response.completed` (or `response.incomplete`) has arrived; `error` and
 * `response.failed` are failures (worded by `failure`), and so is a stream
 * that ends before either.
 */
export async function codexResult(events: AsyncIterable<SseEvent>, failure: (body: string) => string = codexFailure, onEvent?: ChatEventSink): Promise<AIChatResult> {
  const texts = new Map<string, string>();
  const calls = new Map<string, { callId: string; name: string; args: string; gotDelta: boolean; started?: boolean; ended?: boolean }>();
  const announce = (entry: { callId: string; name: string; started?: boolean }) => {
    if (entry.started) return;
    entry.started = true;
    onEvent?.({ type: 'tool_call_start', id: entry.callId, name: entry.name });
  };
  let completed = false;
  let incomplete = false;
  let usage: AIChatResult['usage'];
  let model: string | undefined;
  const items: Array<Record<string, unknown>> = [];
  const thoughts: string[] = [];
  let thought = '';
  const queries: string[] = [];
  let searchCalls = 0;
  const sources = new Map<string, { url: string; title?: string }>();

  const call = (item: Record<string, unknown>) => {
    const id = typeof item['id'] === 'string' ? item['id'] : String(item['call_id'] ?? '');
    let entry = calls.get(id);
    if (!entry) {
      entry = { callId: typeof item['call_id'] === 'string' ? item['call_id'] : id, name: typeof item['name'] === 'string' ? item['name'] : '', args: '', gotDelta: false };
      calls.set(id, entry);
    }
    return entry;
  };

  for await (const { data } of events) {
    if (data.trim() === '[DONE]') break;
    let event: Record<string, any>;
    try { event = JSON.parse(data) as Record<string, any>; } catch { return streamFailure('Malformed stream chunk.'); }
    const itemId = typeof event['item_id'] === 'string' ? event['item_id'] : '';
    switch (event['type']) {
      case 'response.output_item.added':
        if (event['item']?.type === 'function_call') {
          const entry = call(event['item']);
          if (entry.name) announce(entry); // else once the name arrives, on `done`, or with the first arguments
        }
        break;
      case 'response.output_text.delta':
        if (typeof event['delta'] === 'string') {
          texts.set(itemId, (texts.get(itemId) ?? '') + event['delta']);
          if (event['delta']) onEvent?.({ type: 'text', delta: event['delta'] });
        }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event['delta'] === 'string' && event['delta']) {
          thought += event['delta'];
          onEvent?.({ type: 'reasoning', delta: event['delta'] });
        }
        break;
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done':
        if (thought) { thoughts.push(thought); thought = ''; }
        break;
      case 'response.function_call_arguments.delta': {
        const entry = calls.get(itemId);
        if (entry && typeof event['delta'] === 'string') {
          entry.args += event['delta']; entry.gotDelta = true;
          announce(entry);
          if (event['delta']) onEvent?.({ type: 'tool_call_delta', id: entry.callId, argsDelta: event['delta'] });
        }
        break;
      }
      case 'response.output_item.done': {
        const item = event['item'] ?? {};
        if (item && typeof item === 'object' && typeof item.type === 'string') items.push(item as Record<string, unknown>);
        if (item.type === 'web_search_call') {
          // One billed call; its action names the queries (`queries`, or the older `query`). The sources read come as the message's citations.
          searchCalls += 1;
          const action = item.action ?? {};
          const named = Array.isArray(action.queries) ? action.queries : [action.query];
          for (const query of named) {
            if (typeof query === 'string' && query) { queries.push(query); onEvent?.({ type: 'search', query }); }
          }
        }
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            for (const note of Array.isArray(part?.annotations) ? part.annotations : []) {
              if (note?.type === 'url_citation' && typeof note.url === 'string' && !sources.has(note.url)) {
                sources.set(note.url, { url: note.url, ...(typeof note.title === 'string' ? { title: note.title } : {}) });
              }
            }
          }
        }
        if (item.type !== 'function_call') break;
        const entry = call(item);
        if (entry.ended) break; // a repeated `done` changes nothing
        if (!entry.name && typeof item.name === 'string') entry.name = item.name;
        announce(entry);
        if (!entry.gotDelta && typeof item.arguments === 'string') {
          entry.args = item.arguments;
          if (item.arguments) onEvent?.({ type: 'tool_call_delta', id: entry.callId, argsDelta: item.arguments });
        }
        entry.ended = true;
        onEvent?.({ type: 'tool_call_end', id: entry.callId });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = event['response'] ?? {};
        const u = response.usage ?? {};
        if (typeof response.model === 'string' && response.model) model = response.model;
        // input_tokens counts the whole prompt, cached included; the cached part is in its details.
        if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
          const cached = u.input_tokens_details?.cached_tokens;
          const reasoned = u.output_tokens_details?.reasoning_tokens;
          usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}), ...(typeof reasoned === 'number' ? { reasoningTokens: reasoned } : {}) };
          if (searchCalls > 0) usage.webSearchRequests = searchCalls;
        }
        incomplete = event['type'] === 'response.incomplete' || response.status === 'incomplete';
        completed = true;
        break;
      }
      case 'response.failed':
        return streamFailure(failure(JSON.stringify(event['response'] ?? {})), event['response']?.error?.code ?? event['response']?.error?.type);
      case 'error':
        return streamFailure(failure(JSON.stringify({ error: event['error'] ?? event })), event['error']?.code ?? event['error']?.type ?? event['code']);
      default:
    }
  }
  if (!completed) return streamFailure('The response stream ended before it finished.');
  for (const entry of calls.values()) if (!entry.ended) { announce(entry); onEvent?.({ type: 'tool_call_end', id: entry.callId }); }

  const toolCalls: AIToolCall[] = [...calls.values()].map((entry) => {
    const out: AIToolCall = { id: entry.callId, name: entry.name };
    try {
      const parsed: unknown = entry.args.trim() === '' ? {} : JSON.parse(entry.args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.args = parsed as Record<string, unknown>;
      else out.argsError = { raw: entry.args, message: 'Tool arguments are not a JSON object.' };
    } catch (error) {
      out.argsError = { raw: entry.args, message: error instanceof Error ? error.message : 'Invalid JSON.' };
    }
    return out;
  });
  const text = [...texts.values()].join('\n\n').trim();
  if (thought) thoughts.push(thought);
  const reasoning = thoughts.join('\n\n').trim();
  const webSearch = searchCalls > 0 || sources.size > 0 ? { queries, sources: [...sources.values()] } : undefined;
  // A turn cut off by the limit may carry a truncated call: never hand one out.
  if (incomplete) return { ok: true, ...(text ? { text } : {}), ...(reasoning ? { reasoning } : {}), ...(webSearch ? { webSearch } : {}), stopReason: 'length', ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
  return {
    ok: true,
    ...(text ? { text } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    // The turn's items come back as sent, the reasoning's encrypted content included, to be the next input.
    ...(items.length > 0 ? { providerState: tagged.responses(items) } : {}),
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  };
}
