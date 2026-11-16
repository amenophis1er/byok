// The handlers on a host that is not a Chrome extension's worker (useAiPlatform): the same messages and results,
// with the connections kept where the host says, and never a `chrome` call.
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiSse, streamOf } from './helpers.js';
import { chat, createAiMessageHandler, useAiPlatform, type AiPlatform, type EncBlob } from '../src/background/index.js';

/** A host's own: maps for storage, a key of its own for the secrets (as a daemon would keep one in the system's keychain). */
async function memoryPlatform() {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const opened: string[] = [];
  const signing = new Map<string, CryptoKeyPair>();
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const b64 = (b: ArrayBuffer) => Buffer.from(b).toString('base64');
  const platform: AiPlatform = {
    local: { get: async (k) => structuredClone(local.get(k)), set: async (k, v) => { local.set(k, structuredClone(v)); } },
    session: { get: async (k) => session.get(k), set: async (k, v) => { session.set(k, v); }, remove: async (k) => { session.delete(k); } },
    openTab: async (url) => { opened.push(url); },
    secrets: {
      encryptString: async (plain) => {
        if (!plain) return { iv: '', ct: '' };
        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        return { iv: b64(iv.buffer), ct: b64(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))) };
      },
      decryptBlob: async (blob: EncBlob | null | undefined) => {
        if (!blob?.ct) return '';
        return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(blob.iv, 'base64') }, key, Buffer.from(blob.ct, 'base64')));
      },
      createSigningKey: async (id) => { const pair = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair; signing.set(id, pair); return pair; },
      getSigningKey: async (id) => signing.get(id),
      deleteSigningKey: async (id) => { signing.delete(id); },
    },
  };
  return { platform, local, session, opened, signing };
}

const ask = (handle: ReturnType<typeof createAiMessageHandler>, message: Record<string, unknown>) =>
  new Promise<any>((resolve, reject) => { if (!handle(message as { type?: string }, resolve)) reject(new Error(`not handled: ${String(message.type)}`)); });

