/**
 * When to come back after a provider refused for load. Each provider says, in
 * its own place, how long to wait and which window ran out:
 *
 * - the standard `Retry-After` (seconds or an HTTP date), and OpenAI's
 *   `retry-after-ms`;
 * - OpenAI's `x-ratelimit-reset-requests` / `-tokens` ("6m0s", "20ms"), for
 *   the window whose `x-ratelimit-remaining-*` is 0;
 * - Anthropic's `anthropic-ratelimit-*-reset` (RFC 3339 instants), likewise
 *   for the window whose `-remaining` is 0;
 * - Gemini's body: a `RetryInfo` detail (`"retryDelay": "20s"`) and a
 *   `QuotaFailure` naming the quota (`…PerDay…` / `…PerMinute…`);
 * - ChatGPT's body: `resets_in_seconds`;
 * - and the words: "Please try again in 1h2m3s", "requests per day (RPD)",
 *   "tokens per minute".
 *
 * The wait is read from every failure; the window only from a 429. Neither is
 * inferred: a failure that said nothing carries nothing.
 */

import type { AIChatResult } from '../types.js';

/** A rate-limit window: a minute window heals by itself, a day window not before tomorrow. */
export type RateLimitWindow = NonNullable<AIChatResult['quota']>;

/** What a failed response said about coming back: each field only when the provider said. */
export interface RateLimit {
  /** How long the provider asked us to wait, when it said. */
  retryAfterMs?: number;
  /** Which window ran out, when the provider said. */
  quota?: RateLimitWindow;
}

/** What a failed response says about coming back; `{}` when it says nothing. */
export function rateLimitOf(status: number, headers: Headers | undefined, body: string, now = Date.now()): RateLimit {
  const out: RateLimit = {};
  const get = (name: string) => headers?.get(name) ?? null;
  const json = parseJson(body);
  const wait = retryAfterHeader(get, now)
    ?? (status === 429 ? bodyWait(json, body) ?? resetWindows(get, now) : undefined);
  if (wait !== undefined) out.retryAfterMs = wait;
  if (status === 429) {
    const quota = namedQuota(json, body);
    if (quota) out.quota = quota;
  }
  return out;
}

/** `retry-after-ms`, else `Retry-After` as seconds or as an HTTP date. */
function retryAfterHeader(get: (name: string) => string | null, now: number): number | undefined {
  const ms = get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms));
  const header = get('retry-after');
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The wait in the body: Gemini's `RetryInfo.retryDelay` ("20s"), ChatGPT's
 * `resets_in_seconds`, or the words "try again in 1h2m3s" / "retry in 20.5s".
 */
function bodyWait(json: Record<string, unknown> | undefined, body: string): number | undefined {
  for (const detail of details(json)) {
    if (typeof detail['@type'] === 'string' && /RetryInfo$/.test(detail['@type'])) {
      const ms = duration(detail['retryDelay']);
      if (ms !== undefined) return ms;
    }
  }
  const error = (json?.['error'] ?? json) as Record<string, unknown> | undefined;
  const seconds = error?.['resets_in_seconds'] ?? json?.['resets_in_seconds'];
  if (typeof seconds === 'number' && seconds >= 0) return Math.ceil(seconds * 1000);
  const words = /\b(?:try again|retry)\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?(?:ms|s|m|h)(?:\d+(?:\.\d+)?(?:ms|s|m))*)\b/i.exec(body);
  return words ? duration(words[1]) : undefined;
}

/**
 * OpenAI's and Anthropic's per-window headers: the wait is the latest reset
 * among the windows that ran out (remaining 0); without remaining counts, the
 * latest reset given.
 */
function resetWindows(get: (name: string) => string | null, now: number): number | undefined {
  const windows: Array<{ remaining: string | null; reset: string | null; parse: (value: string) => number | undefined }> = [];
  for (const name of ['requests', 'tokens']) {
    windows.push({ remaining: get(`x-ratelimit-remaining-${name}`), reset: get(`x-ratelimit-reset-${name}`), parse: duration });
  }
  for (const name of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    windows.push({ remaining: get(`anthropic-ratelimit-${name}-remaining`), reset: get(`anthropic-ratelimit-${name}-reset`), parse: (v) => instant(v, now) });
  }
  const given = windows.filter((w) => w.reset !== null);
  // With remaining counts given, only a window at 0 ran out; a healthy window's reset says nothing about the wait.
  const marked = given.some((w) => w.remaining !== null);
  const pool = marked ? given.filter((w) => Number(w.remaining) === 0) : given;
  const waits = pool.map((w) => w.parse(w.reset!)).filter((ms): ms is number => ms !== undefined);
  return waits.length > 0 ? Math.max(...waits) : undefined;
}

/**
 * The window named: Gemini's `QuotaFailure` violations (`…PerDay…`,
 * `…PerMinute…`), else the words ("requests per day (RPD)", "tokens per
 * minute (TPM)"). A day window wins over a minute one named alongside it.
 */
function namedQuota(json: Record<string, unknown> | undefined, body: string): RateLimitWindow | undefined {
  const names: string[] = [];
  for (const detail of details(json)) {
    if (typeof detail['@type'] === 'string' && /QuotaFailure$/.test(detail['@type'])) {
      const violations = detail['violations'];
      if (!Array.isArray(violations)) continue;
      for (const v of violations as Array<Record<string, unknown>>) {
        for (const key of ['quotaId', 'quotaMetric', 'subject', 'description']) {
          if (typeof v[key] === 'string') names.push(v[key]);
        }
      }
    }
  }
  const text = names.join(' ');
  if (/per[_ ]?day|daily|\b[RT]PD\b/i.test(text)) return 'day';
  if (/per[_ ]?minute|per[_ ]?min\b|\b[RT]PM\b/i.test(text)) return 'minute';
  if (/\bper day\b|\bdaily (?:limit|quota)\b|\b[RT]PD\b/i.test(body)) return 'day';
  if (/\bper min(?:ute)?\b|\b(?:[RT]PM|ITPM|OTPM)\b/i.test(body)) return 'minute';
  return undefined;
}

/* ── pieces ──────────────────────────────────────────────────────── */

function parseJson(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Google's `error.details`, when the body carries them. */
function details(json: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const error = json?.['error'];
  const list = error && typeof error === 'object' ? (error as Record<string, unknown>)['details'] : undefined;
  return Array.isArray(list) ? (list.filter((d) => d && typeof d === 'object') as Array<Record<string, unknown>>) : [];
}

/** A Go-style duration — "1h2m3.5s", "6m0s", "20ms", "1.5s" — in milliseconds. */
export function duration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(text)) return undefined;
  let ms = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const n = Number(match[1]);
    ms += match[2] === 'ms' ? n : match[2] === 's' ? n * 1000 : match[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return Math.ceil(ms);
}

/** An RFC 3339 instant as a wait from `now`, never negative. */
function instant(value: string, now: number): number | undefined {
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
