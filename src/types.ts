/**
 * Types and the message protocol between an extension's UI surfaces and its
 * background worker.
 *
 * The user can save any number of CONNECTIONS (an OpenAI key, a local
 * Ollama, an Anthropic key, several of each) and pick one active at a time.
 * All secret handling lives in the background worker: keys are encrypted at
 * rest with a non-extractable key and stored as ciphertext; the UI only ever
 * sends a freshly-typed key to save and receives a REDACTED view (hasKey +
 * hint), never the key back — so plaintext keys never enter page frames.
 *
 * Message `type` strings are `${prefix}:ai-<op>`; the prefix is chosen by
 * the host extension (see registerAiHandlers / createAiClient).
 */

/**
 * 'chatgpt'        = ChatGPT subscription via the Codex backend (Responses
 *                    API) — a different wire protocol from openai-compatible.
 * 'chrome-builtin' = Chrome's on-device model. Runs in a PAGE context, not
 *                    the worker (no key, no CORS, and model downloads need a
 *                    user gesture) — the host extension wires that side.
 */
export type ProviderKind = 'anthropic' | 'openai-compatible' | 'chatgpt' | 'chrome-builtin';

/**
 * The wire format a connection's requests are written in, separate from who
 * they go to: `anthropic` = the Messages API (`/messages`), `responses` = the
 * OpenAI Responses API (`/responses`), `chat-completions` = Chat Completions
 * (`/chat/completions`), `gemini` = the Gemini API
 * (`/models/{model}:streamGenerateContent`). An 'anthropic' connection speaks
 * `anthropic`, a 'chatgpt' one `responses`; an 'openai-compatible' one speaks
 * `chat-completions` unless saved with another, and an OpenCode sign-in
 * speaks whichever each model is served on.
 */
export type Protocol = 'anthropic' | 'responses' | 'chat-completions' | 'gemini';

/** How a connection authenticates. 'key' = API key; 'oauth'/'setup-token'
 *  = a Claude Pro/Max, ChatGPT or OpenCode Console token (Bearer, refreshable / long-lived);
 *  'device-key' = an Ollama Cloud connected device (requests signed with a
 *  non-extractable Ed25519 key, no secret stored). */
export type AuthMode = 'key' | 'oauth' | 'setup-token' | 'device-key';

/** A saved connection, minus the secret (what the settings UI sees). */
export interface ConnectionView {
  id: string;
  kind: ProviderKind;
  auth: AuthMode;
  /** The protocol its requests use; for an OpenCode sign-in, the one most models are on. */
  protocol: Protocol;
  label: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** e.g. "····a1b2" — last chars only, for recognition. For a
   *  'device-key' connection, the Ollama account name. */
  keyHint: string;
  /** Bumped by every settings save (not by token refresh). A run pins it: see AIChatRequest.connectionRevision. */
  revision: number;
}

export interface AIConfigView {
  activeId: string | null;
  connections: ConnectionView[];
}

/** A known OpenAI-compatible server, for a host picker: where it is, what it needs, how to name it. */
export interface OpenAiCompatiblePreset {
  /** A stable id (`groq`, `cloudflare-ai-gateway`), the same when the label is reworded. */
  id: string;
  label: string;
  /** The API root, with a `{placeholder}` for each of `fields`. */
  baseUrl: string;
  /** Local/self-hosted endpoints usually need no key. */
  keyOptional?: boolean;
  /** The server's own protocol, when it is better served than Chat Completions; pass it on save. */
  protocol?: Protocol;
  /** Where a key is made, when the provider has such a page. */
  keyUrl?: string;
  /** A model a picker can preselect before any listing answers; the listing is the authority. */
  defaultModel?: string;
  /** The `{placeholders}` in `baseUrl`, in order, each with a label to ask for it by. */
  fields?: Array<{ name: string; label: string }>;
}

/**
 * Preset base URLs offered in the UI for openai-compatible connections. A
 * base URL is the API root: requests go to `${baseUrl}/chat/completions` and
 * `${baseUrl}/models`. A `{placeholder}` in it (an account id) is for the
 * user to fill in; `presetOf` matches a filled-in URL back to its preset.
 */