describe('a host of its own (useAiPlatform)', () => {
  afterEach(() => { useAiPlatform(); vi.unstubAllGlobals(); });

  it('keeps connections where the host says, encrypted by the host, and answers as the worker does', async () => {
    vi.stubGlobal('chrome', undefined); // a `chrome` call would throw
    const host = await memoryPlatform();
    useAiPlatform(host.platform);
    const handle = createAiMessageHandler({ prefix: 'd', openConsentTab: false });

    expect(await ask(handle, { type: 'd:ai-get' })).toEqual({ activeId: null, connections: [] });
    const saved = await ask(handle, { type: 'd:ai-save-connection', kind: 'openai-compatible', label: '', baseUrl: 'https://api.example.test/v1', model: 'm-1', apiKeyMode: 'set', apiKey: 'sk-secret-1234', makeActive: true });
    expect(saved.ok).toBe(true);

    // what is kept: under the host's key, no secret in the clear
    const kept = JSON.stringify(host.local.get('aiConnections'));
    expect(kept).toContain('https://api.example.test/v1');
    expect(kept).not.toContain('sk-secret-1234');

    // what a UI is shown: the key's last characters only
    const view = await ask(handle, { type: 'd:ai-get' });
    expect(view.activeId).toBe(saved.data.id);
    expect(view.connections[0]).toMatchObject({ kind: 'openai-compatible', model: 'm-1', hasKey: true, keyHint: '····1234' });

    // a turn goes to the connection's server with its key
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(streamOf(openaiSse([{ choices: [{ delta: { content: 'hello from the host' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const turn = await chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(turn).toMatchObject({ ok: true, text: 'hello from the host' });
    expect(calls[0]).toEqual({ url: 'https://api.example.test/v1/chat/completions', auth: 'Bearer sk-secret-1234' });

    expect((await ask(handle, { type: 'd:ai-delete-connection', id: saved.data.id })).ok).toBe(true);
    expect((await ask(handle, { type: 'd:ai-get' })).connections).toEqual([]);
  });

  it('a saved key goes only to the server it was saved for', async () => {
    vi.stubGlobal('chrome', undefined);
    const host = await memoryPlatform();
    useAiPlatform(host.platform);
    const handle = createAiMessageHandler({ prefix: 'd', openConsentTab: false });
    const saved = await ask(handle, { type: 'd:ai-save-connection', kind: 'openai-compatible', label: '', baseUrl: 'https://api.example.test/v1', model: 'm-1', apiKeyMode: 'set', apiKey: 'sk-secret-1234', makeActive: true });
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ data: [{ id: 'm-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const id = saved.data.id;

    // listing with the saved key: at its own server (another path of it too), never at another
    expect((await ask(handle, { type: 'd:ai-list-models', kind: 'openai-compatible', baseUrl: 'https://api.example.test/v1', apiKey: '', id })).ok).toBe(true);
    expect((await ask(handle, { type: 'd:ai-list-models', kind: 'openai-compatible', baseUrl: 'https://api.example.test/gateway/v1', apiKey: '', id })).ok).toBe(true);
    const sentTo = calls.length;
    for (const baseUrl of ['https://collector.example/v1', 'http://api.example.test/v1', 'https://api.example.test:8443/v1']) {
      const r = await ask(handle, { type: 'd:ai-list-models', kind: 'openai-compatible', baseUrl, apiKey: '', id });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/saved for another server/) });
    }
    expect((await ask(handle, { type: 'd:ai-list-models', kind: 'anthropic', baseUrl: '', apiKey: '', id })).ok).toBe(false); // nor as another provider's
    expect(calls.length).toBe(sentTo); // nothing left for those
    // nor to ChatGPT: asked as a ChatGPT listing, a key of another provider is not used (the built-in list answers)
    const codex = await ask(handle, { type: 'd:ai-list-models', kind: 'chatgpt', baseUrl: '', apiKey: '', id });
    expect(codex.ok).toBe(true);
    expect(calls.length).toBe(sentTo);
    // its own server typed as people type it (no scheme, a trailing slash) is still its own
    expect((await ask(handle, { type: 'd:ai-list-models', kind: 'openai-compatible', baseUrl: 'api.example.test/v1/', apiKey: '', id })).ok).toBe(true);
    calls.length = sentTo;
    // an address that would swallow the request's own path is no API root
    for (const baseUrl of ['https://api.example.test/private/x?x=', 'https://api.example.test/v1#', 'https://user:pw@api.example.test/v1']) {
      expect((await ask(handle, { type: 'd:ai-list-models', kind: 'openai-compatible', baseUrl, apiKey: 'sk-typed' })).ok).toBe(false);
    }
    expect(calls.length).toBe(sentTo);
    // with a key typed in the form, any server: that key is the form's to send
    expect((await ask(handle, { type: 'd:ai-list-models', kind: 'openai-compatible', baseUrl: 'https://collector.example/v1', apiKey: 'sk-typed', id })).ok).toBe(true);
    expect(calls.at(-1)).toEqual({ url: 'https://collector.example/v1/models', auth: 'Bearer sk-typed' });

    // saving: the kept key does not follow the connection to another server
    const base = { type: 'd:ai-save-connection', id, kind: 'openai-compatible', label: 'x', model: 'm-2' };
    expect(await ask(handle, { ...base, baseUrl: 'https://collector.example/v1', apiKeyMode: 'keep' })).toEqual({ ok: false, error: expect.stringMatching(/saved for another server/) });
    expect(await ask(handle, { ...base, baseUrl: 'https://collector.example/v1' })).toEqual({ ok: false, error: expect.stringMatching(/saved for another server/) }); // (no mode said: kept)
    expect((await ask(handle, { type: 'd:ai-get' })).connections[0]).toMatchObject({ baseUrl: 'https://api.example.test/v1', model: 'm-1' }); // untouched
    expect((await ask(handle, { ...base, baseUrl: 'https://api.example.test/v1', apiKeyMode: 'keep' })).ok).toBe(true); // its model changed, same server
    expect((await ask(handle, { ...base, baseUrl: 'https://collector.example/v1', apiKeyMode: 'set', apiKey: 'sk-new-0000' })).ok).toBe(true); // typed again: its to send
    expect((await ask(handle, { ...base, baseUrl: 'https://third.example/v1', apiKeyMode: 'clear' })).ok).toBe(true); // or cleared
  });

  it('a secret that cannot be opened does not hide the connections: listed without a key, to be fixed or removed', async () => {
    vi.stubGlobal('chrome', undefined);
    const host = await memoryPlatform();
    useAiPlatform(host.platform);
    const handle = createAiMessageHandler({ prefix: 'd', openConsentTab: false });
    const a = await ask(handle, { type: 'd:ai-save-connection', kind: 'openai-compatible', label: 'A', baseUrl: 'https://a.example/v1', model: 'm', apiKeyMode: 'set', apiKey: 'sk-aaaa1111' });
    await ask(handle, { type: 'd:ai-save-connection', kind: 'openai-compatible', label: 'B', baseUrl: 'https://b.example/v1', model: 'm', apiKeyMode: 'set', apiKey: 'sk-bbbb2222' });
    // A's secret no longer opens (sealed under a key that is gone)
    const cfg = host.local.get('aiConnections') as { connections: { id: string; apiKeyEnc: { iv: string; ct: string } }[] };
    cfg.connections.find((c) => c.id === a.data.id)!.apiKeyEnc.ct = Buffer.from('not what was sealed, at all').toString('base64');
    const view = await ask(handle, { type: 'd:ai-get' });
    expect(view.connections.map((c: { label: string; hasKey: boolean; keyHint: string }) => [c.label, c.hasKey, c.keyHint])).toEqual([['A', false, ''], ['B', true, '····2222']]);
    expect((await ask(handle, { type: 'd:ai-delete-connection', id: a.data.id })).ok).toBe(true);
  });

  it('what the host\'s store hands out is not changed before it is saved: a save that fails leaves nothing half made', async () => {
    vi.stubGlobal('chrome', undefined);
    const host = await memoryPlatform();
    const kept = new Map<string, unknown>(); // a store that hands out its own objects
    useAiPlatform({
      ...host.platform,
      local: { get: async (k) => kept.get(k), set: async (k, v) => { kept.set(k, v); } },
      secrets: { ...host.platform.secrets, encryptString: async (plain) => { if (plain === 'boom') throw new Error('no key to seal with'); return host.platform.secrets.encryptString(plain); } },
    });
    const handle = createAiMessageHandler({ prefix: 'd', openConsentTab: false });
    await ask(handle, { type: 'd:ai-save-connection', kind: 'openai-compatible', label: 'One', baseUrl: 'https://a.example/v1', model: 'm', apiKeyMode: 'set', apiKey: 'sk-aaaa1111' });
    const failed = await ask(handle, { type: 'd:ai-save-connection', kind: 'openai-compatible', label: 'Two', baseUrl: 'https://b.example/v1', model: 'm', apiKeyMode: 'set', apiKey: 'boom' });
    expect(failed).toEqual({ ok: false, error: 'no key to seal with' });
    expect((await ask(handle, { type: 'd:ai-get' })).connections.map((c: { label: string }) => c.label)).toEqual(['One']);
  });

  it('a handler that fails answers so: storage that cannot be read is an error, not a silence', async () => {
    vi.stubGlobal('chrome', undefined);
    const host = await memoryPlatform();
    useAiPlatform({ ...host.platform, local: { get: async () => { throw new Error('the disk said no'); }, set: async () => { throw new Error('the disk said no'); } } });
    const handle = createAiMessageHandler({ prefix: 'd', openConsentTab: false });
    expect(await ask(handle, { type: 'd:ai-get' })).toEqual({ ok: false, error: 'the disk said no' });
    expect(await ask(handle, { type: 'd:ai-set-active', id: null })).toEqual({ ok: false, error: 'the disk said no' });
    expect(await ask(handle, { type: 'd:ai-delete-connection', id: 'x' })).toEqual({ ok: false, error: 'the disk said no' });
  });

  it('a sign-in in progress is kept in the host\'s session, and no page is opened when the host leaves that to its UI', async () => {
    vi.stubGlobal('chrome', undefined);
    const host = await memoryPlatform();
    useAiPlatform(host.platform);
    const quiet = createAiMessageHandler({ prefix: 'd', openConsentTab: false });
    const start = await ask(quiet, { type: 'd:ai-anthropic-login-start' });
    expect(start.ok).toBe(true);
    expect(start.data.authorizeUrl).toMatch(/^https:\/\//);
    expect(host.session.size).toBe(1);
    expect(host.opened).toEqual([]);
    // a host that does open pages is asked to, with the same address
    const opening = createAiMessageHandler({ prefix: 'd' });
    const again = await ask(opening, { type: 'd:ai-anthropic-login-start' });
    expect(host.opened).toEqual([again.data.authorizeUrl]);
  });
});
