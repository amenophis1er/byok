/**
 * The Codex originator (#25): ChatGPT turns and the catalog request name the
 * client in the `originator` header — the Codex CLI's by default, the host's
 * own when the connection says.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_ORIGINATOR, chat, listModels, type Connection, type Fetch } from '../src/core/index.js';
import { codexModels } from '../src/core/openai-oauth.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const catalog = () => json({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 1 }] });
const req = { system: '', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [] };
const headerOf = (fetch: ReturnType<typeof vi.fn<Fetch>>, name: string, call = 0): string | undefined =>
  (fetch.mock.calls[call]![1]!.headers as Record<string, string>)[name];

afterEach(() => vi.unstubAllGlobals());

describe('the originator header', () => {
  it("is the Codex CLI's when the connection names none", async () => {
    expect(CODEX_ORIGINATOR).toBe('codex_cli_rs');
    const fetch = vi.fn<Fetch>(async () => json({ error: { message: 'down' } }, 503));
    const conn: Connection = { kind: 'chatgpt', baseUrl: '', model: 'gpt-5.5', accountId: 'acc' };
    await chat(conn, 'tok', req, { fetch });
    expect(headerOf(fetch, 'originator')).toBe('codex_cli_rs');
    expect(headerOf(fetch, 'chatgpt-account-id')).toBe('acc');
  });

  it("is the host's own on a turn and on the catalog request when the connection says", async () => {
    const fetch = vi.fn<Fetch>(async () => json({ error: { message: 'down' } }, 503));
    const conn: Connection = { kind: 'chatgpt', baseUrl: '', model: 'gpt-5.5', originator: 'myext' };
    await chat(conn, 'tok', req, { fetch });
    expect(headerOf(fetch, 'originator')).toBe('myext');

    const listing = vi.fn<Fetch>(async () => catalog());
    expect(await listModels(conn, 'tok', { fetch: listing })).toMatchObject([{ id: 'gpt-5.5' }]);
    expect(headerOf(listing, 'originator')).toBe('myext');
    expect(String(listing.mock.calls[0]![0])).toContain('/backend-api/codex/models');
  });

  it('codexModels() takes it directly, and an empty one means the default', async () => {
    const fetch = vi.fn<Fetch>(async () => catalog());
    await codexModels({ accessToken: 'tok', originator: 'myext' }, { fetch });
    await codexModels({ accessToken: 'tok', originator: '' }, { fetch });
    await codexModels({ accessToken: 'tok' }, { fetch });
    expect([0, 1, 2].map((call) => headerOf(fetch, 'originator', call))).toEqual(['myext', 'codex_cli_rs', 'codex_cli_rs']);
  });

  it('is not sent on an Anthropic or OpenAI-compatible connection, whatever the connection says', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ error: { message: 'down' } }, 503));
    await chat({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', originator: 'myext' }, 'k', req, { fetch });
    expect(headerOf(fetch, 'originator')).toBeUndefined();
  });
});
