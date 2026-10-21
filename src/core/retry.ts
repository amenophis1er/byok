/**
 * The retry loop most callers of `chat()` would write, once, on top of it:
 *
 *   const result = await withRetry((attempt) => chat(conn, credential, request, { signal }), {
 *     signal, onRetry: ({ waitMs, result }) => show(`Retrying in ${waitMs} ms: ${result.error}`),
 *   });
 *
 * It tries again only what `retryable` already means — nothing was acted on:
 * a dropped connection, a failed server, a rate limit that lifts within the
 * minute — and never a turn that produced output, a refused request or a
 * day window. The wait is the provider's (`retryAfterMs`) when it said, else
 * exponential with jitter, never under `minDelayMs`; a wait longer than
 * `maxWaitMs`, or one that would take the waits past `maxTotalWaitMs`, ends
 * the retries with the failure as it stands. A network failure gets its
 * own, longer budget: nothing reached the server; `networkWindowMs` bounds
 * it in time from the first attempt instead. A 429 that named neither a
 * wait nor a window is retried on the backoff only when `retryBare429`
 * says. Between attempts the signal is honoured; an aborted wait is
 * `Stopped.`, or the signal's reason thrown when `throwOnAbort` says.
 *
 * `chat()` itself stays single-shot: a caller with its own policy ignores
 * this.
 */

import type { AIChatResult } from '../types.js';

export interface RetryOptions {
  /** Attempts answered by the server with a failure (5xx, overloaded, a short 429) before giving up. Default 4. */
  maxAttempts?: number;
  /** Attempts on which the connection dropped (nothing was sent) before giving up; its own budget, so a mix may run to maxAttempts + maxNetworkAttempts − 1 attempts. Default 6. */
  maxNetworkAttempts?: number;
  /** How long after the first attempt a dropped connection is still retried: the next attempt must start within it. With `maxNetworkAttempts: Infinity`, the window alone decides. Default none. */
  networkWindowMs?: number;
  /** The first backoff, doubled each retry, then jittered by ×[0.5, 1.5). Default 1000 ms. */
  baseDelayMs?: number;
  /** The longest backoff, jitter included. Default 30 000 ms. */
  maxDelayMs?: number;
  /** The shortest wait, a provider's hint included: "retry after 0 s" waits this long. Never over `maxWaitMs`. Default 0. */
  minDelayMs?: number;
  /** The longest wait honoured: a provider asking for more ends the retries. Default 60 000 ms. */
  maxWaitMs?: number;
  /** The most the waits may add up to: a wait that would pass it ends the retries with the failure as it stands. Default none. */
  maxTotalWaitMs?: number;
  /** Retry a 429 that named neither a wait nor a window (a local or generic server's "slow down"), on the backoff; never a day or plan window. Default false. */
  retryBare429?: boolean;
  /** Throw the signal's reason (an `AbortError` when it has none) on abort, instead of returning `{ ok: false, error: 'Stopped.' }`. Default false. */
  throwOnAbort?: boolean;
  /** Stops the loop; an attempt in flight is the caller's to stop (pass the same signal to `chat()`). */
  signal?: AbortSignal;
  /** Waits; injectable for tests. Default `setTimeout`, cut short by `signal`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The jitter's source, in [0, 1). Default `Math.random`. */
  random?: () => number;
  /** The clock `networkWindowMs` is measured on; injectable for tests. Default `Date.now`. */
  now?: () => number;
  /** Called before each wait: which attempt failed, how long the wait is, and why. */
  onRetry?: (notice: RetryNotice) => void;
}

export interface RetryNotice {
  /** The attempt that failed, from 1. */
  attempt: number;
  /** The wait before the next one, in ms. */
  waitMs: number;
  /** The failure. */
  result: AIChatResult;
  /** Whether the connection dropped (true) or the server answered (false). */
  network: boolean;
}

const DEFAULTS = { maxAttempts: 4, maxNetworkAttempts: 6, baseDelayMs: 1000, maxDelayMs: 30_000, maxWaitMs: 60_000 };

