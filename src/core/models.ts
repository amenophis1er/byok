/**
 * The models a connection can run: Anthropic's catalog, the Codex catalog
 * for a ChatGPT sign-in, Gemini's own listing (its OpenAI-compatible one
 * includes models that 404 on chat), Workers AI's search, else `/models`.
 */

import type { ModelInfo } from '../types.js';
import { codexModels } from './openai-oauth.js';
import { ANTHROPIC_BASE, anthropicHeaders, apiRoot, bearer, describeHttp, type Authorizer, type ConnectionCredential } from './http.js';
import { authorizerFor, tokenOf, type Connection } from './connection.js';

/** The models a connection offers, sorted by id. Throws on an HTTP failure, in words. */
export async function listModels(conn: Connection, credential: ConnectionCredential): Promise<ModelInfo[]> {
  if (conn.kind === 'chrome-builtin') return [{ id: 'gemini-nano', name: 'Chrome on-device model' }];
  const token = tokenOf(credential);
  if (conn.kind === 'chatgpt') return codexModels({ accessToken: token, accountId: conn.accountId });
  if (conn.kind === 'anthropic') {
    if (!token) throw new Error('Enter an API key first.');
    return anthropicModels(token, conn.auth === 'oauth' || conn.auth === 'setup-token');
  }
  const base = apiRoot(conn.baseUrl);
  if (isGemini(base)) return geminiModels(token, new URL(base).origin);
  const account = workersAiAccount(base);
  if (account) return workersAiModels(token, account);
  return openaiModels(authorizerFor(conn, credential), base);
}

async function anthropicModels(token: string, subscription: boolean): Promise<ModelInfo[]> {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=100`, {
    headers: anthropicHeaders(token, subscription),
  });
  if (!res.ok) throw new Error(await describeHttp(res));
  const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
}

export const isGemini = (base: string): boolean => {
  try { return new URL(base).hostname === 'generativelanguage.googleapis.com'; } catch { return false; }
};

/**
 * Gemini's OpenAI-compatible /models lists every model on the account,
 * embedding, image and agent models included, which 404 on chat. Its own
 * API says what each supports: keep the generateContent ones.
 */
async function geminiModels(apiKey: string, origin: string): Promise<ModelInfo[]> {
  if (!apiKey) throw new Error('Enter an API key first.');
  const models: ModelInfo[] = [];
  let pageToken = '';
  do {
    const url = new URL(`${origin}/v1beta/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw new Error(await describeHttp(res));
    const json = (await res.json()) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    };
    for (const m of json.models ?? []) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      models.push({ id, name: m.displayName || id });
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
async function workersAiModels(apiKey: string, account: string): Promise<ModelInfo[]> {
  if (!apiKey) throw new Error('Enter an API token first.');
  const models: ModelInfo[] = [];
  const perPage = 100;
  for (let page = 1; ; page++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search`);
    url.searchParams.set('task', 'Text Generation');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    const res = await fetch(url, { headers: bearer(apiKey) });
    if (!res.ok) throw new Error(await describeHttp(res));
    const json = (await res.json()) as {
      result?: { name?: string; task?: { name?: string } }[];
      result_info?: { total_count?: number };
    };
    const result = json.result ?? [];
    for (const m of result) {
      if (m.name && (!m.task?.name || m.task.name === 'Text Generation')) models.push({ id: m.name, name: m.name });
    }
    const total = json.result_info?.total_count;
    if (result.length < perPage || (total !== undefined && page * perPage >= total)) break;
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function openaiModels(authorize: Authorizer, base: string): Promise<ModelInfo[]> {
  const url = new URL(`${base}/models`);
  const res = await fetch(url, { headers: await authorize('GET', url) });
  if (!res.ok) throw new Error(await describeHttp(res));
  // `{ data: [...] }`, or a bare array (Together).
  const json = (await res.json()) as { data?: { id: string }[] } | { id: string }[];
  return (Array.isArray(json) ? json : (json.data ?? []))
    .map((m) => ({ id: m.id, name: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
