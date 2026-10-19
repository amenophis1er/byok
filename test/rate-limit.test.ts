/** What a refused response says about coming back, read from each provider's headers and body. */
import { describe, expect, it } from 'vitest';
import { duration, rateLimitOf } from '../src/core/rate-limit.js';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const h = (entries: Record<string, string>) => new Headers(entries);

describe('rateLimitOf', () => {
  it('reads Retry-After as seconds or as an HTTP date, and OpenAI\'s retry-after-ms first', () => {
    expect(rateLimitOf(429, h({ 'retry-after': '2' }), '', NOW)).toEqual({ retryAfterMs: 2000 });
    expect(rateLimitOf(429, h({ 'retry-after': '0.5' }), '', NOW)).toEqual({ retryAfterMs: 500 });
    expect(rateLimitOf(503, h({ 'retry-after': 'Sat, 18 Oct 2026 12:00:30 GMT' }), '', NOW)).toEqual({ retryAfterMs: 30_000 });
    expect(rateLimitOf(429, h({ 'retry-after': '7', 'retry-after-ms': '6500' }), '', NOW)).toEqual({ retryAfterMs: 6500 });
    // A date in the past is a wait of nothing, not a negative one.
    expect(rateLimitOf(429, h({ 'retry-after': 'Sat, 18 Oct 2026 11:00:00 GMT' }), '', NOW)).toEqual({ retryAfterMs: 0 });
  });

  it('reads OpenAI\'s reset headers for the window that ran out, and the window from its words', () => {
    const headers = h({
      'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-remaining-tokens': '150000', 'x-ratelimit-reset-tokens': '20ms',
    });
    const body = JSON.stringify({ error: { message: 'Rate limit reached for gpt-5 in organization org-1 on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s.', type: 'requests' } });
    // The words name the wait before the reset headers do.
    expect(rateLimitOf(429, headers, body, NOW)).toEqual({ retryAfterMs: 20_000, quota: 'minute' });
    expect(rateLimitOf(429, headers, '', NOW)).toEqual({ retryAfterMs: 360_000 });
    const daily = JSON.stringify({ error: { message: 'Rate limit reached for gpt-5-mini on requests per day (RPD): Limit 200, Used 200, Requested 1. Please try again in 7h12m3s.' } });
    expect(rateLimitOf(429, undefined, daily, NOW)).toEqual({ retryAfterMs: 7 * 3_600_000 + 12 * 60_000 + 3000, quota: 'day' });
  });

  it('reads Anthropic\'s reset instants for the exhausted window', () => {
    const headers = h({
      'anthropic-ratelimit-requests-remaining': '40', 'anthropic-ratelimit-requests-reset': '2026-10-18T12:00:05Z',
      'anthropic-ratelimit-input-tokens-remaining': '0', 'anthropic-ratelimit-input-tokens-reset': '2026-10-18T12:00:41Z',
    });
    const body = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed the rate limit for your organization of 50,000 input tokens per minute.' } });
    expect(rateLimitOf(429, headers, body, NOW)).toEqual({ retryAfterMs: 41_000, quota: 'minute' });
    // Anthropic also sends retry-after; it wins.
    expect(rateLimitOf(429, h({ 'retry-after': '41', 'anthropic-ratelimit-input-tokens-reset': '2026-10-18T12:05:00Z' }), '', NOW)).toEqual({ retryAfterMs: 41_000 });
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
    expect(rateLimitOf(429, undefined, body(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier']), NOW)).toEqual({ retryAfterMs: 20_000, quota: 'minute' });
    expect(rateLimitOf(429, undefined, body(['GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '2.5s'), NOW)).toEqual({ retryAfterMs: 2500, quota: 'day' });
    expect(rateLimitOf(429, undefined, body(['GenerateRequestsPerMinutePerProjectPerModel', 'GenerateRequestsPerDayPerProjectPerModel']), NOW)).toEqual({ retryAfterMs: 20_000, quota: 'day' });
  });

  it('reads ChatGPT\'s resets_in_seconds', () => {
    const body = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'You have hit your usage limit.', resets_in_seconds: 3700 } });
    expect(rateLimitOf(429, undefined, body, NOW)).toEqual({ retryAfterMs: 3_700_000 });
  });

  it('says nothing when the response says nothing, and reads the window only from a 429', () => {
    expect(rateLimitOf(429, h({}), '{"error":"slow down"}', NOW)).toEqual({});
    expect(rateLimitOf(429, undefined, 'not json', NOW)).toEqual({});
    expect(rateLimitOf(500, undefined, JSON.stringify({ error: { message: 'tokens per minute' } }), NOW)).toEqual({});
    expect(rateLimitOf(400, h({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s' }), '', NOW)).toEqual({});
    // Garbage in the headers is ignored, not a crash.
    expect(rateLimitOf(429, h({ 'retry-after': 'soon', 'retry-after-ms': 'x', 'x-ratelimit-reset-requests': 'later' }), '', NOW)).toEqual({});
  });
});

it('reads Go-style durations', () => {
  expect(duration('6m0s')).toBe(360_000);
  expect(duration('20ms')).toBe(20);
  expect(duration('1h2m3.5s')).toBe(3_600_000 + 120_000 + 3500);
  expect(duration('1.5s')).toBe(1500);
  expect(duration('')).toBeUndefined();
  expect(duration('5')).toBeUndefined();
  expect(duration(5)).toBeUndefined();
});
