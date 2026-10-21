# Changelog

All notable changes to this package. It follows [semantic versioning](https://semver.org);
while on 0.x, a breaking change bumps the minor version.

## 0.1.13

- **`reasoning: 'on'`**: thinking and its summaries at the provider's own
  default, no effort, budget or level named — Anthropic's adaptive thinking
  with no `output_config.effort` (the medium budget where the model takes
  a budget only), the Responses API's `summary: 'auto'` alone, Gemini's
  `includeThoughts`, Ollama's `think: true`; nothing on OpenAI's Chat
  Completions, whose default is the model's.
- **`failure.code`** on a dropped connection: the innermost `code` down the
  transport error's cause chain (`ECONNRESET`,
  `ERR_SOCKET_CONNECTION_TIMEOUT`), beside `cause`. `transportCode` is
  exported.
- **`failure.providerType` and `failure.providerMessage`** on an HTTP
  failure, and on `HttpError`: the provider's `error.type` apart from the
  code it may have supplied, and its message as written (cut at 2000
  characters) — never ChatGPT's, whose wording is hidden on purpose.
- **Gemini 3 over Google's OpenAI-compatible root replays without a 400.**
  A tool call replayed with no kept `thought_signature` gets Google's
  `skip_thought_signature_validator` placeholder in `extra_content`, as the
  native Gemini path adds it, on generativelanguage/aiplatform hosts for a
  model that checks.
- **Inline thinking: `<thinking>` recognised, and only a block that opens
  the answer is reasoning.** A `<think>` the model quotes partway through
  its answer stays text, as does everything after it, and nothing is held
  back for a tag once the answer began; `new ThinkSplitter(emit, true)`
  keeps the old anywhere behaviour.
- **`truncatedToolCall: { id, name, raw }`** on a turn cut off in the
  middle of a tool call (`stopReason` `length` or `refusal`): the call
  whose block never stopped or whose arguments did not come whole, with
  them as far as they came; none when every call came whole (the cut fell
  after them). Not on Gemini, which sends a call whole or not at all.
- **`webSearch.searches`**: each search on its own — its query, sources,
  `resultCount` or `error` (`max_uses_exceeded`) on Anthropic, which tells
  them apart by `tool_use_id`; the query alone on the Responses API and
  Gemini. `AIWebSearchCall` is the type.

- **A failed tool result is marked on Chat Completions.** A tool message
  with `isError` goes as `Error: …`, as the Responses items go; it went as
  bare text.
- **`cacheKey` reaches the ChatGPT backend.** `prompt_cache_key` is sent
  there as the Codex CLI sends it, besides OpenAI itself.
- **The quota in OpenAI's and Anthropic's words.** A 429 whose message says
  "requests per min (RPM): Limit 3", "Limit: 20.000000 / min" or "of 50,000
  input tokens per minute" carries `limit: { value, unit }`; the words alone
  never name a tier or a model.
- **An error body wrapped in an array reads its message.** `HTTP 429: Quota
  exceeded.` from `[{ error: { message } }]`, as the code already was.
- **`providerState` built and read through the API.** `providerState.anthropic(blocks)`
  (`.gemini`, `.chatCompletions`, `.responses`) builds what `chat()` writes
  and replays, `readProviderState(state)` says the protocol and what it holds
  (the shapes written before the tag included), `ProviderState` is the type;
  the shapes are covered by semver.
- **A native Anthropic connection honours its `baseUrl`.** `chat()` posts to
  `${baseUrl}/messages` and `listModels()` reads `${baseUrl}/models` when it
  is set (a gateway serving the Messages API), Anthropic's own when it is `''`.
- **`codexModels({ clientVersion })`**, exported from the core: the Codex CLI
  version the catalog request claims, for a host tracking its releases;
  `CODEX_CLIENT_VERSION` otherwise.
- **`failure.timeout`** on a `timeout`: `'idle'` (nothing arrived for
  `idleTimeoutMs`) or `'total'` (`timeoutMs` passed), the retry policy being
  the host's.

