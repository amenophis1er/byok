/**
 * The models a connection can run: Anthropic's catalog, the Codex catalog
 * for a ChatGPT sign-in, Gemini's own listing (its OpenAI-compatible one
 * includes models that 404 on chat), Workers AI's search, else `/models`.
 */

import type { ModelInfo } from '../types.js';
import { codexModels } from './openai-oauth.js';
import { ANTHROPIC_BASE, anthropicHeaders, apiRoot, fetchOf, httpFailure, type Authorizer, type ConnectionCredential, type Fetch, type RequestOptions } from './http.js';
import { authorizerFor, tokenOf, type Connection } from './connection.js';
import { anthropicFacts, geminiFacts, knownModelInfo, mergeFacts, openaiListingFacts, workersAiFacts } from './model-info.js';

/**
 * The models a connection offers, sorted by id, each with what is known
 * about it (`contextWindow`, `maxOutputTokens`, `capabilities`: from the
 * listing where it says, else the built-in tables, else absent). Throws on
 * an HTTP failure, in words: an `HttpError` with the status and, on a rate
 * limit, `retryAfterMs` and `quota` when the server said. Requests go through
 * `options.fetch` when given, else the global one.
 */
export async function listModels(conn: Connection, credential: ConnectionCredential, options: RequestOptions = {}): Promise<ModelInfo[]> {
  if (conn.kind === 'chrome-builtin') return [{ id: 'gemini-nano', name: 'Chrome on-device model' }];
  const token = tokenOf(credential);
  const fetch = fetchOf(options);
  const signer = typeof credential === 'function';
  if (conn.kind === 'chatgpt') {
    if (signer) throw new Error('ChatGPT takes a token, not a request signer.');
    return withKnown(conn, await codexModels({ accessToken: token, accountId: conn.accountId, originator: conn.originator }, options));
  }
  if (conn.kind === 'anthropic') {
    if (signer) throw new Error('Anthropic takes a key or token, not a request signer.');
    if (!token) throw new Error('Enter an API key first.');
    return withKnown(conn, await anthropicModels(fetch, token, conn.auth === 'oauth' || conn.auth === 'setup-token', conn.baseUrl));
  }
  const base = apiRoot(conn.baseUrl);
  const authorize = authorizerFor(conn, credential);
  // Google and Cloudflare take the key in their own header; a signer, or another server's token, goes as its headers.
  if (isGemini(base)) return geminiModels(fetch, signer || conn.issuer ? authorize : keyHeader('x-goog-api-key', token), new URL(base).origin);
  const account = workersAiAccount(base);
  if (account) return workersAiModels(fetch, signer ? authorize : keyHeader('Authorization', token && `Bearer ${token}`), account);
  return withKnown(conn, await openaiModels(fetch, authorize, base));
}

/**
 * What is known about one model on a connection — the bound one by default —
 * without listing them all when the tables already say (Anthropic, OpenAI,
 * ChatGPT). Else the listing is asked and the model found in it; a model the
 * listing does not carry comes back as its id with what the tables say, which
 * may be nothing.
 */
export async function getModelInfo(conn: Connection, credential: ConnectionCredential, modelId: string | undefined = conn.model, options: RequestOptions = {}): Promise<ModelInfo> {
  if (!modelId) throw new Error('No model given, and the connection has none selected.');
  const known = knownModelInfo(conn, modelId);
  if (known.contextWindow !== undefined) return { id: modelId, name: modelId, ...known };
  const listed = (await listModels(conn, credential, options)).find((m) => m.id === modelId);
  return listed ?? { id: modelId, name: modelId, ...known };
}

/** The tables' facts under each listed model's own, field by field. */
function withKnown(conn: Connection, models: ModelInfo[]): ModelInfo[] {
  return models.map(({ id, name, ...listed }) => ({ id, name, ...mergeFacts(knownModelInfo(conn, id), listed) }));
}

/** One header with the key, or none when there is no key; the listing then says so. */
function keyHeader(name: string, value: string): Authorizer | undefined {
  return value ? async () => ({ [name]: value }) : undefined;
}

