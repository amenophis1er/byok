/**
 * Base URLs as API roots: normalizing what users type, the presets, saved
 * connections from before 0.1.2 (origins `/v1` was appended to), unfilled
 * `{placeholders}`, and the model lists of providers that differ from OpenAI's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiMessageHandler } from '../src/background/index.js';
import { OPENAI_COMPATIBLE_PRESETS, defaultLabel, normalizeBaseUrl, originPattern, presetOf } from '../src/types.js';
import { openaiSse, streamOf } from './helpers.js';

const STORAGE_KEY = 'aiConnections';
let local: Map<string, unknown>;

beforeEach(() => {
  local = new Map();
  const area = (map: Map<string, unknown>) => ({
    async get(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    },
    async set(items: Record<string, unknown>) { for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v)); },
    async remove(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) map.delete(k); },
  });
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(new Map()) } });
});
afterEach(() => vi.unstubAllGlobals());

const handle = createAiMessageHandler({ prefix: 't' });
const send = <T>(message: Record<string, unknown>) => new Promise<T>((resolve) => handle(message as never, resolve as never));
type Result = { ok: boolean; data?: unknown; error?: string };

const conn = (id: string, baseUrl: string) => ({
  id, kind: 'openai-compatible', label: id, baseUrl, model: 'm', apiKeyEnc: null, revision: 1,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// complete() is a chat() turn: the answer streams.
const answer = () => new Response(
  streamOf(openaiSse([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

describe('normalizeBaseUrl', () => {
  it.each([
    ['', 'https://api.openai.com/v1'],
    ['api.openai.com', 'https://api.openai.com/v1'],
    ['https://api.openai.com/', 'https://api.openai.com/v1'],
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1'],
    ['https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://gateway.ai.cloudflare.com/v1/acct/gw/compat', 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it('leaves every preset unchanged, and labels connections by preset', () => {
    for (const preset of OPENAI_COMPATIBLE_PRESETS) {
      expect(normalizeBaseUrl(preset.baseUrl)).toBe(preset.baseUrl);
      expect(originPattern(preset.baseUrl)).toMatch(/^https?:\/\/[^/]+\/\*$/);
      expect(defaultLabel('openai-compatible', preset.baseUrl)).toBe(preset.label);
    }
  });

  it('gives every preset a stable id, and names each placeholder of its URL in fields', () => {
    const ids = OPENAI_COMPATIBLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of OPENAI_COMPATIBLE_PRESETS) {
      expect(preset.id).toMatch(/^[a-z][a-z0-9-]*$/);
      const placeholders = [...preset.baseUrl.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
      expect((preset.fields ?? []).map((f) => f.name)).toEqual(placeholders);
      for (const url of [preset.keyUrl]) if (url) expect(url).toMatch(/^https:\/\//);
    }
    expect(OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === 'groq')).toMatchObject({ keyUrl: 'https://console.groq.com/keys' });
  });

  it('matches a base URL to its preset: templated, with the values; loopback names as one host; hosts without case', () => {
    expect(presetOf('https://gateway.ai.cloudflare.com/v1/abc/gw1/compat')).toMatchObject({ preset: { id: 'cloudflare-ai-gateway' }, values: { account_id: 'abc', gateway_id: 'gw1' } });
    expect(presetOf('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/')).toMatchObject({ preset: { id: 'cloudflare-workers-ai' }, values: { account_id: 'abc' } });
    expect(defaultLabel('openai-compatible', 'https://gateway.ai.cloudflare.com/v1/abc/gw1/compat')).toBe('Cloudflare AI Gateway');
    for (const local of ['http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1', 'http://LOCALHOST:11434', 'localhost:11434'.replace(/^/, 'http://')]) {
      expect(presetOf(local), local).toMatchObject({ preset: { id: 'ollama-local' }, values: {} });
    }
    expect(presetOf('https://API.Groq.com/openai/v1')).toMatchObject({ preset: { id: 'groq' } });
    expect(defaultLabel('openai-compatible', 'https://API.Groq.com/openai/v1')).toBe('Groq');
    // Not a preset: another path, another port, a placeholder still unfilled, a scheme that differs, not a URL.
    expect(presetOf('https://api.groq.com/v1')).toBeUndefined();
    expect(presetOf('http://localhost:1234/v1')).toBeUndefined();
    expect(presetOf('https://gateway.ai.cloudflare.com/v1/{account_id}/gw1/compat')).toBeUndefined();
    expect(presetOf('http://api.groq.com/openai/v1')).toBeUndefined();
    expect(presetOf('::')).toBeUndefined();
    // Encoding is kept as the request will carry it: an encoded slash is no separator, a malformed escape no value.
    expect(presetOf('https://api.groq.com/openai%2Fv1')).toBeUndefined();
    expect(presetOf('https://api.groq.com/openai/v1%2F')).toBeUndefined();
    expect(presetOf('https://gateway.ai.cloudflare.com/v1/a%2Fb/gw1/compat')).toBeUndefined();
    expect(presetOf('https://gateway.ai.cloudflare.com/v1/a%ZZ/gw1/compat')).toBeUndefined();
    expect(presetOf('https://gateway.ai.cloudflare.com/v1/a%20b/gw1/compat')).toMatchObject({ values: { account_id: 'a b', gateway_id: 'gw1' } });
    // The plain presets match themselves, with no values.
    expect(presetOf('https://ollama.com/v1')).toMatchObject({ preset: { id: 'ollama-cloud' }, values: {} });
  });
});

describe('saved connections', () => {
  it('reads base URLs saved before 0.1.2 as roots ending in /v1', async () => {
    local.set(STORAGE_KEY, {
      activeId: 'r',
      connections: [conn('r', 'https://openrouter.ai/api'), conn('l', 'http://localhost:11434'), conn('o', ''), conn('v', 'https://x.example/v1/')],
    });
    const view = await send<{ connections: Array<{ baseUrl: string }> }>({ type: 't:ai-get' });
    expect(view.connections.map((c) => c.baseUrl)).toEqual([
      'https://openrouter.ai/api/v1',
      'http://localhost:11434/v1',
      'https://api.openai.com/v1',
      'https://x.example/v1',
    ]);

    const fetch = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetch);
    expect(await send<Result>({ type: 't:ai-complete', system: '', prompt: 'hello' })).toMatchObject({ ok: true });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('persists the roots on the next save, and does not append /v1 again', async () => {
    local.set(STORAGE_KEY, { activeId: null, connections: [conn('r', 'https://openrouter.ai/api'), conn('g', 'https://gemini.example')] });
    await send({ type: 't:ai-set-active', id: 'r' });
    await send({ type: 't:ai-set-active', id: 'g' });
    const stored = local.get(STORAGE_KEY) as { apiRoots: boolean; connections: Array<{ baseUrl: string }> };
    expect(stored.apiRoots).toBe(true);
    expect(stored.connections.map((c) => c.baseUrl)).toEqual(['https://openrouter.ai/api/v1', 'https://gemini.example/v1']);
  });

  it('saves roots without a version as typed', async () => {
    const res = await send<Result>({
      type: 't:ai-save-connection', kind: 'openai-compatible', label: '', model: 'gemini-2.5-flash', apiKeyMode: 'clear',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', makeActive: true,
    });
    expect(res.ok).toBe(true);
    const fetch = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetch);
    await send({ type: 't:ai-complete', system: '', prompt: 'hello' });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((local.get(STORAGE_KEY) as { connections: Array<{ label: string }> }).connections[0]!.label).toBe('Google Gemini');
  });

  it('refuses a base URL with an unfilled placeholder', async () => {
    const workersAi = OPENAI_COMPATIBLE_PRESETS.find((p) => p.label === 'Cloudflare Workers AI')!.baseUrl;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const saved = await send<Result>({ type: 't:ai-save-connection', kind: 'openai-compatible', label: '', model: 'm', apiKeyMode: 'clear', baseUrl: workersAi });
    expect(saved).toMatchObject({ ok: false, error: 'Replace {account_id} in the base URL with your own value.' });
    const listed = await send<Result>({ type: 't:ai-list-models', kind: 'openai-compatible', baseUrl: workersAi, apiKey: 'k' });
    expect(listed).toMatchObject({ ok: false, error: expect.stringContaining('{account_id}') });
    expect(fetch).not.toHaveBeenCalled();
    expect(local.has(STORAGE_KEY)).toBe(false);
  });
});

describe('listModels', () => {
  const list = (baseUrl: string) => send<Result>({ type: 't:ai-list-models', kind: 'openai-compatible', baseUrl, apiKey: 'k' });

  it('asks the root for /models with the key', async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: 'b' }, { id: 'a' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await list('https://api.groq.com/openai/v1')).toEqual({ ok: true, data: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://api.groq.com/openai/v1/models');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('lists only the Gemini models that chat, from its own API, across pages', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
          { name: 'models/antigravity-preview', supportedGenerationMethods: [] },
        ],
        nextPageToken: 'p2',
      }))
      .mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] }));
    vi.stubGlobal('fetch', fetch);
    // Each with its token limits when listed, and what the family takes.
    const takes = { tools: true, images: true, pdf: true };
    expect(await list('https://generativelanguage.googleapis.com/v1beta/openai')).toEqual({ ok: true, data: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: takes },
      { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', capabilities: takes },
    ] });
    const [first, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(`${first.origin}${first.pathname}`).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(init.headers).toEqual({ 'x-goog-api-key': 'k' });
    expect((fetch.mock.calls[1] as unknown as [URL])[0].searchParams.get('pageToken')).toBe('p2');
  });

  it('lists Workers AI text models from its own model search, across pages', async () => {
    const page = (names: string[], total: number) => json({
      success: true,
      result: names.map((name) => ({ name, task: { name: name.includes('embed') ? 'Text Embeddings' : 'Text Generation' } })),
      result_info: { total_count: total },
    });
    const first = Array.from({ length: 100 }, (_, i) => `@cf/m/model-${String(i).padStart(3, '0')}`);
    const fetch = vi.fn().mockResolvedValueOnce(page(first, 102)).mockResolvedValueOnce(page(['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/baai/bge-embed'], 102));
    vi.stubGlobal('fetch', fetch);
    const res = await list('https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1');
    expect(res.ok).toBe(true);
    expect((res.data as Array<{ id: string }>)).toHaveLength(101);
    expect((res.data as Array<{ id: string }>)[0]!.id).toBe('@cf/m/model-000');
    expect((res.data as Array<{ id: string }>).some((m) => m.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(`${url.origin}${url.pathname}`).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/models/search');
    expect(url.searchParams.get('task')).toBe('Text Generation');
    expect(init.headers).toEqual({ Authorization: 'Bearer k' });
    expect((fetch.mock.calls[1] as unknown as [URL])[0].searchParams.get('page')).toBe('2');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads Together's bare array", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }])));
    expect(await list('https://api.together.xyz/v1')).toMatchObject({ ok: true, data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }] });
  });
});
