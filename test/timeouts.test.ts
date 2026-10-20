/**
 * The two limits on a turn (#39): the whole-request one, which `0` turns
 * off, and the idle one, which fails the turn only when the server goes
 * quiet, from the request going out and between chunks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, TIMED_OUT, type Connection } from '../src/core/index.js';
import { openaiSse } from './helpers.js';

const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' };
const req = { system: '', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [] };
const chunks = openaiSse([
  { choices: [{ index: 0, delta: { content: 'Hello.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]).split('\n\n').filter(Boolean).map((c) => `${c}\n\n`);

/** A stream that sends each chunk after `gapMs`, honouring the fetch signal as a real body does. */
function slowBody(gapMs: number, signal: AbortSignal | null | undefined, stall = false): ReadableStream<Uint8Array> {
  let i = 0;
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          if (i >= chunks.length) { controller.close(); resolve(); return; }
          controller.enqueue(encoder.encode(chunks[i++]!));
          resolve();
        }, stall && i === 1 ? 10 * 60_000 : gapMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('the whole-request limit', () => {
  it('is off with 0: a slow stream finishes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(slowBody(30, init.signal), { status: 200 })));
    expect(await chat(conn, 'k', req, { timeoutMs: 0 })).toMatchObject({ ok: true, text: 'Hello.' });
    expect(await chat(conn, 'k', { ...req, timeoutMs: 0 }, { timeoutMs: 20 })).toMatchObject({ ok: true, text: 'Hello.' });
  });

  it('still cuts a slow stream when set', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(slowBody(30, init.signal), { status: 200 })));
    expect(await chat(conn, 'k', req, { timeoutMs: 40 })).toEqual({ ok: false, error: TIMED_OUT });
  });
});

describe('the idle limit', () => {
  it('lets a stream run as long as it keeps sending, past the whole-request limit when that is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(slowBody(20, init.signal), { status: 200 })));
    expect(await chat(conn, 'k', req, { timeoutMs: 0, idleTimeoutMs: 60 })).toMatchObject({ ok: true, text: 'Hello.' });
  });

  it('cuts a stream that goes quiet mid-turn, and names it a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(slowBody(5, init.signal, true), { status: 200 })));
    const seen: string[] = [];
    expect(await chat(conn, 'k', req, { timeoutMs: 0, idleTimeoutMs: 40, onEvent: (e) => { if (e.type === 'text') seen.push(e.delta); } }))
      .toEqual({ ok: false, error: TIMED_OUT });
    expect(seen).toEqual(['Hello.']);
  });

  it('covers the wait for the first byte too', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    expect(await chat(conn, 'k', { ...req, idleTimeoutMs: 30 }, { timeoutMs: 0 })).toEqual({ ok: false, error: TIMED_OUT });
  });

  it('does not re-arm after the turn: a body still open at [DONE] is cancelled, not left pending', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) { controller.enqueue(new TextEncoder().encode(chunks.join('') + 'data: [DONE]\n\n')); return; }
        return new Promise(() => undefined); // more may come, never does
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const timeout = vi.fn();
    expect(await chat(conn, 'k', req, { timeoutMs: 0, idleTimeoutMs: 30, onEvent: () => undefined })).toMatchObject({ ok: true, text: 'Hello.' });
    await new Promise((r) => setTimeout(r, 60));
    expect(cancelled).toBe(true);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('is off by default and with 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(slowBody(25, init.signal), { status: 200 })));
    expect(await chat(conn, 'k', req, { idleTimeoutMs: 0 })).toMatchObject({ ok: true });
    expect(await chat(conn, 'k', req)).toMatchObject({ ok: true });
  });
});