/** Anthropic's catalog, across its pages (`has_more` / `last_id`), at the connection's base URL when it has one. */
async function anthropicModels(fetch: Fetch, token: string, subscription: boolean, baseUrl = ''): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(baseUrl ? `${apiRoot(baseUrl)}/models` : `${ANTHROPIC_BASE}/v1/models`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after_id', after);
    const res = await fetch(url, { headers: anthropicHeaders(token, subscription) });
    if (!res.ok) throw await httpFailure(res);
    // Since the 5 generation the listing says each model's limits and inputs; those win over the table.
    const json = (await res.json()) as { data?: Array<Record<string, unknown> & { id: string; display_name?: string }>; has_more?: boolean; last_id?: string | null };
    const data = json.data ?? [];
    for (const m of data) models.push({ id: m.id, name: m.display_name ?? m.id, ...anthropicFacts(m) });
    if (!json.has_more || typeof json.last_id !== 'string' || !json.last_id || data.length === 0 || json.last_id === after) break;
    after = json.last_id;
  }
  return models;
}

export const isGemini = (base: string): boolean => {
  try { return new URL(base).hostname === 'generativelanguage.googleapis.com'; } catch { return false; }
};

/**
 * Gemini's OpenAI-compatible /models lists every model on the account,
 * embedding, image and agent models included, which 404 on chat. Its own
 * API says what each supports: keep the generateContent ones.
 */
async function geminiModels(fetch: Fetch, authorize: Authorizer | undefined, origin: string): Promise<ModelInfo[]> {
  if (!authorize) throw new Error('Enter an API key first.');
  const models: ModelInfo[] = [];
  let pageToken = '';
  do {
    const url = new URL(`${origin}/v1beta/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: await authorize('GET', url) });
    if (!res.ok) throw await httpFailure(res);
    const json = (await res.json()) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: unknown; outputTokenLimit?: unknown }[];
      nextPageToken?: string;
    };
    for (const m of json.models ?? []) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      models.push({ id, name: m.displayName || id, ...geminiFacts(id, m) });
    }
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** The account in a Workers AI root (`api.cloudflare.com/client/v4/accounts/<id>/ai/v1`), else undefined. */
export function workersAiAccount(base: string): string | undefined {
  try {
    const url = new URL(base);
    if (url.hostname !== 'api.cloudflare.com') return undefined;
    return /^\/client\/v4\/accounts\/([^/]+)\/ai\/v1$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Workers AI has no OpenAI-style /models (405): its own model search lists
 * the account's catalog. Keep the Text Generation models, across pages.
 */
async function workersAiModels(fetch: Fetch, authorize: Authorizer | undefined, account: string): Promise<ModelInfo[]> {
  if (!authorize) throw new Error('Enter an API token first.');
  const models: ModelInfo[] = [];
  const perPage = 100;
  for (let page = 1; ; page++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search`);
    url.searchParams.set('task', 'Text Generation');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    const res = await fetch(url, { headers: await authorize('GET', url) });
    if (!res.ok) throw await httpFailure(res);
    const json = (await res.json()) as {
      result?: { name?: string; task?: { name?: string }; properties?: unknown }[];
      result_info?: { total_count?: number };
    };
    const result = json.result ?? [];
    for (const m of result) {
      if (m.name && (!m.task?.name || m.task.name === 'Text Generation')) models.push({ id: m.name, name: m.name, ...workersAiFacts(m.properties) });
    }
    const total = json.result_info?.total_count;
    if (result.length < perPage || (total !== undefined && page * perPage >= total)) break;
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function openaiModels(fetch: Fetch, authorize: Authorizer, base: string): Promise<ModelInfo[]> {
  const url = new URL(`${base}/models`);
  const res = await fetch(url, { headers: await authorize('GET', url) });
  if (!res.ok) throw await httpFailure(res);
  // `{ data: [...] }`, or a bare array (Together). An entry that says more than its id (OpenRouter, vLLM) is read.
  const json = (await res.json()) as { data?: Array<Record<string, unknown> & { id: string }> } | Array<Record<string, unknown> & { id: string }>;
  return (Array.isArray(json) ? json : (json.data ?? []))
    .map((m) => ({ id: m.id, name: typeof m['name'] === 'string' && m['name'] ? m['name'] : m.id, ...openaiListingFacts(m) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
