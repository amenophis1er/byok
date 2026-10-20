/**
 * A connection as the core sees it: where requests go and how they are
 * written. No secret, no storage — the credential travels beside it.
 */

import type { AuthMode, Protocol, ProviderKind } from '../types.js';
import { opencodeHeaders } from './opencode-oauth.js';
import { bearerAuth, type Authorizer, type ConnectionCredential } from './http.js';

export interface Connection {
  /** Remembers which protocol each model answered on; the base URL when absent. */
  id?: string;
  kind: ProviderKind;
  /** 'key' (default) | 'oauth' | 'setup-token' | 'device-key'. */
  auth?: AuthMode;
  /** openai-compatible only: the protocol the server speaks; absent = chat-completions. */
  protocol?: Protocol;
  /** openai-compatible only: the API root (`…/v1`). */
  baseUrl: string;
  /** The model a request uses when it names none. */
  model?: string;
  /** Shown in debug output. */
  label?: string;
  /** chatgpt only: the account id from the token, sent as chatgpt-account-id. */
  accountId?: string;
  /** chatgpt only: the `originator` header Codex requests carry, naming the client. Default `codex_cli_rs`, the Codex CLI's. */
  originator?: string;
  /** oauth only: 'opencode' when the OpenCode Console issued the token. */
  issuer?: 'opencode';
  /** opencode only: the organization the token was issued for. */
  orgId?: string;
}

/** The protocol a connection's requests are written in: by its kind, or as saved for an openai-compatible one. */
export function protocolOf(conn: Pick<Connection, 'kind' | 'protocol'>): Protocol {
  if (conn.kind === 'anthropic') return 'anthropic';
  if (conn.kind === 'chatgpt') return 'responses';
  return conn.protocol ?? 'chat-completions';
}

/** The credential as a function of the request: a signer as given, a key as a Bearer or OpenCode's headers. */
export function authorizerFor(conn: Connection, credential: ConnectionCredential): Authorizer {
  if (typeof credential === 'function') return credential;
  if (conn.issuer === 'opencode') return async () => opencodeHeaders(credential, conn.orgId);
  return bearerAuth(credential);
}

/** The key or token itself, or '' for a signer. */
export const tokenOf = (credential: ConnectionCredential): string => (typeof credential === 'string' ? credential : '');
