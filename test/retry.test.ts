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
    expect(await pending).toEqual({ ok: false, error: 'Stopped.' });
    expect(attempt).toHaveBeenCalledTimes(1);
    // Already aborted: no attempt at all.
    expect(await withRetry(attempt, { signal: controller.signal })).toEqual({ ok: false, error: 'Stopped.' });
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
    expect(await slow).toEqual({ ok: false, error: 'Stopped.' });
  });

  it('lets an exception from the attempt through', async () => {
    await expect(withRetry(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

it('tells a dropped connection from a server answer by the core\'s wording', () => {
  expect(isNetworkFailure(dropped)).toBe(true);
  expect(isNetworkFailure({ ok: false, error: 'Network error: the server could not be reached.' })).toBe(true);
  expect(isNetworkFailure({ ok: false, error: 'Could not reach the model server on this computer (http://localhost:11434/v1). Check that it is running.' })).toBe(true);
  expect(isNetworkFailure(server)).toBe(false);
  expect(isNetworkFailure(ok)).toBe(false);
});
