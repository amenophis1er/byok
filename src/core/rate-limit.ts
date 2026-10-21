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
 *   `QuotaFailure` naming the quota (`…PerDay…` / `…PerMinute…`), its size
 *   (`quotaValue`), its tier and the model it is on;
 * - ChatGPT's body: `resets_in_seconds` or `resets_at` (epoch seconds), and
 *   `usage_limit_reached` naming the plan's window, or `usage_not_included`,
 *   a plan that does not include the model at all; its headers
 *   `x-codex-*-reset-at` (epoch seconds) for the window at 100%, or the one
 *   `x-codex-rate-limit-reached-type` names;
 * - and the words of the error message: "Please try again in 1h2m3s",
 *   "requests per day (RPD)", "tokens per minute".
 *
 * The wait is read from every failure; the window only from a 429, except
 * ChatGPT's plan window, which its body names on any 4xx. Neither is
 * inferred: a failure that said nothing carries nothing. On a day window the
 * wait is what the provider said, which may be the day's end (OpenAI's
 * "7h12m3s") or a polite pause that is not (Gemini's "20s"): the window is
 * the authority, and `shortRateLimit` and `withRetry` read it first; the
 * day's end is claimed as `resetAt` only where the provider documents it
 * (Gemini: midnight Pacific). A malformed answer (a violation that is not
 * an object, a Retry-After that is neither a number nor a date) says nothing
 * either, and never throws. A body wrapped in an array (Gemini, at times) is
 * read as its first object.
 */

import type { AIChatResult } from '../types.js';

/** A rate-limit window: a minute window heals by itself, a day window not before tomorrow, a plan window (a subscription's usage limit, hours to a week) at its reset. */
export type RateLimitWindow = NonNullable<AIChatResult['quota']>;

/** The quota that ran out, as far as the provider named it (Gemini's `QuotaFailure`): each field only when said. */
export type RateLimitQuota = NonNullable<AIChatResult['limit']>;

/** What a failed response said about coming back: each field only when the provider said. */
export interface RateLimit {
  /** How long the provider asked us to wait, when it said. */
  retryAfterMs?: number;
  /** When that wait ends, epoch ms (`now + retryAfterMs`, or the instant the provider named); on a day window, the day's end where the provider documents it (Gemini: midnight Pacific), else unset. */
  resetAt?: number;
  /** Which window ran out, when the provider said. */
  quota?: RateLimitWindow;
  /** The quota that ran out — its size, unit, tier and model — when the provider named it. */
  limit?: RateLimitQuota;
}

/**
 * Where the headers come from: a WHATWG `Headers`, or anything with its
 * `get`, asked by the lowercase name (a `Map` must be keyed so); or a plain
 * record as Node's `IncomingHttpHeaders` and test doubles give them — names
 * in any case, an array value read as its first.
 */
export type HeaderSource = { get(name: string): string | null | undefined } | Record<string, string | string[] | undefined>;

/** What a failed response says about coming back; `{}` when it says nothing. */
export function rateLimitOf(status: number, headers: HeaderSource | undefined, body: string, now = Date.now()): RateLimit {
  const out: RateLimit = {};
  const get = headerGetter(headers);
  const json = parseJson(body);
  const plan = status >= 400 && status < 500 ? planWindow(get, json, status) : undefined;
  const named = status === 429 && !plan ? namedQuota(json, body) : undefined;
  const quota = plan ?? named?.window;
  // A plan that does not include the model at all has no wait to come back after. A `RetryInfo` is read on any status, as the
  // header is (Google sends one on a 503 too); the rest of the body only where a limit was named.
  const wait = plan === 'excluded' ? undefined : retryAfterHeader(get, now) ?? retryInfo(json)
    ?? (status === 429 || plan ? bodyWait(json, body, now) ?? codexReset(get, now) ?? resetWindows(get, now) : undefined);
  if (wait !== undefined) {
    out.retryAfterMs = wait;
    // A day window ends when the day does, not when the wait does: no instant is claimed from the wait. The wait stays its words.
    if (quota !== 'day') out.resetAt = now + wait;
  }
  // Gemini documents its day's end: "Requests per day (RPD) quotas reset at midnight Pacific time" (ai.google.dev/gemini-api/docs/rate-limits).
  if (quota === 'day' && named?.documented) {
    const midnight = nextMidnight(now, 'America/Los_Angeles');
    if (midnight !== undefined) out.resetAt = midnight;
  }
  if (quota) out.quota = quota === 'excluded' ? 'plan' : quota;
  if (named?.limit) out.limit = named.limit;
  return out;
}

/** A case-insensitive lookup over any header source; `null` for a header not given, or given as something other than a string. */
function headerGetter(headers: HeaderSource | undefined): (name: string) => string | null {
  if (!headers) return () => null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    return (name) => {
      const value = (get as (name: string) => unknown).call(headers, name);
      return typeof value === 'string' ? value : null;
    };
  }
  const lower = new Map<string, string>();
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    const key = name.toLowerCase();
    if (typeof first === 'string' && !lower.has(key)) lower.set(key, first);
  }
  return (name) => lower.get(name.toLowerCase()) ?? null;
}

