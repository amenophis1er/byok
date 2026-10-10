/** The client and the worker's handlers agree on a protocol version; a newer one is refused with a clear error. */
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../src/types.js';

describe('the message protocol', () => {
  it('the client stamps every message with the protocol version, under its own type', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('chrome', { runtime: { sendMessage: async (message: unknown) => { sent.push(message); return { ok: true }; } } });
    const { createAiClient } = await import('../src/client.js');
    await createAiClient({ prefix: 'x' }).setActive('c1');
    expect(sent).toEqual([{ id: 'c1', type: 'x:ai-set-active', v: PROTOCOL_VERSION }]);
    vi.unstubAllGlobals();
  });

  it('the worker refuses a message from a newer protocol, and leaves other messages alone', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => undefined } }, runtime: { onMessage: { addListener: () => undefined } } });
    const { createAiMessageHandler } = await import('../src/background/index.js');
    const handle = createAiMessageHandler({ prefix: 'x' });
    const answers: unknown[] = [];
    expect(handle({ type: 'x:ai-get', v: PROTOCOL_VERSION + 1 } as { type: string }, (answer) => answers.push(answer))).toBe(false);
    expect(answers[0]).toMatchObject({ ok: false, error: expect.stringMatching(/newer version.*Reload the extension/) });
    expect(handle({ type: 'other:thing', v: 99 } as { type: string }, () => undefined)).toBe(false);
    vi.unstubAllGlobals();
  });
});
