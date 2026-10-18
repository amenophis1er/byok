/** The sign-in flows are reachable from the core's auth entry point, and are pure functions of fetch. */
import { expect, it } from 'vitest';
import * as auth from '../src/core/auth.js';

it('exports each flow: Claude PKCE, ChatGPT device, OpenCode device grant, Ollama pairing', () => {
  expect(auth.startLogin).toBeTypeOf('function');
  expect(auth.exchangeCode).toBeTypeOf('function');
  expect(auth.refreshTokens).toBeTypeOf('function');
  expect(auth.startDeviceLogin).toBeTypeOf('function');
  expect(auth.pollDevice).toBeTypeOf('function');
  expect(auth.exchangeDeviceCode).toBeTypeOf('function');
  expect(auth.refreshOpenAiTokens).toBeTypeOf('function');
  expect(auth.accountIdFromJwt).toBeTypeOf('function');
  expect(auth.startOpencodeLogin).toBeTypeOf('function');
  expect(auth.pollOpencode).toBeTypeOf('function');
  expect(auth.refreshOpencodeTokens).toBeTypeOf('function');
  expect(auth.publicKeyLine).toBeTypeOf('function');
  expect(auth.connectUrl).toBeTypeOf('function');
  expect(auth.whoami).toBeTypeOf('function');
  expect(auth.disconnect).toBeTypeOf('function');
  expect(auth.withClaudeCodeSystem('x').system[0]?.text).toBe(auth.CLAUDE_CODE_SENTINEL);
});
