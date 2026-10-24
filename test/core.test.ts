/**
 * The core entry point, as a Node program uses it: a connection and its
 * credential, no storage, no chrome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, HttpError, listModels, protocolOf, workersAiAccount, type Connection } from '../src/core/index.js';
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
      .toMatchObject({ ok: false, error: 'The AI connection has no model selected. Pick one.' });
    expect(await chat({ kind: 'chrome-builtin', baseUrl: '' }, '', req)).toMatchObject({ ok: false, error: 'The on-device model has no tool calling.' });
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' }, 'k', req))
      .toMatchObject({ ok: false, error: 'The connection to x.example dropped (network error).', retryable: true });
  });

  describe('says when to come back after a rate limit', () => {
    const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' };
    const refused = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));

    it('a short wait is worth another try, and the wait comes with the result', async () => {
      vi.stubGlobal('fetch', refused(429, { error: { message: 'Rate limit reached on requests per min (RPM). Please try again in 20s.' } }, { 'retry-after': '20' }));
      expect(await chat(conn, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 429: Rate limit reached on requests per min (RPM). Please try again in 20s.', retryable: true, retryAfterMs: 20_000, resetAt: expect.any(Number), quota: 'minute' });
    });

    it('a day window is not: the key is out until tomorrow, whatever the wait says', async () => {
      vi.stubGlobal('fetch', refused(429, { error: { message: 'Rate limit reached on requests per day (RPD). Please try again in 2s.' } }));
      expect(await chat(conn, 'k', req)).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 429'), retryAfterMs: 2000, quota: 'day' });
    });

    it('a long or unknown wait is the caller\'s call: not retryable, the wait given when known', async () => {
      vi.stubGlobal('fetch', refused(429, { error: { message: 'slow down' } }, { 'retry-after': '120' }));
      expect(await chat(conn, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 429: slow down', retryAfterMs: 120_000, resetAt: expect.any(Number) });
      vi.stubGlobal('fetch', refused(429, { error: { message: 'slow down' } }));
      expect(await chat(conn, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 429: slow down' });
    });

    it('a 5xx stays retryable, and carries Retry-After when the server sent one', async () => {
      vi.stubGlobal('fetch', refused(503, { error: { message: 'overloaded' } }, { 'retry-after': '3' }));
      expect(await chat(conn, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 503: overloaded', retryable: true, retryAfterMs: 3000, resetAt: expect.any(Number) });
      vi.stubGlobal('fetch', refused(502, { error: { message: 'bad gateway' } }));
      expect(await chat(conn, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 502: bad gateway', retryable: true });
    });

    it('reads the Gemini API\'s details, the Messages API\'s headers and ChatGPT\'s resets_in_seconds', async () => {
      const gemini = {
        error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
        ] },
      };
      vi.stubGlobal('fetch', refused(429, gemini));
      expect(await chat({ kind: 'openai-compatible', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' }, 'k', req))
        .toMatchObject({ ok: false, error: 'HTTP 429: You exceeded your current quota.', retryAfterMs: 37_000, quota: 'day' });

      vi.stubGlobal('fetch', refused(429, { type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed the rate limit for your organization of 50,000 input tokens per minute.' } },
        { 'anthropic-ratelimit-input-tokens-remaining': '0', 'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 15_000).toISOString() }));
      const anthropic = await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5' }, 'sk', req);
      expect(anthropic).toMatchObject({ ok: false, retryable: true, quota: 'minute' });
      expect(anthropic.retryAfterMs).toBeGreaterThan(10_000);
      expect(anthropic.retryAfterMs).toBeLessThanOrEqual(15_000);

      vi.stubGlobal('fetch', refused(429, { error: { type: 'usage_limit_reached', message: 'You have hit your usage limit.', resets_in_seconds: 5400 } }));
      expect(await chat({ kind: 'chatgpt', baseUrl: '', model: 'gpt-5-codex' }, 'tok', req))
        .toMatchObject({ ok: false, error: 'Your ChatGPT plan’s limit is reached. Wait for it to reset.', retryAfterMs: 5_400_000, resetAt: expect.any(Number), quota: 'plan' });
      // The same limit reported inside the stream, before any output: the same fields, and retryable when it lifts within the minute.
      vi.stubGlobal('fetch', vi.fn(async () => sse('data: {"type":"error","error":{"type":"usage_limit_reached","resets_in_seconds":5400}}\n\n')));
      const inStream = await chat({ kind: 'chatgpt', baseUrl: '', model: 'gpt-5-codex' }, 'tok', req);
      expect(inStream).toMatchObject({ ok: false, failure: { kind: 'stream', providerCode: 'usage_limit_reached', streamed: false }, retryAfterMs: 5_400_000, quota: 'plan' });
      expect(inStream).not.toHaveProperty('retryable');
      vi.stubGlobal('fetch', vi.fn(async () => sse('data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached. Please try again in 20s."}}}\n\n')));
      expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', protocol: 'responses' }, 'k', req))
        .toMatchObject({ ok: false, retryable: true, retryAfterMs: 20_000, failure: { kind: 'stream', providerCode: 'rate_limit_exceeded' } });
    });
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

  it('lists Gemini models with the key in its header, or with a signer\'s headers; Anthropic and ChatGPT take no signer', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'models/g', supportedGenerationMethods: ['generateContent'] }] })));
    vi.stubGlobal('fetch', fetched);
    const gemini: Connection = { kind: 'openai-compatible', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
    expect(await listModels(gemini, 'g-key')).toMatchObject([{ id: 'g', name: 'g' }]);
    expect((fetched.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toEqual({ 'x-goog-api-key': 'g-key' });
    await listModels(gemini, async () => ({ Authorization: 'Signed' }));
    expect((fetched.mock.calls[1] as unknown as [URL, RequestInit])[1].headers).toEqual({ Authorization: 'Signed' });
    await expect(listModels(gemini, '')).rejects.toThrow('Enter an API key first.');
    const signer = async () => ({});
    await expect(listModels({ kind: 'anthropic', baseUrl: '' }, signer)).rejects.toThrow(/not a request signer/);
    await expect(chat({ kind: 'anthropic', baseUrl: '', model: 'c' }, signer, req)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not a request signer/) });
    await expect(chat({ kind: 'chatgpt', baseUrl: '', model: 'c' }, signer, req)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not a request signer/) });
  });

  it('throws in words when the server refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));
    await expect(listModels({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1' }, 'k')).rejects.toThrow('HTTP 401: bad key');
  });

  it('the Codex catalog too: an HttpError with its own words and the wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '10' } })));
    const error = await listModels({ kind: 'chatgpt', baseUrl: '' }, 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, message: 'Codex model catalog failed (HTTP 429)', retryAfterMs: 10_000 });
  });

  it('a malformed rate-limit answer is still the HTTP failure, not a crash', async () => {
    const body = JSON.stringify({ error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [null] }] } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 429 })));
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' }, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 429: quota' });
    await expect(listModels({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1' }, 'k')).rejects.toBeInstanceOf(HttpError);
  });

  it('a 4xx that says overloaded stays worth another try', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"upstream overloaded"}}', { status: 429 })));
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' }, 'k', req)).toMatchObject({ ok: false, error: 'HTTP 429: upstream overloaded', retryable: true });
  });

  it('throws an HttpError that says when to come back after a rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached on requests per min (RPM).' } }), { status: 429, headers: { 'retry-after': '9' } })));
    const error = await listModels({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1' }, 'k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, message: 'HTTP 429: Rate limit reached on requests per min (RPM).', retryAfterMs: 9000, quota: 'minute' });
  });
});

it('names the protocol a connection speaks', () => {
  expect(protocolOf({ kind: 'anthropic' })).toBe('anthropic');
  expect(protocolOf({ kind: 'chatgpt' })).toBe('responses');
  expect(protocolOf({ kind: 'openai-compatible' })).toBe('chat-completions');
  expect(protocolOf({ kind: 'openai-compatible', protocol: 'gemini' })).toBe('gemini');
});

describe('workersAiAccount', () => {
  it('names the account in a Workers AI root, so a host can tell which listing a URL gets', () => {
    expect(workersAiAccount('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1')).toBe('abc');
    expect(workersAiAccount('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/')).toBeUndefined();
    expect(workersAiAccount('https://gateway.ai.cloudflare.com/v1/abc/gw/compat')).toBeUndefined();
    expect(workersAiAccount('nope')).toBeUndefined();
  });
});