export const OPENAI_COMPATIBLE_PRESETS: OpenAiCompatiblePreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-5.5' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'gemini', keyUrl: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-3-flash' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', keyUrl: 'https://vercel.com/dashboard' },
  { id: 'cloudflare-workers-ai', label: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', fields: [{ name: 'account_id', label: 'Account ID' }] },
  { id: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway', baseUrl: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', fields: [{ name: 'account_id', label: 'Account ID' }, { name: 'gateway_id', label: 'Gateway ID' }] },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', defaultModel: 'openai/gpt-oss-120b' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', defaultModel: 'mistral-large-latest' },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-chat' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  { id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', defaultModel: 'gpt-oss-120b' },
  { id: 'ollama-cloud', label: 'Ollama (cloud)', baseUrl: 'https://ollama.com/v1', keyUrl: 'https://ollama.com/settings/keys', defaultModel: 'gpt-oss:120b' },
  { id: 'ollama-local', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', keyOptional: true },
];

/** A host for comparison: lowercased, the loopback names as one (`localhost`, `127.0.0.1`, `[::1]`). */
function hostKey(hostname: string): string {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === '[::1]' || host === '::1' ? 'localhost' : host;
}

/**
 * The preset a base URL is an instance of, with the values its placeholders
 * took: `presetOf('https://gateway.ai.cloudflare.com/v1/abc/gw1/compat')` is
 * the AI Gateway preset with `{ account_id: 'abc', gateway_id: 'gw1' }`. The
 * URL is normalised first; hosts compare without case, and `localhost`,
 * `127.0.0.1` and `[::1]` count as one. Nothing for a URL no preset matches,
 * or one with a placeholder still unfilled.
 */
