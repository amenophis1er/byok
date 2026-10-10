# byok

[![npm](https://img.shields.io/npm/v/@amenophis1er/byok)](https://www.npmjs.com/package/@amenophis1er/byok)
[![CI](https://github.com/amenophis1er/byok/actions/workflows/ci.yml/badge.svg)](https://github.com/amenophis1er/byok/actions/workflows/ci.yml)

**Bring-your-own-key AI for Chrome extensions (Manifest V3).** Your users
connect the model they already pay for — an API key, or a sign-in with their
Claude, ChatGPT or Ollama account — and your extension talks to it through one
API, with keys encrypted at rest and never leaving the background worker.

Three provider families, one message-passing API between your UI and your
worker, and `chat()` with native tool calling for agents:

- **Anthropic** — API key, Claude Pro/Max subscription OAuth (PKCE +
  paste-code, no redirect registration), or a pasted `claude setup-token`.
- **OpenAI-compatible** — presets for OpenAI, Google Gemini, OpenRouter,
  Vercel AI Gateway, Cloudflare Workers AI and AI Gateway, Groq, Mistral, xAI,
  DeepSeek, Together AI, Fireworks AI, Cerebras and Ollama (local or cloud),
  plus any other server that speaks `/chat/completions`.
- **ChatGPT subscription** — the Codex device flow + Responses-API backend.
- **Ollama Cloud, connected device** — the `ollama signin` flow: a
  non-extractable Ed25519 key paired on ollama.com, every request signed. No
  API key to copy.
- **Chrome built-in** (`gemini-nano`) is modeled as a connection kind, but
  inference runs in a page context; the host extension wires that side.

> [!WARNING]
> **The Claude Pro/Max and ChatGPT subscription sign-ins are unofficial.**
> Neither Anthropic nor OpenAI offers OAuth for third-party apps, so these
> flows reuse the Claude Code and Codex CLI client IDs and present their
> traffic as those tools (a Claude Code system prompt, the `codex_cli_rs`
> originator, and the header rewrites in `dnr-rules.json`). Either provider
> can stop them working at any time, and using them may break its terms of
> service and put your users' accounts at risk. Make API keys the default in
> your extension, and present subscription sign-in as an at-your-own-risk
> option. API keys and OpenAI-compatible servers use each provider's
> documented API. The Ollama device sign-in follows the `ollama signin`
> client too, but it pairs the extension under its own name.

## Security model

- All secrets live in the **background worker only**. Keys are encrypted at
  rest with a per-install **non-extractable** AES-GCM key (IndexedDB); a
  `chrome.storage.local` dump yields ciphertext.
- UI surfaces get a **redacted view** (`hasKey`, `····a1b2`) — a key that has
  been saved is never sent back out of the worker.
- Provider HTTP happens in the worker: no CORS games in page frames, keys
  never touch host-page contexts.
- OAuth refresh tokens are single-use: the rotated pair is persisted before
  the response is used.

## Install

```
npm install @amenophis1er/byok
```

ESM, TypeScript types included, no runtime dependencies. Entry points:
`@amenophis1er/byok/background` (the worker), `/client` (UI surfaces),
`/types`, and `/dnr-rules.json`.

## Wire the background worker

```ts
// service-worker.ts
import { registerAiHandlers } from '@amenophis1er/byok/background';

registerAiHandlers({
  prefix: 'myext',                       // messages become `myext:ai-*`
  settingsHint: 'Open MyExt settings → AI.',
});
```

Composing with an existing `onMessage` listener instead:

```ts
import { createAiMessageHandler } from '@amenophis1er/byok/background';
const handleAi = createAiMessageHandler({ prefix: 'myext' });
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ...your own messages...
  return handleAi(msg, sendResponse); // true = handled, keeps channel open
});
```

## Call it from any UI surface

```ts
import { createAiClient } from '@amenophis1er/byok/client';

const ai = createAiClient({ prefix: 'myext' });

const view = await ai.get();                       // redacted connections
await ai.saveConnection({ kind: 'openai-compatible', label: '', baseUrl: 'https://api.openai.com/v1',
                          model: 'gpt-5.5', apiKeyMode: 'set', apiKey: 'sk-…', makeActive: true });
const res = await ai.complete({ system: 'Be terse.', prompt: 'Hello' });
if (res.ok) console.log(res.data);
```

Subscription sign-ins are UI-driven state machines (the worker can be killed
between steps; pending state lives in `chrome.storage.session`):

```ts
// Claude Pro/Max: start → user approves in the opened tab → paste `code#state`
await ai.anthropicLoginStart();
await ai.anthropicLoginComplete({ pasted, label: 'Claude (Pro/Max)' });

// ChatGPT: start → show userCode → poll until 'created'
const start = await ai.chatgptLoginStart();
// poll every few seconds (chatgptPollDelay in /background gives the delay)
const poll = await ai.chatgptLoginPoll('ChatGPT');

// Ollama Cloud: start → user clicks Connect in the opened tab → poll until 'created'
const o = await ai.ollamaLoginStart('My Extension (Chrome)'); // name shown on the connect page
// poll every o.data.pollMs
const done = await ai.ollamaLoginPoll(''); // '' = label "Ollama Cloud (<account>)"
```

## Demo extension

`example/demo` is a complete host extension: every provider and sign-in flow,
connection management, a model picker, and a chat playground where the model
calls two tools that run in the page. About 500 lines of plain JavaScript on
the client API, with no bundler.

```
npm run example        # builds the library into example/demo
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load
unpacked**, pick `example/demo`, and click the extension's toolbar button. For
a local Ollama, allow extensions first: see
[Local servers](#local-servers-ollama-lm-studio).

## Chat with tools (agents)

`chat()` is one model turn with tool calling, for an agent loop running in the
worker. Call it directly — `runtime.sendMessage` does not reach the sender's
own context — or send `${prefix}:ai-chat` from a page (`ai.chat(...)`).

```ts
import { chat } from '@amenophis1er/byok/background';

const result = await chat({
  system: 'You drive a browser.',
  messages,                      // AIMessage[]: user / assistant / tool
  tools: [{ name: 'browser', description: '…', inputSchema: { type: 'object', /* … */ } }],
  connectionId, connectionRevision, // pin the run's connection (from ai.get())
}, { signal });                  // Stop

if (!result.ok) { /* show result.error once; do not retry against a live page */ }
else if (result.toolCalls) {
  // Persist the assistant turn WITH providerState, then answer every call id.
  messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls, providerState: result.providerState });
  for (const call of result.toolCalls) {
    const content = call.argsError ? `Invalid arguments: ${call.argsError.message}` : await runTool(call.args);
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: !!call.argsError });
  }
}
```

What it guarantees:

- **Streamed, validated to the end.** Every request streams (SSE); a result is
  returned only after the provider's terminal event (`message_stop` /
  `finish_reason`). An SSE error event or a stream that ends early is
  `ok: false`, however complete the partial output looked.
- **Native tool calling per provider.** Anthropic `tool_use`/`tool_result`
  (system prompt and tools cached), OpenAI-compatible `tool_calls` (OpenAI,
  OpenRouter, Ollama local and ollama.com, …). One call per response by default
  (`parallelToolCalls: false`); servers that reject the field are retried
  without it.
- **Nothing half-made is handed out.** Arguments that are not valid JSON come
  back as `argsError` (answer them with an error result). A turn cut off by the
  token limit or a refusal (`stopReason: 'length' | 'refusal'`) carries no tool
  calls.
- **ChatGPT subscription too.** A ChatGPT Plus/Pro connection (signed
  in with the device code) talks to OpenAI's Codex backend — the Responses API
  — with the same tools: calls and results become `function_call` /
  `function_call_output` items. No output cap is sent (the backend refuses
  one) and nothing is stored server-side (`store: false`).
- **Its models come from the Codex catalog.** `listModels` for a
  ChatGPT connection asks `chatgpt.com/backend-api/codex/models` for the
  account's own list, hidden entries left out, and a new sign-in starts on the
  first one. The backend hides models from clients it deems old, so the request
  claims the Codex CLI version in `CODEX_CLIENT_VERSION`: bump it with releases.
  When the catalog cannot be fetched the built-in `CODEX_MODELS` list stands in.
- **Images and PDFs.** Content can be `{type:'image', mediaType, data}` or,
  `{type:'document', mediaType:'application/pdf', data, name?}`
  (base64). Anthropic gets `image` / `document` blocks; OpenAI-compatible
  servers get `image_url` / `file` parts, moved out of tool messages into a
  user message after them. A server without image or PDF input rejects the
  request: fall back to text.
- **Replay what the provider needs.** `providerState` (Anthropic: the turn's
  content blocks, thinking signatures included) must be stored with the
  assistant message and sent back unchanged.
- **Pinned connection.** With `connectionId` + `connectionRevision`, a deleted
  or edited connection fails the call instead of sending the conversation to a
  different provider.
- Not yet: Chrome's built-in model (`gemini-nano`) through `chat()`.

Live check: `npm run build && node scripts/smoke.mjs` runs a two-turn tool round
trip against each provider it has credentials for (Ollama Cloud from
`~/.ollama`, others from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`OPENROUTER_API_KEY`).

## What the host extension must declare

**Permissions** — `storage`, `declarativeNetRequest` (subscription auth
only), and `tabs.create` works without a permission.

**Host permissions** for the providers you enable:

```jsonc
"host_permissions": [
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "https://ollama.com/*",
  "https://openrouter.ai/*",
  "https://claude.com/*",          // Claude subscription consent
  "https://platform.claude.com/*", // Claude subscription token endpoint
  "https://auth.openai.com/*",     // ChatGPT device flow
  "https://chatgpt.com/*"          // Codex inference backend
],
"optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]
```

Other presets and custom base URLs (self-hosted, LM Studio, local Ollama)
need an on-demand grant — `originPattern(baseUrl)` from `/types` gives you the
match pattern for `chrome.permissions.request`.

**Base URLs** for OpenAI-compatible connections are the API root: requests go
to `${baseUrl}/chat/completions` and `${baseUrl}/models`, so the root is
whatever comes before `/chat/completions` in the provider's docs (Gemini:
`…/v1beta/openai`, Groq: `…/openai/v1`). `normalizeBaseUrl` adds `/v1` to a
bare origin like `api.openai.com` or `localhost:11434` and keeps any other path
as typed. `OPENAI_COMPATIBLE_PRESETS` lists the known roots; the Cloudflare
ones contain `{account_id}` (and `{gateway_id}`) for the user to fill in, and a
connection whose URL still has one is refused. Some servers (Cloudflare among
them) may list no models, so let users type a model id too, as the demo does.

**DNR rules** (subscription auth only): merge `manifest/dnr-rules.json` into
your ruleset (it is exported as
`@amenophis1er/byok/dnr-rules.json`). Anthropic subscription orgs reject CORS-classified requests
and the Codex backend rejects browser-shaped ones, so these strip
`Origin`/`Sec-Fetch-*` (and set the expected `user-agent`) on those hosts.
Rule ids are 9001–9003; renumber on collision.

## Local servers (Ollama, LM Studio)

A server on your machine sees requests from an extension with an
`Origin: chrome-extension://<id>` header, and may refuse them: the request then
fails with **HTTP 403**. The extension also needs the host permission for
`http://localhost/*` (asked on demand, see above).

**Ollama** accepts only the origins listed in `OLLAMA_ORIGINS`. Allow one
extension with `chrome-extension://<its id>` (shown in `chrome://extensions`),
or all of them with `chrome-extension://*`. Then restart Ollama. On a Mac, how
depends on how Ollama runs:

- **The Ollama app** (menu bar icon):

  ```
  launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
  ```

  Quit Ollama from the menu bar and open it again. `launchctl setenv` lasts
  until you log out; to keep it, add the same line to a login item or use one
  of the options below.

- **Homebrew service** (`brew services start ollama`): add the variable to the
  service's launch agent, then restart it with `launchctl`. `brew services
  restart` would rewrite the file from the formula and drop the variable.

  ```
  P=~/Library/LaunchAgents/homebrew.mxcl.ollama.plist
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" $P 2>/dev/null
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OLLAMA_ORIGINS string chrome-extension://*" $P
  launchctl bootout gui/$(id -u)/homebrew.mxcl.ollama
  launchctl bootstrap gui/$(id -u) $P
  ```

  Run it again after `brew upgrade ollama` or `brew services restart ollama`.

- **Your own launch agent** (a plist in `~/Library/LaunchAgents` running
  `ollama serve`): add `OLLAMA_ORIGINS` under `EnvironmentVariables`, then
  reload it. If `bootstrap` reports an input/output error, the old job was
  still stopping: run it again.

  ```
  launchctl bootout gui/$(id -u)/<label>
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
  ```

- **In a terminal**: `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`.

On Linux (systemd), run `sudo systemctl edit ollama`, add
`Environment="OLLAMA_ORIGINS=chrome-extension://*"` under `[Service]`, then
`sudo systemctl restart ollama`. On Windows, set it as a user environment
variable and restart Ollama.

Check it worked. This should print `200`, not `403`:

```
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: chrome-extension://x" localhost:11434/v1/models
```

**LM Studio**: in the Developer tab, open the server settings and turn on
**Enable CORS**.

## Provider fine print (already handled, documented so you don't undo it)

- Anthropic **API keys** need `anthropic-dangerous-direct-browser-access`;
  **subscription tokens** are rejected if it's present, must use
  `Authorization: Bearer`, and are gated on Claude-Code-shaped traffic — the
  system prompt is automatically prefixed with the Claude Code sentinel.
- The ChatGPT flow polls by `device_auth_id` (not RFC-8628 `device_code`),
  and users must first enable *“device code authorization for Codex”* in
  ChatGPT security settings. Codex only streams; the SSE is aggregated for
  you. Tokens do **not** work against `api.openai.com`.
- Ollama Cloud device keys: `Authorization: <ssh public key>:<Ed25519
  signature of "METHOD,PATH?ts=<unix>">`, with the same `ts` in the query —
  ollama's own scheme, accepted on `/api/*` and `/v1/*`. An unpaired key is
  **not** a 401 on `/api/me` (it returns an all-zero user), so pairing is
  detected by a real user ID. Removing the connection un-pairs the key on
  ollama.com and deletes it. Needs WebCrypto Ed25519 (Chrome 137+).
- `<think>…</think>` / `<reasoning>…</reasoning>` blocks are stripped from
  completions (local models emit them despite instructions).
- Debug logging: `chrome.storage.local.set({ <debugFlagKey>: true })` in the
  SW console logs full request/response bodies (never keys).

## Migrating an extension that already stored connections

Pass your legacy names so nothing is lost:

```ts
registerAiHandlers({
  prefix: 'myext',               // keep existing message names
  storageKey: 'ai',              // keep stored connections
  cryptoDbName: 'myext-crypto',  // keep decrypting existing ciphertext
  debugFlagKey: 'myextDebug',
});
```

v1/v2 config shapes (flat plaintext key / per-kind creds) are migrated and
encrypted automatically on first load.

## Storage/session keys used

- `chrome.storage.local`: `<storageKey>` (config), `<debugFlagKey>` (flag)
- `chrome.storage.session`: `aiConnectAnthropicLogin`, `aiConnectChatgptDevice`,
  `aiConnectOllamaConnect` (pending sign-ins; safe to lose — the user just
  restarts the flow)
- IndexedDB `<cryptoDbName>`: the non-extractable AES key, and one
  non-extractable Ed25519 key pair per Ollama Cloud connection
  (`ed25519:<connection id>`)

## Versioning

[Semantic versioning](https://semver.org). The public API is what the four
entry points export; it is recorded in `api/*.api.md` and CI fails on any
change to it that was not committed on purpose — so an additive change is a
minor release and a breaking one a major (while on 0.x: a minor). The
messages between `createAiClient` and the worker carry `PROTOCOL_VERSION`; a
worker meeting a newer one than its own refuses the message with an error
asking to reload the extension, instead of misreading it. Changes are listed
in [CHANGELOG.md](CHANGELOG.md).

## Releasing (maintainers)

Bump `version` in package.json and add the release to CHANGELOG.md, merge,
then tag: `git tag v0.1.1 && git push --tags`. The release workflow checks the
tag against the version, runs the tests and the API check, and publishes to
npm with provenance through trusted publishing (no token stored anywhere).

## License

Apache-2.0. See [LICENSE](LICENSE).
