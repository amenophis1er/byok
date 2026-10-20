/**
 * chat() end to end against a fake chrome.storage and a mocked fetch: pinned
 * connections, the retries without rejected optional fields, Stop, the ai-chat message op —
 * and the one-writer queue under interleaved storage calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chat, createAiMessageHandler } from '../src/background/index.js';
import { anthropicSse, openaiSse, streamOf } from './helpers.js';

// Stored secrets are sealed with a key kept in IndexedDB, which this test environment lacks:
// a blob of the form { plain } stands for a sealed secret here.
vi.mock('../src/background/crypto.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/background/crypto.js')>();
  return {
    ...original,
    encryptString: async (plain: string) => ({ plain }),
    decryptBlob: async (blob: unknown) => (blob && typeof blob === 'object' && 'plain' in blob ? String((blob as { plain: string }).plain) : original.decryptBlob(blob as never)),
  };
});

const STORAGE_KEY = 'aiConnections';
let local: Map<string, unknown>;

/** Storage whose calls take a random few ms, so unsynchronised read-modify-writes interleave. */
function installChrome() {
  local = new Map();
  const session = new Map<string, unknown>();
  const jitter = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 6));
  const area = (map: Map<string, unknown>) => ({
    async get(key: string | string[]) {
      await jitter();
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      await jitter();
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
    },
    async remove(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) map.delete(k); },
  });
  (globalThis as any).chrome = { storage: { local: area(local), session: area(session) }, tabs: { create: async () => ({}) } };
}

function seed(connections: Array<Record<string, unknown>>, activeId: string | null = null) {
  local.set(STORAGE_KEY, { activeId, connections, apiRoots: true });
}

const conn = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'openai-compatible', label: id, baseUrl: 'http://localhost:11434/v1', model: 'gpt-oss:20b', apiKeyEnc: null, revision: 1, ...extra,
});

const sseResponse = (text: string) => new Response(streamOf(text, 13), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolCallStream = openaiSse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"observe"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
]);

beforeEach(() => installChrome());
afterEach(() => vi.unstubAllGlobals());

