/**
 * A failure as data (#34): every failed `chat()` result carries `failure`
 * with its kind, the provider's code and request id when given, and whether
 * output had streamed — in which case it is never retryable, and `withRetry`
 * leaves it alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, HttpError, listModels, withRetry, type Connection, type Fetch } from '../src/core/index.js';
import { providerCodeOf, requestIdOf } from '../src/core/failure.js';
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

  it('network: the connection dropped, with what the transport said', async () => {
    const fetch = vi.fn<Fetch>(async () => { throw new TypeError('fetch failed: ECONNRESET'); });
    expect(await chat(conn, 'k', req, { fetch })).toMatchObject({ retryable: true, failure: { kind: 'network', cause: 'fetch failed: ECONNRESET', streamed: false } });
  });

  it('http: the status, the provider\'s code and request id', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota.' } }, 429, { 'x-request-id': 'req_123' }));
    const result = await chat(conn, 'k', req, { fetch });
    expect(result.failure).toEqual({ kind: 'http', status: 429, providerCode: 'insufficient_quota', requestId: 'req_123', streamed: false });
    expect(result.retryable).toBeUndefined();
    const anthropic = vi.fn<Fetch>(async () => json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529, { 'request-id': 'req_abc' }));
    expect(await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' }, 'sk', req, { fetch: anthropic }))
      .toMatchObject({ retryable: true, failure: { kind: 'http', status: 529, providerCode: 'overloaded_error', requestId: 'req_abc' } });
  });

  it('stream: a failure event with the provider\'s code, or a stream that ended early', async () => {
    const error = vi.fn<Fetch>(async () => sse(anthropicSse([{ type: 'message_start', message: { usage: {} } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])));
    expect(await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' }, 'sk', req, { fetch: error }))
      .toMatchObject({ failure: { kind: 'stream', providerCode: 'overloaded_error', streamed: false } });
    const cut = vi.fn<Fetch>(async () => sse(openaiSse([{ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }], false)));
    expect(await chat(conn, 'k', req, { fetch: cut })).toMatchObject({ retryable: true, failure: { kind: 'stream', streamed: false } });
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
    const result = await chat(conn, 'k', req, { fetch });
    expect(result).toMatchObject({ ok: false, error: 'The response stream ended before it finished.', failure: { kind: 'stream', streamed: true } });
    expect(result).not.toHaveProperty('retryable');
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
    expect(requestIdOf(new Headers({ 'x-request-id': ' req_1 ' }))).toBe('req_1');
    expect(requestIdOf(new Headers({ 'request-id': 'req_2', 'x-request-id': 'req_3' }))).toBe('req_2');
    expect(requestIdOf(new Headers())).toBeUndefined();
    expect(requestIdOf(undefined)).toBeUndefined();
  });
});
