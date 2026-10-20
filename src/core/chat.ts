/**
 * One model turn with tools, against any connection, in any runtime with
 * `fetch` and streams: the browser, Node 20+, Bun, Deno, Workers.
 *
 * Four protocols — the Messages API, the Responses API, Chat Completions and
 * the Gemini API — each streamed and returned only after the provider's
 * terminal event. A server that serves the model on another protocol says so
 * with HTTP 400, and the next candidate is tried.
 */

import type { AIChatRequest, AIChatResult, AIFailure, Protocol } from '../types.js';
import { anthropicBody, anthropicMessages, anthropicResult } from './chat-anthropic.js';
import { openaiBody, openaiResult, rejectedField, type OptionalField } from './chat-openai.js';
import { geminiBody, geminiResult } from './chat-gemini.js';
import { CODEX_RESPONSES_URL, codexBody, codexFailure, codexHttpError, codexResult } from './chat-codex.js';
import { readSse } from './sse.js';
import { withClaudeCodeSystem } from './anthropic-oauth.js';
import { CODEX_ORIGINATOR } from './openai-oauth.js';
import { ANTHROPIC_BASE, ANTHROPIC_VERSION, HttpError, anthropicHeaders, apiRoot, describeHttpText, errMessage, failureSource, fetchOf, rateLimitFields, shortRateLimit, type ConnectionCredential, type Fetch, type RequestOptions } from './http.js';
import { rateLimitOf } from './rate-limit.js';
import { authorizerFor, protocolOf, tokenOf, type Connection } from './connection.js';
import { anthropicState, withoutThinking } from './provider-state.js';
import type { ChatEventSink } from './events.js';

/** A turn's request. The worker's `connectionId`/`connectionRevision` pin a stored connection; here the connection is given. */
export type ChatRequest = Omit<AIChatRequest, 'connectionId' | 'connectionRevision'>;

/** The sink threw: the turn fails with its message, and it is not a provider failure. */
class SinkError extends Error {
  constructor(public readonly cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); }
}

/** The caller's sink, with its exceptions told apart from the provider's, and `seen()` called once output has streamed. */
function guarded(onEvent: ChatEventSink | undefined, seen: () => void): ChatEventSink {
  return (event) => {
    if (event.type !== 'usage') seen();
    if (!onEvent) return;
    try { onEvent(event); } catch (error) { throw new SinkError(error); }
  };
}

export interface ChatOptions extends RequestOptions {
  /** Stops the turn; the result is then `Stopped.`. */
  signal?: AbortSignal;
  /** Whole-request limit. Default 120 s; `0` turns it off (the caller's `signal` remains). `req.timeoutMs` takes precedence. */
  timeoutMs?: number;
  /**
   * The longest silence allowed: the turn fails (`Timed out waiting for the
   * model.`) when nothing arrives from the server for this long, from the
   * request going out and between stream chunks. Off by default, as is `0`.
   * For a long thinking turn, `timeoutMs: 0` with an idle limit is the usual
   * pair: a healthy stream runs as long as it needs, a hung one is cut.
   * `req.idleTimeoutMs` takes precedence.
   */
  idleTimeoutMs?: number;
  /** Gets each request (URL and body, image bytes redacted) and result. Off when absent. */
  debug?: (label: string, data: unknown) => void;
  /** Appended to "no model / no key" errors: tell users where to fix it. */
  settingsHint?: string;
  /**
   * Observes the turn as it streams: text deltas, tool calls as they are
   * announced and filled in, and the usage once known. Nothing is reported
   * before a protocol has been settled on, so a candidate that was then
   * abandoned never shows. The result is the same with or without it. An
   * exception thrown by the sink fails the turn with its message (never as a
   * provider failure, never retryable): a gateway whose client went away
   * stops the model there.
   */
  onEvent?: ChatEventSink;
}

const CHAT_TIMEOUT_MS = 120_000;
export const TIMED_OUT = 'Timed out waiting for the model.';

/**
 * One model turn with tools. Streams the response (SSE) and returns it only
 * after the provider's terminal event. Never throws: every failure is an
 * `{ ok: false }` result, `retryable` when nothing was acted on.
 */
