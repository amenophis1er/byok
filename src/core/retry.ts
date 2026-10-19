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
 * exponential with jitter; a wait longer than `maxWaitMs` ends the retries
 * with the failure as it stands. A network failure gets its own, longer
 * budget: nothing reached the server. Between attempts the signal is
 * honoured; an aborted wait is `Stopped.`.
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
  /** The first backoff, doubled each retry, then jittered by ×[0.5, 1.5). Default 1000 ms. */
  baseDelayMs?: number;
  /** The longest backoff, jitter included. Default 30 000 ms. */
  maxDelayMs?: number;
  /** The longest wait honoured: a provider asking for more ends the retries. Default 60 000 ms. */
  maxWaitMs?: number;
  /** Stops the loop; an attempt in flight is the caller's to stop (pass the same signal to `chat()`). */
  signal?: AbortSignal;
  /** Waits; injectable for tests. Default `setTimeout`, cut short by `signal`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The jitter's source, in [0, 1). Default `Math.random`. */
  random?: () => number;
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
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const { signal, onRetry } = options;
  // Each kind of failure spends its own budget: at most maxAttempts + maxNetworkAttempts − 1 attempts in all.
  let statusFailures = 0;
  let networkFailures = 0;
  for (let n = 1; ; n++) {
    if (signal?.aborted) return STOPPED;
    const result = await attempt(n);
    if (!shouldRetry(result)) return result;
    const network = isNetworkFailure(result);
    const failures = network ? ++networkFailures : ++statusFailures;
    if (failures >= (network ? maxNetworkAttempts : maxAttempts)) return result;
    const asked = result.retryAfterMs;
    if (asked !== undefined && asked > maxWaitMs) return result;
    const waitMs = asked ?? Math.min(maxDelayMs, Math.round(baseDelayMs * 2 ** (n - 1) * (0.5 + random())));
    onRetry?.({ attempt: n, waitMs, result, network });
    if (signal?.aborted) return STOPPED;
    await sleep(waitMs, signal);
    if (signal?.aborted) return STOPPED;
  }
}

const STOPPED: AIChatResult = { ok: false, error: 'Stopped.' };

/** Only a failure on which nothing was acted: `retryable`, no output, no day window. */
function shouldRetry(result: AIChatResult): boolean {
  if (result.ok || !result.retryable) return false;
  if (result.quota === 'day') return false;
  if (result.text || (result.toolCalls && result.toolCalls.length > 0)) return false;
  return true;
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
