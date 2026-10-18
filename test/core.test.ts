/**
 * The core entry point, as a Node program uses it: a connection and its
 * credential, no storage, no chrome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, listModels, protocolOf, type Connection } from '../src/core/index.js';
import { openaiSse, streamOf } from './helpers.js';

const sse = (text: string) => new Response(streamOf(text, 11), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const answer = openaiSse([
  { choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]);
const req = { system: 'Be brief.', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [] };

afterEach(() => vi.unstubAllGlobals());

describe('core chat()', () => {
  it('speaks to an openai-compatible server with the key as a Bearer, taking the model from the connection', async () => {
    const fetch = vi.fn(async () => sse(answer));
    vi.stubGlobal('fetch', fetch);
    const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
    expect(await chat(conn, 'gsk_123', req)).toMatchObject({ ok: true, text: 'Hello.', stopReason: 'end' });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer gsk_123');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'llama', stream: true });
  });

  it('takes a signer as the credential, and lets it edit the URL', async () => {
    const fetch = vi.fn(async () => sse(answer));
    vi.stubGlobal('fetch', fetch);
    const signer = async (method: string, url: URL) => { url.searchParams.set('ts', '1'); return { Authorization: `Signed ${method}` }; };
    await chat({ kind: 'openai-compatible', auth: 'device-key', baseUrl: 'https://ollama.com/v1' }, signer, { ...req, model: 'glm' });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://ollama.com/v1/chat/completions?ts=1');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Signed POST');
  });

  it('never throws: no model, the on-device model, and a dropped connection are results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1' }, 'k', req, { settingsHint: 'Pick one.' }))
      .toEqual({ ok: false, error: 'The AI connection has no model selected. Pick one.' });
    expect(await chat({ kind: 'chrome-builtin', baseUrl: '' }, '', req)).toEqual({ ok: false, error: 'The on-device model has no tool calling.' });
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' }, 'k', req))
      .toEqual({ ok: false, error: 'The connection to x.example dropped (network error).', retryable: true });
  });

  it('reports each request to the debug callback with image bytes redacted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(answer)));
    const debug = vi.fn();
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'A'.repeat(300) };
    await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm', label: 'X' }, 'k',
      { ...req, messages: [{ role: 'user', content: [image] }] }, { debug });
    expect(debug).toHaveBeenCalledWith('chat request', expect.objectContaining({ connection: 'X', url: 'https://x.example/v1/chat/completions' }));
    expect(JSON.stringify(debug.mock.calls[0]![1])).not.toContain('A'.repeat(300));
    expect(debug).toHaveBeenCalledWith('chat result', expect.objectContaining({ ok: true }));
  });
});

describe('core listModels()', () => {
  it('reads /models, as an object or a bare array, sorted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'b' }, { id: 'a' }]))));
    expect(await listModels({ kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' }, 'k')).toEqual([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]);
  });

  it('throws in words when the server refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));
    await expect(listModels({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1' }, 'k')).rejects.toThrow('HTTP 401: bad key');
  });
});

it('names the protocol a connection speaks', () => {
  expect(protocolOf({ kind: 'anthropic' })).toBe('anthropic');
  expect(protocolOf({ kind: 'chatgpt' })).toBe('responses');
  expect(protocolOf({ kind: 'openai-compatible' })).toBe('chat-completions');
  expect(protocolOf({ kind: 'openai-compatible', protocol: 'gemini' })).toBe('gemini');
});
