/**
 * OpenAI "Connect with ChatGPT" device flow + Codex inference, ported from
 * the proven ekip/vonzio/wassup implementations to the MV3 worker.
 *
 * The flow is non-standard in two ways that matter:
 *   - polling is keyed by `device_auth_id`, NOT the RFC-8628 device_code;
 *   - approval does NOT return tokens — it returns an authorization_code
 *     plus a SERVER-ISSUED code_verifier, exchanged at /oauth/token with the
 *     DEVICE redirect uri.
 *
 * The resulting token does NOT work against api.openai.com: inference goes
 * to the ChatGPT Codex backend, which speaks the OpenAI *Responses* API,
 * only streams, and rejects max_output_tokens. The client id is OpenAI's own
 * Codex CLI app id (there is no third-party client to register).
 *
 * Users must first enable: ChatGPT → Settings → Security & Login →
 * "Enable device code authorization for Codex" (off by default; the start
 * call 404s without it).
 */
/** The usercode response carries no expiry; this bounds the poll loop. */
export declare const DEVICE_TIMEOUT_MS: number;
/**
 * The Codex CLI version the catalog request claims. The backend hides models
 * from clients it deems too old, so bump this with releases (`npm view
 * @openai/codex version`).
 */
export declare const CODEX_CLIENT_VERSION = "0.162.0";
/** What the dropdown shows when the catalog cannot be fetched (no network, a revoked sign-in). */
export declare const CODEX_MODELS: string[];
/**
 * The models the Codex catalog lists for this client, in the backend's order
 * (`priority`, lowest first): id is the slug the Responses API takes, name the
 * display name. Entries the backend hides are left out, as the Codex CLI does.
 * Returns [] for a body that is not a catalog.
 */
export declare function codexCatalogModels(body: unknown): Array<{
    id: string;
    name: string;
}>;
/** GET the Codex model catalog for a signed-in account. Throws on a failed request or an empty catalog. */
export declare function codexModels(input: {
    accessToken: string;
    accountId?: string;
}): Promise<Array<{
    id: string;
    name: string;
}>>;
export interface OpenAiTokens {
    accessToken: string;
    refreshToken: string;
    /** Absolute expiry, epoch ms — from the JWT `exp`, else `expires_in`. */
    expiresAt: number;
    accountId?: string;
}
export declare function accountIdFromJwt(jwt: string): string | undefined;
export interface DeviceStart {
    /** Poll key — this flow uses device_auth_id, not device_code. */
    deviceAuthId: string;
    userCode: string;
    verifyUrl: string;
    intervalSec: number;
    expiresAt: number;
}
export declare function startDeviceLogin(): Promise<DeviceStart>;
export type DevicePoll = {
    status: 'pending';
} | {
    status: 'slow_down';
} | {
    status: 'authorized';
    authorizationCode: string;
    codeVerifier: string;
} | {
    status: 'denied';
    error: string;
};
/** One poll. 403/404 and `deviceauth_authorization_pending` mean keep going. */
export declare function pollDevice(deviceAuthId: string, userCode: string): Promise<DevicePoll>;
/** Exchange the approval for tokens. Form-encoded; DEVICE redirect uri. */
export declare function exchangeDeviceCode(input: {
    authorizationCode: string;
    codeVerifier: string;
}): Promise<OpenAiTokens>;
/** Rotate a refresh token. SINGLE-USE — persist the pair immediately. A
 *  response omitting refresh_token keeps the old one. */
export declare function refreshOpenAiTokens(refreshToken: string): Promise<OpenAiTokens>;
/** Poll interval floor + slow_down backoff, bounded by the 15-min window. */
export declare function nextPollDelayMs(intervalSec: number, slowDowns: number): number;
/**
 * One text completion through the ChatGPT Codex backend. The backend only
 * streams and rejects max_output_tokens, so we always stream and aggregate
 * the SSE `response.output_text.delta` events into a single string.
 */
export declare function codexComplete(input: {
    accessToken: string;
    accountId?: string;
    model: string;
    system: string;
    prompt: string;
}, signal: AbortSignal): Promise<string>;
