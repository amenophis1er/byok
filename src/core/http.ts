/**
 * What every provider request shares: the API root, auth headers, and an HTTP
 * failure in words. Nothing here touches the browser.
 */

import { normalizeBaseUrl } from '../types.js';
import { rateLimitOf, type RateLimit, type RateLimitQuota, type RateLimitWindow } from './rate-limit.js';
import { providerCodeOf, requestIdOf } from './failure.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The API root requests go to; refuses one with an unfilled `{placeholder}`. */
export function apiRoot(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const placeholder = /\{[^}]*\}/.exec(base);
  if (placeholder) throw new Error(`Replace ${placeholder[0]} in the base URL with your own value.`);
  return base;
}

/**
 * Auth headers for one request; may also edit the URL (a device-key
 * signature adds `ts` to the query).
 */
export type Authorizer = (method: string, url: URL) => Promise<Record<string, string>>;

/** What a connection authenticates with: a key or token, or a signer for each request (an Ollama device key). */
export type ConnectionCredential = string | Authorizer;

/**
 * `fetch` as the core calls it: a URL or string and the standard init,
 * answering a `Response` whose `body` is a `ReadableStream` and honouring
 * `init.signal`. The global one by default; a host that owns its transport
 * (a proxy, a custom CA, a fresh connection per request, a test double)
 * passes its own.
 */
export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** What every request-making function takes: the host's `fetch`, else the global one. */
export interface RequestOptions {
  /** Makes every request of this call. Default `globalThis.fetch`. */
  fetch?: Fetch;
}

/** The fetch to call: the host's, else the global one, looked up at call time. */
export function fetchOf(options?: RequestOptions): Fetch {
  return options?.fetch ?? ((input, init) => fetch(input, init));
}

export function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function bearerAuth(apiKey: string): Authorizer {
  return async () => bearer(apiKey);
}

/**
 * Anthropic headers. Subscription tokens ride in Authorization (x-api-key
 * 401s for them); API keys use x-api-key.
 *
 * The `dangerous-direct-browser-access` header opts a request into CORS
 * (browser) handling — API keys NEED it in a browser (else 401 "must set the
 * header"), and it is harmless from a server; subscription orgs REJECT it
 * ("CORS requests are not allowed for this Organization"). In an extension,
 * subscription requests go out as plain server requests: no such header, and
 * the host's DNR ruleset (manifest/dnr-rules.json) strips Origin/Sec-Fetch on
 * api.anthropic.com so Anthropic doesn't classify them as CORS.
 */
export function anthropicHeaders(token: string, subscription: boolean): Record<string, string> {
  return subscription
    ? {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': ANTHROPIC_VERSION,
      }
    : {
        'x-api-key': token,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };
}

/**
 * A request the server refused, with what it said about coming back: the
 * status, and on a rate limit the wait it asked for and the window that ran
 * out, when it said. `listModels()` throws it; `chat()` folds it into its
 * result (`error`, `retryAfterMs`, `quota`, `retryable`).
 */
export class HttpError extends Error {
  /** The HTTP status the server answered with. */
  readonly status: number;
  /** How long the server asked us to wait, when it said. */
  readonly retryAfterMs?: number;
  /** When that wait ends, epoch ms; on a day window, the day's end where the server documents it (Gemini: midnight Pacific), else unset. */
  readonly resetAt?: number;
  /** Which rate-limit window ran out, when the server said. */
  readonly quota?: RateLimitWindow;
  /** The quota that ran out — its size, unit, tier and model — when the server named it. */
  readonly limit?: RateLimitQuota;
  /** The provider's own code, when the body carried one (`rate_limit_error`, `insufficient_quota`, …). */
  readonly providerCode?: string;
  /** The provider's request id, when a header carried one. */
  readonly requestId?: string;
  constructor(status: number, message: string, rateLimit: RateLimit = {}, source: { providerCode?: string; requestId?: string } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (rateLimit.retryAfterMs !== undefined) this.retryAfterMs = rateLimit.retryAfterMs;
    if (rateLimit.resetAt !== undefined) this.resetAt = rateLimit.resetAt;
    if (rateLimit.quota !== undefined) this.quota = rateLimit.quota;
    if (rateLimit.limit !== undefined) this.limit = rateLimit.limit;
    if (source.providerCode !== undefined) this.providerCode = source.providerCode;
    if (source.requestId !== undefined) this.requestId = source.requestId;
  }
}

/** The provider's code and request id of a failed response, for an `HttpError`. */
export function failureSource(res: Response, body: string): { providerCode?: string; requestId?: string } {
  const providerCode = providerCodeOf(body);
  const requestId = requestIdOf(res.headers);
  return { ...(providerCode ? { providerCode } : {}), ...(requestId ? { requestId } : {}) };
}

/** A failed response as an `HttpError`: the status and body in words, what it said about coming back, its code and request id. */
export async function httpFailure(res: Response, message?: string): Promise<HttpError> {
  const text = await res.text();
  return new HttpError(res.status, message ?? describeHttpText(res.status, text), rateLimitOf(res.status, res.headers, text), failureSource(res, text));
}

/** The rate-limit fields of a failure, only those it carries, for spreading into a result. */
export function rateLimitFields(error: HttpError): RateLimit {
  return {
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}),
    ...(error.quota !== undefined ? { quota: error.quota } : {}),
    ...(error.limit !== undefined ? { limit: error.limit } : {}),
  };
}

/**
 * A 429 worth one more try: the provider asked for a short wait (a minute at
 * most), or named a minute window, which heals by itself. A day window is
 * gone until tomorrow, a plan window until its reset (hours), and a long or
 * unknown wait is the caller's to decide.
 */
export function shortRateLimit(error: HttpError): boolean {
  if (error.status !== 429 || error.quota === 'day' || error.quota === 'plan') return false;
  return error.retryAfterMs !== undefined ? error.retryAfterMs <= 60_000 : error.quota === 'minute';
}

export async function describeHttp(res: Response): Promise<string> {
  return describeHttpText(res.status, await res.text());
}

export function describeHttpText(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    detail =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? body.slice(0, 200));
  } catch {
    detail = body.slice(0, 200);
  }
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

export function errMessage(error: unknown): string {
  if (error instanceof TypeError) return 'Network error: the server could not be reached.';
  return error instanceof Error ? error.message : String(error);
}
