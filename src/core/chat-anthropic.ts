/**
 * `chat()` for Anthropic: the Messages API, streamed, with tools.
 *
 * Request: tools as `{name, description, input_schema}`, the last tool and the
 * system prompt marked `cache_control` (they are the stable prefix), and
 * `tool_choice: {type: "auto", disable_parallel_tool_use}` — never forced
 * tool use, which some models reject. Tool results go back as `tool_result`
 * blocks in one user message.
 *
 * Response: SSE. Content blocks are rebuilt from their deltas; tool inputs
 * from `input_json_delta` fragments, parsed strictly at the end. The result
 * counts only after `message_stop` with no `error` event before it.
 *
 * Replay: the assistant turn's content blocks — thinking blocks with their
 * signatures, text, tool_use — are returned as `providerState` and sent back
 * verbatim on the next request, as the API requires for thinking blocks.
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIReasoning, AIStopReason, AIToolCall, AIWebSearchCall } from '../types.js';
import type { SseEvent } from './sse.js';
import type { ChatEventSink } from './events.js';
import { anthropicState, tagged } from './provider-state.js';
import { streamFailure } from './failure.js';
import { approximateLocation, functionTools, webSearchTool } from './tools.js';

type Block = Record<string, unknown> & { type: string };

export interface AnthropicAuth {
  /** API key (x-api-key) or subscription token (Bearer). */
  token: string;
  subscription: boolean;
}

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;

function parts(content: string | AIContentPart[]): string | Block[] {
  if (typeof content === 'string') return content;
  return content.map((part): Block => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'document') return { type: 'document', source: { type: 'base64', media_type: part.mediaType, data: part.data }, ...(part.name ? { title: part.name } : {}) };
    return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } };
  });
}

/** The assistant turn as blocks: the provider's own blocks when we have them (written under this protocol), else rebuilt. */
function assistantBlocks(message: Extract<AIMessage, { role: 'assistant' }>): Block[] {
  const own = anthropicState(message.providerState);
  if (own) return own as Block[];
  const blocks: Block[] = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const call of message.toolCalls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
  return blocks;
}

export function anthropicMessages(messages: AIMessage[]): Array<{ role: 'user' | 'assistant'; content: string | Block[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string | Block[] }> = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: assistantBlocks(message) });
      continue;
    }
    if (message.role === 'tool') {
      const result: Block = { type: 'tool_result', tool_use_id: message.toolCallId, content: parts(message.content),
        ...(message.isError ? { is_error: true } : {}) };
      // Every tool_result for one assistant turn goes in a single user message.
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((block) => block.type === 'tool_result')) {
        last.content.push(result);
      } else {
        out.push({ role: 'user', content: [result] });
      }
      continue;
    }
    out.push({ role: 'user', content: parts(message.content) });
  }
  return out;
}

/**
 * The messages with a cache breakpoint on the last one's last eligible block,
 * so the whole conversation is the cached prefix of the next turn. Thinking
 * blocks take no breakpoint (Anthropic refuses one), nor does an empty text
 * block; the nearest block before them carries it, or none does. The
 * caller's blocks are copied, never edited.
 */
