/** What a refused response says about coming back, read from each provider's headers and body. */
import { describe, expect, it } from 'vitest';
import { duration, rateLimitOf } from '../src/core/rate-limit.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const h = (entries: Record<string, string>) => new Headers(entries);

describe('rateLimitOf', () => {
  it('reads Retry-After as seconds or as an HTTP date, and OpenAI\'s retry-after-ms first', () => {
    expect(rateLimitOf(429, h({ 'retry-after': '2' }), '', NOW)).toEqual({ retryAfterMs: 2000, resetAt: NOW + (2000) });
    expect(rateLimitOf(429, h({ 'retry-after': '0.5' }), '', NOW)).toEqual({ retryAfterMs: 500, resetAt: NOW + (500) });
    expect(rateLimitOf(503, h({ 'retry-after': 'Sat, 18 Oct 2026 12:00:30 GMT' }), '', NOW)).toEqual({ retryAfterMs: 30_000, resetAt: NOW + (30_000) });
    expect(rateLimitOf(429, h({ 'retry-after': '7', 'retry-after-ms': '6500' }), '', NOW)).toEqual({ retryAfterMs: 6500, resetAt: NOW + (6500) });
    // A date in the past is a wait of nothing, not a negative one.
    expect(rateLimitOf(429, h({ 'retry-after': 'Sat, 18 Oct 2026 11:00:00 GMT' }), '', NOW)).toEqual({ retryAfterMs: 0, resetAt: NOW + (0) });
  });

  it('reads OpenAI\'s reset headers for the window that ran out, and the window from its words', () => {
    const headers = h({
      'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-remaining-tokens': '150000', 'x-ratelimit-reset-tokens': '20ms',
    });
    const body = JSON.stringify({ error: { message: 'Rate limit reached for gpt-5 in organization org-1 on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s.', type: 'requests' } });
    // The words name the wait before the reset headers do.
    expect(rateLimitOf(429, headers, body, NOW)).toEqual({ retryAfterMs: 20_000, resetAt: NOW + (20_000), quota: 'minute' });
    expect(rateLimitOf(429, headers, '', NOW)).toEqual({ retryAfterMs: 360_000, resetAt: NOW + (360_000) });
    // A healthy window's reset says nothing about the wait; without remaining counts, the latest reset given does.
    expect(rateLimitOf(429, h({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '6m0s' }), '', NOW)).toEqual({});
    expect(rateLimitOf(429, h({ 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-reset-tokens': '8s' }), '', NOW)).toEqual({ retryAfterMs: 360_000, resetAt: NOW + (360_000) });
    const daily = JSON.stringify({ error: { message: 'Rate limit reached for gpt-5-mini on requests per day (RPD): Limit 200, Used 200, Requested 1. Please try again in 7h12m3s.' } });
    expect(rateLimitOf(429, undefined, daily, NOW)).toEqual({ retryAfterMs: 7 * 3_600_000 + 12 * 60_000 + 3000, quota: 'day' });
  });

  it('reads Anthropic\'s reset instants for the exhausted window', () => {
    const headers = h({
      'anthropic-ratelimit-requests-remaining': '40', 'anthropic-ratelimit-requests-reset': '2026-10-18T12:00:05Z',
      'anthropic-ratelimit-input-tokens-remaining': '0', 'anthropic-ratelimit-input-tokens-reset': '2026-10-18T12:00:41Z',
    });
    const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed the rate limit for your organization of 50,000 input tokens per minute.' } });
    expect(rateLimitOf(429, headers, body, NOW)).toEqual({ retryAfterMs: 41_000, resetAt: NOW + (41_000), quota: 'minute' });
    // Anthropic also sends retry-after; it wins.
    expect(rateLimitOf(429, h({ 'retry-after': '41', 'anthropic-ratelimit-input-tokens-reset': '2026-10-18T12:05:00Z' }), '', NOW)).toEqual({ retryAfterMs: 41_000, resetAt: NOW + (41_000) });
  });

  it('reads Gemini\'s RetryInfo and QuotaFailure details; a day window outranks a minute one named beside it', () => {
    const body = (quotaIds: string[], retryDelay = '20s') => JSON.stringify({
      error: {
        code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: quotaIds.map((quotaId) => ({ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId })) },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
        ],
      },
    });
    const limit = { unit: 'requests', freeTier: true };
    expect(rateLimitOf(429, undefined, body(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier']), NOW)).toEqual({ retryAfterMs: 20_000, resetAt: NOW + (20_000), quota: 'minute', limit });
    // A Gemini day window: the wait stays the provider's words, the instant is the documented day's end (midnight Pacific).
    const midnight = Date.parse('2026-10-19T07:00:00Z');
    expect(rateLimitOf(429, undefined, body(['GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '2.5s'), NOW)).toEqual({ retryAfterMs: 2500, resetAt: midnight, quota: 'day', limit });
    expect(rateLimitOf(429, undefined, body(['GenerateRequestsPerMinutePerProjectPerModel', 'GenerateRequestsPerDayPerProjectPerModel']), NOW)).toEqual({ retryAfterMs: 20_000, resetAt: midnight, quota: 'day', limit });
  });

  it('reads ChatGPT\'s resets_in_seconds, and usage_limit_reached as the plan window', () => {
    const body = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'You have hit your usage limit.', resets_in_seconds: 3700, plan_type: 'plus' } });
    expect(rateLimitOf(429, undefined, body, NOW)).toEqual({ retryAfterMs: 3_700_000, resetAt: NOW + 3_700_000, quota: 'plan' });
    // The code may come as `code`; the plan's window, and its wait, are read from any 4xx, not from a 5xx.
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { code: 'usage_limit_reached' } }), NOW)).toEqual({ quota: 'plan' });
    expect(rateLimitOf(400, undefined, body, NOW)).toEqual({ retryAfterMs: 3_700_000, resetAt: NOW + 3_700_000, quota: 'plan' });
    expect(rateLimitOf(403, undefined, JSON.stringify({ error: { code: 'usage_limit_reached' } }), NOW)).toEqual({ quota: 'plan' });
    expect(rateLimitOf(500, undefined, body, NOW)).toEqual({});
    // The headers name the plan on a 429 only.
    expect(rateLimitOf(403, h({ 'x-codex-rate-limit-reached-type': 'primary' }), '', NOW)).toEqual({});
  });

  it('reads ChatGPT\'s resets_at when sent alone, after resets_in_seconds when both are, and usage_not_included as a plan window with no wait', () => {
    const at = Math.floor(NOW / 1000) + 5400;
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: at } }), NOW)).toEqual({ retryAfterMs: 5_400_000, resetAt: NOW + 5_400_000, quota: 'plan' });
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: at, resets_in_seconds: 60 } }), NOW)).toEqual({ retryAfterMs: 60_000, resetAt: NOW + 60_000, quota: 'plan' });
    // A reset in the past is a wait of nothing; a value that is not epoch seconds (milliseconds, a string) says nothing.
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: at - 9000 } }), NOW)).toEqual({ retryAfterMs: 0, resetAt: NOW, quota: 'plan' });
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: at * 1000 } }), NOW)).toEqual({ quota: 'plan' });
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: String(at) } }), NOW)).toEqual({ quota: 'plan' });
    // The plan does not include the model: a plan window, and no wait, whatever else the response says.
    const excluded = JSON.stringify({ error: { type: 'usage_not_included', message: 'Your plan does not include this model.', resets_in_seconds: 60 } });
    expect(rateLimitOf(429, h({ 'retry-after': '5', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': String(at) }), excluded, NOW)).toEqual({ quota: 'plan' });
    expect(rateLimitOf(403, undefined, JSON.stringify({ error: { code: 'usage_not_included' } }), NOW)).toEqual({ quota: 'plan' });
    expect(rateLimitOf(500, undefined, excluded, NOW)).toEqual({});
  });

  it('carries the quota Gemini names: its size, unit, tier and model, from the violation that named the window', () => {
    const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
        { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaDimensions: { location: 'global', model: 'gemini-2.5-pro' }, quotaValue: '5' },
        { quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { location: 'global', model: 'gemini-2.5-pro' }, quotaValue: '50' },
      ] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' },
    ] } });
    expect(rateLimitOf(429, undefined, body, NOW)).toMatchObject({ retryAfterMs: 20_000, quota: 'day', limit: { value: 50, unit: 'requests', freeTier: true, model: 'gemini-2.5-pro' } });
    const tokens = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
      { quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count', quotaId: 'GenerateContentPaidTierInputTokensPerModelPerMinute', quotaDimensions: { model: 'gemini-2.5-flash' }, quotaValue: 250000 },
    ] }] } });
    expect(rateLimitOf(429, undefined, tokens, NOW)).toEqual({ quota: 'minute', limit: { value: 250_000, unit: 'tokens', model: 'gemini-2.5-flash' } });
    // Each field only when said; a violation saying none of it carries no `limit`; a malformed value says nothing.
    const bare = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ subject: 'project:1', description: 'Quota exceeded per day' }] }] } });
    expect(rateLimitOf(429, undefined, bare, NOW)).toMatchObject({ quota: 'day' });
    expect(rateLimitOf(429, undefined, bare, NOW)).not.toHaveProperty('limit');
    const odd = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'PerMinute', quotaValue: 'many', quotaDimensions: 'global' }] }] } });
    expect(rateLimitOf(429, undefined, odd, NOW)).toEqual({ quota: 'minute' });
    // Not on a result from words alone.
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { message: 'requests per day (RPD): Limit 200' } }), NOW)).toEqual({ quota: 'day' });
  });

  it('claims a day window\'s end only where the provider documents it: Gemini\'s, at the next midnight Pacific, a clock change included', () => {
    const gemini = JSON.stringify({ error: { details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' },
    ] } });
    const limit = { unit: 'requests', freeTier: true };
    // 05:00 PDT → midnight is 07:00Z the next day; the wait stays the provider's 20 s.
    expect(rateLimitOf(429, undefined, gemini, NOW)).toEqual({ retryAfterMs: 20_000, resetAt: Date.parse('2026-10-19T07:00:00Z'), quota: 'day', limit });
    // 23:59 PT and 00:01 PT.
    expect(rateLimitOf(429, undefined, gemini, Date.parse('2026-10-18T06:59:00Z'))).toMatchObject({ resetAt: Date.parse('2026-10-18T07:00:00Z') });
    expect(rateLimitOf(429, undefined, gemini, Date.parse('2026-10-18T07:01:00.250Z'))).toMatchObject({ resetAt: Date.parse('2026-10-19T07:00:00Z') });
    // Across the fall-back (2026-11-01, 02:00 PDT → 01:00 PST) and the spring-forward (2026-03-08, 02:00 PST → 03:00 PDT).
    expect(rateLimitOf(429, undefined, gemini, Date.parse('2026-11-01T07:30:00Z'))).toMatchObject({ resetAt: Date.parse('2026-11-02T08:00:00Z') });
    expect(rateLimitOf(429, undefined, gemini, Date.parse('2026-10-31T19:00:00Z'))).toMatchObject({ resetAt: Date.parse('2026-11-01T07:00:00Z') });
    expect(rateLimitOf(429, undefined, gemini, Date.parse('2026-03-08T08:30:00Z'))).toMatchObject({ resetAt: Date.parse('2026-03-09T07:00:00Z') });
    expect(rateLimitOf(429, undefined, gemini, Date.parse('2026-03-07T20:00:00Z'))).toMatchObject({ resetAt: Date.parse('2026-03-08T08:00:00Z') });
    // Another provider's day window, or a Google quota not under the Gemini API's metric, still carries no instant.
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { message: 'Rate limit reached on requests per day (RPD). Please try again in 7h.' } }), NOW)).toEqual({ retryAfterMs: 7 * 3_600_000, quota: 'day' });
    const vertex = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'aiplatform.googleapis.com/generate_content_requests_per_day', quotaId: 'GenerateContentRequestsPerDayPerProjectPerModel' }] }] } });
    expect(rateLimitOf(429, undefined, vertex, NOW)).toEqual({ quota: 'day', limit: { unit: 'requests' } });
  });

  it('reads headers from any source: a Headers, a Map keyed by lowercase names, a plain record in any case, an array value as its first', () => {
    expect(rateLimitOf(429, new Map([['retry-after', '2']]), '', NOW)).toEqual({ retryAfterMs: 2000, resetAt: NOW + 2000 });
    expect(rateLimitOf(429, { 'Retry-After': '2' }, '', NOW)).toEqual({ retryAfterMs: 2000, resetAt: NOW + 2000 });
    expect(rateLimitOf(429, { 'retry-after-ms': ['1500', '9'], 'RETRY-AFTER': '2' }, '', NOW)).toEqual({ retryAfterMs: 1500, resetAt: NOW + 1500 });
    expect(rateLimitOf(429, { 'x-ratelimit-remaining-requests': '0', 'X-RateLimit-Reset-Requests': '6m0s' }, '', NOW)).toEqual({ retryAfterMs: 360_000, resetAt: NOW + 360_000 });
    // A value that is not a string, or an empty array, is a header not given; a `get` that is not a function is a record's key.
    expect(rateLimitOf(429, { 'retry-after': undefined, 'retry-after-ms': [] }, '', NOW)).toEqual({});
    expect(rateLimitOf(429, { get: 'x', 'retry-after': '3' } as Record<string, string>, '', NOW)).toEqual({ retryAfterMs: 3000, resetAt: NOW + 3000 });
    expect(rateLimitOf(429, { get: () => 7 as unknown as string }, '', NOW)).toEqual({});
  });

  it('reads ChatGPT\'s reset headers: the window named as reached, else the ones used in full', () => {
    const at = (s: number) => String(Math.floor(NOW / 1000) + s);
    const full = h({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': at(1800),
      'x-codex-secondary-used-percent': '42', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': at(86400) });
    expect(rateLimitOf(429, full, '', NOW)).toEqual({ retryAfterMs: 1_800_000, resetAt: NOW + 1_800_000 });
    const named = h({ 'x-codex-rate-limit-reached-type': 'secondary', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': at(60), 'x-codex-secondary-reset-at': at(7200) });
    expect(rateLimitOf(429, named, '', NOW)).toEqual({ retryAfterMs: 7_200_000, resetAt: NOW + 7_200_000, quota: 'plan' });
    // A body that says the seconds wins over the headers; a healthy window says nothing; a malformed instant says nothing.
    expect(rateLimitOf(429, full, JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 60 } }), NOW)).toEqual({ retryAfterMs: 60_000, resetAt: NOW + 60_000, quota: 'plan' });
    expect(rateLimitOf(429, h({ 'x-codex-primary-used-percent': '80', 'x-codex-primary-reset-at': at(60) }), '', NOW)).toEqual({});
    expect(rateLimitOf(429, h({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': 'soon' }), '', NOW)).toEqual({});
    // A reset in the past is a wait of nothing.
    expect(rateLimitOf(429, h({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': at(-5) }), '', NOW)).toEqual({ retryAfterMs: 0, resetAt: NOW });
    // A window name that is not a header token names nothing, and never throws; an instant too long to be one says nothing.
    expect(rateLimitOf(429, h({ 'x-codex-rate-limit-reached-type': 'primary, secondary', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': at(60) }), '', NOW))
      .toEqual({ retryAfterMs: 60_000, resetAt: NOW + 60_000, quota: 'plan' });
    expect(rateLimitOf(429, h({ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': '9'.repeat(309) }), '', NOW)).toEqual({});
    // The plan is named by `code` even when `type` says something else.
    expect(rateLimitOf(429, undefined, JSON.stringify({ error: { type: 'rate_limit_error', code: 'usage_limit_reached', resets_in_seconds: 20 } }), NOW))
      .toEqual({ retryAfterMs: 20_000, resetAt: NOW + 20_000, quota: 'plan' });
  });

  it('reads a body wrapped in an array, as Gemini sends at times', () => {
    const body = JSON.stringify([{ error: { code: 429, message: 'Quota exceeded for quota metric ... per minute. Please retry in 12s.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } }]);
    expect(rateLimitOf(429, undefined, body, NOW)).toEqual({ retryAfterMs: 12_000, resetAt: NOW + 12_000, quota: 'minute' });
    expect(rateLimitOf(429, undefined, '[]', NOW)).toEqual({});
    expect(rateLimitOf(429, undefined, '[1, "x"]', NOW)).toEqual({});
  });

  it('says nothing when the response says nothing, and reads the window only from a 429', () => {
    expect(rateLimitOf(429, h({}), '{"error":"slow down"}', NOW)).toEqual({});
    expect(rateLimitOf(429, undefined, 'not json', NOW)).toEqual({});
    expect(rateLimitOf(500, undefined, JSON.stringify({ error: { message: 'tokens per minute' } }), NOW)).toEqual({});
    expect(rateLimitOf(503, undefined, JSON.stringify({ error: { message: 'Overloaded. Please try again in 5s.' } }), NOW)).toEqual({});
    // Google's RetryInfo is read on any status, as the header is: a 503 says when to come back too.
    const retryInfo = JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } });
    expect(rateLimitOf(503, undefined, retryInfo, NOW)).toEqual({ retryAfterMs: 37_000, resetAt: NOW + 37_000 });
    expect(rateLimitOf(503, h({ 'retry-after': '2' }), retryInfo, NOW)).toEqual({ retryAfterMs: 2000, resetAt: NOW + 2000 });
    expect(rateLimitOf(400, h({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s' }), '', NOW)).toEqual({});
    // Garbage in the headers is ignored, not a crash; a malformed number is not a date in the past.
    expect(rateLimitOf(429, h({ 'retry-after': 'soon', 'retry-after-ms': 'x', 'x-ratelimit-reset-requests': 'later' }), '', NOW)).toEqual({});
    expect(rateLimitOf(429, h({ 'retry-after': '-1' }), JSON.stringify({ error: { message: 'Please try again in 3s.' } }), NOW)).toEqual({ retryAfterMs: 3000, resetAt: NOW + (3000) });
    // Malformed details say nothing, and never throw.
    const malformed = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [null, 7, 'x'] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: 20 }, null] } });
    expect(rateLimitOf(429, undefined, malformed, NOW)).toEqual({});
    // A list of violations too long to spread into a call is read all the same.
    const many = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [...Array(200_000).fill({}), { quotaId: 'PerMinute' }] }] } });
    expect(rateLimitOf(429, undefined, many, NOW)).toEqual({ quota: 'minute' });
  });

  it('reads the words of the message only, the window named first, and a spaced duration whole', () => {
    const message = (text: string) => JSON.stringify({ error: { message: text }, meta: { plan: 'daily quota 10000 requests per day', note: 'try again in 1s' } });
    expect(rateLimitOf(429, undefined, message('Rate limit reached on requests per min (RPM). Please try again in 2s. Your plan also has a daily quota of 10000 requests.'), NOW))
      .toEqual({ retryAfterMs: 2000, resetAt: NOW + (2000), quota: 'minute' });
    expect(rateLimitOf(429, undefined, message('Rate limit reached on requests per day (RPD): Limit 200. Also 3 RPM. Please try again in 1m 30s.'), NOW))
      .toEqual({ retryAfterMs: 90_000, quota: 'day' });
    expect(rateLimitOf(429, undefined, message('slow down'), NOW)).toEqual({});
    // A body that is not JSON is read as the message.
    expect(rateLimitOf(429, undefined, 'Too many requests per minute. Retry in 500ms', NOW)).toEqual({ retryAfterMs: 500, resetAt: NOW + (500), quota: 'minute' });
  });
});

it('reads Go-style durations', () => {
  expect(duration('6m0s')).toBe(360_000);
  expect(duration('20ms')).toBe(20);
  expect(duration('1h2m3.5s')).toBe(3_600_000 + 120_000 + 3500);
  expect(duration('1.5s')).toBe(1500);
  expect(duration('1m 30s')).toBe(90_000);
  expect(duration('')).toBeUndefined();
  expect(duration('5')).toBeUndefined();
  expect(duration(5)).toBeUndefined();
});
