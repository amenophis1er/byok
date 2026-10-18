/**
 * The events a turn reports while it streams, the same shape from all four
 * protocols, and the result unchanged by observing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicResult } from '../src/core/chat-anthropic.js';
import { openaiResult } from '../src/core/chat-openai.js';
import { codexResult } from '../src/core/chat-codex.js';
import { geminiResult } from '../src/core/chat-gemini.js';
import { chat } from '../src/core/index.js';
import type { ChatEvent } from '../src/core/events.js';
import { readSse } from '../src/core/sse.js';
import { anthropicSse, openaiSse, streamOf } from './helpers.js';

const collect = () => { const events: ChatEvent[] = []; return { events, sink: (e: ChatEvent) => { events.push(e); } }; };
const sse = (text: string, size = 9) => readSse(streamOf(text, size));

/** The same parser twice: once observed, once not. The results must match. */
async function both<T>(parse: (sink?: (e: ChatEvent) => void) => Promise<T>) {
  const { events, sink } = collect();
  const observed = await parse(sink);
  expect(observed).toEqual(await parse());
  return { result: observed, events };
}

describe('events', () => {
  it('Messages API: text deltas, then the call announced, filled in and ended', async () => {
    const text = anthropicSse([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'look.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'browser', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"action":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"observe"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]);
    const { result, events } = await both((sink) => anthropicResult(sse(text), sink));
    expect(result).toMatchObject({ ok: true, text: 'Let me look.', toolCalls: [{ id: 'toolu_1', args: { action: 'observe' } }] });
    expect(events).toEqual([
      { type: 'text', delta: 'Let me ' }, { type: 'text', delta: 'look.' },
      { type: 'tool_call_start', id: 'toolu_1', name: 'browser' },
      { type: 'tool_call_delta', id: 'toolu_1', argsDelta: '{"action":' }, { type: 'tool_call_delta', id: 'toolu_1', argsDelta: '"observe"}' },
      { type: 'tool_call_end', id: 'toolu_1' },
    ]);
  });

  it('Chat Completions: a call is announced when its arguments start, under the id the result will use', async () => {
    const text = openaiSse([
      { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'browser', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { name: 'other', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const { result, events } = await both((sink) => openaiResult(sse(text), sink));
    expect(result).toMatchObject({ ok: true, toolCalls: [{ id: 'c1', args: { a: 1 } }, { id: 'call_1', name: 'other', args: {} }] });
    expect(events).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'tool_call_start', id: 'c1', name: 'browser' },
      { type: 'tool_call_delta', id: 'c1', argsDelta: '{"a":' }, { type: 'tool_call_delta', id: 'c1', argsDelta: '1}' },
      { type: 'tool_call_start', id: 'call_1', name: 'other' }, { type: 'tool_call_delta', id: 'call_1', argsDelta: '{}' },
      { type: 'tool_call_end', id: 'c1' }, { type: 'tool_call_end', id: 'call_1' },
    ]);
  });

  it('Responses API: the call from its item events, whole arguments on done when no delta came', async () => {
    const text = [
      { type: 'response.output_item.added', item: { type: 'message', id: 'm1' } },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Sure.' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'call_a', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"x":1}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_a', name: 'browser', arguments: '{"x":1}' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc2', call_id: 'call_b', name: 'other', arguments: '{"y":2}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const { result, events } = await both((sink) => codexResult(sse(text), undefined, sink));
    expect(result).toMatchObject({ ok: true, text: 'Sure.', toolCalls: [{ id: 'call_a', args: { x: 1 } }, { id: 'call_b', args: { y: 2 } }] });
    expect(events).toEqual([
      { type: 'text', delta: 'Sure.' },
      { type: 'tool_call_start', id: 'call_a', name: 'browser' }, { type: 'tool_call_delta', id: 'call_a', argsDelta: '{"x":1}' }, { type: 'tool_call_end', id: 'call_a' },
      { type: 'tool_call_start', id: 'call_b', name: 'other' }, { type: 'tool_call_delta', id: 'call_b', argsDelta: '{"y":2}' }, { type: 'tool_call_end', id: 'call_b' },
    ]);
  });

  it('Gemini API: text as it arrives, thoughts left out, each call whole under the result\'s numbering', async () => {
    const chunk = (parts: unknown[], finishReason?: string) => ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });
    const text = openaiSse([
      chunk([{ text: 'Thinking…', thought: true }, { text: 'Let me ' }]),
      chunk([{ text: 'look.' }]),
      chunk([{ functionCall: { name: 'browser', args: { action: 'observe' } } }, { functionCall: { id: 'fc-9', name: 'other', args: {} } }], 'STOP'),
    ], false);
    const { result, events } = await both((sink) => geminiResult(sse(text), sink));
    expect(result).toMatchObject({ ok: true, text: 'Let me look.', toolCalls: [{ id: 'call_0' }, { id: 'fc-9' }] });
    expect(events).toEqual([
      { type: 'text', delta: 'Let me ' }, { type: 'text', delta: 'look.' },
      { type: 'tool_call_start', id: 'call_0', name: 'browser' }, { type: 'tool_call_delta', id: 'call_0', argsDelta: '{"action":"observe"}' }, { type: 'tool_call_end', id: 'call_0' },
      { type: 'tool_call_start', id: 'fc-9', name: 'other' }, { type: 'tool_call_delta', id: 'fc-9', argsDelta: '{}' }, { type: 'tool_call_end', id: 'fc-9' },
    ]);
  });
});

describe('chat() with onEvent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the usage once the turn is done, and nothing from a protocol that was abandoned', async () => {
    const mismatch = () => new Response('{"error":{"message":"Model does not support this protocol."}}', { status: 400 });
    const answer = () => new Response(streamOf(openaiSse([
      { choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]), 7), { status: 200 });
    // OpenCode: a GPT-named model is tried on Responses first, which refuses; then on Chat Completions.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mismatch()).mockResolvedValueOnce(answer()));
    const { events, sink } = collect();
    const result = await chat({ kind: 'openai-compatible', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1', model: 'gpt-x' }, 'tok',
      { system: '', messages: [{ role: 'user', content: 'hi' }] }, { onEvent: sink });
    expect(result).toMatchObject({ ok: true, text: 'Hello.' });
    expect(events).toEqual([{ type: 'text', delta: 'Hello.' }, { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }]);
  });
});