export async function chat(conn: Connection, credential: ConnectionCredential, req: ChatRequest, options: ChatOptions = {}): Promise<AIChatResult> {
  const controller = new AbortController();
  const timeout = () => controller.abort(new DOMException('timeout', 'TimeoutError'));
  const limit = req.timeoutMs ?? options.timeoutMs ?? CHAT_TIMEOUT_MS;
  const timer = limit > 0 ? setTimeout(timeout, limit) : undefined;
  const idle = new Idle(req.idleTimeoutMs ?? options.idleTimeoutMs ?? 0, timeout);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const hint = options.settingsHint ? ` ${options.settingsHint}` : '';
  let streamed = false;
  /** A failed result with its failure as data; never `retryable` once output has streamed. */
  const failed = (error: string, failure: Omit<AIFailure, 'streamed'>, extra: Partial<AIChatResult> = {}): AIChatResult => {
    const { retryable, ...rest } = extra;
    return { ok: false, error, ...rest, ...(retryable && !streamed ? { retryable: true } : {}), failure: { ...failure, streamed } };
  };
  try {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (conn.kind === 'chrome-builtin') throw new Error('The on-device model has no tool calling.');
    const model = req.model ?? conn.model;
    if (!model) throw new Error(`The AI connection has no model selected.${hint}`);
    const onEvent = guarded(options.onEvent, () => { streamed = true; });
    const ctx: Turn = { conn, credential, model, req, signal: controller.signal, fetch: fetchOf(options), idle, debug: options.debug, hint, onEvent };

    const candidates = protocolCandidates(conn, model);
    let mismatch: ProtocolMismatch | undefined;
    for (const protocol of candidates) {
      try {
        const result = await turn(protocol, ctx);
        if (candidates.length > 1) learnedProtocols.set(learnKey(conn, model), protocol);
        if (result.ok && result.usage) onEvent({ type: 'usage', usage: { ...result.usage } });
        options.debug?.('chat result', result);
        if (result.ok) return result;
        // A failure from inside the stream: the module said what it knows; whether output had streamed is known here.
        const { failure, ...rest } = transient(result);
        return failed(result.error ?? 'The turn failed.', { kind: 'stream', ...failure }, rest);
      } catch (error) {
        if (!(error instanceof ProtocolMismatch)) throw error;
        mismatch = error;
      }
    }
    throw new Error(conn.issuer === 'opencode'
      ? `OpenCode serves ${model} on a protocol this library does not speak (${mismatch?.message}).`
      : mismatch?.message);
  } catch (error) {
    if (options.signal?.aborted) return failed('Stopped.', { kind: 'stopped', ...cause(options.signal.reason) });
    if (controller.signal.aborted) return failed(TIMED_OUT, { kind: 'timeout' });
    if (error instanceof SinkError) return failed(error.message, { kind: 'sink', cause: error.message });
    // A dropped connection: nothing was acted on, so the caller may send the same request again — unless output had streamed.
    if (error instanceof TypeError) return failed(networkError(conn), { kind: 'network', cause: error.message }, { retryable: true });
    // The server refused: a 5xx (or an overloaded one) is worth another try, and so is a rate limit that lifts within the minute. It says when.
    if (error instanceof HttpError) {
      const retryable = error.status >= 500 || shortRateLimit(error) || /overloaded|backend failed/i.test(error.message);
      return failed(error.message, {
        kind: 'http', status: error.status,
        ...(error.providerCode ? { providerCode: error.providerCode } : {}), ...(error.requestId ? { requestId: error.requestId } : {}),
      }, { ...rateLimitFields(error), ...(retryable ? { retryable: true } : {}) });
    }
    const message = errMessage(error);
    return failed(message, { kind: 'request' }, /^HTTP (5\d\d|529)\b|overloaded|backend failed/i.test(message) ? { retryable: true } : {});
  } finally {
    clearTimeout(timer);
    idle.stop();
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** The silence watchdog: armed when a request goes out, reset by every chunk, and `onTimeout` when the limit passes. Nothing when the limit is 0. */
class Idle {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  constructor(private readonly ms: number, private readonly onTimeout: () => void) {}
  touch(): void {
    if (this.ms <= 0 || this.done) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(this.onTimeout, this.ms);
  }
  /** Disarms for good: a read still pending when the turn ends cannot arm it again. */
  stop(): void {
    this.done = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** The body with the watchdog on it: every chunk read resets the clock, and the end of the stream stops it. */
  watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    if (this.ms <= 0) return body;
    const reader = body.getReader();
    this.touch();
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) { clearTimeout(this.timer); controller.close(); return; }
        this.touch();
        controller.enqueue(value);
      },
      cancel: async (reason) => { clearTimeout(this.timer); await reader.cancel(reason); },
    });
  }
}

