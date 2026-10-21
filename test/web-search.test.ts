/**
 * The provider's web search (#37): the server tool in the request as each
 * provider takes it, the queries and sources a turn used, the searches
 * counted, a paused Anthropic turn sent back as it came, and the function
 * tools kept apart.
 */
import { describe, expect, it, vi } from 'vitest';
import { anthropicBody, anthropicMessages, anthropicResult } from '../src/core/chat-anthropic.js';
import { codexBody, codexResult } from '../src/core/chat-codex.js';
import { geminiBody, geminiResult } from '../src/core/chat-gemini.js';
import { openaiBody } from '../src/core/chat-openai.js';
import { readSse } from '../src/core/sse.js';
import type { AIChatRequest, AIMessage } from '../src/types.js';
import type { ChatEvent } from '../src/core/events.js';
import { anthropicSse, openaiSse, streamOf } from './helpers.js';

const TOOL = { name: 'browser', description: 'Control a page.', inputSchema: { type: 'object' } };
const SEARCH = { type: 'web_search' as const, maxUses: 3, allowedDomains: ['example.com'], userLocation: { city: 'Paris', country: 'FR' } };
const req: AIChatRequest = { system: '', messages: [{ role: 'user', content: 'What happened today?' }], tools: [TOOL, SEARCH] };
const sse = (text: string) => readSse(streamOf(text, 9));

describe('the tool in the request', () => {
  it('Anthropic: the web_search server tool after the function tools, with its limit, domains and location', () => {
    const tools = anthropicBody(req, 'claude-opus-5-5', [])['tools'] as Array<Record<string, unknown>>;
    expect(tools).toEqual([
      { name: 'browser', description: 'Control a page.', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3, allowed_domains: ['example.com'], user_location: { type: 'approximate', city: 'Paris', country: 'FR' }, cache_control: { type: 'ephemeral' } },
    ]);
    const blocked = anthropicBody({ ...req, tools: [{ type: 'web_search', blockedDomains: ['spam.example'] }] }, 'm', [])['tools'] as Array<Record<string, unknown>>;
    expect(blocked).toEqual([{ type: 'web_search_20250305', name: 'web_search', blocked_domains: ['spam.example'], cache_control: { type: 'ephemeral' } }]);
    expect(anthropicBody({ ...req, tools: [TOOL] }, 'm', [])['tools']).toHaveLength(1);
  });

  it('Responses: the web_search tool with its filters and location; Gemini: Google Search grounding; Chat Completions: a refusal before any request', () => {
    const tools = codexBody(req, 'gpt-5.5')['tools'] as Array<Record<string, unknown>>;
    expect(tools).toEqual([
      { type: 'function', name: 'browser', description: 'Control a page.', parameters: { type: 'object' }, strict: false },
      { type: 'web_search', filters: { allowed_domains: ['example.com'] }, user_location: { type: 'approximate', city: 'Paris', country: 'FR' } },
    ]);
    const gemini = geminiBody(req, 'gemini-3-pro');
    expect(gemini['tools']).toEqual([{ functionDeclarations: [{ name: 'browser', description: 'Control a page.', parametersJsonSchema: { type: 'object' } }] }, { googleSearch: {} }]);
    expect(geminiBody({ ...req, tools: [SEARCH] }, 'gemini-3-pro')).toMatchObject({ tools: [{ googleSearch: {} }] });
    expect(geminiBody({ ...req, tools: [SEARCH] }, 'gemini-3-pro')).not.toHaveProperty('toolConfig');
    expect(() => openaiBody(req, 'gpt-5', 'https://api.openai.com/v1')).toThrow(/no web search tool/);
    expect(openaiBody({ ...req, tools: [TOOL] }, 'gpt-5', 'https://api.openai.com/v1')['tools']).toEqual([{ type: 'function', function: { name: 'browser', description: 'Control a page.', parameters: { type: 'object' } } }]);
  });
});

