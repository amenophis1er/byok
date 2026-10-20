/**
 * A sign-in call the provider refused, as data: the status, the provider's
 * code when the body carried one, and whether only a new sign-in recovers
 * (`reconnect`: the refresh token was revoked, rotated elsewhere or
 * expired). The message never quotes the body, which can carry token
 * material.
 */

import { code as codeOf } from './failure.js';

export class AuthError extends Error {
  readonly status: number;
  readonly code?: string;
  /** The sign-in is gone: remove the connection and sign in again. A refresh after this cannot succeed. */
  readonly reconnect: boolean;
  constructor(message: string, source: { status: number; code?: string; reconnect?: boolean }) {
    super(message);
    this.name = 'AuthError';
    this.status = source.status;
    if (source.code) this.code = source.code;
    this.reconnect = source.reconnect === true;
  }
}

/** The provider's code in a token endpoint's body: `error` as a string, or `error.code` / `error.type` / `error`. */
export function authCodeOf(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as unknown;
    if (!json || typeof json !== 'object') return undefined;
    const error = (json as Record<string, unknown>)['error'];
    if (typeof error === 'string') return codeOf(error).providerCode;
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      return codeOf(e['code']).providerCode ?? codeOf(e['type']).providerCode;
    }
  } catch { /* not JSON */ }
  // A bare body is a code only when shaped like one (`invalid_grant`), not any short word.
  const bare = body.trim();
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(bare) ? bare : undefined;
}

/**
 * The failure of `what` (a refresh, an exchange) for `provider`: a `reconnect`
 * one when a 400/401 names a revoked or expired grant, else the status and
 * code in words.
 */
export function authFailure(provider: string, what: string, status: number, body: string): AuthError {
  const code = authCodeOf(body);
  const reconnect = (status === 400 || status === 401) && /invalid_grant|revoked|expired/i.test(body);
  if (reconnect) return new AuthError(`Your ${provider} sign-in was revoked or expired — remove the connection and sign in again.`, { status, code, reconnect: true });
  return new AuthError(`${what} failed (HTTP ${status}${code ? `: ${code}` : ''}).`, { status, code });
}