/* ── protocols ───────────────────────────────────────────────────── */

/**
 * Some servers serve a model on another protocol than the connection's and
 * say so with HTTP 400. OpenCode serves each model on its origin's — Claude
 * on Messages, GPT on Responses, most others on Chat Completions — and
 * answers "Model does not support this protocol" to any other; OpenAI's newer
 * models take function tools on Responses only ("use /v1/responses"). The
 * candidates are tried in order, and what a model answered to is kept for the
 * process's lifetime.
 */
const learnedProtocols = new Map<string, Protocol>();
const PROTOCOLS: readonly Protocol[] = ['chat-completions', 'anthropic', 'responses', 'gemini'];
const learnKey = (conn: Connection, model: string) => `${conn.id ?? conn.baseUrl}:${model}`;

const isOpenAi = (baseUrl: string): boolean => {
  try { return new URL(baseUrl).hostname === 'api.openai.com'; } catch { return false; }
};

/** The protocols to try for a model on a connection, likeliest first. */
export function protocolCandidates(conn: Connection, model: string): Protocol[] {
  const learned = learnedProtocols.get(learnKey(conn, model));
  if (conn.issuer === 'opencode') {
    const first = learned
      ?? (/^claude-/.test(model) ? 'anthropic' : /^(gpt-|grok-|muse-)/.test(model) ? 'responses' : /^gemini-/.test(model) ? 'gemini' : 'chat-completions');
    return [first, ...PROTOCOLS.filter((p) => p !== first)];
  }
  const saved = protocolOf(conn);
  if (conn.kind === 'openai-compatible' && saved === 'chat-completions' && isOpenAi(conn.baseUrl)) {
    return learned === 'responses' ? ['responses'] : ['chat-completions', 'responses'];
  }
  return [saved];
}

/** The server's answer to a request in a protocol it does not serve that model on. */
class ProtocolMismatch extends Error {}

/**
 * An HTTP failure as an error: a protocol mismatch when the server says so,
 * else an `HttpError` with the text in words and what the server said about
 * coming back.
 */
function httpError(res: Response, text: string): Error {
  const message = describeHttpText(res.status, text);
  const mismatch = res.status === 400 && (/does not support this protocol/i.test(text) || /use \/v1\/responses/i.test(text));
  return mismatch ? new ProtocolMismatch(message) : new HttpError(res.status, message, rateLimitOf(res.status, res.headers, text), failureSource(res, text));
}

/** A failure event in a Responses stream from a server other than ChatGPT, in its own words. */
const providerFailure = (body: string): string => describeHttpText(0, body).replace(/^HTTP 0:? ?/, '') || 'The provider reported an error.';

interface Turn {
  conn: Connection;
  credential: ConnectionCredential;
  model: string;
  req: ChatRequest;
  signal: AbortSignal;
  fetch: Fetch;
  idle: Idle;
  debug?: (label: string, data: unknown) => void;
  hint: string;
  onEvent?: ChatEventSink;
}

/** Request bodies for the debug log, with image bytes replaced (they are never logged). */
function redactImages(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body, (key, value: unknown) =>
    (key === 'data' || key === 'url') && typeof value === 'string' && (value.length > 200 || value.startsWith('data:'))
      ? `[${value.length} chars redacted]` : value));
}

