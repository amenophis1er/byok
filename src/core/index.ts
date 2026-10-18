/**
 * The library without the browser: `chat()` and `listModels()` against a
 * connection and its credential, in Node 20+, Bun, Deno, Workers or a page.
 * Keys, storage and sign-in flows are the caller's; this is the protocols.
 *
 *   import { chat } from '@amenophis1er/byok/core';
 *   const result = await chat(
 *     { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
 *     process.env.OPENAI_API_KEY,
 *     { system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }], tools: [] },
 *   );
 */

export { chat, protocolCandidates, TIMED_OUT, type ChatOptions, type ChatRequest } from './chat.js';
export type { ChatEvent, ChatEventSink } from './events.js';
export { listModels } from './models.js';
export { protocolOf, type Connection } from './connection.js';
export { apiRoot, type Authorizer, type ConnectionCredential } from './http.js';
export { OPENCODE_BASE, opencodeHeaders } from './opencode-oauth.js';
export { CODEX_MODELS, CODEX_CLIENT_VERSION } from './openai-oauth.js';
export { signRequest, OLLAMA_BASE } from './ollama-device.js';