function withConversationBreakpoint(messages: ReturnType<typeof anthropicMessages>): ReturnType<typeof anthropicMessages> {
  const last = messages[messages.length - 1];
  // A paused assistant turn goes back exactly as it came; the breakpoint waits for the next user turn.
  if (!last || last.role !== 'user') return messages;
  const blocks: Block[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
  const eligible = (block: Block) => block.type !== 'thinking' && block.type !== 'redacted_thinking' && !(block.type === 'text' && !block['text']);
  const block = [...blocks].reverse().find(eligible);
  if (!block) return messages;
  block['cache_control'] = { type: 'ephemeral' };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/**
 * Which thinking a Claude takes: adaptive (the 4.6 generation and later, the
 * 5 generation, Mythos), extended with a token budget (3.7 to 4.5), or none.
 */
export function claudeThinking(model: string): 'adaptive' | 'enabled' | 'none' {
  const id = model.toLowerCase();
  if (/claude-(?:fable|mythos|opus|sonnet|haiku)-5(?:[-.]|$)/.test(id) || /claude-mythos/.test(id)) return 'adaptive';
  if (/claude-(?:opus|sonnet)-4[-.][678](?:-|$)/.test(id)) return 'adaptive';
  if (/claude-(?:opus|sonnet|haiku)-4(?:[-.]|$)/.test(id) || /claude-3-7-sonnet/.test(id)) return 'enabled';
  return 'none';
}

const BUDGETS: Record<Exclude<AIReasoning, 'off' | 'on'>, number> = { low: 2048, medium: 8192, high: 16000 };

/**
 * The thinking fields for a reasoning level: adaptive thinking with
 * `output_config.effort` where the model takes it, a budget where it takes
 * extended thinking only, nothing where it takes neither. `on` asks for
 * adaptive thinking with no effort (the model's own default), or the medium
 * budget where it takes a budget only. `off` is sent only where the model
 * thinks by default and can be told not to (Opus 5, Sonnet 5, Haiku 5.5:
 * `disabled`; Sonnet 5.5: `between_tools`); the always-on models and the
 * off-by-default ones get nothing.
 */
export function thinkingFields(reasoning: AIReasoning | undefined, model: string, maxTokens: number): Record<string, unknown> {
  if (!reasoning) return {};
  const mode = claudeThinking(model);
  if (mode === 'none') return {};
  if (reasoning === 'off') {
    if (mode !== 'adaptive') return {};
    if (/claude-sonnet-5-5(?:-|$)/.test(model)) return { thinking: { type: 'between_tools' } };
    if (/claude-(?:opus|sonnet)-5(?:-\d{8})?$|claude-haiku-5-5(?:-|$)/.test(model)) return { thinking: { type: 'disabled' } };
    return {};
  }
  if (mode === 'adaptive') return { thinking: { type: 'adaptive', display: 'summarized' }, ...(reasoning === 'on' ? {} : { output_config: { effort: reasoning } }) };
  const budget = Math.min(BUDGETS[reasoning === 'on' ? 'medium' : reasoning], maxTokens - 1024);
  return budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {};
}

/** The request body. `system` is the already-prepared system blocks (the subscription sentinel is the caller's). */
export function anthropicBody(req: AIChatRequest, model: string, system: Array<{ type: 'text'; text: string }>): Record<string, unknown> {
  const systemBlocks: Block[] = system.map((block) => ({ ...block }));
  const lastSystem = systemBlocks[systemBlocks.length - 1];
  if (lastSystem) lastSystem['cache_control'] = { type: 'ephemeral' };
  const tools: Array<Record<string, unknown>> = functionTools(req).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  const search = webSearchTool(req);
  if (search) {
    if (tools.some((tool) => tool['name'] === 'web_search')) throw new Error("A function tool named web_search collides with the provider's web search tool: rename it.");
    const location = approximateLocation(search);
    tools.push({
      type: 'web_search_20250305', name: 'web_search',
      ...(search.maxUses !== undefined ? { max_uses: search.maxUses } : {}),
      ...(search.allowedDomains?.length ? { allowed_domains: search.allowedDomains } : search.blockedDomains?.length ? { blocked_domains: search.blockedDomains } : {}),
      ...(location ? { user_location: { type: 'approximate', ...location } } : {}),
    });
  }
  // The last tool, server tool included, closes the cached prefix.
  const lastTool = tools[tools.length - 1];
  if (lastTool) lastTool['cache_control'] = { type: 'ephemeral' };
  const messages = anthropicMessages(req.messages);
  const maxTokens = req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    ...thinkingFields(req.reasoning, model, maxTokens),
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: req.cacheConversation ? withConversationBreakpoint(messages) : messages,
    ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto', disable_parallel_tool_use: req.parallelToolCalls !== true } } : {}),
  };
}

const STOP: Record<string, AIStopReason> = {
  end_turn: 'end', stop_sequence: 'end', pause_turn: 'pause',
  tool_use: 'tool_use', max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'refusal',
};

/**
 * The web searches in a turn's blocks: each `server_tool_use` query with
 * the sources (or the error) its `web_search_tool_result` brought, matched
 * by `tool_use_id`; and the queries and sources over the turn, each once.
 */
function searchesOf(blocks: Block[]): AIChatResult['webSearch'] {
  const queries: string[] = [];
  const sources = new Map<string, { url: string; title?: string }>();
  const searches: AIWebSearchCall[] = [];
  const byId = new Map<string, AIWebSearchCall>();
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'server_tool_use' && block['name'] === 'web_search') {
      const query = (block['input'] as Record<string, unknown> | undefined)?.['query'];
      if (typeof query !== 'string' || !query) continue;
      queries.push(query);
      const search: AIWebSearchCall = { query, sources: [] };
      searches.push(search);
      if (typeof block['id'] === 'string') byId.set(block['id'], search);
    }
    if (block.type === 'web_search_tool_result') {
      const search = typeof block['tool_use_id'] === 'string' ? byId.get(block['tool_use_id']) : undefined;
      const content = block['content'];
      if (Array.isArray(content)) {
        if (search) search.resultCount = content.length;
        for (const result of content as Array<Record<string, unknown>>) {
          if (!result || typeof result['url'] !== 'string') continue;
          const source = { url: result['url'], ...(typeof result['title'] === 'string' ? { title: result['title'] } : {}) };
          if (!sources.has(source.url)) sources.set(source.url, source);
          if (search && !search.sources.some((s) => s.url === source.url)) search.sources.push(source);
        }
      } else if (search && content && typeof content === 'object') {
        const code = (content as Record<string, unknown>)['error_code'];
        if (typeof code === 'string' && code) search.error = code;
      }
    }
  }
  return queries.length > 0 || sources.size > 0 ? { queries, sources: [...sources.values()], searches } : undefined;
}