- **A dropped connection is whatever the transport rejected with.** A host
  `fetch` that rejects with its own error (`{ code: 'ECONNRESET' }`, not a
  `TypeError`), or a body read that fails (a refused response's included),
  is `failure.kind: 'network'`,
  retryable before anything streamed, with the message and code in `cause`.
  `isNetworkFailure` reads `failure.kind` where the result carries it, the
  core's wording only on a result without the failure data.
- **Every refusal over thinking blocks is retried, once more at most.** A
  manual-mode (budget) turn whose latest assistant message has no thinking
  block to open with ("…must start with a thinking block") is sent again
  with thinking off; a stripped retry refused over thinking again gets one
  last request with no thinking block anywhere (and, in manual mode,
  thinking off), unless that is what was just sent.
- **The subscription sentinel in a block of its own.** On an Anthropic
  subscription, a system prompt that already opens with the Claude Code
  identity line is split into the sentinel block and the rest, as a prompt
  without it is: one shape of request either way.
- **`reasoning: 'off'` reaches OpenAI, the Responses API and Ollama.** The
  least effort the model takes is sent (`none` from GPT-5.1 on, `minimal`
  on GPT-5, `low` on the Codex models and the o-series; `low` on the ChatGPT
  backend, whose accepted levels are not published), nothing for a model
  not known to reason or for the Pro models, which take only their highest
  levels; Ollama gets `think: false`, dropped on a refusal like the other
  optional fields. Before, `off` sent nothing and a thinking model reasoned
  at full length.
- **A Gemini prompt block is final.** A stream whose `promptFeedback` names
  a `blockReason` and brings no candidate fails with "The prompt was blocked
  (SAFETY…)" and the reason as `providerCode`, never retryable; it was read
  as a cut stream and retried.
- **`response.incomplete` says why.** A Responses turn cut by
  `content_filter` is `stopReason: 'refusal'`; `max_output_tokens`, or no
  reason, stays `length`.
- **Google's `RetryInfo` on any status.** A 503 whose body carries
  `retryDelay` has `retryAfterMs`, as one with a `Retry-After` header does;
  before, the body was read only on a 429 or a plan window.

## 0.1.12

- **`withRetry` for a host with its own policy** (#72), all off by default:
  `maxTotalWaitMs` (the waits' sum; a wait that would pass it ends the
  retries with the failure as it stands), `minDelayMs` (a floor on every
  wait, a provider's shorter hint included, never over `maxWaitMs`),
  `networkWindowMs` (a dropped connection is retried while the next attempt
  would start within it, measured from the first attempt, a sleep that
  overran included; `maxNetworkAttempts: Infinity` leaves it to the window),
  `retryBare429` (a 429 that named neither a wait nor a window, which
  `retryable` leaves out, retried on the backoff; never a day or plan
  window, never after output streamed) and `throwOnAbort` (the signal's
  reason thrown, an `AbortError` when it has none, instead of
  `{ ok: false, error: 'Stopped.' }`, whether the loop or the attempt saw
  the abort). `now` is injectable for tests.
- **The quota Gemini names** (#68): a rate-limited result, an `HttpError`
  and `rateLimitOf` carry `limit: { value?, unit?, freeTier?, model? }` read
  from the `QuotaFailure` violation that named the window — "the free tier
  allows 50 requests a day on gemini-2.5-pro". Each field only when said.
- **A day window's end where the provider documents it** (#69): on a Gemini
  API day quota, `resetAt` is the next midnight Pacific (Google: "Requests
  per day (RPD) quotas reset at midnight Pacific time"), a clock change
  included; `retryAfterMs` stays the provider's words. Another provider's
  day window still carries no instant.
- **ChatGPT's usage limits in full** (#70): `resets_at` (epoch seconds) is
  read as the wait when `resets_in_seconds` is absent; `usage_limit_reached`
  names the plan window on any 4xx, not only a 429; `usage_not_included`
  (the plan does not include the model) is a plan window with no wait, never
  retryable.
- **`rateLimitOf` reads headers from any source** (#71): a `Headers`, a
  `Map` keyed by lowercase names, or a plain record in any case as Node's
  `IncomingHttpHeaders` gives them, an array value read as its first.
  `HeaderSource` is exported.

## 0.1.11

- **More names the tables know** (#66): `knownModelInfoByName` answers for
  the Gemini `-latest` aliases (`gemini-pro-latest`, `gemini-flash-latest`,
  `gemini-flash-lite-latest`) and a 4-generation model other than Argon —
  any Gemini chat name beyond the tabled families gets the window and
  output every chat family since 2.5 shares (1,048,576 in, 65,536 out;
  tools and images, no word on PDFs), the retired 1.x and 2.0 generations
  and their `gemini-exp-…` previews excepted, and the image (Nano Banana),
  video (Omni) and other non-chat variants left out. Google's own OpenAI-compatible
  root keeps to the tabled families, so `getModelInfo` still asks its
  listing, which says each model's limits, for the rest. And `modelName`
  hyphenates a dotted Claude version (`claude-opus-5.5`, `claude-3.5-sonnet`),
  so a gateway's spelling reaches the Claude table.

## 0.1.10

- **Model facts by name** (#64): `knownModelInfoByName(id)` answers from
  the tables by the model's name alone, whichever gateway serves it — the
  routing prefix (`anthropic/`, `openai/`, `google/`, `models/`, Bedrock's
  `us.anthropic.…-v1:0`) and the long-context suffix in every spelling
  (`[1m]`, `-1m`, `:1m`) read, the family chosen from the name;
  `modelName(id)` is the normalization. The tables gain Google's chat
  families (2.0 Flash to 4 Argon, as their model pages say; the image,
  speech and live variants are left to the listing), which
  `knownModelInfo` also uses for Google's OpenAI-compatible root, where the
  listing says no limits; and GPT-6 (Astra, Sol, Luna: 1,050,000 in,
  128,000 out). `knownModelInfo(conn, id)` keeps its by-connection answer.

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
- **`providerState` is tagged with the protocol that wrote it** (#36):
  `{ protocol: 'anthropic', blocks }`, `{ protocol: 'gemini', parts }`,
  `{ protocol: 'chat-completions', extraContent }`, and each protocol replays
  only its own — a conversation that moved from Gemini to Anthropic no longer
  sends Gemini parts as Anthropic blocks (a 400); the turn is rebuilt from its
  text and tool calls. State written before the tag is read when it looks
  like the protocol's own (Anthropic blocks all carry a `type`, Gemini parts
  never do). `stripProviderState(messages)` is exported from the core for a
  host moving a conversation. (A Gemini placeholder signature for a rebuilt
  call is sent since the follow-up below.)
- Two notes on the follow-up: the Gemini placeholder signature goes on
  replayed history too when none of its parts carries one (a 2.5 turn sent
  to a 3); a Chat Completions server asked for the web search tool now fails
  the turn before any request (`request`), instead of dropping the tool in
  silence.
- **Follow-up gaps** (#60, the rest). A sign-in call the provider refused
  throws an `AuthError` (`@amenophis1er/byok/core/auth`) with `status`,
  `code` and `reconnect` — true when only a new sign-in recovers
  (`invalid_grant`, a revoked or expired grant) — and a message that never
  quotes the body; the ChatGPT device poll keeps going through a 5xx or a
  dropped connection instead of ending the sign-in; a network failure's
  `failure.cause` keeps the transport's code ("fetch failed (ECONNRESET:
  …)", `networkCause()` exported); `providerCodeOf` reads an array-wrapped
  body; ChatGPT's `x-codex-*-reset-after-seconds` headers are read; a day
  window claims no `resetAt` (its end is not known), only the provider's
  wait; a function call replayed to Gemini 3 without a thought signature
  gets Google's placeholder `skip_thought_signature_validator`; a function
  tool named `web_search` beside the server tool is refused as a `request`
  failure (Anthropic would answer 400). Not done: Ollama's `think` field
  and the gpt-oss analysis channel (reasoning in their own fields is read
  already; the inline split covers `<think>` tags).
- **Follow-up fixes** (#60, the bugs): `timeoutMs: Infinity` (and any
  non-finite or oversized limit, idle too) is off or clamped, not an abort
  after a millisecond; the Responses API is always asked for the reasoning's
  encrypted content, and a reasoning item that came without it is left out
  of the replay (it cannot be found again under `store: false`); Gemini's
  Pro models, which cannot stop thinking, get nothing for `off` (2.5 Pro)
  or `LOW` (3 Pro, which takes `LOW` and `HIGH` only); the Anthropic retry
  after a refused thinking block turns thinking off for that one request on
  a manual-mode model, whose latest turn would otherwise have to open with
  the block; Anthropic's token counts take the latest value from
  `message_delta` too, so a server-tool or paused turn is not under-counted.
- **The provider's web search** (#37). `tools` takes `{ type: 'web_search',
  maxUses?, allowedDomains?, blockedDomains?, userLocation? }` beside the
  function tools: Anthropic's `web_search` server tool, the Responses API's
  `web_search` tool (domains and location; `maxUses` has no equivalent) and
  Gemini's Google Search grounding (no options). A Chat Completions server
  has none and is sent nothing. The turn reports what it searched —
  `AIChatResult.webSearch: { queries, sources }`, a `search` event per
  query as it runs, `usage.webSearchRequests` — and the provider's own
  blocks and items stay in `providerState` (Anthropic's results with their
  `encrypted_content`), so the next turn replays them. **A new stop reason,
  `pause`**: Anthropic's `pause_turn` was reported as `end`; a paused turn
  now says so, keeps every block, and continues when the assistant message
  is sent back as it came (no conversation breakpoint lands on it).
- **Reasoning** (#35). `ChatRequest.reasoning: 'off' | 'low' | 'medium' | 'high'`
  is mapped per provider: Anthropic's adaptive thinking with
  `output_config.effort` on the models that take it (the 4.6 generation and
  later, the 5 generation), extended thinking with a budget on 3.7 to 4.5,
  `disabled` / `between_tools` for `off` where the model thinks by default
  and can be told not to; `reasoning_effort` on Chat Completions and
  `reasoning: { effort, summary: 'auto' }` with the encrypted content on the
  Responses API, to OpenAI; Gemini's `thinkingLevel` (3 and later) or
  `thinkingBudget`. Absent, nothing is sent. What the provider shows of its
  reasoning streams as `reasoning` events and comes back as
  `AIChatResult.reasoning`; `usage.reasoningTokens` counts it. A model that
  writes its thinking inline in `<think>` tags has it split from the text as
  it streams, never stripped after the fact; DeepSeek's and OpenRouter's
  `reasoning_content` / `reasoning` fields are read. A Responses turn's
  output items — the reasoning with its encrypted content included — are
  its `providerState` (`{ protocol: 'responses', items }`) and go back as
  the next input, so a ChatGPT tool continuation keeps its reasoning. When
  Anthropic refuses the thinking blocks it signed (an edited prefix, a block
  bound to another conversation), the turn is sent once more without them.
  Fixed on the way: a Chat Completions 400 that merely names an optional
  field (OpenAI's "use /v1/responses or set reasoning_effort to 'none'") no
  longer counts as that field being rejected; only a field the request
  carried is dropped for the retry, so the move to the Responses API happens.
- **A failure as data** (#34). Every failed `chat()` result carries
  `failure: { kind, status?, providerCode?, requestId?, cause?, streamed }`
  beside the sentence: the kind (`request`, `network`, `http`, `stream`,
  `timeout`, `stopped`, `sink`), the HTTP status, the provider's own code
  (`rate_limit_error`, `insufficient_quota`, `usage_limit_reached`,
  `RESOURCE_EXHAUSTED`, …) and request id (`request-id`, `x-request-id`)
  when given, what the transport or the sink said, and whether text or a
  tool call had streamed to `onEvent` before the failure. **Once output has
  streamed, a failure is never `retryable`** — a cut-off stream after half
  an answer was marked so before — and `withRetry` leaves it alone. An
  `HttpError` from `listModels()` carries `providerCode` and `requestId` too.
  The worker's own refusals (a stopped call, a gone connection, a token
  refresh that failed) carry it as well, with nothing streamed.
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
