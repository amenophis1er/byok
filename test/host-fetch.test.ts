/**
 * The host's own `fetch` (#31): every request the core makes goes through
 * `options.fetch` when given, and the global one is never touched. Each
 * test stubs the global to fail loudly, so a request that slipped past the
 * option shows as a thrown test, not a passing one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chat, getModelInfo, listModels, type Connection, type Fetch } from '../src/core/index.js';
import {
  disconnect,
  exchangeCode,
  exchangeDeviceCode,
  opencodeAccount,
  pollDevice,
  pollOpencode,
  refreshOpenAiTokens,
  refreshOpencodeTokens,
  refreshTokens,
  startDeviceLogin,
  startOpencodeLogin,
  whoami,
} from '../src/core/auth.js';
import { openaiSse, streamOf } from './helpers.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (text: string) => new Response(streamOf(text, 11), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const answer = openaiSse([
  { choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]);
const req = { system: '', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [] };

/** A fetch of the host's own, answering the given responses in order. */
function own(...responses: Response[]) {
  const fetch = vi.fn<Fetch>();
  for (const res of responses) fetch.mockResolvedValueOnce(res);
  return fetch;
}
const urlOf = (fetch: ReturnType<typeof own>, call = 0): string => String(fetch.mock.calls[call]![0]);

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the global fetch was called'); })));
afterEach(() => vi.unstubAllGlobals());

