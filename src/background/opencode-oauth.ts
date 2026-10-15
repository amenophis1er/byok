/**
 * OpenCode Console sign-in (the `opencode auth login opencode` flow) for the
 * MV3 worker: an RFC 8628 device grant against the Console, and inference
 * through OpenCode's OpenAI-compatible endpoint with the resulting token.
 *
 *   POST {CONSOLE}/auth/device/code   { client_id, supports_org_scope }
 *     → device_code, user_code, verification_uri_complete, expires_in, interval
 *   POST {CONSOLE}/auth/device/token  { grant_type: device_code, device_code, client_id }
 *     → { error: 'authorization_pending' | 'slow_down' | … } until approved,
 *       then access_token, refresh_token, expires_in (30 days), org_id
 *   POST {CONSOLE}/auth/device/token  { grant_type: refresh_token, refresh_token, client_id }
 *
 * The Console registers no third-party clients: any `client_id` is accepted,
 * and an unregistered one is shown as "Unknown client" on the approval page.
 * Requests carry `Authorization: Bearer <access>` and, when the account has
 * an organization, `x-opencode-org-id`. The token reaches the paid models
 * only: OpenCode's free tier answers 403 to any client but its own.
 */

export const OPENCODE_CONSOLE = 'https://opencode.ai/console';
/** The API root for chat and the model list (the `opencode` provider in models.dev). */
export const OPENCODE_BASE = 'https://opencode.ai/inference/v1';
/** The header naming the organization the token was issued for. */
export const OPENCODE_ORG_HEADER = 'x-opencode-org-id';
/** The client id when the host names none; shown on the approval page. */
export const DEFAULT_CLIENT_ID = 'byok';
/** Never poll faster than this, whatever the server suggests. */
const MIN_POLL_MS = 2000;

export interface OpencodeDeviceStart {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  intervalSec: number;
  /** Epoch ms, from the server's `expires_in`. */
  expiresAt: number;
}

export interface OpencodeTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  orgId?: string;
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${OPENCODE_CONSOLE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseTokens(raw: unknown): OpencodeTokens {
  const r = (raw ?? {}) as Record<string, unknown>;
  const accessToken = typeof r.access_token === 'string' ? r.access_token : '';
  if (!accessToken) throw new Error('Token response missing access_token.');
  const refreshToken = typeof r.refresh_token === 'string' ? r.refresh_token : '';
  const expiresInSec = typeof r.expires_in === 'number' && r.expires_in > 0 ? r.expires_in : 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
    ...(typeof r.org_id === 'string' && r.org_id ? { orgId: r.org_id } : {}),
  };
}

/** Start the device grant: a code for the user and the page to enter it on (it is pre-filled there). */
export async function startOpencodeLogin(clientId = DEFAULT_CLIENT_ID): Promise<OpencodeDeviceStart> {
  const res = await post('/auth/device/code', { client_id: clientId, supports_org_scope: true });
  if (!res.ok) throw new Error(`OpenCode sign-in start failed (${res.status}): ${await res.text()}`);
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const deviceCode = typeof j.device_code === 'string' ? j.device_code : '';
  const userCode = typeof j.user_code === 'string' ? j.user_code : '';
  if (!deviceCode || !userCode) throw new Error('OpenCode sign-in returned no code.');
  const verify = typeof j.verification_uri_complete === 'string' ? j.verification_uri_complete
    : typeof j.verification_uri === 'string' ? j.verification_uri : '/console/device';
  const verifyUrl = new URL(verify, `${OPENCODE_CONSOLE}/`);
  if (verifyUrl.protocol !== 'https:') throw new Error('OpenCode sign-in sent a verification page that is not https.');
  const intervalSec = typeof j.interval === 'number' && Number.isFinite(j.interval) && j.interval > 0 ? j.interval : 5;
  const expiresInSec = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 600;
  return { deviceCode, userCode, verifyUrl: verifyUrl.href, intervalSec, expiresAt: Date.now() + expiresInSec * 1000 };
}

export type OpencodePoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'authorized'; tokens: OpencodeTokens }
  | { status: 'denied'; error: string };

/** One poll of the token endpoint. `authorization_pending` and `slow_down` mean keep going. */
export async function pollOpencode(deviceCode: string, clientId = DEFAULT_CLIENT_ID): Promise<OpencodePoll> {
  const res = await post('/auth/device/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: clientId,
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof j.access_token === 'string') return { status: 'authorized', tokens: parseTokens(j) };
  const error = typeof j.error === 'string' ? j.error : '';
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down' };
  if (error === 'access_denied') return { status: 'denied', error: 'You denied the sign-in on opencode.ai.' };
  if (error === 'expired_token') return { status: 'denied', error: 'The code expired — start the sign-in again.' };
  if (!res.ok && !error) return { status: 'denied', error: `OpenCode sign-in failed (HTTP ${res.status}).` };
  if (error) return { status: 'denied', error: `OpenCode sign-in failed: ${error}.` };
  return { status: 'pending' };
}

/** Rotate the token pair. The Console answers `invalid_grant` once the session was revoked: only a new sign-in recovers. */
export async function refreshOpencodeTokens(refreshToken: string, clientId = DEFAULT_CLIENT_ID): Promise<OpencodeTokens> {
  const res = await post('/auth/device/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (!res.ok) {
    const text = await res.text();
    if (/invalid_grant/.test(text)) throw new Error('Your OpenCode sign-in was revoked or expired — remove the connection and sign in again.');
    throw new Error(`OpenCode token refresh failed (${res.status}): ${text}`);
  }
  const tokens = parseTokens(await res.json());
  // A refresh answers with the same refresh token when it does not rotate: keep what we have either way.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
}

/** The signed-in user's email, for the connection's label; empty when the Console will not say. */
export async function opencodeAccount(tokens: OpencodeTokens): Promise<string> {
  const res = await fetch(`${OPENCODE_CONSOLE}/api/user`, { headers: opencodeHeaders(tokens.accessToken, tokens.orgId) }).catch(() => null);
  if (!res?.ok) return '';
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return typeof j.email === 'string' ? j.email : '';
}

/** Auth headers for one request: the bearer token, and the organization when there is one. */
export function opencodeHeaders(accessToken: string, orgId?: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, ...(orgId ? { [OPENCODE_ORG_HEADER]: orgId } : {}) };
}

/** Delay before the next poll: the server's interval, stretched by 5 s for each `slow_down`. */
export function opencodePollDelayMs(intervalSec: number, slowDowns: number): number {
  return Math.max(MIN_POLL_MS, (intervalSec + 5 * slowDowns) * 1000);
}