export function presetOf(baseUrl: string): { preset: OpenAiCompatiblePreset; values: Record<string, string> } | undefined {
  let url: URL;
  try { url = new URL(normalizeBaseUrl(baseUrl)); } catch { return undefined; }
  // The path decoded, so a placeholder left in it (`{account_id}`, which `URL` percent-encodes) is seen as one and matches nothing.
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/\/+$/, ''); } catch { return undefined; }
  for (const preset of OPENAI_COMPATIBLE_PRESETS) {
    const template = new URL(preset.baseUrl);
    if (template.protocol !== url.protocol || hostKey(template.hostname) !== hostKey(url.hostname) || template.port !== url.port) continue;
    const names: string[] = [];
    // The path as written: `URL` would percent-encode the braces of a placeholder.
    const templatePath = preset.baseUrl.slice(template.origin.length).replace(/[?#].*$/, '');
    const pattern = templatePath.replace(/\/+$/, '').split(/(\{[a-z_]+\})/).map((piece) => {
      const field = /^\{([a-z_]+)\}$/.exec(piece);
      if (!field) return piece.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      names.push(field[1]!);
      return '([^/{}]+)';
    }).join('');
    const match = new RegExp(`^${pattern}$`).exec(path);
    if (!match) continue;
    const values: Record<string, string> = {};
    names.forEach((name, i) => { values[name] = match[i + 1]!; });
    return { preset, values };
  }
  return undefined;
}

/**
 * Normalize a user-typed base URL to an API root: add a scheme, drop trailing
 * slashes and a pasted `/chat/completions`. A bare origin gets `/v1`, the
 * usual root; any other path is kept as typed.
 */
export function normalizeBaseUrl(url: string): string {
  let base = url.trim();
  if (!base) return 'https://api.openai.com/v1';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
  try {
    if (new URL(base).pathname === '/') base += '/v1';
  } catch {
    /* not a URL; requests will say so */
  }
  return base;
}

/** Host-permission match pattern for a base URL's origin (port-agnostic). */
export function originPattern(baseUrl: string): string | null {
  try {
    const u = new URL(normalizeBaseUrl(baseUrl));
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** A sensible default label for a connection. */
export function defaultLabel(kind: ProviderKind, baseUrl: string): string {
  if (kind === 'anthropic') return 'Anthropic';
  if (kind === 'chatgpt') return 'ChatGPT';
  if (kind === 'chrome-builtin') return 'Chrome built-in (on-device)';
  // The template as typed (a placeholder still unfilled) is the preset too; a filled-in URL matches through its placeholders.
  const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === normalizeBaseUrl(baseUrl)) ?? presetOf(baseUrl)?.preset;
  if (preset) return preset.label;
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname;
  } catch {
    return 'OpenAI-compatible';
  }
}

/* ── message protocol (UI → background worker) ─────────────────────── */

export interface AIGetRequest {
  type: string; // `${prefix}:ai-get`
}
export interface AISetActiveRequest {
  type: string; // `${prefix}:ai-set-active`
  id: string | null;
}
export interface AISaveConnectionRequest {
  type: string; // `${prefix}:ai-save-connection`
  /** Omit to create; provide to update an existing connection. */
  id?: string;
  kind: ProviderKind;
  /** openai-compatible only: the protocol the server speaks at `baseUrl`. Default 'chat-completions';
   *  'responses' for OpenAI's own Responses API (`${baseUrl}/responses`); 'gemini' for the Gemini API
   *  (a base URL ending in `/openai`, Gemini's OpenAI-compatible root, is read as the root above it). */
  protocol?: Protocol;
  label: string;
  baseUrl: string;
  model: string;
  /** 'set' stores `apiKey`; 'keep' leaves the stored key; 'clear' removes it. */
  apiKeyMode: 'set' | 'keep' | 'clear';
  apiKey?: string;
  /** Make this the active connection after saving. */
  makeActive?: boolean;
}
export interface AIDeleteConnectionRequest {
  type: string; // `${prefix}:ai-delete-connection`
  id: string;
}
export interface AIListModelsRequest {
  type: string; // `${prefix}:ai-list-models`
  kind: ProviderKind;
  baseUrl: string;
  /** Freshly typed key; empty means "use the saved key for `id`". */
  apiKey: string;
  /** Existing connection whose stored key to fall back on. */
  id?: string;
}
export interface AICompleteRequest {
  type: string; // `${prefix}:ai-complete`
  system: string;
  prompt: string;
  maxTokens?: number;
}

/* ── Claude subscription (Pro/Max) sign-in ────────────────────────── */

export interface AIAnthropicLoginStartRequest {
  type: string; // `${prefix}:ai-anthropic-login-start`
}
/** Reply from login-start: the worker opened the consent tab; the UI shows
 *  the authorize URL as a fallback link and waits for the pasted code. */
export interface AIAnthropicLoginStart {
  authorizeUrl: string;
}
export interface AIAnthropicLoginCompleteRequest {
  type: string; // `${prefix}:ai-anthropic-login-complete`
  /** The `code#state` string the consent page displayed. */
  pasted: string;
  label: string;
}
/** Paste a `claude setup-token` (sk-ant-oat…) directly instead of the flow. */
export interface AIAnthropicPasteTokenRequest {
  type: string; // `${prefix}:ai-anthropic-paste-token`
  token: string;
  label: string;
}

/* ── ChatGPT subscription (device flow) ───────────────────────────── */

export interface AIChatgptLoginStartRequest {
  type: string; // `${prefix}:ai-chatgpt-login-start`
}
/** Reply: show this code, send the user to verifyUrl, then poll. */
export interface AIChatgptLoginStart {
  userCode: string;
  verifyUrl: string;
}
/** Poll once; the worker holds the device session. */
export interface AIChatgptLoginPollRequest {
  type: string; // `${prefix}:ai-chatgpt-login-poll`
  label: string;
}
export type AIChatgptPoll =
  | { status: 'pending' }
  | { status: 'created'; id: string };

/* ── Ollama Cloud (connect device) ────────────────────────────────── */

export interface AIOllamaLoginStartRequest {
  type: string; // `${prefix}:ai-ollama-login-start`
  /** Shown on the ollama.com connect page ("Connect <name> with <account>"). */
  deviceName?: string;
}
/** Reply: the worker opened the connect page; the UI shows the URL as a
 *  fallback link and polls until the user clicks Connect. */
export interface AIOllamaLoginStart {
  connectUrl: string;
  /** Suggested delay between polls, ms. */
  pollMs: number;
}
export interface AIOllamaLoginPollRequest {
  type: string; // `${prefix}:ai-ollama-login-poll`
  label: string;
}
export type AIOllamaPoll =
  | { status: 'pending' }
  | { status: 'created'; id: string };

/* ── OpenCode Console (device flow) ───────────────────────────────── */

export interface AIOpencodeLoginStartRequest {
  type: string; // `${prefix}:ai-opencode-login-start`
}
/** Reply: the worker opened the approval page with the code filled in; show
 *  the code (to compare), offer the URL, then poll every `pollMs`. */
export interface AIOpencodeLoginStart {
  userCode: string;
  verifyUrl: string;
  pollMs: number;
}
export interface AIOpencodeLoginPollRequest {
  type: string; // `${prefix}:ai-opencode-login-poll`
  label: string;
}
export type AIOpencodePoll =
  | { status: 'pending'; /** Wait this long before the next poll (the server may ask to slow down). */ pollMs: number }
  | { status: 'created'; id: string };

/* ── Chat with tools ─────────────────────────────────────── */

/** Message content: text, images for vision-capable providers, and PDF documents. */
export type AIContentPart =
  | { type: 'text'; text: string }
  /** PNG, JPEG, GIF and WebP: what Anthropic and OpenAI take. The Gemini API takes no GIF (PNG, JPEG, WebP, HEIC). */
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string /* base64 */ }
  /** Anthropic: a `document` block. OpenAI-compatible: a `file` part (OpenAI, OpenRouter); servers without PDF input reject the request. */
  | { type: 'document'; mediaType: 'application/pdf'; data: string /* base64 */; name?: string };

