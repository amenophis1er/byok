/**
 * The OpenCode Console device grant against mocked opencode.ai responses:
 * starting, every poll outcome, refresh rotation, the headers one request
 * carries, and the poll delay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_BASE,
  OPENCODE_ORG_HEADER,
  opencodeAccount,
  opencodeHeaders,
  opencodePollDelayMs,
  pollOpencode,
  refreshOpencodeTokens,
  startOpencodeLogin,
} from '../src/core/opencode-oauth.js';

function mockFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const res of responses) fetch.mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const body = (fetch: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse(String((fetch.mock.calls[call]![1] as RequestInit).body)) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startOpencodeLogin', () => {
  it('posts the client id and returns the code, the pre-filled approval page and the window', async () => {
    vi.useFakeTimers({ now: 5000 });
    const fetch = mockFetch(json({
      device_code: 'dev-1', user_code: 'QHSC-JJMK', verification_uri: '/console/device',
      verification_uri_complete: '/console/device?user_code=QHSC-JJMK&client_id=valet', expires_in: 600, interval: 5,
    }));
    expect(await startOpencodeLogin('valet')).toEqual({
      deviceCode: 'dev-1',
      userCode: 'QHSC-JJMK',
      verifyUrl: 'https://opencode.ai/console/device?user_code=QHSC-JJMK&client_id=valet',
      intervalSec: 5,
      expiresAt: 5000 + 600_000,
    });
    expect(fetch.mock.calls[0]![0]).toBe('https://opencode.ai/console/auth/device/code');
    expect(body(fetch)).toEqual({ client_id: 'valet', supports_org_scope: true });
  });

  it('defaults the client id, interval and expiry', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetch = mockFetch(json({ device_code: 'd', user_code: 'u', verification_uri_complete: '/console/device?user_code=u' }));
    const start = await startOpencodeLogin();
    expect(body(fetch).client_id).toBe('byok');
    expect(start.intervalSec).toBe(5);
    expect(start.expiresAt).toBe(600_000);
  });

  it('rejects failures, responses without a code, and a verification page off https', async () => {
    mockFetch(new Response('boom', { status: 500 }), json({ device_code: 'd' }), json({ device_code: 'd', user_code: 'u', verification_uri_complete: 'http://evil.test/' }));
    const failure = await startOpencodeLogin().catch((error: unknown) => error as Error);
    expect(failure).toMatchObject({ name: 'AuthError', status: 500, message: 'OpenCode sign-in start failed (HTTP 500).' });
    expect(String(failure)).not.toContain('boom');
    await expect(startOpencodeLogin()).rejects.toThrow('returned no code');
    await expect(startOpencodeLogin()).rejects.toThrow('not https');
  });
});

describe('pollOpencode', () => {
  it('posts the device grant with the client id', async () => {
    const fetch = mockFetch(json({ error: 'authorization_pending' }, 400));
    expect(await pollOpencode('dev-1', 'valet')).toEqual({ status: 'pending' });
    expect(fetch.mock.calls[0]![0]).toBe('https://opencode.ai/console/auth/device/token');
    expect(body(fetch)).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dev-1', client_id: 'valet' });
  });

  it('keeps going on slow_down, and stops on a denial or an expired code', async () => {
    mockFetch(json({ error: 'slow_down' }, 400), json({ error: 'access_denied' }, 400), json({ error: 'expired_token' }, 400), new Response('', { status: 502 }));
    expect(await pollOpencode('d')).toEqual({ status: 'slow_down' });
    expect(await pollOpencode('d')).toMatchObject({ status: 'denied', error: /denied the sign-in/ });
    expect(await pollOpencode('d')).toMatchObject({ status: 'denied', error: /code expired/ });
    expect(await pollOpencode('d')).toMatchObject({ status: 'denied', error: /HTTP 502/ });
    // Another code is named; a sentence in that field is not echoed.
    mockFetch(json({ error: 'invalid_client' }, 400), json({ error: 'Invalid device token SECRET_TOKEN' }, 400));
    expect(await pollOpencode('d')).toEqual({ status: 'denied', error: 'OpenCode sign-in failed (invalid_client).' });
    expect(await pollOpencode('d')).toEqual({ status: 'denied', error: 'OpenCode sign-in failed (HTTP 400).' });
  });

  it('returns the tokens with their expiry and organization once approved', async () => {
    vi.useFakeTimers({ now: 1000 });
    mockFetch(json({ access_token: 'acc', refresh_token: 'ref', token_type: 'Bearer', expires_in: 2592000, org_id: 'org_1' }));
    expect(await pollOpencode('d')).toEqual({
      status: 'authorized',
      tokens: { accessToken: 'acc', refreshToken: 'ref', expiresAt: 1000 + 2592000 * 1000, orgId: 'org_1' },
    });
  });

  it('leaves the organization out when the account has none', async () => {
    mockFetch(json({ access_token: 'acc', refresh_token: 'ref', expires_in: 60, org_id: null }));
    const poll = await pollOpencode('d');
    expect(poll.status === 'authorized' && 'orgId' in poll.tokens).toBe(false);
  });
});

describe('refreshOpencodeTokens', () => {
  it('posts the refresh grant and returns the rotated pair', async () => {
    vi.useFakeTimers({ now: 0 });
    const fetch = mockFetch(json({ access_token: 'acc2', refresh_token: 'ref2', expires_in: 100, org_id: 'org_1' }));
    expect(await refreshOpencodeTokens('ref1', 'valet')).toEqual({ accessToken: 'acc2', refreshToken: 'ref2', expiresAt: 100_000, orgId: 'org_1' });
    expect(body(fetch)).toEqual({ grant_type: 'refresh_token', refresh_token: 'ref1', client_id: 'valet' });
  });

  it('keeps the old refresh token when the server sends none, and names a revoked sign-in', async () => {
    mockFetch(json({ access_token: 'acc2', expires_in: 100 }), json({ error: 'invalid_grant' }, 400), new Response('down', { status: 503 }));
    expect((await refreshOpencodeTokens('ref1')).refreshToken).toBe('ref1');
    await expect(refreshOpencodeTokens('ref1')).rejects.toThrow('revoked or expired');
    await expect(refreshOpencodeTokens('ref1')).rejects.toThrow('Token refresh failed (HTTP 503).');
  });
});

describe('helpers', () => {
  it('builds the bearer header with the organization when there is one', () => {
    expect(opencodeHeaders('acc')).toEqual({ Authorization: 'Bearer acc' });
    expect(opencodeHeaders('acc', 'org_1')).toEqual({ Authorization: 'Bearer acc', [OPENCODE_ORG_HEADER]: 'org_1' });
    expect(OPENCODE_BASE).toBe('https://opencode.ai/inference/v1');
  });

  it('reads the account email, and settles for none', async () => {
    const fetch = mockFetch(json({ id: 'u1', email: 'who@example.test' }), new Response('', { status: 401 }));
    expect(await opencodeAccount({ accessToken: 'acc', refreshToken: '', expiresAt: 0, orgId: 'org_1' })).toBe('who@example.test');
    expect(fetch.mock.calls[0]![0]).toBe('https://opencode.ai/console/api/user');
    expect((fetch.mock.calls[0]![1] as RequestInit).headers).toEqual({ Authorization: 'Bearer acc', [OPENCODE_ORG_HEADER]: 'org_1' });
    expect(await opencodeAccount({ accessToken: 'acc', refreshToken: '', expiresAt: 0 })).toBe('');
  });

  it('spaces polls by the interval, more after each slow_down, never under 2 s', () => {
    expect(opencodePollDelayMs(5, 0)).toBe(5000);
    expect(opencodePollDelayMs(5, 2)).toBe(15000);
    expect(opencodePollDelayMs(1, 0)).toBe(2000);
  });
});