describe('chat() with the host fetch', () => {
  it('sends the turn through it, with the signal and the stream contract unchanged', async () => {
    const fetch = own(sse(answer));
    const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' };
    expect(await chat(conn, 'k', req, { fetch })).toMatchObject({ ok: true, text: 'Hello.' });
    expect(urlOf(fetch)).toBe('https://api.groq.com/openai/v1/chat/completions');
    const init = fetch.mock.calls[0]![1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe('POST');
  });

  it('uses it for every candidate of a protocol fall-through, and for Anthropic and ChatGPT', async () => {
    const mismatch = () => json({ error: { message: 'Model does not support this protocol' } }, 400);
    const anthropic = own(mismatch(), mismatch(), json({ error: { message: 'nope' } }, 500));
    await chat({ kind: 'openai-compatible', baseUrl: 'https://opencode.ai/inference/v1', issuer: 'opencode', model: 'claude-x' }, 'k', req, { fetch: anthropic });
    expect(anthropic).toHaveBeenCalledTimes(3);
    expect(urlOf(anthropic, 0)).toBe('https://opencode.ai/inference/v1/messages');

    const codex = own(json({ error: { message: 'down' } }, 503));
    expect(await chat({ kind: 'chatgpt', baseUrl: '', model: 'gpt-5.5' }, 'tok', req, { fetch: codex })).toMatchObject({ ok: false, retryable: true });
    expect(urlOf(codex)).toBe('https://chatgpt.com/backend-api/codex/responses');
  });

  it('reports a transport that throws as the usual dropped connection, when it throws a TypeError', async () => {
    const fetch = vi.fn<Fetch>(async () => { throw new TypeError('socket hang up'); });
    expect(await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' }, 'sk', req, { fetch }))
      .toEqual({ ok: false, error: 'The connection to Anthropic dropped (network error).', retryable: true });
  });
});

describe('listModels() and getModelInfo() with the host fetch', () => {
  it('an OpenAI-compatible listing', async () => {
    const fetch = own(json({ data: [{ id: 'b' }, { id: 'a' }] }));
    const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' };
    expect((await listModels(conn, 'k', { fetch })).map((m) => m.id)).toEqual(['a', 'b']);
    expect(urlOf(fetch)).toBe('https://api.together.xyz/v1/models');
  });

  it("Anthropic's catalog, Gemini's listing, Workers AI's search and the Codex catalog", async () => {
    const anthropic = own(json({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }));
    expect(await listModels({ kind: 'anthropic', baseUrl: '' }, 'sk', { fetch: anthropic })).toMatchObject([{ id: 'claude-sonnet-5-5', contextWindow: 1_000_000 }]);
    expect(urlOf(anthropic)).toBe('https://api.anthropic.com/v1/models?limit=100');

    const gemini = own(json({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }));
    expect(await listModels({ kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }, 'g', { fetch: gemini })).toMatchObject([{ id: 'gemini-2.5-flash' }]);
    expect(urlOf(gemini)).toContain('https://generativelanguage.googleapis.com/v1beta/models');

    const workers = own(json({ result: [{ name: '@cf/meta/llama-3' }], result_info: { total_count: 1 } }));
    expect(await listModels({ kind: 'openai-compatible', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1' }, 't', { fetch: workers })).toMatchObject([{ id: '@cf/meta/llama-3' }]);
    expect(urlOf(workers)).toContain('/accounts/acct/ai/models/search');

    const codex = own(json({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 1 }] }));
    expect(await listModels({ kind: 'chatgpt', baseUrl: '', accountId: 'acc' }, 'tok', { fetch: codex })).toMatchObject([{ id: 'gpt-5.5', contextWindow: 400_000 }]);
    expect(urlOf(codex)).toContain('https://chatgpt.com/backend-api/codex/models');
  });

  it('getModelInfo() passes it to the listing it falls back on', async () => {
    const fetch = own(json({ data: [{ id: 'mistral-large', context_length: 128_000 }] }));
    const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'mistral-large' };
    expect(await getModelInfo(conn, 'k', undefined, { fetch })).toMatchObject({ id: 'mistral-large', contextWindow: 128_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the sign-in flows with the host fetch', () => {
  it('the Claude subscription exchange and refresh', async () => {
    const pair = { access_token: 'at', refresh_token: 'rt', expires_in: 60 };
    const fetch = own(json(pair), json(pair));
    expect(await exchangeCode({ pasted: 'code#state', expectedState: 'state', verifier: 'v' }, { fetch })).toMatchObject({ accessToken: 'at' });
    expect(await refreshTokens('rt', { fetch })).toMatchObject({ accessToken: 'at' });
    expect(urlOf(fetch, 0)).toBe('https://platform.claude.com/v1/oauth/token');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('the ChatGPT device flow, end to end', async () => {
    const fetch = own(
      json({ device_auth_id: 'd', user_code: 'u', interval: 5 }),
      json({ authorization_code: 'c', code_verifier: 'v' }),
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }),
      json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 60 }),
    );
    expect(await startDeviceLogin({ fetch })).toMatchObject({ deviceAuthId: 'd', userCode: 'u' });
    expect(await pollDevice('d', 'u', { fetch })).toMatchObject({ status: 'authorized' });
    expect(await exchangeDeviceCode({ authorizationCode: 'c', codeVerifier: 'v' }, { fetch })).toMatchObject({ accessToken: 'at' });
    expect(await refreshOpenAiTokens('rt', { fetch })).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2' });
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/oauth/token',
      'https://auth.openai.com/oauth/token',
    ]);
  });

  it('the OpenCode device grant, the refresh and the account lookup', async () => {
    const tokens = { access_token: 'acc', refresh_token: 'ref', expires_in: 100 };
    const fetch = own(
      json({ device_code: 'd', user_code: 'u', verification_uri_complete: '/console/device?user_code=u' }),
      json(tokens),
      json(tokens),
      json({ email: 'who@example.test' }),
    );
    expect(await startOpencodeLogin('valet', { fetch })).toMatchObject({ deviceCode: 'd' });
    const poll = await pollOpencode('d', 'valet', { fetch });
    expect(poll.status).toBe('authorized');
    expect(await refreshOpencodeTokens('ref', 'valet', { fetch })).toMatchObject({ accessToken: 'acc' });
    expect(await opencodeAccount({ accessToken: 'acc', refreshToken: 'ref', expiresAt: 0 }, { fetch })).toBe('who@example.test');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(urlOf(fetch, 3)).toBe('https://opencode.ai/console/api/user');
  });

  it('the Ollama pairing check and un-pairing', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const fetch = own(json({ ID: 'user-1', Name: 'amen' }), new Response('', { status: 200 }));
    expect(await whoami(pair, { fetch })).toEqual({ name: 'amen' });
    await disconnect(pair, { fetch });
    expect(urlOf(fetch, 0)).toMatch(/^https:\/\/ollama\.com\/api\/me\?ts=\d+$/);
    expect(urlOf(fetch, 1)).toMatch(/^https:\/\/ollama\.com\/api\/user\/keys\/.+\?ts=\d+$/);
    expect((fetch.mock.calls[1]![1] as RequestInit).method).toBe('DELETE');
  });
});

describe('without the option', () => {
  it('the global fetch is itself a Fetch, so a host passes it straight or wrapped', () => {
    const direct: Fetch = globalThis.fetch;
    const wrapped: Fetch = (input, init) => globalThis.fetch(input, { ...init, keepalive: false });
    expect(typeof direct).toBe('function');
    expect(typeof wrapped).toBe('function');
  });

  it('the global fetch is called, and looked up at call time', async () => {
    const fetch = vi.fn(async () => sse(answer));
    vi.stubGlobal('fetch', fetch);
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' }, 'k', req)).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