/** A tool the model may call; `inputSchema` is JSON Schema. */
export interface AIToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * A tool the provider runs itself: web search. Anthropic's `web_search`
 * server tool, the Responses API's `web_search` tool and Gemini's Google
 * Search grounding; a Chat Completions server has none, and a turn that asks it for one fails before any request.
 * The results stay with the provider (and in `providerState`); the turn
 * reports the queries and sources it used in `webSearch`.
 */
export interface AIServerTool {
  type: 'web_search';
  /** The most searches one turn may run (Anthropic). */
  maxUses?: number;
  /** Only results from these domains (Anthropic, OpenAI). One of the two lists, not both. */
  allowedDomains?: string[];
  /** Never results from these domains (Anthropic, OpenAI). */
  blockedDomains?: string[];
  /** Where the user is, to localize results (Anthropic, OpenAI): any of city, region, a two-letter country code, an IANA timezone. */
  userLocation?: { city?: string; region?: string; country?: string; timezone?: string };
}

/** What a turn's web searches used: the queries run and the sources read, each once; and each search on its own where the provider tells them apart. */
export interface AIWebSearch {
  queries: string[];
  sources: Array<{ url: string; title?: string }>;
  /**
   * Each search, in order: its query, the sources it returned and their
   * count, or the error the provider gave it (Anthropic's
   * `max_uses_exceeded`, `too_many_requests`, …). Anthropic reports them
   * search by search; the Responses API and Gemini name only the queries,
   * so their entries carry no sources, count or error.
   */
  searches?: AIWebSearchCall[];
}

/** One web search the provider ran. */
export interface AIWebSearchCall {
  query: string;
  sources: Array<{ url: string; title?: string }>;
  /** How many results came back, when the provider lists them. */
  resultCount?: number;
  /** The provider's error code for a search that failed, when it gave one. */
  error?: string;
}

/** One tool call the model made. Arguments that were not valid JSON arrive as `argsError`. */
export interface AIToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  argsError?: { raw: string; message: string };
}

export type AIMessage =
  | { role: 'user'; content: string | AIContentPart[] }
  | {
      role: 'assistant';
      content?: string;
      toolCalls?: AIToolCall[];
      /**
       * Opaque provider data that must be sent back verbatim with this turn —
       * e.g. Anthropic thinking blocks (with signatures) and tool_use blocks.
       * Persist it with the message; never edit it. It is tagged with the
       * protocol that wrote it and replayed only there: a conversation moved
       * to another provider replays this turn from its text and tool calls
       * (`stripProviderState` from the core drops it outright).
       */
      providerState?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string | AIContentPart[]; isError?: boolean };

export interface AIChatRequest {
  system: string;
  messages: AIMessage[];
  /** The caller's function tools, and the provider's server tools (`{ type: 'web_search' }`). */
  tools?: Array<AIToolSpec | AIServerTool>;
  /** Default 16000. */
  maxTokens?: number;
  /** Default false: at most one tool call per response where the provider supports it. */
  parallelToolCalls?: boolean;
  /** The connection to use; default the active one. A run should pin it. */
  connectionId?: string;
  /** The connection's `revision` when the run started; a different one fails the call (the owner edited it). */
  connectionRevision?: number;
  /** The model to use; default the connection's. */
  model?: string;
  /**
   * How much the model reasons before answering, where it can: `off`, or a
   * level. Mapped per provider — Anthropic's adaptive thinking with
   * `output_config.effort` (extended thinking with a budget on the 4.5
   * generation and before), the Responses API's and Chat Completions'
   * `reasoning.effort` / `reasoning_effort` (to OpenAI), Gemini's
   * `thinkingLevel` (3 and later) or `thinkingBudget`. Absent: the provider's
   * default, and nothing is sent.
   */
  reasoning?: AIReasoning;
  /**
   * Cache the conversation's prefix, not only the system prompt and tools:
   * Anthropic gets a `cache_control` breakpoint on the last message, so each
   * turn reads the one before from the cache (a write costs 25% more there;
   * reads 90% less). The other providers cache the prefix on their own.
   */
  cacheConversation?: boolean;
  /** OpenAI's `prompt_cache_key`: routes requests with the same key to the same cache. Sent on Chat Completions and Responses to OpenAI, and to the ChatGPT backend; left out elsewhere. */
  cacheKey?: string;
  /** Whole-request timeout, default 120000 ms; `0` turns it off in the core (the worker keeps 120 s for the token refresh, and none for the turn). */
  timeoutMs?: number;
  /** The longest silence allowed, ms: the turn times out when nothing arrives from the server for this long. Off by default. */
  idleTimeoutMs?: number;
}

