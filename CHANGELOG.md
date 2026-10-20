# Changelog

All notable changes to this package. It follows [semantic versioning](https://semver.org);
while on 0.x, a breaking change bumps the minor version.

## 0.1.9

- **The host's own `fetch`** (#31, `@amenophis1er/byok/core`): every request
  the core makes goes through `options.fetch` when given — `chat(…, { fetch })`,
  `listModels(conn, credential, { fetch })`, `getModelInfo(conn, credential,
  modelId, { fetch })`, and a trailing `{ fetch }` on each sign-in, poll and
  refresh call in `core/auth` — else the global one, looked up at call time.
  `Fetch` and `RequestOptions` are exported. For a proxy, a custom CA,
  logging, a test double, or a Node transport that does not reuse a stale
  keep-alive socket. Nothing changes for extensions.
- **The Codex originator is the host's to set** (#25): `Connection.originator`
  names the client in the `originator` header of a ChatGPT turn and of the
  Codex catalog request (`codexModels`'s `originator` too), default
  `codex_cli_rs` as before (`CODEX_ORIGINATOR`, exported). The worker takes
  it as `AiHandlerOptions.codexOriginator`. The device-flow and refresh calls
  never carried one, and still do not.
- **An idle limit, and the whole-request limit's off switch** (#39).
  `idleTimeoutMs` (on the request or in `ChatOptions`) fails the turn with
  `Timed out waiting for the model.` only when nothing arrives from the
  server for that long, from the request going out and between stream
  chunks; off by default. `timeoutMs: 0` turns the whole-request limit off in
  the core (the caller's `signal` remains). The pair for a long thinking
  turn: `{ timeoutMs: 0, idleTimeoutMs: 120_000 }`. The worker passes both
  through; its token refresh keeps the 120 s default.
- **Usage that means the same thing everywhere; cache controls; the model
  that answered** (#38). `usage.inputTokens` is the whole prompt on every
  provider, cached tokens included — Anthropic's `input_tokens` left them
  out, so its count rises by `cacheReadTokens + cacheWriteTokens` — and
  `cacheReadTokens` is read from OpenAI's and the Responses API's
  `cached_tokens` details too. `ChatRequest.cacheConversation` puts an
  Anthropic `cache_control` breakpoint on the last message, so each turn
  reads the one before from the cache; `ChatRequest.cacheKey` is OpenAI's
  `prompt_cache_key`, sent to OpenAI itself on Chat Completions and the
  Responses API and to no other server (a Chat Completions server that
  refuses it gets the request again without it). `AIChatResult.model` is the
  model that answered, as the provider named it.
- **Small fixes** (#41): the Anthropic model list is read across its pages
  (`has_more` / `after_id`); the Codex catalog's `context_window` and
  `input_modalities` are kept as `contextWindow` and `capabilities.images`;
  the Claude table reads the `[1m]` variant (with its 1M window), Bedrock ids
  (`us.anthropic.claude-…-v1:0`) and Vertex ids (`claude-…@20250805`);
  images may be `image/gif` and `image/webp` (the Gemini API takes no GIF); a
  token refresh the provider answers `invalid_grant` says "remove the
  connection and sign in again" instead of reading as a transient failure;
  a 429 while polling the ChatGPT device flow means slow down, not denied.
  Ollama request signing was checked against ollama's client and already
  matches it (method and path, the query excluded), so it is unchanged.
- **Rate limits beyond a minute or a day** (#40). A failed result, an
  `HttpError` and `rateLimitOf()` carry `resetAt` (epoch ms, when the wait
  ends) beside `retryAfterMs`, and `quota` gains `'plan'`: a subscription's
  usage window, read from ChatGPT's `usage_limit_reached` and its
  `x-codex-rate-limit-reached-type` header, with the wait from
  `resets_in_seconds` or the `x-codex-<window>-reset-at` instants (the window
  named, else the ones used in full). A plan window is never `retryable` and
  `withRetry` leaves it alone, as with a day window. A Gemini error body
  wrapped in an array is read. On a day window the wait stays what the
  provider said (OpenAI's is the day's end, Gemini's is not): `quota` is the
  authority.

## 0.1.8

- **The Claude 5 generation in the model table** (#29): `claude-fable-5-1`,
  `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and the legacy
  `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5` (and Mythos) answer
  1M / 128K with tools and images, as Anthropic's model pages say; Opus
  4.6–4.8 and Sonnet 4.6 likewise (they were tabled at 200k / 64k before).
  Whether a 5 model takes PDFs is left to the listing.
- **Anthropic's `/v1/models` is read for what it says** — `max_input_tokens`,
  `max_tokens`, `capabilities.image_input` / `pdf_input` — and wins over the
  table, so a Claude newer than this release is known once listed.

## 0.1.7

- **A rate limit says when to come back** (#22). A failed `chat()` result
  carries `retryAfterMs` — how long the provider asked us to wait — and
  `quota: 'minute' | 'day'` — which window ran out — whenever the provider
  said: the standard `Retry-After` and OpenAI's `retry-after-ms`, OpenAI's
  `x-ratelimit-reset-*` for the window at 0, Anthropic's
  `anthropic-ratelimit-*-reset`, Gemini's `RetryInfo` and `QuotaFailure`
  details, ChatGPT's `resets_in_seconds`, and the words ("try again in 6m0s",
  "requests per day"). A 429 that lifts within the minute is `retryable`; a
  day window never is. A 5xx carries its `Retry-After` too. Nothing is
  inferred: a failure that said nothing carries nothing.
- `listModels()` from the core throws an `HttpError` (exported) with the same
  `status`, `retryAfterMs` and `quota`; the worker's `ai-list-models` answer
  carries `retryAfterMs` and `quota` on a rate-limited listing.
- `rateLimitOf(status, headers, body)` is exported from the core for a host
  that reads provider responses itself.
- **`withRetry()`, the loop on top of `chat()`** (#24, `@amenophis1er/byok/core`):
  `withRetry((attempt) => chat(conn, credential, request, { signal }), { signal, onRetry })`
  tries again only what `retryable` already means — nothing was acted on —
  waiting as the provider asked (`retryAfterMs`) or else exponentially with
  jitter. It never retries a day window, a wait over `maxWaitMs` (60 s), or a
  turn that produced text or a tool call; a dropped connection gets its own,
  longer budget (`maxNetworkAttempts`, 6) than a server failure
  (`maxAttempts`, 4); the signal is honoured between attempts (`Stopped.`).
  `sleep` and `random` are injectable. `chat()` itself stays single-shot.
- **What is known about a model, before asking it** (#23). `ModelInfo` gains
  `contextWindow`, `maxOutputTokens` and `capabilities: { tools?, images?, pdf? }`,
  each when known and never guessed: from the listing where it says (Gemini's
  token limits; OpenRouter's `context_length`, `max_completion_tokens`,
  `input_modalities`, `supported_parameters`; vLLM's `max_model_len`; Workers
  AI's `context_window` / `function_calling` properties), else from a built-in
  table of the Anthropic and OpenAI families (the Codex slugs included), else
  absent, and a model the tables do not know carries nothing. `getModelInfo(conn, credential, modelId?)` answers for one model —
  the bound one by default — from the table without a request when it knows,
  else from the listing. `knownModelInfo(conn, id)` is the table alone. The
  worker's `ai-list-models` answer carries the new fields.

## 0.1.6

- **Observe a turn while it streams** (`@amenophis1er/byok/core`):
  `ChatOptions.onEvent` gets `ChatEvent`s — `text` deltas, `tool_call_start`,
  `tool_call_delta` (argument JSON as it arrives; whole for Gemini) and
  `tool_call_end`, then `usage` — the same shape from the Messages, Chat
  Completions, Responses and Gemini APIs. Nothing is reported before a protocol
  is settled on, so a candidate that was then abandoned never shows. The
  result is the same with or without it.
- **The sign-in flows, from `@amenophis1er/byok/core/auth`**: the Claude
  subscription PKCE flow, the ChatGPT device flow, the OpenCode Console device
  grant and the Ollama connected-device pairing, with their refresh functions
  and the Claude Code sentinel helper, for a host that owns storage and UI.
- Nothing changes for callers of `chat()` or for extensions.

## 0.1.5

- **The protocols without the browser: `@amenophis1er/byok/core`.** `chat()`
  and `listModels()` take a connection (`kind`, `baseUrl`, `protocol`, `model`,
  …) and its credential — a key or token, or a signer for an Ollama device key —
  and run in anything with `fetch` and streams: Node 20+, Bun, Deno, Workers,
  a page. Same four protocols, same fall-through routing, same results and
  error wording as the worker, which now runs on it. Keys, storage and sign-in
  flows stay the caller's. Nothing changes for an extension: the `background`,
  `client`, `types` and root entry points export what they did.
- `scripts/smoke.mjs` runs through the core, as a Node program would.

## 0.1.4

- **The Gemini API as a protocol** (`protocol: 'gemini'`):
  `models/{model}:streamGenerateContent`, with function calling, images and
  documents, token counts, and the model turn's parts — thought signatures
  included — returned in `providerState` and replayed. The Google Gemini preset
  now carries `protocol: 'gemini'`: a host that passes it on save gets the
  native API (a base URL ending in `/openai` is read as the root above it);
  one that does not keeps the OpenAI-compatible endpoint, as do connections
  saved earlier. OpenCode's `gemini-*` models, served on this protocol, work.
  Gemini has no switch for parallel calls: a turn may carry several.

## 0.1.3 (never released)

Merged but not tagged, so never published: everything below shipped in 0.1.4.

- **Protocols are separate from connections.** A connection says who requests
  go to and how they authenticate; its `protocol` — `anthropic` (the Messages
  API), `responses` (the OpenAI Responses API) or `chat-completions` — says
  how they are written. `ConnectionView.protocol` shows it, and an
  openai-compatible connection can be saved with `protocol: 'responses'` to
  speak OpenAI's own Responses API at `${baseUrl}/responses`. Existing
  connections keep theirs: 'anthropic' speaks `anthropic`, 'chatgpt'
  `responses`, 'openai-compatible' `chat-completions`. `complete()` is now a
  `chat()` turn: streamed, same answer.
- **OpenCode models on their own protocol.** OpenCode serves each model on
  the protocol of its origin — Claude on Messages, GPT on Responses, most
  others on Chat Completions — and answers 400 "Model does not support this
  protocol" to any other. A turn now starts on the likely one (by name) and
  moves to the next on that answer, remembering what worked for the worker's
  lifetime. Gemini models, served on Google's own protocol, which the library
  has no client for yet, fail with a clear error. An OpenAI connection does the
  same for its models that take function tools on Responses only ("use
  /v1/responses"): the turn moves over, and stays there.
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
