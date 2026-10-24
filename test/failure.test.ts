/**
 * A failure as data (#34): every failed `chat()` result carries `failure`
 * with its kind, the provider's code and request id when given, and whether
 * output had streamed — in which case it is never retryable, and `withRetry`
 * leaves it alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, HttpError, listModels, transportCode, withRetry, type Connection, type Fetch } from '../src/core/index.js';
import { providerCodeOf, providerDetailsOf, requestIdOf } from '../src/core/failure.js';
import { describeHttpText } from '../src/core/http.js';
import { anthropicSse, openaiSse, streamOf } from './helpers.js';

const conn: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' };
const req = { system: '', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [] };
const json = (body: unknown, status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const sse = (text: string) => new Response(streamOf(text, 11), { status: 200, headers: { 'content-type': 'text/event-stream' } });

afterEach(() => vi.unstubAllGlobals());

describe('the kinds', () => {
  it('request: refused before anything went out', async () => {
    const fetch = vi.fn<Fetch>();
    expect(await chat({ ...conn, model: undefined }, 'k', req, { fetch })).toMatchObject({ failure: { kind: 'request', streamed: false } });
    expect(await chat({ kind: 'chrome-builtin', baseUrl: '' }, '', req, { fetch })).toMatchObject({ failure: { kind: 'request', streamed: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('request: a body that will not serialise, with nothing sent and no retry', async () => {
    const fetch = vi.fn<Fetch>();
    const poison = { toJSON() { throw new Error('no way'); } };
    const turn = (args: Record<string, unknown>, extra: unknown) => ({ ...req, messages: [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, toolCalls: [{ id: 'c1', name: 't', args }], providerState: { protocol: 'chat-completions', extraContent: { c1: extra } } },
      { role: 'tool' as const, toolCallId: 'c1', name: 't', content: 'ok' },
    ] });
    const result = await chat(conn, 'k', turn({}, poison), { fetch });
    expect(result).toMatchObject({ ok: false, error: 'The request body could not be serialised: no way', failure: { kind: 'request', cause: 'no way', streamed: false } });
    expect(result).not.toHaveProperty('retryable');
    expect(fetch).not.toHaveBeenCalled();
    // A cycle throws a TypeError, wherever the body is built: not the transport's.
    const loop: Record<string, unknown> = {}; loop['me'] = loop;
    for (const bad of [turn({}, loop), turn(loop, undefined)]) {
      const cyclic = await chat(conn, 'k', bad, { fetch });
      expect(cyclic).toMatchObject({ failure: { kind: 'request', cause: expect.stringMatching(/circular/i) } });
      expect(cyclic.error).toMatch(/^The request (body could not be serialised|could not be built): .*circular/i);
      expect(cyclic.error).not.toMatch(/network/i);
      expect(cyclic).not.toHaveProperty('retryable');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('network: the connection dropped, with what the transport said', async () => {
    const fetch = vi.fn<Fetch>(async () => { throw new TypeError('fetch failed: ECONNRESET'); });
    expect(await chat(conn, 'k', req, { fetch })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'fetch failed: ECONNRESET', streamed: false } });
    // Whatever a host's fetch rejects with: its own Error, with a code, or a bare object.
    const own = vi.fn<Fetch>(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
    expect(await chat(conn, 'k', req, { fetch: own })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'socket hang up (ECONNRESET)', streamed: false } });
    const chained = vi.fn<Fetch>(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ERR_SOCKET_CONNECTION_TIMEOUT' }) }); });
    expect(await chat(conn, 'k', req, { fetch: chained })).toMatchObject({ failure: { kind: 'network', cause: 'fetch failed (ERR_SOCKET_CONNECTION_TIMEOUT: connect ETIMEDOUT)', code: 'ERR_SOCKET_CONNECTION_TIMEOUT' } });
    // The code is the innermost down the chain, however deep; none when no link has one; a cycle ends the walk.
    const deep = vi.fn<Fetch>(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('transport'), { code: 'OUTER', cause: { code: 'ECONNRESET' } }) }); });
    expect(await chat(conn, 'k', req, { fetch: deep })).toMatchObject({ failure: { kind: 'network', code: 'ECONNRESET' } });
    expect(transportCode(new TypeError('fetch failed'))).toBeUndefined();
    const loop: { code: string; cause?: unknown } = { code: 'A' }; loop.cause = loop;
    expect(transportCode(loop)).toBe('A');
    const bare = vi.fn<Fetch>(async () => { throw { code: 'ECONNRESET' }; });
    expect(await chat(conn, 'k', req, { fetch: bare })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'ECONNRESET', code: 'ECONNRESET' } });
    const mute = vi.fn<Fetch>(async () => { throw undefined; });
    expect(await chat(conn, 'k', req, { fetch: mute })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'The request failed.' } });
    // A body whose read fails is the transport's too: retryable before anything streamed, not after.
    const failing = (first?: string) => new ReadableStream<Uint8Array>({
      pull(controller) { if (first) { controller.enqueue(new TextEncoder().encode(first)); first = undefined; } else controller.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })); },
    });
    const early = vi.fn<Fetch>(async () => new Response(failing(), { status: 200 }));
    expect(await chat(conn, 'k', req, { fetch: early })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'read ECONNRESET (ECONNRESET)', streamed: false } });
    const late = vi.fn<Fetch>(async () => new Response(failing('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n'), { status: 200 }));
    const cut = await chat(conn, 'k', req, { fetch: late, onEvent: () => undefined });
    expect(cut).toMatchObject({ failure: { kind: 'network', streamed: true } });
    expect(cut).not.toHaveProperty('retryable');
    // Without a sink nothing streamed to anyone: the same request may go again.
    expect(await chat(conn, 'k', req, { fetch: late })).toMatchObject({ retryable: true, failure: { kind: 'network', streamed: false } });
    // A refused response whose body cannot be read is the transport's failure too.
    const refusedCut = vi.fn<Fetch>(async () => new Response(failing(), { status: 503 }));
    expect(await chat(conn, 'k', req, { fetch: refusedCut })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'read ECONNRESET (ECONNRESET)' } });
    // Not a dropped connection: the caller's abort, or a provider that refused.
    const stop = new AbortController();
    const aborted = vi.fn<Fetch>(async (_url, init) => { stop.abort(); throw (init!.signal as AbortSignal).reason; });
    expect(await chat(conn, 'k', req, { fetch: aborted, signal: stop.signal })).toMatchObject({ failure: { kind: 'stopped' } });
  });

  it('http: the status, the provider\'s code and request id', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota.' } }, 429, { 'x-request-id': 'req_123' }));
    const result = await chat(conn, 'k', req, { fetch });
    expect(result.failure).toEqual({ kind: 'http', status: 429, providerCode: 'insufficient_quota', providerMessage: 'You exceeded your current quota.', requestId: 'req_123', streamed: false });
    expect(result.retryable).toBeUndefined();
    const anthropic = vi.fn<Fetch>(async () => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529, { 'request-id': 'req_abc' }));
    expect(await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' }, 'sk', req, { fetch: anthropic }))
      .toMatchObject({ retryable: true, failure: { kind: 'http', status: 529, providerCode: 'overloaded_error', providerMessage: 'Overloaded', requestId: 'req_abc' } });
    // The type apart from the code when both are given; the message as written, cut at 2000 characters; nothing of ChatGPT's wording.
    const typed = vi.fn<Fetch>(async () => json({ error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'x'.repeat(2500) } }, 400));
    const long = await chat(conn, 'k', req, { fetch: typed });
    expect(long.failure).toMatchObject({ providerCode: 'context_length_exceeded', providerType: 'invalid_request_error' });
    expect(long.failure!.providerMessage).toBe(`${'x'.repeat(2000)}…`);
    expect((await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' }, 'sk', req, { fetch: anthropic })).failure).not.toHaveProperty('providerType');
    const codex = vi.fn<Fetch>(async () => json({ error: { type: 'usage_limit_reached', message: 'secret prompt echo' } }, 429));
    const hidden = await chat({ kind: 'chatgpt', baseUrl: '', model: 'gpt-5.5' }, 'tok', req, { fetch: codex });
    expect(hidden.failure).toMatchObject({ kind: 'http', status: 429, providerCode: 'usage_limit_reached' });
    expect(hidden.failure).not.toHaveProperty('providerMessage');
    expect(JSON.stringify(hidden)).not.toContain('secret prompt echo');
    expect(providerDetailsOf(JSON.stringify({ error: 'plain words' }))).toEqual({ providerMessage: 'plain words' });
    expect(providerDetailsOf(JSON.stringify({ error: { message: '  ' } }))).toEqual({});
    expect(providerDetailsOf('nope')).toEqual({});
  });

  it('stream: a failure event with the provider\'s code, or a stream that ended early', async () => {
    const error = vi.fn<Fetch>(async () => sse(anthropicSse([{ type: 'message_start', message: { usage: {} } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])));
    expect(await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' }, 'sk', req, { fetch: error }))
      .toMatchObject({ failure: { kind: 'stream', providerCode: 'overloaded_error', streamed: false } });
    const cut = vi.fn<Fetch>(async () => sse(openaiSse([{ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }], false)));
    expect(await chat(conn, 'k', req, { fetch: cut })).toMatchObject({ retryable: true, failure: { kind: 'stream', streamed: false } });
    // A Gemini prompt block is final, whatever its message says.
    const gemini: Connection = { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini', model: 'gemini-2.5-flash' };
    const blocked = vi.fn<Fetch>(async () => sse(openaiSse([{ promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'The prompt contains the phrase overloaded.' } }], false)));
    const block = await chat(gemini, 'k', req, { fetch: blocked });
    expect(block).toMatchObject({ ok: false, error: 'The prompt was blocked (SAFETY: The prompt contains the phrase overloaded.).', failure: { kind: 'stream', providerCode: 'SAFETY', streamed: false } });
    expect(block).not.toHaveProperty('retryable');
  });

  it('timeout, stopped and sink', async () => {
    // Like real fetch: reject at once on an already-aborted signal, else on abort.
    const hang = vi.fn<Fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (init?.signal?.aborted) abort();
      init?.signal?.addEventListener('abort', abort);
    }));
    expect(await chat(conn, 'k', req, { fetch: hang, timeoutMs: 10 })).toMatchObject({ failure: { kind: 'timeout', streamed: false } });
    const stop = new AbortController();
    const pending = chat(conn, 'k', req, { fetch: hang, signal: stop.signal });
    stop.abort(new Error('user left'));
    expect(await pending).toMatchObject({ error: 'Stopped.', failure: { kind: 'stopped', cause: 'user left', streamed: false } });
    const text = vi.fn<Fetch>(async () => sse(openaiSse([{ choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])));
    expect(await chat(conn, 'k', req, { fetch: text, onEvent: () => { throw new Error('client went away'); } }))
      .toMatchObject({ failure: { kind: 'sink', cause: 'client went away', streamed: true } });
  });
});

describe('once output has streamed', () => {
  const cutAfterText = () => sse(openaiSse([{ choices: [{ index: 0, delta: { content: 'Half an ans' }, finish_reason: null }] }], false));

  it('a cut-off stream is not retryable, and says so', async () => {
    const fetch = vi.fn<Fetch>(async () => cutAfterText());
    const result = await chat(conn, 'k', req, { fetch, onEvent: () => undefined });
    expect(result).toMatchObject({ ok: false, error: 'The response stream ended before it finished.', failure: { kind: 'stream', streamed: true, endedEarly: true } });
    expect(result).not.toHaveProperty('retryable');
    // An error the stream reported, without a code, is not a stream that ended early.
    const errored = vi.fn<Fetch>(async () => sse('data: {"error":{"message":"something broke"}}\n\n'));
    const reported = await chat(conn, 'k', req, { fetch: errored });
    expect(reported).toMatchObject({ ok: false, failure: { kind: 'stream' } });
    expect(reported.failure).not.toHaveProperty('endedEarly');
    expect(reported).not.toHaveProperty('retryable');
    // `streamed` means reached a caller: with no sink, nothing did, and the turn is worth another try.
    expect(await chat(conn, 'k', req, { fetch })).toMatchObject({ retryable: true, failure: { kind: 'stream', streamed: false } });
  });

  it('withRetry leaves it alone, whatever retryable says', async () => {
    const attempt = vi.fn(async () => ({ ok: false, error: 'cut', retryable: true, failure: { kind: 'stream' as const, streamed: true } }));
    expect(await withRetry(attempt, { sleep: async () => undefined })).toMatchObject({ error: 'cut' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('listModels() failures carry the same', () => {
  it('an HttpError with the provider\'s code and request id', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401, { 'x-request-id': 'req_9' }));
    const error = await listModels(conn, 'bad', { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401, providerCode: 'invalid_api_key', requestId: 'req_9' });
  });
});

describe('reading the code and the request id', () => {
  it('takes the first code-shaped field, in order, and nothing from junk', () => {
    expect(providerCodeOf(JSON.stringify({ error: { type: 'rate_limit_error', message: 'x' } }))).toBe('rate_limit_error');
    expect(providerCodeOf(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }))).toBe('RESOURCE_EXHAUSTED');
    expect(providerCodeOf(JSON.stringify({ detail: { code: 'usage_limit_reached' } }))).toBe('usage_limit_reached');
    expect(providerCodeOf(JSON.stringify({ code: 'E_NOPE' }))).toBe('E_NOPE');
    expect(providerCodeOf(JSON.stringify({ error: { code: 'a code with spaces, far too long to be one: '.repeat(3) } }))).toBeUndefined();
    expect(providerCodeOf('not json')).toBeUndefined();
    expect(providerCodeOf('[1]')).toBeUndefined();
    // The message is read from the same shapes, a body wrapped in an array included.
    expect(describeHttpText(429, JSON.stringify([{ error: { code: 429, message: 'Quota exceeded.' } }]))).toBe('HTTP 429: Quota exceeded.');
    expect(describeHttpText(400, JSON.stringify({ error: 'bad request' }))).toBe('HTTP 400: bad request');
    expect(describeHttpText(500, '[]')).toBe('HTTP 500: []');
    expect(describeHttpText(502, 'Bad gateway')).toBe('HTTP 502: Bad gateway');
    expect(describeHttpText(500, JSON.stringify({ error: { message: 7 } }))).toBe('HTTP 500: {"error":{"message":7}}');
    expect(requestIdOf(new Headers({ 'x-request-id': ' req_1 ' }))).toBe('req_1');
    expect(requestIdOf(new Headers({ 'request-id': 'req_2', 'x-request-id': 'req_3' }))).toBe('req_2');
    expect(requestIdOf(new Headers())).toBeUndefined();
    expect(requestIdOf(undefined)).toBeUndefined();
  });
});