/** Why the turn stopped. `pause`: the provider paused a long server-tool turn (Anthropic's `pause_turn`); send the assistant message back as it is, with its `providerState`, and call again to continue. */
export type AIStopReason = 'end' | 'tool_use' | 'length' | 'refusal' | 'pause';

/**
 * How much the model reasons before answering: off, on at the provider's
 * own default (thinking and its summaries asked for, no effort or budget
 * named), or a level.
 */
export type AIReasoning = 'off' | 'on' | 'low' | 'medium' | 'high';

/**
 * Why a turn failed: refused before any request went out (`request`: no
 * model, no key, a model this library cannot serve, a body that would not
 * serialise), the connection dropped
 * (`network`), the server refused (`http`, with `status`), the stream failed
 * or ended early (`stream`), a limit passed (`timeout`), the caller's signal
 * (`stopped`), or the caller's `onEvent` threw (`sink`).
 */
export type AIFailureKind = 'request' | 'network' | 'http' | 'stream' | 'timeout' | 'stopped' | 'sink';

/** A failure as data, beside the sentence in `error`. */
export interface AIFailure {
  kind: AIFailureKind;
  /** The HTTP status, on `http`. */
  status?: number;
  /** The provider's own code when it gave one: Anthropic's `rate_limit_error`, OpenAI's `insufficient_quota`, ChatGPT's `usage_limit_reached`, Gemini's `RESOURCE_EXHAUSTED`. */
  providerCode?: string;
  /** On `http`: the provider's error type when it gave one beside the code (OpenAI's `error.type`), kept apart from `providerCode`. */
  providerType?: string;
  /** On `http`: the provider's message as it wrote it, for a log or a support ticket; never from ChatGPT, whose wording is hidden on purpose. */
  providerMessage?: string;
  /** The provider's request id (`request-id`, `x-request-id`), for its support. */
  requestId?: string;
  /** The underlying exception's message, when there was one (what the network said, what the sink threw). */
  cause?: string;
  /** On `network`: the innermost `code` in the transport error's cause chain (`ECONNRESET`, `ERR_SOCKET_CONNECTION_TIMEOUT`), when there is one. */
  code?: string;
  /** On `timeout`: which limit passed — the idle one (`idleTimeoutMs`: nothing arrived for that long) or the whole-request one (`timeoutMs`). */
  timeout?: 'idle' | 'total';
  /** On `stream`: the stream ended before the provider's closing event, naming no error. Not a transport fault as such (the connection may simply have closed), told apart from an error the stream reported without a code. */
  endedEarly?: boolean;
  /** Whether text or a tool call had streamed to `onEvent` before the failure: the user may have seen it, so the turn is never `retryable`. Always false without an `onEvent`, which nothing reached. */
  streamed: boolean;
}

