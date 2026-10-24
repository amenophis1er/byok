/** The gaps left from #34–#41 (#60): typed sign-in errors, a device poll that survives the server, causes with their codes, and the rest. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError, refreshOpenAiTokens, refreshTokens } from '../src/core/auth.js';
import { authCodeOf, authFailure } from '../src/core/auth-error.js';
import { anthropicBody } from '../src/core/chat-anthropic.js';
import { GEMINI_SIGNATURE_PLACEHOLDER, geminiContents } from '../src/core/chat-gemini.js';
import { chat, networkCause, rateLimitOf, type Fetch } from '../src/core/index.js';
import { providerCodeOf } from '../src/core/failure.js';

const req = { system: '', messages: [{ role: 'user' as const, content: 'Hi' }], tools: [] };
const NOW = Date.parse('2026-10-20T12:00:00Z');
const h = (entries: Record<string, string>) => new Headers(entries);

afterEach(() => vi.unstubAllGlobals());

describe('sign-in errors as data', () => {
  it('a revoked grant says reconnect, with the code; a passing failure says the status and code, never the body', async () => {
    const revoked = authFailure('ChatGPT', 'Token refresh', 400, JSON.stringify({ error: 'invalid_grant', error_description: 'secret-ish' }));
    expect(revoked).toBeInstanceOf(AuthError);
    expect(revoked).toMatchObject({ status: 400, code: 'invalid_grant', reconnect: true });
    expect(revoked.message).not.toContain('secret');
    const down = authFailure('Claude', 'Token refresh', 503, '{"error":{"type":"overloaded_error","message":"token=abc"}}');
    expect(down).toMatchObject({ status: 503, code: 'overloaded_error', reconnect: false, message: 'Token refresh failed (HTTP 503: overloaded_error).' });
    expect(authCodeOf('invalid_grant')).toBe('invalid_grant');
    expect(authFailure('OpenCode', 'Token refresh', 403, '{"error":"invalid_grant"}')).toMatchObject({ reconnect: true, status: 403 });
    expect(authFailure('OpenCode', 'Token refresh', 503, '{"error":"invalid_grant"}')).toMatchObject({ reconnect: true });
    expect(authFailure('OpenCode', 'Token refresh', 403, 'forbidden')).toMatchObject({ reconnect: false });
    expect(authCodeOf('<html>no</html>')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 401 })));
    const openai = await refreshOpenAiTokens('rt').catch((e: unknown) => e);
    expect(openai).toMatchObject({ name: 'AuthError', reconnect: true, status: 401 });
    const claude = await refreshTokens('rt').catch((e: unknown) => e);
    expect(claude).toMatchObject({ name: 'AuthError', reconnect: true });
  });
});

describe('causes and codes', () => {
  it('a network failure keeps the transport\'s code', async () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNRESET 1.2.3.4:443'), { code: 'ECONNRESET' });
    expect(networkCause(error)).toBe('fetch failed (ECONNRESET: connect ECONNRESET 1.2.3.4:443)');
    expect(networkCause(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
    const fetch = vi.fn<Fetch>(async () => { throw error; });
    expect(await chat({ kind: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm' }, 'k', req, { fetch }))
      .toMatchObject({ failure: { kind: 'network', cause: 'fetch failed (ECONNRESET: connect ECONNRESET 1.2.3.4:443)' } });
  });

  it('providerCodeOf reads an array-wrapped body', () => {
    expect(providerCodeOf('[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}]')).toBe('RESOURCE_EXHAUSTED');
    expect(providerCodeOf('[]')).toBeUndefined();
  });
});

describe('rate limits', () => {
  it('reads ChatGPT\'s reset-after-seconds headers before the instant', () => {
    expect(rateLimitOf(429, h({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '90', 'x-codex-primary-reset-at': String(Math.floor(NOW / 1000) + 5000) }), '', NOW))
      .toEqual({ retryAfterMs: 90_000, resetAt: NOW + 90_000 });
    expect(rateLimitOf(429, h({ 'x-codex-rate-limit-reached-type': 'secondary', 'x-codex-secondary-reset-after-seconds': '1.5' }), '', NOW))
      .toEqual({ retryAfterMs: 1500, resetAt: NOW + 1500, quota: 'plan' });
  });

  it('claims no instant for a day window: the wait is the provider\'s words, the day\'s end is not known', () => {
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { message: 'Rate limit reached on requests per day (RPD). Please try again in 20s.' } }), NOW))
      .toEqual({ retryAfterMs: 20_000, quota: 'day' });
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 20 } }), NOW))
      .toEqual({ retryAfterMs: 20_000, resetAt: NOW + 20_000, quota: 'plan' });
  });
});

describe('Gemini thought signatures', () => {
  it('a rebuilt function call gets the placeholder on Gemini 3, not before, and not when the turn replays its own parts', () => {
    const messages = [{ role: 'user' as const, content: 'go' }, { role: 'assistant' as const, toolCalls: [{ id: 'c0', name: 'a', args: {} }, { id: 'c1', name: 'b', args: {} }] }];
    expect(geminiContents(messages, 'gemini-3-pro')[1]!.parts).toEqual([
      { functionCall: { name: 'a', args: {} }, thoughtSignature: GEMINI_SIGNATURE_PLACEHOLDER },
      { functionCall: { name: 'b', args: {} } },
    ]);
    expect(geminiContents(messages, 'gemini-2.5-flash')[1]!.parts[0]).not.toHaveProperty('thoughtSignature');
    expect(geminiContents(messages, 'models/gemini-3-pro-preview')[1]!.parts[0]).toHaveProperty('thoughtSignature', GEMINI_SIGNATURE_PLACEHOLDER);
    expect(geminiContents(messages, 'models/gemini-2.5-pro')[1]!.parts[0]).not.toHaveProperty('thoughtSignature');
    expect(geminiContents(messages)[1]!.parts[0]).not.toHaveProperty('thoughtSignature');
    // Replayed history too, when none of its parts carries a signature (a 2.5 turn sent to a 3); signed history is left alone.
    const unsigned = [{ text: 'Looking.' }, { functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }];
    expect(geminiContents([messages[0]!, { ...messages[1]!, providerState: { protocol: 'gemini', parts: unsigned } }], 'gemini-3-pro')[1]!.parts)
      .toEqual([{ text: 'Looking.' }, { functionCall: { name: 'a', args: {} }, thoughtSignature: GEMINI_SIGNATURE_PLACEHOLDER }, { functionCall: { name: 'b', args: {} } }]);
    const signed = [{ functionCall: { name: 'a', args: {} }, thoughtSignature: 'real' }, { functionCall: { name: 'b', args: {} } }];
    expect(geminiContents([messages[0]!, { ...messages[1]!, providerState: { protocol: 'gemini', parts: signed } }], 'gemini-3-pro')[1]!.parts).toEqual(signed);
    // Decided on the first function call, whose signature the validator reads: bare, it gets the placeholder whatever a later part carries.
    const laterSigned = [{ text: 'Looking.', thoughtSignature: 'text-sig' }, { functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} }, thoughtSignature: 'real' }];
    expect(geminiContents([messages[0]!, { ...messages[1]!, providerState: { protocol: 'gemini', parts: laterSigned } }], 'gemini-3-pro')[1]!.parts)
      .toEqual([laterSigned[0], { functionCall: { name: 'a', args: {} }, thoughtSignature: GEMINI_SIGNATURE_PLACEHOLDER }, laterSigned[2]]);
    expect(geminiContents([messages[0]!, { ...messages[1]!, providerState: { protocol: 'gemini', parts: unsigned } }], 'gemini-2.5-flash')[1]!.parts).toEqual(unsigned);
  });
});

describe('web search', () => {
  it('refuses a function tool named web_search beside the server tool, as a request failure', async () => {
    const tools = [{ name: 'web_search', description: 'mine', inputSchema: {} }, { type: 'web_search' as const }];
    expect(() => anthropicBody({ ...req, tools }, 'claude-opus-5-5', [])).toThrow(/collides/);
    const fetch = vi.fn<Fetch>();
    expect(await chat({ kind: 'anthropic', baseUrl: '', model: 'claude-opus-5-5' }, 'sk', { ...req, tools }, { fetch })).toMatchObject({ ok: false, failure: { kind: 'request' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