/**
 * Runs `attempt` until it succeeds, fails for good, or the budget is spent.
 * Never throws for a failed result; an exception from `attempt` propagates.
 */
export async function withRetry(attempt: (n: number) => Promise<AIChatResult>, options: RetryOptions = {}): Promise<AIChatResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const maxNetworkAttempts = options.maxNetworkAttempts ?? DEFAULTS.maxNetworkAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const maxWaitMs = options.maxWaitMs ?? DEFAULTS.maxWaitMs;
  // The floor never lifts a wait over the longest honoured.
  const minDelayMs = Math.min(options.minDelayMs ?? 0, maxWaitMs);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const { signal, onRetry, maxTotalWaitMs, networkWindowMs, retryBare429, throwOnAbort } = options;
  const stopped = (): AIChatResult => {
    if (throwOnAbort) throw signal?.reason !== undefined ? signal.reason : new DOMException('The retry loop was aborted.', 'AbortError');
    return STOPPED;
  };
  // Each kind of failure spends its own budget: at most maxAttempts + maxNetworkAttempts − 1 attempts in all.
  let statusFailures = 0;
  let networkFailures = 0;
  let waited = 0;
  const started = now();
  for (let n = 1; ; n++) {
    if (signal?.aborted) return stopped();
    const result = await attempt(n);
    // An attempt that saw the abort itself (chat() returns Stopped.) throws the same way when asked; a success is still a success.
    if (!result.ok && signal?.aborted && throwOnAbort) return stopped();
    if (!shouldRetry(result, retryBare429 === true)) return result;
    const network = isNetworkFailure(result);
    const failures = network ? ++networkFailures : ++statusFailures;
    if (failures >= (network ? maxNetworkAttempts : maxAttempts)) return result;
    const asked = result.retryAfterMs;
    if (asked !== undefined && asked > maxWaitMs) return result;
    const waitMs = Math.max(minDelayMs, asked ?? Math.min(maxDelayMs, Math.round(baseDelayMs * 2 ** (n - 1) * (0.5 + random()))));
    if (maxTotalWaitMs !== undefined && waited + waitMs > maxTotalWaitMs) return result;
    // The next attempt must start within the network window, measured from the first attempt.
    if (network && networkWindowMs !== undefined && now() - started + waitMs > networkWindowMs) return result;
    onRetry?.({ attempt: n, waitMs, result, network });
    if (signal?.aborted) return stopped();
    await sleep(waitMs, signal);
    waited += waitMs;
    if (signal?.aborted) return stopped();
    // A sleep that overran (a suspended tab, a busy loop) may have taken the next attempt past the window.
    if (network && networkWindowMs !== undefined && now() - started > networkWindowMs) return result;
  }
}

const STOPPED: AIChatResult = { ok: false, error: 'Stopped.' };

/**
 * Only a failure on which nothing was acted: `retryable`, no output, no day
 * or plan window — or, when `bare429` says, a 429 that named neither a wait
 * nor a window, which `retryable` leaves out.
 */
function shouldRetry(result: AIChatResult, bare429: boolean): boolean {
  if (result.ok) return false;
  if (!result.retryable && !(bare429 && isBare429(result))) return false;
  if (result.quota === 'day' || result.quota === 'plan') return false;
  if (result.failure?.streamed) return false;
  if (result.text || (result.toolCalls && result.toolCalls.length > 0)) return false;
  return true;
}

/** A 429 that said nothing about coming back: no wait, no window. */
function isBare429(result: AIChatResult): boolean {
  return result.failure?.status === 429 && result.retryAfterMs === undefined && result.quota === undefined;
}

/** A dropped connection, in the core's own words: nothing reached the server. */
export function isNetworkFailure(result: AIChatResult): boolean {
  return !result.ok && /\(network error\)|could not be reached|Could not reach the model server/i.test(result.error ?? '');
}

/** `setTimeout`, cut short by the signal (the wait ends; the loop then returns `Stopped.`). */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); resolve(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
