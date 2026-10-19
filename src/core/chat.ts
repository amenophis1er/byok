/**
 * One model turn with tools, against any connection, in any runtime with
 * `fetch` and streams: the browser, Node 20+, Bun, Deno, Workers.
 *
 * Four protocols — the Messages API, the Responses API, Chat Completions and
 * the Gemini API — each streamed and returned only after the provider's
 * terminal event. A server that serves the model on another protocol says so
 * with HTTP 400, and the next candidate is tried.
 */

import type { AIChatRequest, AIChatResult, Protocol } from '../types.js';
import { anthropicBody, anthropicResult } from './chat-anthropic.js';
import { openaiBody, openaiResult, rejectedField, type OptionalField } from './chat-openai.js';
import { geminiBody, geminiResult } from './chat-gemini.js';
import { CODEX_RESPONSES_URL, codexBody, codexFailure, codexHttpError, codexResult } from './chat-codex.js';
import { readSse } from './sse.js';
import { withClaudeCodeSystem } from './anthropic-oauth.js';
import { ANTHROPIC_BASE, ANTHROPIC_VERSION, HttpError, anthropicHeaders, apiRoot, describeHttpText, errMessage, rateLimitFields, shortRateLimit, type ConnectionCredential } from './http.js';
import { rateLimitOf } from './rate-limit.js';
import { authorizerFor, protocolOf, tokenOf, type Connection } from './connection.js';
import type { ChatEventSink } from './events.js';

/** A turn's request. The worker's `connectionId`/`connectionRevision` pin a stored connection; here the connection is given. */
export type ChatRequest = Omit<AIChatRequest, 'connectionId' | 'connectionRevision'>;

/** The sink threw: the turn fails with its message, and it is not a provider failure. */
class SinkError extends Error {
  constructor(public readonly cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); }
}

/** The caller's sink, with its exceptions told apart from the provider's. */
function guarded(onEvent: ChatEventSink | undefined): ChatEventSink | undefined {
  if (!onEvent) return undefined;
  return (event) => { try { onEvent(event); } catch (error) { throw new SinkError(error); } };
}

export interface ChatOptions {
  /** Stops the turn; the result is then `Stopped.`. */
  signal?: AbortSignal;
  /** Whole-request limit. Default 120 s. `req.timeoutMs` takes precedence. */
  timeoutMs?: number;
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
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), req.timeoutMs ?? options.timeoutMs ?? CHAT_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const hint = options.settingsHint ? ` ${options.settingsHint}` : '';
  try {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (conn.kind === 'chrome-builtin') throw new Error('The on-device model has no tool calling.');
    const model = req.model ?? conn.model;
    if (!model) throw new Error(`The AI connection has no model selected.${hint}`);
    const onEvent = guarded(options.onEvent);
    const ctx: Turn = { conn, credential, model, req, signal: controller.signal, debug: options.debug, hint, onEvent };

    const candidates = protocolCandidates(conn, model);
    let mismatch: ProtocolMismatch | undefined;
    for (const protocol of candidates) {
      try {
        const result = await turn(protocol, ctx);
        if (candidates.length > 1) learnedProtocols.set(learnKey(conn, model), protocol);
        if (result.ok && result.usage) onEvent?.({ type: 'usage', usage: { ...result.usage } });
        options.debug?.('chat result', result);
        return transient(result);
      } catch (error) {
        if (!(error instanceof ProtocolMismatch)) throw error;
        mismatch = error;
      }
    }
    throw new Error(conn.issuer === 'opencode'
      ? `OpenCode serves ${model} on a protocol this library does not speak (${mismatch?.message}).`
      : mismatch?.message);
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, error: 'Stopped.' };
    if (controller.signal.aborted) return { ok: false, error: TIMED_OUT };
    if (error instanceof SinkError) return { ok: false, error: error.message };
    // A dropped connection or a server-side failure: nothing was acted on, so the caller may send the same request again.
    if (error instanceof TypeError) return { ok: false, error: networkError(conn), retryable: true };
    // The server refused: a 5xx (or an overloaded one) is worth another try, and so is a rate limit that lifts within the minute. It says when.
    if (error instanceof HttpError) {
      const retryable = error.status >= 500 || shortRateLimit(error) || /overloaded|backend failed/i.test(error.message);
      return { ok: false, error: error.message, ...rateLimitFields(error), ...(retryable ? { retryable: true } : {}) };
    }
    const message = errMessage(error);
    return { ok: false, error: message, ...(/^HTTP (5\d\d|529)\b|overloaded|backend failed/i.test(message) ? { retryable: true } : {}) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
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
  return mismatch ? new ProtocolMismatch(message) : new HttpError(res.status, message, rateLimitOf(res.status, res.headers, text));
}

/** A failure event in a Responses stream from a server other than ChatGPT, in its own words. */
const providerFailure = (body: string): string => describeHttpText(0, body).replace(/^HTTP 0:? ?/, '') || 'The provider reported an error.';

interface Turn {
  conn: Connection;
  credential: ConnectionCredential;
  model: string;
  req: ChatRequest;
  signal: AbortSignal;
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
  return fetch(url, {
    method: 'POST', signal: t.signal,
    headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
}

function bodyOf(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new Error('The provider sent no response body.');
  return res.body;
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
  const res = await post(t, url, headers, geminiBody(t.req));
  if (!res.ok) throw httpError(res, await res.text());
  return geminiResult(readSse(bodyOf(res)), t.onEvent);
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
  const res = await post(t, url, headers, anthropicBody(req, t.model, system));
  if (!res.ok) throw httpError(res, await res.text());
  return anthropicResult(readSse(bodyOf(res)), t.onEvent);
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
        originator: 'codex_cli_rs', 'openai-beta': 'responses=experimental',
      }
    : await authorizerFor(conn, credential)('POST', url);
  const res = await post(t, url, headers, codexBody(req, t.model, { maxOutputTokens: !codex }));
  if (!res.ok) {
    const text = await res.text();
    // ChatGPT's refusals in its own words; no protocol fall-through there, the Codex backend is Responses only.
    throw codex ? new HttpError(res.status, codexHttpError(res.status, text), rateLimitOf(res.status, res.headers, text)) : httpError(res, text);
  }
  return codexResult(readSse(bodyOf(res)), codex ? codexFailure : providerFailure, t.onEvent);
}

/** Chat Completions at `${baseUrl}/chat/completions`. */
async function chatCompletionsTurn(t: Turn): Promise<AIChatResult> {
  const base = apiRoot(t.conn.baseUrl);
  const authorize = authorizerFor(t.conn, t.credential);
  const omit = new Set<OptionalField>();
  const send = async () => {
    const url = new URL(`${base}/chat/completions`);
    return post(t, url, await authorize('POST', url), openaiBody(t.req, t.model, base, omit));
  };
  // A server that rejects an optional field gets the request again without it, once per field.
  let res = await send();
  while (!res.ok) {
    const text = await res.text();
    const field = rejectedField(res.status, text);
    if (!field || omit.has(field)) throw httpError(res, text);
    omit.add(field);
    res = await send();
  }
  return openaiResult(readSse(bodyOf(res)), t.onEvent);
}

/* ── failures ────────────────────────────────────────────────────── */

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