describe('what a turn searched', () => {
  it('Anthropic: the queries and sources from the blocks, the count from usage, the search announced, the blocks replayed whole', async () => {
    const seen: ChatEvent[] = [];
    const result = await anthropicResult(sse(anthropicSse([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"news ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'today"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [
        { type: 'web_search_result', url: 'https://example.com/a', title: 'A', encrypted_content: 'enc', page_age: 'today' },
        { type: 'web_search_result', url: 'https://example.com/b', title: 'B', encrypted_content: 'enc2' },
      ] } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Two things.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20, server_tool_use: { web_search_requests: 1 } } },
      { type: 'message_stop' },
    ])), (e) => seen.push(e));
    expect(result).toMatchObject({
      ok: true, text: 'Two things.', stopReason: 'end',
      webSearch: {
        queries: ['news today'], sources: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b', title: 'B' }],
        searches: [{ query: 'news today', sources: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b', title: 'B' }], resultCount: 2 }],
      },
      usage: { webSearchRequests: 1 },
    });
    expect(result.webSearch!.searches![0]).not.toHaveProperty('error');
    expect(result.toolCalls).toBeUndefined();
    expect(seen).toEqual([{ type: 'search', query: 'news today' }, { type: 'text', delta: 'Two things.' }]);
    // The server tool's call and result go back as they came, encrypted content included.
    const state = result.providerState as { blocks: Array<Record<string, unknown>> };
    expect(state.blocks[0]).toEqual({ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'news today' } });
    expect(state.blocks[1]).toMatchObject({ type: 'web_search_tool_result', content: [expect.objectContaining({ encrypted_content: 'enc' }), expect.anything()] });
  });

  it('Anthropic: a paused turn stops as `pause`, keeps every block, and is replayed as it came', async () => {
    const result = await anthropicResult(sse(anthropicSse([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])));
    expect(result).toMatchObject({ ok: true, stopReason: 'pause', webSearch: { queries: ['q'], sources: [], searches: [{ query: 'q', sources: [], error: 'max_uses_exceeded' }] } });
    expect(result).not.toHaveProperty('truncatedToolCall');
    const history: AIMessage[] = [{ role: 'user', content: 'go' }, { role: 'assistant', providerState: result.providerState }];
    const replayed = anthropicMessages(history);
    expect(replayed[1]).toEqual({ role: 'assistant', content: (result.providerState as { blocks: unknown[] }).blocks });
    expect(JSON.stringify(anthropicBody({ ...req, messages: history, cacheConversation: true }, 'm', [])['messages'])).not.toContain('cache_control');
  });

  it('Responses: one call with several queries counts once, the newer `queries` over the older `query`, and a truncated turn keeps what it searched', async () => {
    const seen: ChatEvent[] = [];
    const result = await codexResult(sse(openaiSse([
      { type: 'response.output_item.done', item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'a', queries: ['a', 'b'] } } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Half' },
      { type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 5, output_tokens: 9 } } },
    ], false)), undefined, (e) => seen.push(e));
    expect(result).toMatchObject({ stopReason: 'length', webSearch: { queries: ['a', 'b'], sources: [] }, usage: { webSearchRequests: 1 } });
    expect(seen.filter((e) => e.type === 'search')).toEqual([{ type: 'search', query: 'a' }, { type: 'search', query: 'b' }]);
  });

  it('Responses: the web_search_call queries, the citations as sources, the calls counted', async () => {
    const seen: ChatEvent[] = [];
    const result = await codexResult(sse(openaiSse([
      { type: 'response.output_item.done', item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'news today' } } },
      { type: 'response.output_item.done', item: { id: 'ws_2', type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.com/a' } } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Two things.' },
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two things.', annotations: [
        { type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: 0, end_index: 3 },
        { type: 'url_citation', url: 'https://example.com/a', title: 'A', start_index: 4, end_index: 9 },
        { type: 'file_citation', file_id: 'f' },
      ] }] } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 9 } } },
    ], false)), undefined, (e) => seen.push(e));
    expect(result).toMatchObject({ text: 'Two things.', webSearch: { queries: ['news today'], sources: [{ url: 'https://example.com/a', title: 'A' }], searches: [{ query: 'news today', sources: [] }] }, usage: { webSearchRequests: 2 } });
    expect(seen).toEqual([{ type: 'search', query: 'news today' }, { type: 'text', delta: 'Two things.' }]);
    expect((result.providerState as { items: Array<{ type: string }> }).items.map((i) => i.type)).toEqual(['web_search_call', 'web_search_call', 'message']);
  });

  it('Gemini: billed per query from Gemini 3, once per prompt before, not at all when the model is unknown', async () => {
    const grounded = (modelVersion?: string) => sse(openaiSse([{ ...(modelVersion ? { modelVersion } : {}), candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['a', 'b'] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }], false));
    expect((await geminiResult(grounded('gemini-3-pro-001'))).usage).toMatchObject({ webSearchRequests: 2 });
    expect((await geminiResult(grounded('gemini-2.5-flash'))).usage).toMatchObject({ webSearchRequests: 1 });
    expect((await geminiResult(grounded())).usage).not.toHaveProperty('webSearchRequests');
  });

  it('Gemini: the grounding queries and web chunks, in whichever chunk they arrive', async () => {
    const seen: ChatEvent[] = [];
    const result = await geminiResult(sse(openaiSse([
      { modelVersion: 'gemini-3-pro', candidates: [{ content: { role: 'model', parts: [{ text: 'Two ' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'things.' }] }, finishReason: 'STOP', groundingMetadata: {
        webSearchQueries: ['news today', 'news today'],
        groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }, { web: { uri: 'https://example.com/a', title: 'A' } }, { retrievedContext: { uri: 'x' } }],
      } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
    ], false)), (e) => seen.push(e));
    expect(result).toMatchObject({ text: 'Two things.', webSearch: { queries: ['news today'], sources: [{ url: 'https://example.com/a', title: 'A' }], searches: [{ query: 'news today', sources: [] }] }, usage: { webSearchRequests: 1 } });
    // The grounding is read before the chunk's parts, so the search is announced before the text it arrived with.
    expect(seen).toEqual([{ type: 'text', delta: 'Two ' }, { type: 'search', query: 'news today' }, { type: 'text', delta: 'things.' }]);
  });

  it('on a server that speaks Chat Completions only, the turn fails before any request; on OpenAI it moves to the Responses API', async () => {
    const { chat } = await import('../src/core/index.js');
    const fetch = vi.fn(async () => new Response('{"error":{"message":"no"}}', { status: 500 }));
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' }, 'k', { ...req, tools: [SEARCH] }, { fetch }))
      .toMatchObject({ ok: false, error: expect.stringContaining('no web search tool'), failure: { kind: 'request' } });
    expect(fetch).not.toHaveBeenCalled();
    await chat({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' }, 'k', { ...req, tools: [SEARCH] }, { fetch });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.openai.com/v1/responses');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a turn that searched nothing carries no webSearch', async () => {
    const result = await geminiResult(sse(openaiSse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hi.' }] }, finishReason: 'STOP' }] }], false)));
    expect(result).not.toHaveProperty('webSearch');
  });
});
