/**
 * Usage that means the same thing everywhere (#38): `inputTokens` is the
 * whole prompt on every provider, the cached part beside it; the conversation
 * breakpoint and the cache key, where each provider takes them; and the model
 * that actually answered.
 */
import { describe, expect, it, vi } from 'vitest';
import { anthropicBody, anthropicResult } from '../src/core/chat-anthropic.js';
import { chat } from '../src/core/chat.js';
import { codexBody, codexResult } from '../src/core/chat-codex.js';
import { geminiResult } from '../src/core/chat-gemini.js';
import { openaiBody, openaiResult, rejectedField } from '../src/core/chat-openai.js';
import { readSse } from '../src/core/sse.js';
import type { AIChatRequest } from '../src/types.js';
import { anthropicSse, openaiSse, streamOf } from './helpers.js';

type Block = Record<string, unknown>;
const req: AIChatRequest = { system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], tools: [] };
const sse = (text: string) => readSse(streamOf(text, 9));

describe('inputTokens is the whole prompt, the cached part beside it', () => {
  it('Anthropic: input_tokens plus what was read from and written to the cache', async () => {
    const result = await anthropicResult(sse(anthropicSse([
      { type: 'message_start', message: { id: 'm', model: 'claude-sonnet-5-5-20260301', usage: { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ])));
    expect(result).toMatchObject({ ok: true, model: 'claude-sonnet-5-5-20260301', usage: { inputTokens: 150, outputTokens: 3, cacheReadTokens: 100, cacheWriteTokens: 30 } });
  });

  it('Anthropic: the counts grow after message_start (a server tool, a pause), and the latest wins', async () => {
    const result = await anthropicResult(sse(anthropicSse([
      { type: 'message_start', message: { id: 'm', usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 6000, cache_read_input_tokens: 100, output_tokens: 900, server_tool_use: { web_search_requests: 2 } } },
      { type: 'message_stop' },
    ])));
    expect(result.usage).toEqual({ inputTokens: 6100, outputTokens: 900, cacheReadTokens: 100, cacheWriteTokens: 0, webSearchRequests: 2 });
  });

  it('Chat Completions: prompt_tokens as is, the cached part from its details, the model from the chunks', async () => {
    const result = await openaiResult(sse(openaiSse([
      { model: 'gpt-5.5-2026-02-01', choices: [{ index: 0, delta: { content: 'Hi.' }, finish_reason: null }] },
      { model: 'gpt-5.5-2026-02-01', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { model: 'gpt-5.5-2026-02-01', choices: [], usage: { prompt_tokens: 150, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 100 } } },
    ])));
    expect(result).toMatchObject({ ok: true, model: 'gpt-5.5-2026-02-01', usage: { inputTokens: 150, outputTokens: 3, cacheReadTokens: 100 } });
    // Without details, no cached count is claimed.
    const bare = await openaiResult(sse(openaiSse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }])));
    expect(bare.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
    expect(bare.model).toBeUndefined();
  });

  it('Responses: input_tokens as is, the cached part from its details, the model from the completed response', async () => {
    const result = await codexResult(sse(openaiSse([
      { type: 'response.output_text.delta', item_id: 'i', delta: 'Hi.' },
      { type: 'response.completed', response: { status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 150, output_tokens: 3, input_tokens_details: { cached_tokens: 100 } } } },
    ], false)));
    expect(result).toMatchObject({ ok: true, model: 'gpt-5.5', usage: { inputTokens: 150, outputTokens: 3, cacheReadTokens: 100 } });
  });

  it('Gemini: promptTokenCount as is (it includes the cached part), the model from modelVersion', async () => {
    const result = await geminiResult(sse(openaiSse([
      { modelVersion: 'gemini-3-pro-001', candidates: [{ content: { role: 'model', parts: [{ text: 'Hi.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 3, cachedContentTokenCount: 100 } },
    ], false)));
    expect(result).toMatchObject({ ok: true, model: 'gemini-3-pro-001', usage: { inputTokens: 150, outputTokens: 3, cacheReadTokens: 100 } });
  });
});

describe('the conversation breakpoint', () => {
  const history: AIChatRequest = { ...req, messages: [
    { role: 'user', content: 'Open it' },
    { role: 'assistant', content: 'Opening.', toolCalls: [{ id: 't1', name: 'browser', args: {} }] },
    { role: 'tool', toolCallId: 't1', name: 'browser', content: 'ok' },
  ] };

  it('Anthropic gets cache_control on the last message\'s last block, only when asked', () => {
    const marked = anthropicBody({ ...history, cacheConversation: true }, 'm', []);
    const messages = marked['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', cache_control: { type: 'ephemeral' } });
    expect(messages[1]!.content.some((b) => b['cache_control'])).toBe(false);
    const plain = anthropicBody(history, 'm', []);
    expect(JSON.stringify(plain['messages'])).not.toContain('cache_control');
    // A string message becomes a block to carry it; an empty one is left alone.
    const text = anthropicBody({ ...req, cacheConversation: true }, 'm', []);
    expect((text['messages'] as Array<{ content: unknown }>)[0]!.content).toEqual([{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }]);
    const empty = anthropicBody({ ...req, messages: [{ role: 'user', content: '' }], cacheConversation: true }, 'm', []);
    expect((empty['messages'] as Array<{ content: unknown }>)[0]!.content).toBe('');
  });

  it('waits for a user turn: a paused or trailing assistant turn goes back as it came, thinking blocks and all', () => {
    const state = [{ type: 'text', text: 'Thought it over.' }, { type: 'thinking', thinking: '…', signature: 'sig' }];
    const trailing = anthropicBody({ ...req, messages: [{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Thought it over.', providerState: state }], cacheConversation: true }, 'm', []);
    expect(JSON.stringify(trailing['messages'])).not.toContain('cache_control');
    expect(state[0]).not.toHaveProperty('cache_control');
    const followed = anthropicBody({ ...req, messages: [{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Thought it over.', providerState: state }, { role: 'user', content: 'And?' }], cacheConversation: true }, 'm', []);
    const messages = followed['messages'] as Array<{ content: Block[] }>;
    expect(messages[2]!.content).toEqual([{ type: 'text', text: 'And?', cache_control: { type: 'ephemeral' } }]);
    expect(JSON.stringify(messages[1])).not.toContain('cache_control');
  });
});

describe('the cache key', () => {
  it('goes to OpenAI as prompt_cache_key on Chat Completions and Responses, and nowhere else', () => {
    expect(openaiBody({ ...req, cacheKey: 'user-7' }, 'gpt-5', 'https://api.openai.com/v1')).toMatchObject({ prompt_cache_key: 'user-7' });
    expect(openaiBody({ ...req, cacheKey: 'user-7' }, 'llama', 'https://api.groq.com/openai/v1')).not.toHaveProperty('prompt_cache_key');
    expect(openaiBody({ ...req, cacheKey: 'user-7' }, 'gpt-5', 'https://api.openai.com/v1', new Set(['prompt_cache_key']))).not.toHaveProperty('prompt_cache_key');
    expect(openaiBody(req, 'gpt-5', 'https://api.openai.com/v1')).not.toHaveProperty('prompt_cache_key');
    expect(codexBody({ ...req, cacheKey: 'user-7' }, 'gpt-5', { maxOutputTokens: true, cacheKey: true })).toMatchObject({ prompt_cache_key: 'user-7' });
    // The Codex backend takes no such field, nor is another Responses server sent one.
    expect(codexBody({ ...req, cacheKey: 'user-7' }, 'gpt-5.5')).not.toHaveProperty('prompt_cache_key');
    expect(codexBody({ ...req, cacheKey: 'user-7' }, 'gpt-5', { maxOutputTokens: true })).not.toHaveProperty('prompt_cache_key');
    expect(JSON.stringify(anthropicBody({ ...req, cacheKey: 'user-7' }, 'm', []))).not.toContain('user-7');
  });

  it('is left out of the retry when a server rejects it', () => {
    expect(rejectedField(400, '{"error":{"message":"Unrecognized request argument supplied: prompt_cache_key"}}')).toBe('prompt_cache_key');
  });

  it('on the Responses API goes to OpenAI itself, not to another server speaking it', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response('{"error":{"message":"no"}}', { status: 500 }); });
    await chat({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', protocol: 'responses', model: 'gpt-5' }, 'k', { ...req, cacheKey: 'user-7' }, { fetch });
    await chat({ kind: 'openai-compatible', baseUrl: 'https://gateway.example/v1', protocol: 'responses', model: 'gpt-5' }, 'k', { ...req, cacheKey: 'user-7' }, { fetch });
    expect(sent[0]).toMatchObject({ prompt_cache_key: 'user-7' });
    expect(sent[1]).not.toHaveProperty('prompt_cache_key');
  });
});
