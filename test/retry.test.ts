/** withRetry: the loop on top of chat(), retrying only what nothing was acted on, waiting as the provider said. */
import { describe, expect, it, vi } from 'vitest';
import type { AIChatResult } from '../src/types.js';
import { isNetworkFailure, withRetry } from '../src/core/retry.js';

const ok: AIChatResult = { ok: true, text: 'Hi', stopReason: 'end' };
const server: AIChatResult = { ok: false, error: 'HTTP 503: overloaded', retryable: true };
const dropped: AIChatResult = { ok: false, error: 'The connection to api.openai.com dropped (network error).', retryable: true };
const limited: AIChatResult = { ok: false, error: 'HTTP 429: slow down', retryable: true, retryAfterMs: 1500, quota: 'minute' };

/** Answers in order, the last one repeated; records the waits instead of waiting. */
function harness(answers: AIChatResult[]) {
  const attempt = vi.fn(async () => answers.length > 1 ? answers.shift()! : answers[0]!);
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => { waits.push(ms); });
  return { attempt, waits, sleep, random: () => 0.5 };
}

describe('withRetry', () => {
  it('returns a success at once, and a failure that is not retryable without another attempt', async () => {
    const won = harness([ok]);
    expect(await withRetry(won.attempt, won)).toBe(ok);
    expect(won.attempt).toHaveBeenCalledTimes(1);
    const refused = harness([{ ok: false, error: 'HTTP 400: bad request' }]);
    expect(await withRetry(refused.attempt, refused)).toMatchObject({ error: 'HTTP 400: bad request' });
    expect(refused.attempt).toHaveBeenCalledTimes(1);
    expect(refused.sleep).not.toHaveBeenCalled();
  });

  it('waits as the provider asked, else exponentially with jitter, and tells each retry', async () => {
    const h = harness([limited, server, server, ok]);
    const onRetry = vi.fn();
    expect(await withRetry(h.attempt, { ...h, onRetry })).toBe(ok);
    // The 429 said 1500 ms; the 503s are 1000·2^(n−1) with jitter 0.5 + random (=1.0 here).
    expect(h.waits).toEqual([1500, 2000, 4000]);
    expect(onRetry.mock.calls.map(([n]) => n)).toEqual([
      { attempt: 1, waitMs: 1500, result: limited, network: false },
      { attempt: 2, waitMs: 2000, result: server, network: false },
      { attempt: 3, waitMs: 4000, result: server, network: false },
    ]);
    expect(h.attempt).toHaveBeenCalledTimes(4);
    expect(h.attempt).toHaveBeenLastCalledWith(4);
  });

  it('spends the server budget, then returns the last failure', async () => {
    const h = harness([server]);
    expect(await withRetry(h.attempt, { ...h, maxAttempts: 3 })).toBe(server);
    expect(h.attempt).toHaveBeenCalledTimes(3);
    expect(h.waits).toEqual([1000, 2000]);
  });

  it('gives a dropped connection its own, longer budget, capped by the delay ceiling', async () => {
    const h = harness([dropped]);
    expect(await withRetry(h.attempt, { ...h, maxAttempts: 2, maxNetworkAttempts: 6, maxDelayMs: 5000 })).toBe(dropped);
    expect(h.attempt).toHaveBeenCalledTimes(6);
    expect(h.waits).toEqual([1000, 2000, 4000, 5000, 5000]);
    // The ceiling holds jitter included.
    const high = harness([server]);
    expect(await withRetry(high.attempt, { ...high, random: () => 0.99, maxDelayMs: 1000 })).toBe(server);
    expect(high.waits).toEqual([1000, 1000, 1000]);
  });

  it('spends each budget separately when the failures mix', async () => {
    const h = harness([server, dropped, server, ok]);
    expect(await withRetry(h.attempt, { ...h, maxAttempts: 2, maxNetworkAttempts: 3 })).toBe(server);
    expect(h.attempt).toHaveBeenCalledTimes(3);
    const mixed = harness([server, dropped, dropped, server, ok]);
    expect(await withRetry(mixed.attempt, { ...mixed, maxAttempts: 3, maxNetworkAttempts: 3 })).toBe(ok);
    expect(mixed.attempt).toHaveBeenCalledTimes(5);
  });

  it('never retries a day window, a long wait, or a turn that produced output', async () => {
    const day = harness([{ ...limited, quota: 'day', retryable: true }]);
    expect(await withRetry(day.attempt, day)).toMatchObject({ quota: 'day' });
    expect(day.attempt).toHaveBeenCalledTimes(1);
    const long = harness([{ ...server, retryAfterMs: 120_000 }, ok]);
    expect(await withRetry(long.attempt, long)).toMatchObject({ retryAfterMs: 120_000 });
    expect(long.attempt).toHaveBeenCalledTimes(1);
    const spoke = harness([{ ok: false, error: 'cut', retryable: true, text: 'half an answer' }, ok]);
    expect(await withRetry(spoke.attempt, spoke)).toMatchObject({ error: 'cut' });
    const acted = harness([{ ok: false, error: 'cut', retryable: true, toolCalls: [{ id: 'c', name: 't', args: {} }] }, ok]);
    expect(await withRetry(acted.attempt, acted)).toMatchObject({ error: 'cut' });
    // A longer maxWaitMs honours the provider's ask.
    const patient = harness([{ ...server, retryAfterMs: 120_000 }, ok]);
    expect(await withRetry(patient.attempt, { ...patient, maxWaitMs: 300_000 })).toBe(ok);
    expect(patient.waits).toEqual([120_000]);
  });

  it('honours the signal between attempts: an aborted wait is Stopped., and nothing more is sent', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => server);
    const sleep = async (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    const pending = withRetry(attempt, { sleep, signal: controller.signal });
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'Stopped.' });
    expect(attempt).toHaveBeenCalledTimes(1);
    // Already aborted: no attempt at all.
    expect(await withRetry(attempt, { signal: controller.signal })).toMatchObject({ ok: false, error: 'Stopped.' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('waits for real by default, and the signal cuts the wait short', async () => {
    const started = Date.now();
    const h = harness([{ ...server, retryAfterMs: 30 }, ok]);
    expect(await withRetry(h.attempt, { random: h.random })).toBe(ok);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const controller = new AbortController();
    const slow = withRetry(async () => ({ ...server, retryAfterMs: 10_000 }), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    expect(await slow).toMatchObject({ ok: false, error: 'Stopped.' });
  });

  it('stops when the waits would add up past maxTotalWaitMs, with the failure as it stands', async () => {
    // 1000 + 2000 + 4000: the third wait would pass 5000.
    const h = harness([server, server, server, ok]);
    expect(await withRetry(h.attempt, { ...h, maxTotalWaitMs: 5000 })).toBe(server);
    expect(h.waits).toEqual([1000, 2000]);
    expect(h.attempt).toHaveBeenCalledTimes(3);
    // A provider's wait counts the same.
    const asked = harness([limited, limited, limited, ok]);
    expect(await withRetry(asked.attempt, { ...asked, maxTotalWaitMs: 2000 })).toBe(limited);
    expect(asked.waits).toEqual([1500]);
    // Exactly the budget is still within it.
    const exact = harness([server, server, ok]);
    expect(await withRetry(exact.attempt, { ...exact, maxTotalWaitMs: 3000 })).toBe(ok);
    expect(exact.waits).toEqual([1000, 2000]);
  });

  it('waits at least minDelayMs, a provider\'s shorter hint included', async () => {
    const h = harness([{ ...limited, retryAfterMs: 0 }, { ...limited, retryAfterMs: 200 }, server, ok]);
    expect(await withRetry(h.attempt, { ...h, minDelayMs: 500 })).toBe(ok);
    // The third failure is the third attempt's: its backoff is 1000·2².
    expect(h.waits).toEqual([500, 500, 4000]);
    // A hint over maxWaitMs still ends the retries; the floor does not revive it.
    const long = harness([{ ...server, retryAfterMs: 120_000 }, ok]);
    expect(await withRetry(long.attempt, { ...long, minDelayMs: 500 })).toMatchObject({ retryAfterMs: 120_000 });
    // Nor does the floor lift a wait over maxWaitMs: it is capped there.
    const capped = harness([{ ...limited, retryAfterMs: 0 }, ok]);
    expect(await withRetry(capped.attempt, { ...capped, minDelayMs: 2000, maxWaitMs: 1000 })).toBe(ok);
    expect(capped.waits).toEqual([1000]);
  });

  it('bounds a dropped connection in time with networkWindowMs, from the first attempt', async () => {
    let clock = 0;
    const h = harness([dropped, dropped, dropped, dropped, ok]);
    const sleep = async (ms: number) => { h.waits.push(ms); clock += ms; };
    // Waits 1000, 2000, 4000: the third (to 7000) would start past a 5000 ms window.
    expect(await withRetry(h.attempt, { ...h, sleep, now: () => clock, networkWindowMs: 5000, maxNetworkAttempts: Infinity })).toBe(dropped);
    expect(h.waits).toEqual([1000, 2000]);
    expect(h.attempt).toHaveBeenCalledTimes(3);
    // The window lets a long run of short drops through where the count would not.
    clock = 0;
    const many = harness([dropped, dropped, dropped, dropped, dropped, dropped, dropped, ok]);
    const quick = async (ms: number) => { many.waits.push(ms); clock += ms; };
    expect(await withRetry(many.attempt, { ...many, sleep: quick, now: () => clock, networkWindowMs: 120_000, maxNetworkAttempts: Infinity, maxDelayMs: 1000 })).toBe(ok);
    expect(many.attempt).toHaveBeenCalledTimes(8);
    // The window does not bound a server failure; the count still bounds a drop within it.
    clock = 0;
    const mixed = harness([server, server, server, ok]);
    expect(await withRetry(mixed.attempt, { ...mixed, sleep: async (ms) => { mixed.waits.push(ms); clock += ms; }, now: () => clock, networkWindowMs: 10 })).toBe(ok);
    const counted = harness([dropped, dropped, ok]);
    expect(await withRetry(counted.attempt, { ...counted, networkWindowMs: 60_000, maxNetworkAttempts: 2 })).toBe(dropped);
    // A sleep that overran the window (a suspended tab) ends the retries too: the next attempt would start outside it.
    clock = 0;
    const overran = harness([dropped, ok]);
    expect(await withRetry(overran.attempt, { ...overran, sleep: async (ms) => { overran.waits.push(ms); clock += ms + 5000; }, now: () => clock, networkWindowMs: 3000 })).toBe(dropped);
    expect(overran.attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 that named neither a wait nor a window only when retryBare429 says, never a day or plan window', async () => {
    const bare: AIChatResult = { ok: false, error: 'HTTP 429: slow down', failure: { kind: 'http', status: 429, streamed: false } };
    const asIs = harness([bare, ok]);
    expect(await withRetry(asIs.attempt, asIs)).toBe(bare);
    const h = harness([bare, bare, ok]);
    expect(await withRetry(h.attempt, { ...h, retryBare429: true })).toBe(ok);
    expect(h.waits).toEqual([1000, 2000]);
    // A 429 naming a window or a wait is not bare: the usual rules apply.
    for (const named of [{ ...bare, quota: 'day' as const }, { ...bare, quota: 'plan' as const }, { ...bare, retryAfterMs: 120_000 }]) {
      const n = harness([named, ok]);
      expect(await withRetry(n.attempt, { ...n, retryBare429: true })).toBe(named);
    }
    // Nor is one on which output streamed, or another status.
    const spoke = harness([{ ...bare, failure: { kind: 'http', status: 429, streamed: true } }, ok]);
    expect(await withRetry(spoke.attempt, { ...spoke, retryBare429: true })).toMatchObject({ error: 'HTTP 429: slow down' });
    const other = harness([{ ...bare, error: 'HTTP 418', failure: { kind: 'http', status: 418, streamed: false } }, ok]);
    expect(await withRetry(other.attempt, { ...other, retryBare429: true })).toMatchObject({ error: 'HTTP 418' });
  });

  it('throws the signal\'s reason on abort when throwOnAbort says, an AbortError when it has none', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => server);
    const sleep = async (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    const pending = withRetry(attempt, { sleep, signal: controller.signal, throwOnAbort: true });
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    controller.abort(new Error('user left'));
    await expect(pending).rejects.toThrow('user left');
    // Already aborted, with no reason given: an AbortError, before any attempt.
    const bare = new AbortController();
    bare.abort();
    await expect(withRetry(attempt, { signal: bare.signal, throwOnAbort: true })).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempt).toHaveBeenCalledTimes(1);
    // An explicit reason is thrown as given, null included.
    const nulled = new AbortController();
    nulled.abort(null);
    await expect(withRetry(attempt, { signal: nulled.signal, throwOnAbort: true })).rejects.toBeNull();
    // An attempt that saw the abort itself (chat() returns Stopped.) throws the same way; a success that came back as the abort landed is still a success.
    const inner = new AbortController();
    const sawIt = vi.fn(async () => { inner.abort(new Error('closed')); return { ok: false, error: 'Stopped.' } as AIChatResult; });
    await expect(withRetry(sawIt, { signal: inner.signal, throwOnAbort: true })).rejects.toThrow('closed');
    const late = new AbortController();
    const won = vi.fn(async () => { late.abort(); return ok; });
    expect(await withRetry(won, { signal: late.signal, throwOnAbort: true })).toBe(ok);
    // Without throwOnAbort the result is handed back as it came.
    const quiet = new AbortController();
    const sawQuiet = vi.fn(async () => { quiet.abort(); return { ok: false, error: 'Stopped.' } as AIChatResult; });
    expect(await withRetry(sawQuiet, { signal: quiet.signal })).toMatchObject({ error: 'Stopped.' });
  });

  it('lets an exception from the attempt through', async () => {
    await expect(withRetry(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

it('tells a dropped connection from a server answer by the core\'s wording', () => {
  expect(isNetworkFailure(dropped)).toBe(true);
  // The failure data decides when it is there, whatever the sentence says.
  expect(isNetworkFailure({ ok: false, error: 'ECONNRESET', failure: { kind: 'network', streamed: false } })).toBe(true);
  expect(isNetworkFailure({ ok: false, error: 'The connection to the provider dropped (network error).', failure: { kind: 'http', status: 502, streamed: false } })).toBe(false);
  expect(isNetworkFailure({ ok: false, error: 'Network error: the server could not be reached.' })).toBe(true);
  expect(isNetworkFailure({ ok: false, error: 'Could not reach the model server on this computer (http://localhost:11434/v1). Check that it is running.' })).toBe(true);
  expect(isNetworkFailure(server)).toBe(false);
  expect(isNetworkFailure(ok)).toBe(false);
});