/** `retry-after-ms`, else `Retry-After` as seconds or as an HTTP date. */
function retryAfterHeader(get: (name: string) => string | null, now: number): number | undefined {
  const ms = get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms));
  const header = get('retry-after');
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  // Else an HTTP date ("Sat, 18 Oct 2026 12:00:30 GMT"); a malformed number is not one.
  if (!/^[A-Za-z]/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Google's `RetryInfo.retryDelay` ("20s") among the error's details, on any status. */
function retryInfo(json: Record<string, unknown> | undefined): number | undefined {
  for (const detail of details(json)) {
    if (typeof detail['@type'] === 'string' && /RetryInfo$/.test(detail['@type'])) {
      const ms = duration(detail['retryDelay']);
      if (ms !== undefined) return ms;
    }
  }
  return undefined;
}

/**
 * The wait in the body of a named limit: ChatGPT's `resets_in_seconds` or,
 * sent alone, its `resets_at` (epoch seconds), or the words "try again in
 * 1h2m3s" / "retry in 20.5s".
 */
function bodyWait(json: Record<string, unknown> | undefined, body: string, now: number): number | undefined {
  const error = (json?.['error'] ?? json) as Record<string, unknown> | undefined;
  const seconds = error?.['resets_in_seconds'] ?? json?.['resets_in_seconds'];
  if (typeof seconds === 'number' && seconds >= 0) return Math.ceil(seconds * 1000);
  // Epoch seconds: a number of that size, not milliseconds (a thousand times larger) or a date string.
  const at = error?.['resets_at'] ?? json?.['resets_at'];
  if (typeof at === 'number' && Number.isFinite(at) && at >= 0 && at < 1e11) return Math.max(0, Math.ceil(at * 1000 - now));
  const words = /\b(?:try again|retry)\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s*\d+(?:\.\d+)?(?:ms|s|m))*)\b/i.exec(messageOf(json, body));
  return words ? duration(words[1]) : undefined;
}