async function post(t: Turn, url: URL, headers: Record<string, string>, body: unknown): Promise<Response> {
  t.debug?.('chat request', { connection: t.conn.label, url: url.origin + url.pathname, body: redactImages(body) });
  t.idle.touch();
  return t.fetch(url, {
    method: 'POST', signal: t.signal,
    headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
}

function bodyOf(t: Turn, res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new Error('The provider sent no response body.');
  return t.idle.watch(res.body);
}

/** One model turn in `protocol`, against the connection's server with its credentials. */
async function turn(protocol: Protocol, t: Turn): Promise<AIChatResult> {
  if (protocol === 'anthropic') return anthropicTurn(t);
  if (protocol === 'responses') return responsesTurn(t);
  if (protocol === 'gemini') return geminiTurn(t);
  return chatCompletionsTurn(t);
}

/** The Gemini API root: the base URL, or for Gemini's OpenAI-compatible root (`…/v1beta/openai`) the root above it. */
export const geminiRoot = (baseUrl: string): string => apiRoot(baseUrl).replace(/\/openai$/, '');

/** Gemini API: Google itself with the key in `x-goog-api-key`, or another server serving it, such as OpenCode. */
async function geminiTurn(t: Turn): Promise<AIChatResult> {
  const { conn, credential } = t;
  const url = new URL(`${geminiRoot(conn.baseUrl)}/models/${encodeURIComponent(t.model)}:streamGenerateContent`);
  url.searchParams.set('alt', 'sse');
  const token = tokenOf(credential);
  const headers = conn.issuer === 'opencode' || typeof credential === 'function'
    ? await authorizerFor(conn, credential)('POST', url)
    : token ? { 'x-goog-api-key': token } : {};
  const res = await post(t, url, headers, geminiBody(t.req, t.model));
  if (!res.ok) throw httpError(res, await res.text());
  return geminiResult(readSse(bodyOf(t, res)), t.onEvent);
}

/** Messages API: Anthropic itself (key or subscription), or another server serving it, such as OpenCode. */
async function anthropicTurn(t: Turn): Promise<AIChatResult> {
  const { conn, credential, req } = t;
  const native = conn.kind === 'anthropic';
  const subscription = native && (conn.auth === 'oauth' || conn.auth === 'setup-token');
  const token = tokenOf(credential);
  if (native && typeof credential === 'function') throw new Error('Anthropic takes a key or token, not a request signer.');
  if (native && !token) throw new Error(`The AI connection has no key.${t.hint}`);
  const system = subscription ? withClaudeCodeSystem(req.system).system : req.system ? [{ type: 'text' as const, text: req.system }] : [];
  const url = new URL(native ? `${ANTHROPIC_BASE}/v1/messages` : `${apiRoot(conn.baseUrl)}/messages`);
  const headers = native
    ? anthropicHeaders(token, subscription)
    : { ...(await authorizerFor(conn, credential)('POST', url)), 'anthropic-version': ANTHROPIC_VERSION };
  let res = await post(t, url, headers, anthropicBody(req, t.model, system));
  if (!res.ok) {
    const text = await res.text();
    // The API refused the thinking blocks it had itself signed (an edited prefix, a block bound to another conversation): once more
    // without them, from the turn it named onward — the turns before keep theirs, as the docs ask.
    const from = res.status === 400 ? refusedThinkingFrom(text, req.messages) : undefined;
    if (from !== undefined) {
      let n = -1;
      const stripped = { ...req, messages: req.messages.map((m) => {
        if (m.role !== 'assistant') return m;
        n += 1;
        return n >= from && m.providerState !== undefined ? { ...m, providerState: withoutThinking(m.providerState) } : m;
      }) };
      res = await post(t, url, headers, anthropicBody(stripped, t.model, system));
      if (!res.ok) throw httpError(res, await res.text());
    } else {
      throw httpError(res, text);
    }
  }
  return anthropicResult(readSse(bodyOf(t, res)), t.onEvent);
}

/** Responses API: the Codex backend for a ChatGPT sign-in, else `${baseUrl}/responses`. */
async function responsesTurn(t: Turn): Promise<AIChatResult> {
  const { conn, credential, req } = t;
  const codex = conn.kind === 'chatgpt';
  const token = tokenOf(credential);
  if (codex && typeof credential === 'function') throw new Error('ChatGPT takes a token, not a request signer.');
  if (codex && !token) throw new Error(`The ChatGPT sign-in is missing.${t.hint}`);
  const url = new URL(codex ? CODEX_RESPONSES_URL : `${apiRoot(conn.baseUrl)}/responses`);
  const headers = codex
    ? {
        authorization: `Bearer ${token}`,
        ...(conn.accountId ? { 'chatgpt-account-id': conn.accountId } : {}),
        originator: conn.originator || CODEX_ORIGINATOR, 'openai-beta': 'responses=experimental',
      }
    : await authorizerFor(conn, credential)('POST', url);
  const res = await post(t, url, headers, codexBody(req, t.model, { maxOutputTokens: !codex, cacheKey: !codex && isOpenAi(conn.baseUrl) }));
  if (!res.ok) {
    const text = await res.text();
    // ChatGPT's refusals in its own words; no protocol fall-through there, the Codex backend is Responses only.
    throw codex ? new HttpError(res.status, codexHttpError(res.status, text), rateLimitOf(res.status, res.headers, text), failureSource(res, text)) : httpError(res, text);
  }
  return codexResult(readSse(bodyOf(t, res)), codex ? codexFailure : providerFailure, t.onEvent);
}

/**
 * The assistant turn (0-based, counting assistant turns) from which to drop
 * replayed thinking after Anthropic refused it, or undefined when the 400 is
 * about something else or no turn replays thinking. The two documented
 * refusals: "`thinking` or `redacted_thinking` blocks in the latest assistant
 * message cannot be modified" (the latest turn) and "messages.{i}.content.{j}:
 * Invalid `signature` in `thinking` block" (that turn, in the API's numbering
 * of messages, where consecutive tool results share one).
 */
function refusedThinkingFrom(text: string, messages: ChatRequest['messages']): number | undefined {
  const thinking = (m: ChatRequest['messages'][number]) => m.role === 'assistant' && (anthropicState(m.providerState) ?? []).some((b) => b['type'] === 'thinking' || b['type'] === 'redacted_thinking');
  if (!messages.some(thinking)) return undefined;
  const invalid = /messages\.(\d+)\.content\.\d+:[^\n]{0,40}Invalid `signature` in `thinking` block/i.exec(text);
  const modified = /(?:`thinking`|redacted_thinking)[^\n]{0,80}cannot be modified/i.test(text);
  if (!invalid && !modified) return undefined;
  const assistants = messages.filter((m) => m.role === 'assistant').length;
  if (!invalid) return assistants - 1;
  // The API's message index to the assistant turn it names: assistants map one to one, tool results merge.
  const api = anthropicMessages(messages);
  const named = Number(invalid[1]);
  const before = api.slice(0, named).filter((m) => m.role === 'assistant').length;
  return api[named]?.role === 'assistant' ? Math.min(before, assistants - 1) : Math.min(before, assistants - 1);
}

/** Chat Completions at `${baseUrl}/chat/completions`. */
async function chatCompletionsTurn(t: Turn): Promise<AIChatResult> {
  const base = apiRoot(t.conn.baseUrl);
  const authorize = authorizerFor(t.conn, t.credential);
  const omit = new Set<OptionalField>();
  let body: Record<string, unknown> = {};
  const send = async () => {
    const url = new URL(`${base}/chat/completions`);
    body = openaiBody(t.req, t.model, base, omit);
    return post(t, url, await authorize('POST', url), body);
  };
  // A server that rejects an optional field gets the request again without it, once per field — only a field the request carried, not one its answer merely names.
  let res = await send();
  while (!res.ok) {
    const text = await res.text();
    const field = rejectedField(res.status, text);
    if (!field || omit.has(field) || !(field in body)) throw httpError(res, text);
    omit.add(field);
    res = await send();
  }
  return openaiResult(readSse(bodyOf(t, res)), t.onEvent);
}

/* ── failures ────────────────────────────────────────────────────── */

/** `{ cause }` for an abort reason that says something, else nothing. */
function cause(reason: unknown): Pick<AIFailure, 'cause'> {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return text ? { cause: text } : {};
}

/** A stream cut short or an overloaded provider mid-answer: worth one more try, like a dropped connection. */
function transient(result: AIChatResult): AIChatResult {
  return !result.ok && /ended before it finished|overloaded/i.test(result.error ?? '') ? { ...result, retryable: true } : result;
}

/** A network failure, naming who could not be reached; the local-server hint only for local servers. */
function networkError(conn: Pick<Connection, 'kind' | 'baseUrl'>): string {
  if (conn.kind === 'anthropic') return 'The connection to Anthropic dropped (network error).';
  if (conn.kind === 'chatgpt') return 'The connection to ChatGPT dropped (network error).';
  let host = '';
  try { host = new URL(conn.baseUrl).hostname; } catch { /* no URL */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return `Could not reach the model server on this computer (${conn.baseUrl}). Check that it is running; from a browser it may also need CORS opened, e.g. OLLAMA_ORIGINS.`;
  }
  return `The connection to ${host || 'the provider'} dropped (network error).`;
}
