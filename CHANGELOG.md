# Changelog

All notable changes to this package. It follows [semantic versioning](https://semver.org);
while on 0.x, a breaking change bumps the minor version.

## 0.2.0

- **Protocols are separate from connections.** A connection says who requests
  go to and how they authenticate; its `protocol` — `anthropic` (the Messages
  API), `responses` (the OpenAI Responses API) or `chat-completions` — says
  how they are written. `ConnectionView.protocol` shows it, and an
  openai-compatible connection can be saved with `protocol: 'responses'` to
  speak OpenAI's own Responses API at `${baseUrl}/responses`. Existing
  connections keep theirs: 'anthropic' speaks `anthropic`, 'chatgpt'
  `responses`, 'openai-compatible' `chat-completions`. Minor bump: the view
  gained a field, and `complete()` is now a `chat()` turn (streamed, same
  answer).
- **OpenCode models on their own protocol.** OpenCode serves each model on
  the protocol of its origin — Claude on Messages, GPT on Responses, most
  others on Chat Completions — and answers 400 "Model does not support this
  protocol" to any other. A turn now starts on the likely one (by name) and
  moves to the next on that answer, remembering what worked for the worker's
  lifetime. Gemini models, served on Google's own protocol, which the library
  has no client for yet, fail with a clear error.
- The OpenCode inference root is `https://opencode.ai/inference/v1` (the
  earlier `…/inference/openai/v1` did not exist), and the demo asks for
  `https://opencode.ai/*`.
- A failed request that is not a network error no longer suggests
  `OLLAMA_ORIGINS` unless the server is on this computer.
- **Sign in with OpenCode**: the OpenCode Console device code
  (`opencodeLoginStart` / `opencodeLoginPoll`), as `opencode auth login` does
  it. The connection is OpenAI-compatible against
  `https://opencode.ai/inference/v1`, its token refreshed at the
  Console and its organization sent as `x-opencode-org-id`. Set
  `AiHandlerOptions.opencodeClientId` to your extension's name: the Console
  registers no clients, and the approval page shows the id (an unknown one as
  "Unknown client"). OpenCode's free models answer only its own client; the
  token reaches the paid ones.
- A sign-in connection's `keyHint` is the account it signed in as, when the
  provider says (OpenCode: the email).

## 0.1.2

- Presets for Google Gemini, Vercel AI Gateway, Cloudflare Workers AI and AI
  Gateway, Groq, Mistral, xAI, DeepSeek, Together AI, Fireworks AI and
  Cerebras, all on the OpenAI-compatible connection.
- Base URLs are now the API root: requests go to `${baseUrl}/chat/completions`
  and `/models`, with no `/v1` added except to a bare origin. This is what lets
  Gemini (`…/v1beta/openai`) and the Cloudflare AI Gateway (`…/compat`) work.
  Connections saved by earlier versions are read as `<old base>/v1` and keep
  working. **Host extensions**: `normalizeBaseUrl` now keeps the `/v1`
  (`https://openrouter.ai/api/v1`, not `https://openrouter.ai/api`), and a
  stripped base URL you pass to `listModels` or `saveConnection` yourself
  must get its `/v1` back.
- A base URL with an unfilled `{placeholder}` is refused.
- Token counts from every OpenAI-compatible server that supports
  `stream_options.include_usage` (xAI and Gemini sent none before). A server
  that rejects the field, or `parallel_tool_calls`, gets the request again
  without it.
- Tool calling with Gemini: a tool call's `extra_content` (Gemini's
  `thought_signature`) is returned in `providerState` and sent back with the
  next turn, which Gemini requires.
- Model lists: Gemini's come from its own API, keeping only the models that
  support `generateContent` (its OpenAI-compatible list includes embedding,
  image and agent models that 404 on chat); Workers AI's come from its model
  search (Text Generation only), as it has no `/models`; a bare array
  (Together) is read.
- Demo: placeholder URLs are editable, a model id can be typed when the server
  lists none, and Connect is disabled again after connecting.

## 0.1.1

- Published from the release workflow through npm trusted publishing, with a
  provenance attestation linking the package to its source commit. No code
  changes.

## 0.1.0

First release.

- Connections for Chrome extensions (Manifest V3): Anthropic API keys, Claude
  Pro/Max sign-in and setup tokens; ChatGPT sign-in (Codex backend); Ollama
  Cloud device keys; any OpenAI-compatible server (OpenAI, OpenRouter, local
  Ollama, LM Studio).
- Keys and tokens encrypted at rest with a non-extractable key, used only in
  the background worker; UI surfaces see redacted connections.
- `chat()`: one model turn with native tool calling, streamed and validated to
  the provider's terminal event, with images and PDF documents.
- `complete()` for one-shot text, and `listModels()` per connection (the Codex
  catalog for ChatGPT).
- Network errors marked `retryable` when sending again is safe.
- One message-passing API between UI and worker, carrying
  `PROTOCOL_VERSION`.
- Public API recorded in `api/*.api.md` and checked in CI.
- A demo extension in `example/demo`.
