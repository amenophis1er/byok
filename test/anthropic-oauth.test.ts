/**
 * Claude subscription OAuth against a mocked token endpoint: the authorize
 * URL and PKCE challenge, every paste shape, the CSRF state check before any
 * request, and the error messages users see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_SENTINEL,
  exchangeCode,
  isSetupToken,
  parsePaste,
  refreshTokens,
  startLogin,
  withClaudeCodeSystem,
} from '../src/background/anthropic-oauth.js';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

function mockFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const res of responses) fetch.mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sentBody = (fetch: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse(String(fetch.mock.calls[call]![1]!.body)) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startLogin', () => {
  it('builds the authorize URL with an S256 challenge of the verifier', async () => {
    const { verifier, state, authorizeUrl } = await startLogin();
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://claude.com/cai/oauth/authorize');
    const q = url.searchParams;
    expect(q.get('code')).toBe('true');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(q.get('scope')).toBe('user:inference');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe(state);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = Buffer.from(digest).toString('base64url');
    expect(q.get('code_challenge')).toBe(expected);
  });

  it('uses fresh base64url values and never form-encodes', async () => {
    const a = await startLogin();
    const b = await startLogin();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    for (const v of [a.verifier, a.state]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.authorizeUrl).not.toContain('+');
  });
});

describe('parsePaste', () => {
  it.each([
    ['abc#xyz', { code: 'abc', state: 'xyz' }],
    ['  abc # xyz \n', { code: 'abc', state: 'xyz' }],
    ['https://platform.claude.com/oauth/code/callback?code=abc&state=xyz', { code: 'abc', state: 'xyz' }],
    ['code=abc&state=xyz', { code: 'abc', state: 'xyz' }],
    ['abc', { code: 'abc' }],
    ['', {}],
    ['   ', {}],
  ])('%j', (input, expected) => {
    expect(parsePaste(input)).toEqual(expected);
  });
});

describe('exchangeCode', () => {
  it('posts the code, state and verifier as JSON and returns the pair', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fetch = mockFetch(json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800 }));
    const tokens = await exchangeCode({ pasted: 'the-code#the-state', expectedState: 'the-state', verifier: 'v' });

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000 + 28_800_000 });
    expect(fetch.mock.calls[0]![0]).toBe(TOKEN_URL);
    expect(sentBody(fetch)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      state: 'the-state',
      code_verifier: 'v',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    });
  });

  it('defaults expiry to an hour when expires_in is missing', async () => {
    vi.useFakeTimers({ now: 0 });
    mockFetch(json({ access_token: 'at', refresh_token: 'rt' }));
    const tokens = await exchangeCode({ pasted: 'c#s', expectedState: 's', verifier: 'v' });
    expect(tokens.expiresAt).toBe(3_600_000);
  });

  it.each([
    ['', 'Paste the code'],
    ['only-the-code', "including the part after '#'"],
    ['code#wrong-state', 'state mismatch'],
  ])('rejects %j without calling the endpoint', async (pasted, message) => {
    const fetch = mockFetch();
    await expect(exchangeCode({ pasted, expectedState: 'right-state', verifier: 'v' })).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a response without both tokens', async () => {
    mockFetch(json({ access_token: 'at' }));
    await expect(exchangeCode({ pasted: 'c#s', expectedState: 's', verifier: 'v' })).rejects.toThrow('no token pair');
  });

  it('explains rate limiting, from the status or the body', async () => {
    mockFetch(new Response('slow down', { status: 429 }), new Response('{"error":"rate_limit_error"}', { status: 400 }));
    for (let i = 0; i < 2; i++) {
      await expect(exchangeCode({ pasted: 'c#s', expectedState: 's', verifier: 'v' })).rejects.toThrow('rate-limiting sign-in');
    }
  });

  it('reports other failures with the status and a trimmed body', async () => {
    mockFetch(new Response('x'.repeat(1000), { status: 400 }));
    const error = await exchangeCode({ pasted: 'c#s', expectedState: 's', verifier: 'v' }).catch((e: Error) => e);
    expect((error as Error).message).toBe(`Token exchange failed (400): ${'x'.repeat(300)}`);
  });
});

describe('refreshTokens', () => {
  it('posts a refresh grant and returns the rotated pair', async () => {
    const fetch = mockFetch(json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 60 }));
    const tokens = await refreshTokens('rt1');
    expect(tokens).toMatchObject({ accessToken: 'at2', refreshToken: 'rt2' });
    expect(sentBody(fetch)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt1' });
  });

  it('fails when the endpoint does not rotate the refresh token', async () => {
    mockFetch(json({ access_token: 'at2' }));
    await expect(refreshTokens('rt1')).rejects.toThrow('no token pair');
  });

  it('labels its failures as a refresh', async () => {
    mockFetch(new Response('invalid_grant', { status: 400 }));
    await expect(refreshTokens('rt1')).rejects.toThrow('Token refresh failed (400): invalid_grant');
  });
});

describe('helpers', () => {
  it('recognises pasted setup-tokens', () => {
    expect(isSetupToken('  sk-ant-oat01-abc')).toBe(true);
    expect(isSetupToken('sk-ant-api03-abc')).toBe(false);
  });

  it('leads the system prompt with the sentinel exactly once', () => {
    expect(withClaudeCodeSystem('')).toEqual({ system: [{ type: 'text', text: CLAUDE_CODE_SENTINEL }] });
    expect(withClaudeCodeSystem('Be terse.')).toEqual({
      system: [{ type: 'text', text: CLAUDE_CODE_SENTINEL }, { type: 'text', text: 'Be terse.' }],
    });
    const already = `${CLAUDE_CODE_SENTINEL}\nBe terse.`;
    expect(withClaudeCodeSystem(already)).toEqual({ system: [{ type: 'text', text: already }] });
  });
});
