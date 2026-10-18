/**
 * What every provider request shares: the API root, auth headers, and an HTTP
 * failure in words. Nothing here touches the browser.
 */

import { normalizeBaseUrl } from '../types.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The API root requests go to; refuses one with an unfilled `{placeholder}`. */
export function apiRoot(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const placeholder = /\{[^}]*\}/.exec(base);
  if (placeholder) throw new Error(`Replace ${placeholder[0]} in the base URL with your own value.`);
  return base;
}

/**
 * Auth headers for one request; may also edit the URL (a device-key
 * signature adds `ts` to the query).
 */
export type Authorizer = (method: string, url: URL) => Promise<Record<string, string>>;

/** What a connection authenticates with: a key or token, or a signer for each request (an Ollama device key). */
export type ConnectionCredential = string | Authorizer;

export function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function bearerAuth(apiKey: string): Authorizer {
  return async () => bearer(apiKey);
}

/**
 * Anthropic headers. Subscription tokens ride in Authorization (x-api-key
 * 401s for them); API keys use x-api-key.
 *
 * The `dangerous-direct-browser-access` header opts a request into CORS
 * (browser) handling — API keys NEED it in a browser (else 401 "must set the
 * header"), and it is harmless from a server; subscription orgs REJECT it
 * ("CORS requests are not allowed for this Organization"). In an extension,
 * subscription requests go out as plain server requests: no such header, and
 * the host's DNR ruleset (manifest/dnr-rules.json) strips Origin/Sec-Fetch on
 * api.anthropic.com so Anthropic doesn't classify them as CORS.
 */
export function anthropicHeaders(token: string, subscription: boolean): Record<string, string> {
  return subscription
    ? {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': ANTHROPIC_VERSION,
      }
    : {
        'x-api-key': token,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };
}

export async function describeHttp(res: Response): Promise<string> {
  return describeHttpText(res.status, await res.text());
}

export function describeHttpText(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    detail =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? body.slice(0, 200));
  } catch {
    detail = body.slice(0, 200);
  }
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

export function errMessage(error: unknown): string {
  if (error instanceof TypeError) return 'Network error: the server could not be reached.';
  return error instanceof Error ? error.message : String(error);
}
