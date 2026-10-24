/**
 * The ChatGPT device flow against mocked auth.openai.com responses: starting,
 * every poll outcome, the form-encoded exchange, refresh rotation, expiry and
 * account id from the JWT, and Codex text streaming.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_TIMEOUT_MS,
  accountIdFromJwt,
  codexComplete,
  exchangeDeviceCode,
  nextPollDelayMs,
  pollDevice,
  refreshOpenAiTokens,
  startDeviceLogin,
} from '../src/core/openai-oauth.js';
import { streamOf } from './helpers.js';

function mockFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const res of responses) fetch.mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An unsigned JWT with the given payload (only the payload is ever read). */
const jwt = (payload: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

const withAccount = (id: string, extra: Record<string, unknown> = {}) =>
  jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: id }, ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startDeviceLogin', () => {
  it('returns the poll key, user code and a bounded window', async () => {
    vi.useFakeTimers({ now: 5000 });
    const fetch = mockFetch(json({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '7' }));
    expect(await startDeviceLogin()).toEqual({
      deviceAuthId: 'dev-1',
      userCode: 'ABCD-1234',
      verifyUrl: 'https://auth.openai.com/codex/device',
      intervalSec: 7,
      expiresAt: 5000 + DEVICE_TIMEOUT_MS,
    });
    expect(fetch.mock.calls[0]![0]).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
  });

  it.each([undefined, 0, -3, 'soon'])('falls back to a 5s interval for %j', async (interval) => {
    mockFetch(json({ device_auth_id: 'd', user_code: 'u', interval }));
    expect((await startDeviceLogin()).intervalSec).toBe(5);
  });

  it('tells the user to enable device codes on a 404', async () => {
    mockFetch(new Response('', { status: 404 }));
    await expect(startDeviceLogin()).rejects.toThrow('Enable device code authorization for Codex');
  });

  it('rejects other failures and responses without a code', async () => {
    mockFetch(new Response('boom', { status: 500 }), json({ device_auth_id: 'd' }));
    // The status and the code, never the body.
    const failure = await startDeviceLogin().catch((error: unknown) => error as Error);
    expect(failure).toMatchObject({ name: 'AuthError', status: 500, message: 'Device login start failed (HTTP 500).' });
    expect(String(failure)).not.toContain('boom');
    await expect(startDeviceLogin()).rejects.toThrow('returned no code');
  });
});

describe('pollDevice', () => {
  it('posts the poll key and user code', async () => {
    const fetch = mockFetch(new Response('', { status: 403 }));
    await pollDevice('dev-1', 'ABCD');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ device_auth_id: 'dev-1', user_code: 'ABCD' });
  });

  it('returns the authorization code and server-issued verifier', async () => {
    mockFetch(json({ authorization_code: 'ac', code_verifier: 'cv' }));
    expect(await pollDevice('d', 'u')).toEqual({ status: 'authorized', authorizationCode: 'ac', codeVerifier: 'cv' });
  });

  it.each([
    ['403', () => new Response('', { status: 403 }), { status: 'pending' }],
    ['404', () => new Response('', { status: 404 }), { status: 'pending' }],
    ['pending as a string', () => json({ error: 'deviceauth_authorization_pending' }, 400), { status: 'pending' }],
    ['pending as an object', () => json({ error: { code: 'deviceauth_authorization_pending' } }, 400), { status: 'pending' }],
    ['slow_down', () => json({ error: 'slow_down' }, 400), { status: 'slow_down' }],
    ['a 429 while polling', () => new Response('', { status: 429 }), { status: 'slow_down' }],
  ])('maps %s', async (_name, response, expected) => {
    mockFetch(response());
    expect(await pollDevice('d', 'u')).toEqual(expected);
  });

  it('denies on a refusal, keeping the body; a server failure or a dropped connection is not the user\'s answer, so it keeps polling', async () => {
    mockFetch(json({ error: 'access_denied' }, 400), new Response('gateway', { status: 502 }));
    expect(await pollDevice('d', 'u')).toEqual({ status: 'denied', error: 'Device auth failed (400: access_denied).' });
    expect(await pollDevice('d', 'u')).toEqual({ status: 'pending' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await pollDevice('d', 'u')).toEqual({ status: 'pending' });
    // A sentence in the error field is not a code, and is not echoed.
    mockFetch(json({ error: 'Invalid device token SECRET_TOKEN' }, 400));
    expect(await pollDevice('d', 'u')).toEqual({ status: 'denied', error: 'Device auth failed (400).' });
    // The caller's own stop is not the network: it is thrown, not polled past.
    const stop = new AbortController(); stop.abort();
    const aborted = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); });
    await expect(pollDevice('d', 'u', { fetch: aborted, signal: stop.signal })).rejects.toThrow('aborted');
  });

  it('denies a success response missing the code or verifier', async () => {
    mockFetch(json({ authorization_code: 'ac' }));
    expect(await pollDevice('d', 'u')).toEqual({ status: 'denied', error: 'Malformed device token response.' });
  });
});

