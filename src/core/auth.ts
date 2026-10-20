/**
 * The sign-in flows, for a host that owns storage and UI: the Claude
 * subscription PKCE flow, the ChatGPT (Codex) device flow, the OpenCode
 * Console device grant and the Ollama connected-device pairing. Each starts a
 * flow, polls or exchanges, and refreshes; where the tokens go is the
 * caller's. Nothing here touches the browser.
 *
 *   import { startOpencodeLogin, pollOpencode } from '@amenophis1er/byok/core/auth';
 *
 * The Claude and ChatGPT flows are unofficial: they reuse the Claude Code and
 * Codex CLI client ids (see the README's warning).
 */

export type { Fetch, RequestOptions } from './http.js';
export { AuthError } from './auth-error.js';

export {
  CLAUDE_CODE_SENTINEL,
  exchangeCode,
  isSetupToken,
  parsePaste,
  refreshTokens,
  startLogin,
  withClaudeCodeSystem,
  type AnthropicTokens,
  type LoginStart,
} from './anthropic-oauth.js';

export {
  DEVICE_TIMEOUT_MS,
  accountIdFromJwt,
  exchangeDeviceCode,
  nextPollDelayMs,
  pollDevice,
  refreshOpenAiTokens,
  startDeviceLogin,
  type DevicePoll,
  type DeviceStart,
  type OpenAiTokens,
} from './openai-oauth.js';

export {
  DEFAULT_CLIENT_ID as OPENCODE_DEFAULT_CLIENT_ID,
  OPENCODE_BASE,
  OPENCODE_CONSOLE,
  OPENCODE_ORG_HEADER,
  opencodeAccount,
  opencodeHeaders,
  opencodePollDelayMs,
  pollOpencode,
  refreshOpencodeTokens,
  startOpencodeLogin,
  type OpencodeDeviceStart,
  type OpencodePoll,
  type OpencodeTokens,
} from './opencode-oauth.js';

export {
  CONNECT_POLL_MS,
  CONNECT_TIMEOUT_MS,
  OLLAMA_BASE,
  connectUrl,
  disconnect,
  encodedKey,
  publicKeyLine,
  signRequest,
  whoami,
} from './ollama-device.js';
