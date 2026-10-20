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

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIStopReason, AIToolCall } from '../types.js';
import type { SseEvent } from './sse.js';
import type { ChatEventSink } from './events.js';
import { anthropicState, tagged } from './provider-state.js';
import { streamFailure } from './failure.js';

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
  if (!last) return messages;
  const blocks: Block[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
  const eligible = (block: Block) => block.type !== 'thinking' && block.type !== 'redacted_thinking' && !(block.type === 'text' && !block['text']);
  const block = [...blocks].reverse().find(eligible);
  if (!block) return messages;
  block['cache_control'] = { type: 'ephemeral' };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/** The request body. `system` is the already-prepared system blocks (the subscription sentinel is the caller's). */
export function anthropicBody(req: AIChatRequest, model: string, system: Array<{ type: 'text'; text: string }>): Record<string, unknown> {
  const systemBlocks: Block[] = system.map((block) => ({ ...block }));
  const lastSystem = systemBlocks[systemBlocks.length - 1];
  if (lastSystem) lastSystem['cache_control'] = { type: 'ephemeral' };
  const tools: Array<Record<string, unknown>> = (req.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  const lastTool = tools[tools.length - 1];
  if (lastTool) lastTool['cache_control'] = { type: 'ephemeral' };
  const messages = anthropicMessages(req.messages);
  return {
    model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: true,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: req.cacheConversation ? withConversationBreakpoint(messages) : messages,
    ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto', disable_parallel_tool_use: req.parallelToolCalls !== true } } : {}),
  };
}

const STOP: Record<string, AIStopReason> = {
  end_turn: 'end', stop_sequence: 'end', pause_turn: 'end',
  tool_use: 'tool_use', max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'refusal',
};

/** Rebuild the response from its SSE events. Anything short of a clean `message_stop` is a failure. */
export async function anthropicResult(events: AsyncIterable<SseEvent>, onEvent?: ChatEventSink): Promise<AIChatResult> {
  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  const ended = new Set<number>();
  let stopReason: string | undefined;
  let model: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let finished = false;

  for await (const { event, data } of events) {
    if (event === 'ping') continue;
    let payload: Record<string, any>;
    try { payload = JSON.parse(data) as Record<string, any>; } catch { return streamFailure(`Malformed stream event (${event}).`); }
    switch (payload['type']) {
      case 'message_start': {
        const u = payload['message']?.['usage'] ?? {};
        if (typeof payload['message']?.['model'] === 'string') model = payload['message']['model'];
        // Anthropic's input_tokens leaves the cached tokens out; the whole prompt is the three together, as the other providers count it.
        usage.cacheReadTokens = u['cache_read_input_tokens'] ?? 0;
        usage.cacheWriteTokens = u['cache_creation_input_tokens'] ?? 0;
        usage.inputTokens = (u['input_tokens'] ?? 0) + usage.cacheReadTokens + usage.cacheWriteTokens;
        usage.outputTokens = u['output_tokens'] ?? 0;
        break;
      }
      case 'content_block_start': {
        const block = { ...(payload['content_block'] as Block) };
        if (block.type === 'tool_use') {
          partialJson.set(payload['index'], '');
          onEvent?.({ type: 'tool_call_start', id: String(block['id']), name: String(block['name']) });
        }
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
        else if (delta['type'] === 'thinking_delta') block['thinking'] = `${block['thinking'] ?? ''}${delta['thinking']}`;
        else if (delta['type'] === 'signature_delta') block['signature'] = `${block['signature'] ?? ''}${delta['signature']}`;
        else if (delta['type'] === 'input_json_delta') {
          partialJson.set(payload['index'], `${partialJson.get(payload['index']) ?? ''}${delta['partial_json']}`);
          if (delta['partial_json']) onEvent?.({ type: 'tool_call_delta', id: String(block['id']), argsDelta: String(delta['partial_json']) });
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks[payload['index']];
        if (block?.type === 'tool_use' && !ended.has(payload['index'])) {
          ended.add(payload['index']);
          onEvent?.({ type: 'tool_call_end', id: String(block['id']) });
        }
        break;
      }
      case 'message_delta':
        stopReason = payload['delta']?.['stop_reason'] ?? stopReason;
        if (typeof payload['usage']?.['output_tokens'] === 'number') usage.outputTokens = payload['usage']['output_tokens'];
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
  for (const [index, block] of blocks.entries()) {
    if (!block) continue;
    if (block.type === 'text') texts.push(String(block['text'] ?? ''));
    if (block.type !== 'tool_use') continue;
    const raw = partialJson.get(index) ?? '';
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
  // never hand one out, and drop it from what gets replayed.
  const runnable = mapped === 'tool_use' || mapped === 'end';
  const state = runnable ? blocks.filter(Boolean) : blocks.filter((block) => block && block.type !== 'tool_use');
  const text = texts.join('');
  return {
    ok: true,
    ...(text ? { text } : {}),
    ...(runnable && toolCalls.length > 0 ? { toolCalls } : {}),
    providerState: tagged.anthropic(state),
    stopReason: runnable && toolCalls.length > 0 ? 'tool_use' : mapped,
    ...(model ? { model } : {}),
    usage,
  };
}