describe('exchangeDeviceCode', () => {
  it('posts a form with the device redirect uri; expiry and account come from the access token', async () => {
    const access = withAccount('acct-1', { exp: 2_000_000 });
    const fetch = mockFetch(json({ access_token: access, refresh_token: 'rt', expires_in: 60 }));
    const tokens = await exchangeDeviceCode({ authorizationCode: 'ac', codeVerifier: 'cv' });

    expect(tokens).toEqual({ accessToken: access, refreshToken: 'rt', expiresAt: 2_000_000_000, accountId: 'acct-1' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://auth.openai.com/oauth/token');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'ac',
      code_verifier: 'cv',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
    });
  });

  it('falls back to expires_in and the id token when the access token is opaque', async () => {
    vi.useFakeTimers({ now: 1000 });
    mockFetch(json({ access_token: 'opaque', refresh_token: 'rt', id_token: withAccount('acct-2'), expires_in: 120 }));
    const tokens = await exchangeDeviceCode({ authorizationCode: 'ac', codeVerifier: 'cv' });
    expect(tokens).toMatchObject({ expiresAt: 1000 + 120_000, accountId: 'acct-2' });
  });

  it('fails on an error status or a missing access token', async () => {
    mockFetch(new Response('bad code', { status: 400 }), json({ refresh_token: 'rt' }));
    await expect(exchangeDeviceCode({ authorizationCode: 'ac', codeVerifier: 'cv' })).rejects.toThrow('Code exchange failed (HTTP 400).');
    await expect(exchangeDeviceCode({ authorizationCode: 'ac', codeVerifier: 'cv' })).rejects.toThrow('missing access_token');
  });
});

describe('refreshOpenAiTokens', () => {
  it('returns the rotated refresh token', async () => {
    const fetch = mockFetch(json({ access_token: 'at2', refresh_token: 'rt2' }));
    expect((await refreshOpenAiTokens('rt1')).refreshToken).toBe('rt2');
    expect(new URLSearchParams(String(fetch.mock.calls[0]![1]!.body)).get('refresh_token')).toBe('rt1');
  });

  it('keeps the old refresh token when the response omits one', async () => {
    mockFetch(json({ access_token: 'at2' }));
    expect((await refreshOpenAiTokens('rt1')).refreshToken).toBe('rt1');
  });

  it('fails on an error status, and names a revoked sign-in as one to redo', async () => {
    mockFetch(new Response('down', { status: 502 }), new Response('invalid_grant', { status: 401 }));
    await expect(refreshOpenAiTokens('rt1')).rejects.toThrow('Token refresh failed (HTTP 502).');
    await expect(refreshOpenAiTokens('rt1')).rejects.toThrow('Your ChatGPT sign-in was revoked or expired — remove the connection and sign in again.');
  });
});

describe('helpers', () => {
  it('reads the account id only from a well-formed token', () => {
    expect(accountIdFromJwt(withAccount('acct-1'))).toBe('acct-1');
    expect(accountIdFromJwt(withAccount(''))).toBeUndefined();
    expect(accountIdFromJwt(jwt({ sub: 'x' }))).toBeUndefined();
    expect(accountIdFromJwt('not-a-jwt')).toBeUndefined();
    expect(accountIdFromJwt('a.!!!.c')).toBeUndefined();
  });

  it('floors the poll delay at 2s and backs off 5s per slow_down', () => {
    expect(nextPollDelayMs(5, 0)).toBe(5000);
    expect(nextPollDelayMs(1, 0)).toBe(2000);
    expect(nextPollDelayMs(5, 2)).toBe(15_000);
  });
});

describe('codexComplete', () => {
  const input = { accessToken: 'at', model: 'gpt-5.5', system: '', prompt: 'Hi' };

  it('joins text deltas across arbitrary chunk boundaries', async () => {
    const sse = [
      'data: {"type":"response.created"}',
      'data: {"type":"response.output_text.delta","delta":"  Hello, "}',
      ': keepalive',
      'data: not json',
      'data: {"type":"response.output_text.delta","delta":"wörld  "}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetch = mockFetch(new Response(streamOf(sse, 5), { status: 200 }));
    expect(await codexComplete({ ...input, accountId: 'acct-1' }, new AbortController().signal)).toBe('Hello, wörld');

    const init = fetch.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ 'chatgpt-account-id': 'acct-1', accept: 'text/event-stream' });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-5.5', stream: true, store: false, instructions: 'You are a helpful assistant.' });
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('omits the account header when there is no account id', async () => {
    const fetch = mockFetch(new Response('', { status: 200 }));
    await codexComplete(input, new AbortController().signal);
    expect(fetch.mock.calls[0]![1]!.headers).not.toHaveProperty('chatgpt-account-id');
  });

  it('fails with the status and the code, never the body', async () => {
    mockFetch(new Response(JSON.stringify({ error: { code: 'usage_limit_reached', message: 'y'.repeat(500) } }), { status: 401 }));
    const failure = await codexComplete(input, new AbortController().signal).catch((error: unknown) => error as Error);
    expect(failure).toMatchObject({ name: 'AuthError', status: 401, code: 'usage_limit_reached', message: 'Codex request failed (HTTP 401: usage_limit_reached).' });
    expect(String(failure)).not.toContain('yyyy');
  });
});