export interface AIChatResult {
  ok: boolean;
  text?: string;
  /** The calls to answer: with `stopReason` `tool_use`, the turn's; with `length` or `refusal`, those the cut-off turn had made whole (see `truncatedToolCall`). */
  toolCalls?: AIToolCall[];
  providerState?: unknown;
  stopReason?: AIStopReason;
  /** The model that answered, as the provider named it (an alias resolved, a `-latest` pinned), when it said. */
  model?: string;
  /** The web searches the provider ran for this turn, when it ran any. */
  webSearch?: AIWebSearch;
  /**
   * A tool call the turn was cut off in the middle of (`stopReason` `length` or `refusal`): its id, name and the arguments as far as
   * they came. Never in `toolCalls`, which on such a turn holds the calls that came whole — answer them, then replay the turn: the
   * providers want a result for every call they are given back.
   */
  truncatedToolCall?: { id: string; name: string; raw: string };
  /** The reasoning the provider showed — Anthropic's summarized thinking, a Responses reasoning summary, Gemini's thought summaries, a model's inline `<think>` text — when it showed any. Never the raw chain of thought. */
  reasoning?: string;
  /**
   * Token counts, the same meaning on every provider: `inputTokens` is the
   * whole prompt, cached tokens included; `cacheReadTokens` the part of it
   * read from the cache and `cacheWriteTokens` the part written to it, when
   * the provider says.
   */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; /** The part of `outputTokens` spent reasoning, when the provider says. */ reasoningTokens?: number; /** Web searches the provider ran and bills, when it says. */ webSearchRequests?: number };
  error?: string;
  /** The failure as data: its kind, the provider's code and request id, whether output had streamed. On every `ok: false` result from `chat()`. */
  failure?: AIFailure;
  /**
   * A failure worth one more try: the connection dropped, the provider's
   * server failed (5xx, overloaded), or a rate limit lifts within the minute
   * (a 429 with a wait of a minute at most, or on a minute window) — and
   * nothing had streamed to the caller (`failure.streamed` is false).
   */
  retryable?: boolean;
  /** How long the provider asked us to wait before trying again, when it said (`Retry-After`, OpenAI's reset headers, Gemini's `RetryInfo`). On a day window it is the provider's words, which may not be the day's end: `quota` is the authority. */
  retryAfterMs?: number;
  /** When the wait ends, epoch ms, whenever `retryAfterMs` is given, for showing "resets at 14:00" — except on a day window, where it is the day's end only where the provider documents it (Gemini: midnight Pacific), else unset. */
  resetAt?: number;
  /** Which rate-limit window ran out, when the provider said: a minute window heals by itself, a day window not before tomorrow, a plan window (a subscription's hours-to-a-week usage limit, or a plan that does not include the model at all) when `resetAt` says. */
  quota?: 'minute' | 'day' | 'plan';
  /** The quota that ran out, as far as the provider named it (Gemini's `QuotaFailure`): for "the free tier allows 50 requests a day on gemini-2.5-pro". Each field only when said. */
  limit?: {
    /** The quota's size: 50 requests, 250,000 tokens. */
    value?: number;
    /** What it counts. */
    unit?: 'requests' | 'tokens';
    /** Whether the quota is the free tier's, when the provider said so. */
    freeTier?: boolean;
    /** The model the quota is on, when the provider named it. */
    model?: string;
  };
}

/** `${prefix}:ai-chat` — the same request as `chat()`, for hosts whose caller is a page. */
export interface AIChatMessageRequest extends AIChatRequest {
  type: string;
}

export interface AIResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** On a rate-limited `listModels`: how long the provider asked us to wait, when it said. */
  retryAfterMs?: number;
  /** On a rate-limited `listModels`: when the wait ends, epoch ms. */
  resetAt?: number;
  /** On a rate-limited `listModels`: which window ran out, when the provider said. */
  quota?: 'minute' | 'day' | 'plan';
}

/** What a model takes, each when known: tool calling, image parts, PDF `document` parts. */
export interface ModelCapabilities {
  /** Tool calling. */
  tools?: boolean;
  /** `image` content parts. */
  images?: boolean;
  /** `document` content parts (PDF). */
  pdf?: boolean;
}

/**
 * A model a connection offers. Beyond `id` and `name`, what is known about it
 * — from the provider's listing (Gemini, OpenRouter, vLLM, Workers AI) or a
 * built-in table (Anthropic, OpenAI) — and absent when not known, never
 * guessed.
 */
export type ModelInfo = {
  id: string;
  name: string;
  /** Input tokens the model accepts, when known. */
  contextWindow?: number;
  /** Output tokens one turn may produce, when known. */
  maxOutputTokens?: number;
  /** What the model takes, when known. */
  capabilities?: ModelCapabilities;
};

/**
 * The version of the messages between `createAiClient` (UI) and the worker's
 * handlers. Every client message carries it as `v`. A worker meeting a newer
 * version than its own refuses the message with a clear error rather than
 * misreading it (a UI page left open across an extension update); a message
 * without `v` is version 1. Raised only when the messages change
 * incompatibly — which is a major release of this package.
 */
export const PROTOCOL_VERSION = 1;
