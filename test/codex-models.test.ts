import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLIENT_VERSION, codexCatalogModels, codexModels } from '../src/core/openai-oauth.js';

const catalog = {
  models: [
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 3 },
    { slug: 'gpt-5.6-sol-wm', display_name: 'Sol (routed)', visibility: 'hide', priority: 0 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-5.6-luna', visibility: 'list', priority: 2 },
    { slug: '', display_name: 'Nameless', visibility: 'list', priority: 0 },
    'not an entry',
  ],
};

describe('Codex model catalog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the visible models in priority order, named by their display name', () => {
    expect(codexCatalogModels(catalog)).toEqual([
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);
  });

  it('keeps the context window and input modalities an entry carries', () => {
    expect(codexCatalogModels({ models: [
      { slug: 'gpt-5.5', context_window: 272000, input_modalities: ['text', 'image'] },
      { slug: 'gpt-5.3-codex-spark', context_window: 'big', input_modalities: ['text'] },
    ] })).toEqual([
      { id: 'gpt-5.5', name: 'gpt-5.5', contextWindow: 272000, capabilities: { images: true } },
      { id: 'gpt-5.3-codex-spark', name: 'gpt-5.3-codex-spark', capabilities: { images: false } },
    ]);
  });

  it('keeps an entry without a visibility, and gives nothing for a body that is not a catalog', () => {
    expect(codexCatalogModels({ models: [{ slug: 'gpt-5.5' }] })).toEqual([{ id: 'gpt-5.5', name: 'gpt-5.5' }]);
    expect(codexCatalogModels(null)).toEqual([]);
    expect(codexCatalogModels({ data: [{ id: 'gpt-5.5' }] })).toEqual([]);
  });

  it('asks the backend as the Codex CLI does: its version in the query, the account and originator headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await codexModels({ accessToken: 'tok', accountId: 'acct' });
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.4']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
    expect(init.headers).toEqual({ authorization: 'Bearer tok', 'chatgpt-account-id': 'acct', originator: 'codex_cli_rs', accept: 'application/json' });
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('claims the client version given, and the built-in one for none or junk', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await codexModels({ accessToken: 'tok', clientVersion: '0.170.0' });
    await codexModels({ accessToken: 'tok', clientVersion: '' });
    for (const junk of ['1.0 OR 1=1', 'garbage', '...', '1.2', 'v1.2.3', '1.2.3.4']) await codexModels({ accessToken: 'tok', clientVersion: junk });
    await codexModels({ accessToken: 'tok', clientVersion: '0.171.0-alpha.1' });
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as [string])[0]));
    expect(urls[0]).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.170.0');
    for (const url of urls.slice(1, 8)) expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
    expect(urls[8]).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.171.0-alpha.1');
  });

  it('leaves the account header out when there is no account id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await codexModels({ accessToken: 'tok' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('chatgpt-account-id');
  });

  it('throws on a failed request or an empty catalog, so the caller can fall back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(codexModels({ accessToken: 'tok' })).rejects.toThrow('HTTP 401');
    // ChatGPT's wording is never kept, on the catalog as on a turn: the code, not the message.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'usage_limit_reached', message: 'SECRET BODY' } }), { status: 400 })));
    const failure = await codexModels({ accessToken: 'tok' }).catch((error: unknown) => error as Error);
    expect(failure).toMatchObject({ providerCode: 'usage_limit_reached' });
    expect(JSON.stringify(failure)).not.toContain('SECRET BODY');
    expect(String(failure)).not.toContain('SECRET BODY');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"models":[]}', { status: 200 })));
    await expect(codexModels({ accessToken: 'tok' })).rejects.toThrow('no models');
  });
});