/** Rebuild the response from its SSE events. Anything short of a clean `message_stop` is a failure. */
export async function anthropicResult(events: AsyncIterable<SseEvent>, onEvent?: ChatEventSink): Promise<AIChatResult> {
  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  const ended = new Set<number>();
  let stopReason: string | undefined;
  let model: string | undefined;
  const usage: NonNullable<AIChatResult['usage']> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let finished = false;
  // The counts are cumulative and may grow after message_start (a server tool's results, a paused turn): the latest value of each wins.
  // Anthropic's input_tokens leaves the cached tokens out; the whole prompt is the three together, as the other providers count it.
  let input: number | undefined;
  const readUsage = (u: Record<string, any> | undefined) => {
    if (!u || typeof u !== 'object') return;
    if (typeof u['input_tokens'] === 'number') input = u['input_tokens'];
    if (typeof u['cache_read_input_tokens'] === 'number') usage.cacheReadTokens = u['cache_read_input_tokens'];
    if (typeof u['cache_creation_input_tokens'] === 'number') usage.cacheWriteTokens = u['cache_creation_input_tokens'];
    usage.inputTokens = (input ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (typeof u['output_tokens'] === 'number') usage.outputTokens = u['output_tokens'];
    if (typeof u['output_tokens_details']?.['thinking_tokens'] === 'number') usage.reasoningTokens = u['output_tokens_details']['thinking_tokens'];
    if (typeof u['server_tool_use']?.['web_search_requests'] === 'number') usage.webSearchRequests = u['server_tool_use']['web_search_requests'];
  };

  for await (const { event, data } of events) {
    if (event === 'ping') continue;
    let payload: Record<string, any>;
    try { payload = JSON.parse(data) as Record<string, any>; } catch { return streamFailure(`Malformed stream event (${event}).`); }
    switch (payload['type']) {
      case 'message_start': {
        if (typeof payload['message']?.['model'] === 'string') model = payload['message']['model'];
        readUsage(payload['message']?.['usage']);
        break;
      }
      case 'content_block_start': {
        const block = { ...(payload['content_block'] as Block) };
        if (block.type === 'tool_use') {
          partialJson.set(payload['index'], '');
          onEvent?.({ type: 'tool_call_start', id: String(block['id']), name: String(block['name']) });
        }
        // A server tool's input streams the same way, but it is the provider's call, not the caller's.
        if (block.type === 'server_tool_use') partialJson.set(payload['index'], '');
        if (block.type === 'text' && typeof block['text'] === 'string' && block['text']) onEvent?.({ type: 'text', delta: block['text'] });
        blocks[payload['index']] = block;
        break;
      }
      case 'content_block_delta': {
        const block = blocks[payload['index']];
        const delta = payload['delta'] ?? {};
        if (!block) break;
        if (delta['type'] === 'text_delta') {
          block['text'] = `${block['text'] ?? ''}${delta['text']}`;
          if (block.type === 'text' && delta['text']) onEvent?.({ type: 'text', delta: String(delta['text']) });
        }
        else if (delta['type'] === 'thinking_delta') {
          block['thinking'] = `${block['thinking'] ?? ''}${delta['thinking']}`;
          if (block.type === 'thinking' && delta['thinking']) onEvent?.({ type: 'reasoning', delta: String(delta['thinking']) });
        }
        else if (delta['type'] === 'signature_delta') block['signature'] = `${block['signature'] ?? ''}${delta['signature']}`;
        else if (delta['type'] === 'input_json_delta') {
          partialJson.set(payload['index'], `${partialJson.get(payload['index']) ?? ''}${delta['partial_json']}`);
          if (delta['partial_json'] && block.type === 'tool_use') onEvent?.({ type: 'tool_call_delta', id: String(block['id']), argsDelta: String(delta['partial_json']) });
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks[payload['index']];
        if (block?.type === 'tool_use' && !ended.has(payload['index'])) {
          ended.add(payload['index']);
          onEvent?.({ type: 'tool_call_end', id: String(block['id']) });
        }
        if (block?.type === 'server_tool_use') {
          const raw = partialJson.get(payload['index']) ?? '';
          try { block['input'] = raw.trim() ? JSON.parse(raw) : {}; } catch { block['input'] = {}; }
          const query = (block['input'] as Record<string, unknown>)['query'];
          if (block['name'] === 'web_search' && typeof query === 'string' && query) onEvent?.({ type: 'search', query });
        }
        break;
      }
      case 'message_delta':
        stopReason = payload['delta']?.['stop_reason'] ?? stopReason;
        readUsage(payload['usage']);
        break;
      case 'message_stop':
        finished = true;
        break;
      case 'error':
        return streamFailure(`${payload['error']?.['type'] ?? 'error'}: ${payload['error']?.['message'] ?? 'the stream reported an error'}`, payload['error']?.['type']);
      default:
        break;
    }
  }
  if (!finished) return streamFailure('The response stream ended before it finished.');
  for (const [index, block] of blocks.entries()) if (block?.type === 'tool_use' && !ended.has(index)) onEvent?.({ type: 'tool_call_end', id: String(block['id']) });

  const toolCalls: AIToolCall[] = [];
  const texts: string[] = [];
  const thoughts: string[] = [];
  /** The last call's arguments as they came, for a turn cut off in the middle of it. */
  let lastRaw = '';
  for (const [index, block] of blocks.entries()) {
    if (!block) continue;
    if (block.type === 'text') texts.push(String(block['text'] ?? ''));
    if (block.type === 'thinking' && typeof block['thinking'] === 'string' && block['thinking']) thoughts.push(block['thinking']);
    if (block.type !== 'tool_use') continue;
    const raw = partialJson.get(index) ?? '';
    lastRaw = raw;
    const call: AIToolCall = { id: String(block['id']), name: String(block['name']) };
    try {
      const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        call.args = parsed as Record<string, unknown>;
        block['input'] = parsed;
      } else {
        call.argsError = { raw, message: 'Tool arguments are not a JSON object.' };
        block['input'] = {};
      }
    } catch (error) {
      call.argsError = { raw, message: error instanceof Error ? error.message : 'Invalid JSON.' };
      block['input'] = {};
    }
    toolCalls.push(call);
  }

  const mapped = STOP[stopReason ?? ''] ?? 'end';
  // A turn cut off by max_tokens or a refusal may carry a truncated tool call:
  // never hand one out, and drop it from what gets replayed. A paused turn goes back whole.
  const runnable = mapped === 'tool_use' || mapped === 'end';
  const state = runnable || mapped === 'pause' ? blocks.filter(Boolean) : blocks.filter((block) => block && block.type !== 'tool_use');
  const text = texts.join('');
  const reasoning = thoughts.join('\n\n');
  const webSearch = searchesOf(blocks);
  const cut = !runnable && mapped !== 'pause' ? toolCalls[toolCalls.length - 1] : undefined;
  return {
    ok: true,
    ...(text ? { text } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    // The call the turn was cut off in: its arguments as far as they came, never handed out as a call.
    ...(cut ? { truncatedToolCall: { id: cut.id, name: cut.name, raw: lastRaw } } : {}),
    providerState: tagged.anthropic(state),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(model ? { model } : {}),
    usage,
  };
}