/** The provider's message: `error.message`, a string `error`, `message`, else the whole body. */
function messageOf(json: Record<string, unknown> | undefined, body: string): string {
  if (!json) return body;
  const error = json['error'];
  if (typeof error === 'string') return error;
  const message = (error && typeof error === 'object' ? (error as Record<string, unknown>)['message'] : undefined) ?? json['message'] ?? json['detail'];
  return typeof message === 'string' ? message : body;
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

/** The window a quota named, where it was named, and the quota itself as far as the violation says. */
interface NamedQuota {
  window: RateLimitWindow;
  /** Named by a Gemini API `QuotaFailure` (its metric is under `generativelanguage.googleapis.com/`), whose day's end Google documents. */
  documented: boolean;
  limit?: RateLimitQuota;
}

const DAY = /per[_ ]?day|daily|\b[RT]PD\b/i;
const MINUTE = /per[_ ]?minute|per[_ ]?min\b|\b[RT]PM\b/i;

/**
 * The window named: Gemini's `QuotaFailure` violations (`…PerDay…`,
 * `…PerMinute…`), the one naming a day window first, with what that
 * violation says of the quota; else the words ("requests per day (RPD)",
 * "tokens per minute (TPM)"). A day window wins over a minute one named
 * alongside it.
 */
function namedQuota(json: Record<string, unknown> | undefined, body: string): NamedQuota | undefined {
  const violations: Array<Record<string, unknown>> = [];
  for (const detail of details(json)) {
    if (typeof detail['@type'] === 'string' && /QuotaFailure$/.test(detail['@type']) && Array.isArray(detail['violations'])) {
      // One by one: a list too long to spread into a call must not throw.
      for (const v of detail['violations']) if (v && typeof v === 'object' && !Array.isArray(v)) violations.push(v as Record<string, unknown>);
    }
  }
  const named = violations.find((v) => DAY.test(quotaNames(v))) ?? violations.find((v) => MINUTE.test(quotaNames(v)));
  if (named) {
    const names = quotaNames(named);
    const limit = quotaOf(named, names);
    return { window: DAY.test(names) ? 'day' : 'minute', documented: /\bgenerativelanguage\.googleapis\.com\//i.test(names), ...(limit ? { limit } : {}) };
  }
  // In words, the window named first is the one that ran out ("on requests per day (RPD): … Please try again in …").
  const message = messageOf(json, body);
  const day = /\bper day\b|\bdaily (?:limit|quota)\b|\b[RT]PD\b/i.exec(message)?.index;
  const minute = /\bper min(?:ute)?\b|\b(?:[RT]PM|ITPM|OTPM)\b/i.exec(message)?.index;
  if (day === undefined && minute === undefined) return undefined;
  const limit = wordsQuota(message);
  return { window: minute === undefined || (day !== undefined && day < minute) ? 'day' : 'minute', documented: false, ...(limit ? { limit } : {}) };
}

/**
 * The quota as the words say it: OpenAI's "on requests per min (RPM): Limit
 * 3, Used 3, Requested 1" and "on tokens per min. Limit: 20.000000 / min",
 * Anthropic's "of 50,000 input tokens per minute". The size after "Limit"
 * or before the unit, the unit from the first window named.
 */
function wordsQuota(message: string): RateLimitQuota | undefined {
  const out: RateLimitQuota = {};
  const limit = /\blimit:?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(message) ?? /\b(\d[\d,]*(?:\.\d+)?)\s+(?:input |output )?(?:requests?|tokens?)\s+per\s+(?:min|minute|day)\b/i.exec(message);
  const n = limit ? Number(limit[1]!.replace(/,/g, '')) : NaN;
  // A unit without a size says nothing the window does not: no quota then.
  if (!Number.isFinite(n) || n < 0) return undefined;
  out.value = Math.floor(n);
  const unit = /\b(requests?|tokens?)\s+per\s+(?:min|minute|day)\b|\b([RT])P[MD]\b|\b[IO](T)PM\b/i.exec(message);
  if (unit) out.unit = /^t/i.test(unit[1] ?? unit[2] ?? unit[3] ?? '') ? 'tokens' : 'requests';
  return out;
}

/** A violation's names, joined: its `quotaId`, `quotaMetric`, `subject` and `description`, those that are strings. */
function quotaNames(violation: Record<string, unknown>): string {
  return ['quotaId', 'quotaMetric', 'subject', 'description'].map((key) => violation[key]).filter((v): v is string => typeof v === 'string').join(' ');
}

/**
 * What a violation says of its quota: the size (`quotaValue`, a count as a
 * number or a numeric string), the unit its names say (tokens, else
 * requests), whether they say free tier, and the model in
 * `quotaDimensions.model`. Nothing for a violation that says none of it.
 */
function quotaOf(violation: Record<string, unknown>, names: string): RateLimitQuota | undefined {
  const out: RateLimitQuota = {};
  const value = violation['quotaValue'];
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (Number.isFinite(n) && n >= 0) out.value = Math.floor(n);
  if (/token/i.test(names)) out.unit = 'tokens';
  else if (/request/i.test(names)) out.unit = 'requests';
  if (/free[_ -]?tier/i.test(names)) out.freeTier = true;
  const dimensions = violation['quotaDimensions'];
  const model = dimensions && typeof dimensions === 'object' ? (dimensions as Record<string, unknown>)['model'] : undefined;
  if (typeof model === 'string' && model.trim()) out.model = model.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ChatGPT's plan window, named by the body on any 4xx: `usage_limit_reached`
 * (the plan's window ran out: `plan`), or `usage_not_included` (the plan
 * does not include the model at all: `excluded`, a plan window with no wait
 * to come back after). On a 429 the headers name it too
 * (`x-codex-rate-limit-reached-type`).
 */
function planWindow(get: (name: string) => string | null, json: Record<string, unknown> | undefined, status: number): 'plan' | 'excluded' | undefined {
  const error = json?.['error'];
  const fields = error && typeof error === 'object' ? [(error as Record<string, unknown>)['type'], (error as Record<string, unknown>)['code']] : [];
  if (fields.includes('usage_not_included')) return 'excluded';
  if (fields.includes('usage_limit_reached') || (status === 429 && get('x-codex-rate-limit-reached-type') !== null)) return 'plan';
  return undefined;
}

/**
 * The next midnight in `timeZone` after `now`, epoch ms, a daylight-saving
 * change between the two included; nothing where the runtime does not know
 * the zone.
 */
function nextMidnight(now: number, timeZone: string): number | undefined {
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // The wall clock at an instant, as ms since that day's midnight (a "24" hour, which some engines print at midnight, read as 0).
    const sinceMidnight = (at: number): number => {
      const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
      return (((Number(parts['hour']) % 24) * 60 + Number(parts['minute'])) * 60 + Number(parts['second'])) * 1000 + (((at % 1000) + 1000) % 1000);
    };
    // A day on from this day's midnight, then put right by what the wall clock reads there: 23:00 after a fall-back, 01:00 after a spring-forward.
    let at = now - sinceMidnight(now) + 86_400_000;
    const drift = sinceMidnight(at);
    if (drift !== 0) at -= drift > 43_200_000 ? drift - 86_400_000 : drift;
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ChatGPT's reset instants (`x-codex-<window>-reset-at`, epoch seconds) for
 * the window `x-codex-rate-limit-reached-type` names, else the latest among
 * the windows used in full (`x-codex-<window>-used-percent` ≥ 100).
 */
function codexReset(get: (name: string) => string | null, now: number): number | undefined {
  // A window name goes into a header name: only a token-shaped one does.
  const given = get('x-codex-rate-limit-reached-type')?.trim().toLowerCase();
  const named = given && /^[a-z0-9_-]{1,64}$/.test(given) ? given : undefined;
  const windows = ['primary', 'secondary', ...(named && !['primary', 'secondary'].includes(named) ? [named] : [])];
  const resetOf = (name: string): number | undefined => {
    // The wait in seconds where given, else the instant.
    const after = get(`x-codex-${name}-reset-after-seconds`);
    if (after !== null && /^\d{1,9}(\.\d+)?$/.test(after.trim())) return Math.ceil(Number(after) * 1000);
    const at = get(`x-codex-${name}-reset-at`);
    if (at === null || !/^\d{1,15}$/.test(at.trim())) return undefined;
    const wait = Number(at) * 1000 - now;
    return Number.isFinite(wait) ? Math.max(0, wait) : undefined;
  };
  if (named) {
    const wait = resetOf(named);
    if (wait !== undefined) return wait;
  }
  const waits = windows
    .filter((name) => Number(get(`x-codex-${name}-used-percent`)) >= 100)
    .map(resetOf)
    .filter((ms): ms is number => ms !== undefined);
  return waits.length > 0 ? Math.max(...waits) : undefined;
}

/* ── pieces ──────────────────────────────────────────────────────── */

/** The body as an object; an array (Gemini wraps a batch's error so) as its first object. */
function parseJson(body: string): Record<string, unknown> | undefined {
  try {
    let parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) parsed = parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item));
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

/** A Go-style duration — "1h2m3.5s", "6m0s", "20ms", "1.5s", also "1m 30s" — in milliseconds. */
export function duration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/(?<=[a-z])\s+(?=\d)/g, '');
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