describe('chat()', () => {
  it('calls the pinned connection and returns its tool calls', async () => {
    seed([conn('a'), conn('b', { baseUrl: 'http://127.0.0.1:1234' })], 'a');
    const fetch = vi.fn(async () => sseResponse(toolCallStream));
    vi.stubGlobal('fetch', fetch);
    const result = await chat({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [], connectionId: 'b', connectionRevision: 1 });
    expect(result).toMatchObject({ ok: true, stopReason: 'tool_use', toolCalls: [{ id: 'c1', args: { action: 'observe' } }] });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('carries the failure as data for its own refusals: a stopped call, a gone connection, a failed refresh', async () => {
    seed([conn('a', { kind: 'anthropic', baseUrl: '', model: 'claude', auth: 'oauth', apiKeyEnc: { plain: 'old' }, refreshTokenEnc: { plain: 'rt' }, expiresAt: 1 })], 'a');
    const stopped = new AbortController();
    stopped.abort();
    expect(await chat({ system: '', messages: [] }, { signal: stopped.signal })).toMatchObject({ error: 'Stopped.', failure: { kind: 'stopped', streamed: false } });
    expect(await chat({ system: '', messages: [], connectionId: 'gone' })).toMatchObject({ failure: { kind: 'request', streamed: false } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'Failed to fetch', streamed: false } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ retryable: true, failure: { kind: 'http', streamed: false } });
  });

  it('refuses a pinned connection that is gone, or whose settings changed since the run started', async () => {
    seed([conn('a', { revision: 2 })], 'a');
    vi.stubGlobal('fetch', vi.fn());
    expect(await chat({ system: '', messages: [], connectionId: 'zzz' })).toMatchObject({ ok: false, error: expect.stringMatching(/no longer exists/) });
    expect(await chat({ system: '', messages: [], connectionId: 'a', connectionRevision: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/changed during this run/) });
  });

  it('retries once without parallel_tool_calls when the server rejects the field', async () => {
    seed([conn('a')], 'a');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? new Response('{"error":{"message":"unknown field parallel_tool_calls"}}', { status: 400 })
        : sseResponse(toolCallStream);
    }));
    const tools = [{ name: 'browser', description: 'd', inputSchema: { type: 'object' } }];
    const result = await chat({ system: '', messages: [{ role: 'user', content: 'go' }], tools });
    expect(result.ok).toBe(true);
    expect(bodies[0]).toHaveProperty('parallel_tool_calls', false);
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls');
  });

  it('retries without each rejected optional field in turn, and gives up on a repeat', async () => {
    seed([conn('a')], 'a');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response('{"error":"unknown field stream_options"}', { status: 400 });
      if (bodies.length === 2) return new Response('{"error":"unknown field parallel_tool_calls"}', { status: 400 });
      return sseResponse(toolCallStream);
    }));
    const tools = [{ name: 'browser', description: 'd', inputSchema: { type: 'object' } }];
    expect((await chat({ system: '', messages: [{ role: 'user', content: 'go' }], tools })).ok).toBe(true);
    expect(bodies[1]).not.toHaveProperty('stream_options');
    expect(bodies[1]).toHaveProperty('parallel_tool_calls');
    expect(bodies[2]).not.toHaveProperty('stream_options');
    expect(bodies[2]).not.toHaveProperty('parallel_tool_calls');

    bodies.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{"error":"unknown field stream_options"}', { status: 400 });
    }));
    expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: false });
    expect(bodies).toHaveLength(2);
  });

  it('says Stopped when the caller aborts, and names a timeout as one', async () => {
    seed([conn('a')], 'a');
    // Like real fetch: reject at once on an already-aborted signal, else on abort.
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const stop = new AbortController();
    const pending = chat({ system: '', messages: [] }, { signal: stop.signal });
    setTimeout(() => stop.abort(), 5);
    expect(await pending).toMatchObject({ ok: false, error: 'Stopped.' });
    expect(await chat({ system: '', messages: [], timeoutMs: 5 })).toMatchObject({ ok: false, error: 'Timed out waiting for the model.' });
  });

  it('names who could not be reached when the connection drops, and marks it worth retrying', async () => {
    seed([conn('a', { kind: 'anthropic', baseUrl: '', model: 'claude', apiKeyEnc: { plain: 'k' } }), conn('l'), conn('r', { baseUrl: 'https://openrouter.ai/api' })], 'a');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ ok: false, error: 'The connection to Anthropic dropped (network error).', retryable: true });
    const local = await chat({ system: '', messages: [], connectionId: 'l' });
    expect(local.error).toMatch(/model server on this computer .*OLLAMA_ORIGINS/);
    expect((await chat({ system: '', messages: [], connectionId: 'r' })).error).toBe('The connection to openrouter.ai dropped (network error).');
  });

  it('marks server failures and cut-off streams as worth retrying, and not a request the provider refused', async () => {
    seed([conn('l')], 'l');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"overloaded"}', { status: 503 })));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ ok: false, retryable: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad model"}', { status: 400 })));
    expect(await chat({ system: '', messages: [] })).not.toHaveProperty('retryable');
    // A stream cut off before anything streamed is worth another try; one cut after text the user saw is not.
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ ok: false, error: 'The response stream ended before it finished.', retryable: true, failure: { kind: 'stream', streamed: false } });
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n')));
    const cut = await chat({ system: '', messages: [] });
    expect(cut).toMatchObject({ ok: false, error: 'The response stream ended before it finished.', failure: { kind: 'stream', streamed: true } });
    expect(cut).not.toHaveProperty('retryable');
  });

  it('passes on when the provider said to come back after a rate limit', async () => {
    seed([conn('l')], 'l');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Rate limit reached on tokens per minute (TPM). Please try again in 1.5s."}}', { status: 429 })));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 429'), retryable: true, retryAfterMs: 1500, resetAt: expect.any(Number), quota: 'minute' });
  });

  it('declines the on-device model, which has no tool calling', async () => {
    seed([conn('n', { kind: 'chrome-builtin' })], 'n');
    expect((await chat({ system: '', messages: [] })).error).toMatch(/no tool calling/);
  });

  it('sends a ChatGPT subscription turn to the Codex backend with the account, and reads its tool call', async () => {
    seed([conn('g', { kind: 'chatgpt', baseUrl: '', model: 'gpt-5.5', auth: 'oauth', accountId: 'acct-1',
      apiKeyEnc: { plain: 'access-token' }, expiresAt: Date.now() + 3_600_000 })], 'g');
    const stream = [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"action":"observe"}' },
      { type: 'response.completed', response: {} },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const fetched = vi.fn(async () => sseResponse(stream));
    vi.stubGlobal('fetch', fetched);
    const result = await chat({ system: 'Drive.', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'browser', description: 'd', inputSchema: {} }] });
    expect(result).toMatchObject({ ok: true, toolCalls: [{ id: 'call_1', name: 'browser', args: { action: 'observe' } }], stopReason: 'tool_use' });
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers).toMatchObject({ authorization: 'Bearer access-token', 'chatgpt-account-id': 'acct-1' });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-5.5', instructions: 'Drive.', store: false });
  });

  it('sends an OpenCode Console turn with the organization header, refreshing the token at the Console first', async () => {
    seed([conn('o', { auth: 'oauth', issuer: 'opencode', orgId: 'org_1', baseUrl: 'https://opencode.ai/inference/v1', model: 'glm-5.3-flash',
      apiKeyEnc: { plain: 'old-access' }, refreshTokenEnc: { plain: 'old-refresh' }, expiresAt: Date.now() + 60_000 })], 'o');
    const fetched = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 2592000, org_id: 'org_1' }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse(toolCallStream));
    vi.stubGlobal('fetch', fetched);
    createAiMessageHandler({ prefix: 't', opencodeClientId: 'valet' });
    const result = await chat({ system: 'Drive.', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'browser', description: 'd', inputSchema: {} }] });
    expect(result).toMatchObject({ ok: true, toolCalls: [{ id: 'c1', name: 'browser' }] });
    const [refreshUrl, refreshInit] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(refreshUrl).toBe('https://opencode.ai/console/auth/device/token');
    expect(JSON.parse(String(refreshInit.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: 'valet' });
    const [url, init] = fetched.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://opencode.ai/inference/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer new-access', 'x-opencode-org-id': 'org_1' });
    // The rotated pair is on disk before the turn is sent.
    const stored = (local.get(STORAGE_KEY) as { connections: Array<Record<string, unknown>> }).connections[0]!;
    expect(stored.apiKeyEnc).toEqual({ plain: 'new-access' });
    expect(stored.refreshTokenEnc).toEqual({ plain: 'new-refresh' });
  });

  it('refuses an already-stopped call before reading storage, and times out a token refresh that hangs', async () => {
    seed([conn('o', { auth: 'oauth', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1', model: 'glm',
      apiKeyEnc: { plain: 'old' }, refreshTokenEnc: { plain: 'r' }, expiresAt: Date.now() - 1 })], 'o');
    const stop = new AbortController();
    stop.abort();
    const get = vi.spyOn(chrome.storage.local, 'get');
    expect(await chat({ system: '', messages: [] }, { signal: stop.signal })).toMatchObject({ ok: false, error: 'Stopped.' });
    expect(get).not.toHaveBeenCalled();
    // The refresh answers, but only after the limit (the one writer must get it back: a hung refresh holds the queue).
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(new Response('{}', { status: 500 })), 40))));
    expect(await chat({ system: '', messages: [], timeoutMs: 10 })).toMatchObject({ ok: false, error: 'Timed out waiting for the model.' });
  });

  it('marks a token refresh its server failed as worth retrying', async () => {
    seed([conn('o', { auth: 'oauth', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1', model: 'glm',
      apiKeyEnc: { plain: 'old' }, refreshTokenEnc: { plain: 'r' }, expiresAt: Date.now() - 1 })], 'o');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    expect(await chat({ system: '', messages: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/refresh failed \(503\)/), retryable: true });
  });

  describe('listing models', () => {
    const list = (message: Record<string, unknown>) => new Promise((resolve) => createAiMessageHandler({ prefix: 't' })({ type: 't:ai-list-models', ...message } as never, resolve));

    it('answers for the on-device model without touching the saved sign-in', async () => {
      seed([conn('d', { kind: 'chrome-builtin', auth: 'device-key', baseUrl: '', model: 'gemini-nano' })], 'd');
      vi.stubGlobal('fetch', vi.fn());
      expect(await list({ id: 'd', kind: 'chrome-builtin', baseUrl: '' })).toEqual({ ok: true, data: [{ id: 'gemini-nano', name: 'Chrome on-device model' }] });
    });

    it('says when to come back when the listing is rate limited', async () => {
      seed([conn('l')], 'l');
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Too many requests"}}', { status: 429, headers: { 'retry-after': '4' } })));
      expect(await list({ id: 'l', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toMatchObject({ ok: false, error: 'HTTP 429: Too many requests', retryAfterMs: 4000, resetAt: expect.any(Number) });
    });

    it('tries a key typed in the form as a plain Bearer, not under the saved OpenCode organization', async () => {
      seed([conn('o', { auth: 'oauth', issuer: 'opencode', orgId: 'org_1', baseUrl: 'https://opencode.ai/inference/v1', apiKeyEnc: { plain: 'access' }, expiresAt: Date.now() + 3_600_000 })], 'o');
      const fetched = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] })));
      vi.stubGlobal('fetch', fetched);
      expect(await list({ id: 'o', kind: 'openai-compatible', baseUrl: 'https://other.example/v1', apiKey: 'typed' })).toEqual({ ok: true, data: [{ id: 'm', name: 'm' }] });
      const init = (fetched.mock.calls[0] as unknown as [URL, RequestInit])[1];
      expect(init.headers).toEqual({ Authorization: 'Bearer typed' });
      // Without a typed key, the saved sign-in's headers.
      await list({ id: 'o', kind: 'openai-compatible', baseUrl: 'https://opencode.ai/inference/v1' });
      expect((fetched.mock.calls[1] as unknown as [URL, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer access', 'x-opencode-org-id': 'org_1' });
    });
  });

  it('answers the ai-chat message op with the same result', async () => {
    seed([conn('a')], 'a');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(toolCallStream)));
    const handle = createAiMessageHandler({ prefix: 't' });
    const answer = await new Promise((resolve) => handle({ type: 't:ai-chat', system: '', messages: [{ role: 'user', content: 'go' }] } as never, resolve));
    expect(answer).toMatchObject({ ok: true, toolCalls: [{ id: 'c1' }] });
  });
  describe('protocols', () => {
    const opencode = (model: string) => conn('o', { auth: 'oauth', issuer: 'opencode', orgId: 'org_1', baseUrl: 'https://opencode.ai/inference/v1', model,
      apiKeyEnc: { plain: 'access' }, expiresAt: Date.now() + 3_600_000 });
    const mismatch = () => new Response('{"type":"error","error":{"type":"BadRequest","message":"Model does not support this protocol."}}', { status: 400 });
    const anthropicAnswer = () => sseResponse(anthropicSse([
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]));
    const responsesAnswer = () => sseResponse([
      { type: 'response.output_item.added', item: { type: 'message', id: 'm1' } },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'hi' },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    const calls = (fetched: ReturnType<typeof vi.fn>) => fetched.mock.calls.map((call) => String((call as unknown[])[0]));

    it('sends an OpenCode Claude model straight to the Messages API, with the Console token', async () => {
      seed([opencode('claude-sonnet-5-5')], 'o');
      const fetched = vi.fn(async () => anthropicAnswer());
      vi.stubGlobal('fetch', fetched);
      expect(await chat({ system: 'Be brief.', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: true, text: 'hi', stopReason: 'end' });
      expect(calls(fetched)).toEqual(['https://opencode.ai/inference/v1/messages']);
      const init = (fetched.mock.calls[0] as unknown as [URL, RequestInit])[1];
      expect(init.headers).toMatchObject({ Authorization: 'Bearer access', 'x-opencode-org-id': 'org_1', 'anthropic-version': '2023-06-01' });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'claude-sonnet-5-5', system: [{ type: 'text', text: 'Be brief.' }], stream: true });
    });

    it('tries the other protocols when OpenCode answers a mismatch, and remembers the one that worked', async () => {
      seed([opencode('kimi-k3')], 'o');
      const fetched = vi.fn()
        .mockResolvedValueOnce(mismatch()).mockResolvedValueOnce(mismatch()).mockResolvedValueOnce(responsesAnswer())
        .mockResolvedValueOnce(responsesAnswer());
      vi.stubGlobal('fetch', fetched);
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }], maxTokens: 500 })).toMatchObject({ ok: true, text: 'hi' });
      expect(calls(fetched)).toEqual([
        'https://opencode.ai/inference/v1/chat/completions',
        'https://opencode.ai/inference/v1/messages',
        'https://opencode.ai/inference/v1/responses',
      ]);
      const responsesInit = (fetched.mock.calls[2] as unknown as [URL, RequestInit])[1];
      expect(JSON.parse(String(responsesInit.body))).toMatchObject({ model: 'kimi-k3', max_output_tokens: 500, store: false });
      // The next turn goes where the first one ended up.
      await chat({ system: '', messages: [{ role: 'user', content: 'again' }] });
      expect(calls(fetched)[3]).toBe('https://opencode.ai/inference/v1/responses');
    });

    it('says so when OpenCode serves a model on a protocol it has no client for', async () => {
      seed([opencode('something-new')], 'o');
      vi.stubGlobal('fetch', vi.fn(async () => mismatch()));
      const result = await chat({ system: '', messages: [{ role: 'user', content: 'go' }] });
      expect(result).toMatchObject({ ok: false, error: 'OpenCode serves something-new on a protocol this library does not speak (HTTP 400: Model does not support this protocol.).' });
      expect(result).not.toHaveProperty('retryable');
    });

    const geminiAnswer = () => sseResponse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } })}\n\n`);

    it('sends an OpenCode Gemini model to the Gemini API with the Console token', async () => {
      seed([opencode('gemini-3.8-flash')], 'o');
      const fetched = vi.fn(async () => geminiAnswer());
      vi.stubGlobal('fetch', fetched);
      expect(await chat({ system: 'Be brief.', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: true, text: 'hi', usage: { inputTokens: 3, outputTokens: 1 } });
      expect(calls(fetched)).toEqual(['https://opencode.ai/inference/v1/models/gemini-3.8-flash:streamGenerateContent?alt=sse']);
      const init = (fetched.mock.calls[0] as unknown as [URL, RequestInit])[1];
      expect(init.headers).toMatchObject({ Authorization: 'Bearer access', 'x-opencode-org-id': 'org_1' });
      expect(JSON.parse(String(init.body))).toMatchObject({ systemInstruction: { parts: [{ text: 'Be brief.' }] }, contents: [{ role: 'user', parts: [{ text: 'go' }] }] });
    });

    it('speaks the Gemini API to Google with the key in x-goog-api-key, from the preset\'s OpenAI-compatible root', async () => {
      seed([conn('g', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'gemini', model: 'gemini-3.8-flash', apiKeyEnc: { plain: 'AIza-1' } })], 'g');
      const fetched = vi.fn(async () => geminiAnswer());
      vi.stubGlobal('fetch', fetched);
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: true, text: 'hi' });
      expect(calls(fetched)).toEqual(['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse']);
      const init = (fetched.mock.calls[0] as unknown as [URL, RequestInit])[1];
      expect(init.headers).toMatchObject({ 'x-goog-api-key': 'AIza-1' });
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('speaks the Responses API to an openai-compatible server saved with that protocol, in the server\'s own words on failure', async () => {
      seed([conn('r', { baseUrl: 'https://api.openai.com/v1', protocol: 'responses', model: 'gpt-5.5', apiKeyEnc: { plain: 'sk-1' } })], 'r');
      const fetched = vi.fn()
        .mockResolvedValueOnce(responsesAnswer())
        .mockResolvedValueOnce(new Response('{"error":{"message":"Unknown model."}}', { status: 404 }));
      vi.stubGlobal('fetch', fetched);
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: true, text: 'hi', usage: { inputTokens: 3, outputTokens: 1 } });
      const [url, init] = fetched.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-1' });
      expect(init.headers).not.toHaveProperty('originator');
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: false, error: 'HTTP 404: Unknown model.' });
    });

    it('moves an OpenAI model that takes tools on Responses only over to it, and stays there', async () => {
      seed([conn('oa', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', apiKeyEnc: { plain: 'sk-1' } })], 'oa');
      const refusal = () => new Response(JSON.stringify({ error: { message: 'Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.' } }), { status: 400 });
      const fetched = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(responsesAnswer()).mockResolvedValueOnce(responsesAnswer());
      vi.stubGlobal('fetch', fetched);
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'browser', description: 'd', inputSchema: {} }] })).toMatchObject({ ok: true, text: 'hi' });
      expect(calls(fetched)).toEqual(['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/responses']);
      await chat({ system: '', messages: [{ role: 'user', content: 'again' }] });
      expect(calls(fetched)[2]).toBe('https://api.openai.com/v1/responses');
      // Any other 400 is the answer, not a mismatch.
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"bad"}}', { status: 400 })));
      seed([conn('ob', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKeyEnc: { plain: 'sk-1' } })], 'ob');
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: false, error: 'HTTP 400: bad' });
    });

    it('reports a non-ChatGPT Responses failure event in the provider\'s words', async () => {
      seed([conn('r', { baseUrl: 'https://api.openai.com/v1', protocol: 'responses', apiKeyEnc: { plain: 'sk-1' } })], 'r');
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse(`data: ${JSON.stringify({ type: 'error', error: { message: 'Quota exceeded.' } })}\n\n`)));
      expect(await chat({ system: '', messages: [{ role: 'user', content: 'go' }] })).toMatchObject({ ok: false, error: 'Quota exceeded.' });
    });

    it('shows the protocol on each connection, and keeps a saved one', async () => {
      seed([conn('a', { kind: 'anthropic' }), conn('g', { kind: 'chatgpt' }), conn('l'), opencode('glm-5.3')]);
      const handle = createAiMessageHandler({ prefix: 't' });
      const send = (message: Record<string, unknown>) => new Promise<any>((resolve) => handle(message as never, resolve));
      await send({ type: 't:ai-save-connection', kind: 'openai-compatible', protocol: 'responses', label: 'r', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKeyMode: 'clear' });
      const view = await send({ type: 't:ai-get' });
      expect(view.connections.map((c: { protocol: string }) => c.protocol)).toEqual(['anthropic', 'responses', 'chat-completions', 'chat-completions', 'responses']);
      await send({ type: 't:ai-save-connection', id: view.connections[4].id, kind: 'openai-compatible', label: 'r', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', apiKeyMode: 'keep' });
      expect((await send({ type: 't:ai-get' })).connections[4].protocol).toBe('chat-completions');
    });
  });
});

describe('the one writer for the connection record', () => {
  it('keeps every concurrent edit, across connections', async () => {
    seed([conn('a'), conn('b'), conn('c')], 'a');
    const handle = createAiMessageHandler({ prefix: 't' });
    const send = (message: Record<string, unknown>) => new Promise((resolve) => handle(message as never, resolve));
    const edit = (id: string, model: string) => send({ type: 't:ai-save-connection', id, kind: 'openai-compatible', label: id, baseUrl: 'http://localhost:11434', model, apiKeyMode: 'keep' });
    await Promise.all([edit('a', 'model-a'), edit('b', 'model-b'), edit('c', 'model-c'), send({ type: 't:ai-set-active', id: 'c' }), edit('a', 'model-a2')]);
    const stored = local.get(STORAGE_KEY) as { activeId: string; connections: Array<{ id: string; model: string; revision: number }> };
    expect(Object.fromEntries(stored.connections.map((c) => [c.id, c.model]))).toEqual({ a: 'model-a2', b: 'model-b', c: 'model-c' });
    expect(stored.connections.find((c) => c.id === 'a')!.revision).toBe(3);
    expect(stored.activeId).toBe('c');
  });
});
