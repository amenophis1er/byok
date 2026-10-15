import {
  normalizeBaseUrl,
  defaultLabel,
  PROTOCOL_VERSION,
  type AIAnthropicLoginCompleteRequest,
  type AIAnthropicLoginStart,
  type AIAnthropicPasteTokenRequest,
  type AIChatMessageRequest,
  type AIChatRequest,
  type AIChatResult,
  type AIChatgptPoll,
  type AICompleteRequest,
  type AIConfigView,
  type AIDeleteConnectionRequest,
  type AIListModelsRequest,
  type AIOllamaLoginStart,
  type AIOllamaPoll,
  type AIOpencodeLoginStart,
  type AIOpencodePoll,
  type AIResult,
  type AISaveConnectionRequest,
  type AISetActiveRequest,
  type AuthMode,
  type ConnectionView,
  type ModelInfo,
  type Protocol,
  type ProviderKind,
} from '../types.js';
import {
  configureCryptoDb,
  createSigningKey,
  decryptBlob,
  deleteSigningKey,
  encryptString,
  getSigningKey,
  type EncBlob,
} from './crypto.js';
import { anthropicBody, anthropicResult } from './chat-anthropic.js';
import { openaiBody, openaiResult, rejectedField, type OptionalField } from './chat-openai.js';
import { CODEX_RESPONSES_URL, codexBody, codexFailure, codexHttpError, codexResult } from './chat-codex.js';
import { readSse } from './sse.js';
import {
  CONNECT_POLL_MS,
  CONNECT_TIMEOUT_MS,
  OLLAMA_BASE,
  connectUrl,
  disconnect as ollamaDisconnect,
  publicKeyLine,
  signRequest,
  whoami,
} from './ollama-device.js';
import {
  OPENCODE_BASE,
  type OpencodeDeviceStart,
  opencodeAccount,
  opencodeHeaders,
  opencodePollDelayMs,
  pollOpencode,
  refreshOpencodeTokens,
  startOpencodeLogin,
} from './opencode-oauth.js';
import {
  exchangeCode,
  isSetupToken,
  refreshTokens,
  startLogin,
  withClaudeCodeSystem,
} from './anthropic-oauth.js';
import {
  CODEX_MODELS,
  codexModels,
  exchangeDeviceCode,
  nextPollDelayMs,
  pollDevice,
  refreshOpenAiTokens,
  startDeviceLogin,
  type DeviceStart,
} from './openai-oauth.js';

/**
 * All AI secret handling. Users save any number of connections; one is
 * active at a time. Keys are encrypted at rest (crypto.ts) and stored as
 * ciphertext in chrome.storage.local; UI surfaces only ever get a redacted
 * view. Provider calls run here so keys never enter page frames and CORS is
 * avoided (for hosts the worker has permission for).
 *
 * Wire it up in the service worker:
 *
 *   import { registerAiHandlers } from '@amenophis1er/byok/background';
 *   registerAiHandlers({ prefix: 'myext' });
 *
 * or compose with an existing onMessage listener via createAiMessageHandler.
 */

export interface AiHandlerOptions {
  /** Message-type prefix: handlers match `${prefix}:ai-<op>`. Default 'aiconnect'. */
  prefix?: string;
  /** chrome.storage.local key holding the connection config. Default 'aiConnections'. */
  storageKey?: string;
  /** IndexedDB database holding the non-extractable AES key. Default 'ai-connect-crypto'. */
  cryptoDbName?: string;
  /** chrome.storage.local boolean flag enabling request/response logging. Default 'aiConnectDebug'. */
  debugFlagKey?: string;
  /** Appended to "no/incomplete connection" errors — tell users where your settings live. */
  settingsHint?: string;
  /** Open the OAuth consent page in a new tab on login-start (needs nothing beyond tabs.create). Default true. */
  openConsentTab?: boolean;
  /** The client id the OpenCode Console sign-in sends: your extension's name, shown on its approval page. Default 'byok'. */
  opencodeClientId?: string;
}

interface Resolved {
  prefix: string;
  storageKey: string;
  cryptoDbName: string;
  debugFlagKey: string;
  settingsHint: string;
  openConsentTab: boolean;
  opencodeClientId: string;
}

let opts: Resolved = resolve({});

function resolve(o: AiHandlerOptions): Resolved {
  return {
    prefix: o.prefix ?? 'aiconnect',
    storageKey: o.storageKey ?? 'aiConnections',
    cryptoDbName: o.cryptoDbName ?? 'ai-connect-crypto',
    debugFlagKey: o.debugFlagKey ?? 'aiConnectDebug',
    settingsHint: o.settingsHint ?? 'Add one in the extension settings.',
    openConsentTab: o.openConsentTab ?? true,
    opencodeClientId: o.opencodeClientId ?? 'byok',
  };
}

interface StoredConnection {
  id: string;
  kind: ProviderKind;
  /** 'key' (default) | 'oauth' (Claude Pro/Max, refreshable) | 'setup-token'. */
  auth?: AuthMode;
  /** openai-compatible only: the protocol the server speaks; absent = chat-completions. */
  protocol?: Protocol;
  label: string;
  baseUrl: string;
  model: string;
  /** The secret: API key, or (oauth/setup-token) the access/setup token. */
  apiKeyEnc: EncBlob | null;
  /** oauth only: rotating refresh token + absolute expiry (epoch ms). */
  refreshTokenEnc?: EncBlob | null;
  expiresAt?: number;
  /** chatgpt only: account id from the JWT, sent as chatgpt-account-id. */
  accountId?: string;
  /** oauth only: who issued the token when it is not the provider itself. 'opencode' = the OpenCode Console
   *  (an openai-compatible connection whose token is refreshed there and that names its organization). */
  issuer?: 'opencode';
  /** opencode only: the organization the token was issued for, sent as x-opencode-org-id. */
  orgId?: string;
  /** device-key only: the Ollama account the device key is paired with. The
   *  key pair itself lives in IndexedDB under the connection id. */
  account?: string;
  /** Bumped by every settings save; absent means 0. */
  revision?: number;
}
interface StoredConfig {
  activeId: string | null;
  connections: StoredConnection[];
  /** Base URLs are API roots (`…/v1`). Absent: stored before 0.1.2, as origins `/v1` was appended to. */
  apiRoots?: true;
}

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Abort a completion that runs too long (a hung endpoint / stuck model). */
const COMPLETE_TIMEOUT_MS = 60_000;

/**
 * Debug tracing. Flip on by running in the SW console:
 *   chrome.storage.local.set({ <debugFlagKey>: true })
 * Then every completion logs the full request (URL, body — keys are in
 * headers, never the body) and the raw response to the service-worker
 * console. Off by default so message content isn't logged in normal use.
 */
async function debugOn(): Promise<boolean> {
  return (await chrome.storage.local.get(opts.debugFlagKey))[opts.debugFlagKey] === true;
}
function dlog(label: string, data: unknown): void {
  console.log(`%c[ai-connect] ${label}`, 'color:#00a884;font-weight:bold', data);
}

/** Strip reasoning/thinking the model may emit despite instructions. */
function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim();
}

function empty(): StoredConfig {
  return { activeId: null, connections: [], apiRoots: true };
}

/**
 * A base URL saved before 0.1.2 as the API root: those had `/v1` stripped and
 * every request added it back.
 */
function legacyApiRoot(baseUrl: string): string {
  let base = baseUrl.trim();
  if (!base) return 'https://api.openai.com/v1';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
}

/** The API root requests go to; refuses one with an unfilled `{placeholder}`. */
function apiRoot(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const placeholder = /\{[^}]*\}/.exec(base);
  if (placeholder) throw new Error(`Replace ${placeholder[0]} in the base URL with your own value.`);
  return base;
}

/**
 * Load config, migrating older shapes into the connections list:
 *  - v3: { activeId, connections: [...] }              (current)
 *  - v2: { provider, creds: { <kind>: {baseUrl, model, apiKeyEnc|apiKey} } }
 *  - v1: { provider, apiKey, baseUrl, model }          (flat plaintext)
 * Any plaintext key found is encrypted on the way in.
 */
async function load(): Promise<StoredConfig> {
  const raw = (await chrome.storage.local.get(opts.storageKey))[opts.storageKey] as
    | Record<string, unknown>
    | undefined;
  if (!raw) return empty();

  // v3 — already migrated. Base URLs become API roots in memory; the next save persists them.
  if (Array.isArray(raw.connections)) {
    const connections = raw.connections as StoredConnection[];
    return {
      activeId: (raw.activeId as string | null) ?? null,
      connections: raw.apiRoots
        ? connections
        : connections.map((c) => (c.kind === 'openai-compatible' ? { ...c, baseUrl: legacyApiRoot(c.baseUrl) } : c)),
      apiRoots: true,
    };
  }

  const cfg = empty();
  const add = async (kind: ProviderKind, c: Record<string, unknown>, active: boolean) => {
    const hasContent = c.apiKey || c.apiKeyEnc || c.model;
    if (!hasContent) return;
    const apiKeyEnc =
      typeof c.apiKey === 'string' && c.apiKey
        ? await encryptString(c.apiKey) // v1/v2 plaintext
        : ((c.apiKeyEnc as EncBlob | undefined) ?? null);
    const baseUrl = kind === 'openai-compatible' ? legacyApiRoot((c.baseUrl as string) ?? '') : '';
    const conn: StoredConnection = {
      id: crypto.randomUUID(),
      kind,
      label: defaultLabel(kind, baseUrl),
      baseUrl,
      model: (c.model as string) ?? '',
      apiKeyEnc,
    };
    cfg.connections.push(conn);
    if (active) cfg.activeId = conn.id;
  };

  const activeKind = raw.provider as string | undefined;
  if (raw.creds && typeof raw.creds === 'object') {
    const src = raw.creds as Record<string, Record<string, unknown>>;
    for (const kind of ['anthropic', 'openai-compatible'] as ProviderKind[]) {
      const entry = src[kind];
      if (entry) await add(kind, entry, activeKind === kind);
    }
  } else if (typeof raw.apiKey === 'string') {
    if (activeKind === 'anthropic' || activeKind === 'openai-compatible') {
      await add(activeKind, raw as Record<string, unknown>, true);
    }
  }

  await save(cfg);
  return cfg;
}

async function save(cfg: StoredConfig): Promise<void> {
  await chrome.storage.local.set({ [opts.storageKey]: cfg });
}

/**
 * The one writer for the connection record.
 *
 * Every connection lives in one storage record, and every change is a
 * read-modify-write of the whole record. Two of those interleaved lose one:
 * refreshing connection A while the settings UI edits B can drop B's edit, and
 * two refreshes can restore a used single-use refresh token. So every
 * read-modify-write — saves, deletes, token refresh, sign-in completion —
 * runs through this queue, one at a time. `fn` must not call withConfig.
 */
let configQueue: Promise<unknown> = Promise.resolve();
function withConfig<T>(fn: (cfg: StoredConfig) => Promise<T>): Promise<T> {
  const run = configQueue.then(async () => fn(await load()));
  configQueue = run.catch(() => undefined);
  return run;
}

async function toView(c: StoredConnection): Promise<ConnectionView> {
  if (c.auth === 'device-key') {
    return {
      id: c.id,
      kind: c.kind,
      auth: c.auth,
      protocol: protocolOf(c),
      label: c.label,
      baseUrl: c.baseUrl,
      model: c.model,
      hasKey: true,
      keyHint: c.account ?? '',
      revision: c.revision ?? 0,
    };
  }
  const key = await decryptBlob(c.apiKeyEnc);
  return {
    id: c.id,
    kind: c.kind,
    auth: c.auth ?? 'key',
    protocol: protocolOf(c),
    label: c.label,
    baseUrl: c.baseUrl,
    model: c.model,
    hasKey: key.length > 0,
    // A sign-in shows who signed in when it knows; a key its last characters.
    keyHint: c.account ?? (key ? `····${key.slice(-4)}` : ''),
    revision: c.revision ?? 0,
  };
}

async function getView(): Promise<AIConfigView> {
  const cfg = await load();
  return {
    activeId: cfg.activeId,
    connections: await Promise.all(cfg.connections.map(toView)),
  };
}

async function setActive(req: AISetActiveRequest): Promise<AIResult<null>> {
  return withConfig(async (cfg) => {
    cfg.activeId = req.id && cfg.connections.some((c) => c.id === req.id) ? req.id : null;
    await save(cfg);
    return { ok: true };
  });
}

async function saveConnection(req: AISaveConnectionRequest): Promise<AIResult<{ id: string }>> {
  let baseUrl = '';
  if (req.kind === 'openai-compatible') {
    try {
      baseUrl = apiRoot(req.baseUrl);
    } catch (error) {
      return { ok: false, error: errMessage(error) };
    }
  }
  return withConfig(async (cfg) => {
    let conn = req.id ? cfg.connections.find((c) => c.id === req.id) : undefined;
    if (!conn) {
      conn = {
        id: crypto.randomUUID(),
        kind: req.kind,
        label: '',
        baseUrl: '',
        model: '',
        apiKeyEnc: null,
      };
      cfg.connections.push(conn);
    }
    conn.kind = req.kind;
    conn.label = req.label || defaultLabel(req.kind, req.baseUrl);
    conn.baseUrl = baseUrl;
    if (req.kind === 'openai-compatible' && req.protocol && req.protocol !== 'chat-completions') conn.protocol = req.protocol;
    else delete conn.protocol;
    // Chrome's on-device model has no model list or key.
    conn.model = req.kind === 'chrome-builtin' ? 'gemini-nano' : req.model;
    if (req.apiKeyMode === 'set') conn.apiKeyEnc = await encryptString(req.apiKey ?? '');
    else if (req.apiKeyMode === 'clear') conn.apiKeyEnc = null;
    conn.revision = (conn.revision ?? 0) + 1;
    if (req.makeActive) cfg.activeId = conn.id;
    await save(cfg);
    return { ok: true, data: { id: conn.id } };
  });
}

/* ── Claude subscription sign-in ──────────────────────────────────── */

const PENDING_KEY = 'aiConnectAnthropicLogin';

/** Begin the Claude sign-in: mint PKCE, open the consent tab, stash the
 *  verifier/state in session storage (survives an SW restart while the user
 *  approves), and return the URL as a fallback link. */
async function anthropicLoginStart(): Promise<AIResult<AIAnthropicLoginStart>> {
  try {
    const { verifier, state, authorizeUrl } = await startLogin();
    await chrome.storage.session.set({ [PENDING_KEY]: { verifier, state } });
    if (opts.openConsentTab) void chrome.tabs.create({ url: authorizeUrl }).catch(() => {});
    return { ok: true, data: { authorizeUrl } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** Finish the sign-in: exchange the pasted code, store tokens as a new
 *  connection, make it active. */
async function anthropicLoginComplete(
  req: AIAnthropicLoginCompleteRequest,
): Promise<AIResult<{ id: string }>> {
  try {
    const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as
      | { verifier: string; state: string }
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
    const tokens = await exchangeCode({
      pasted: req.pasted,
      expectedState: pending.state,
      verifier: pending.verifier,
    });
    await chrome.storage.session.remove(PENDING_KEY);
    const id = await createSubscriptionConnection({
      auth: 'oauth',
      label: req.label || 'Claude (Pro/Max)',
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    return { ok: true, data: { id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** Add a Claude subscription connection from a pasted setup-token (no refresh). */
async function anthropicPasteToken(
  req: AIAnthropicPasteTokenRequest,
): Promise<AIResult<{ id: string }>> {
  try {
    const token = req.token.trim();
    if (!isSetupToken(token)) throw new Error('That is not a setup-token (should start with sk-ant-oat).');
    const id = await createSubscriptionConnection({
      auth: 'setup-token',
      label: req.label || 'Claude (setup-token)',
      token,
    });
    return { ok: true, data: { id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

async function createSubscriptionConnection(input: {
  auth: AuthMode;
  label: string;
  token: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<string> {
  const conn: StoredConnection = {
    id: crypto.randomUUID(),
    kind: 'anthropic',
    auth: input.auth,
    label: input.label,
    baseUrl: '',
    model: '',
    apiKeyEnc: await encryptString(input.token),
    refreshTokenEnc: input.refreshToken ? await encryptString(input.refreshToken) : null,
    expiresAt: input.expiresAt,
  };
  await addConnection(conn);
  return conn.id;
}

/** Append a connection and make it active, through the one writer. */
function addConnection(conn: StoredConnection): Promise<void> {
  return withConfig(async (cfg) => {
    cfg.connections.push(conn);
    cfg.activeId = conn.id;
    await save(cfg);
  });
}

/* ── ChatGPT subscription (device flow) ───────────────────────────── */

const CHATGPT_PENDING = 'aiConnectChatgptDevice';

/** Start the device flow: get a user code, stash the session, tell the UI
 *  what to show. The user approves at the verify URL; the UI then polls. */
async function chatgptLoginStart(): Promise<AIResult<{ userCode: string; verifyUrl: string }>> {
  try {
    const start = await startDeviceLogin();
    await chrome.storage.session.set({ [CHATGPT_PENDING]: { ...start, slowDowns: 0 } });
    if (opts.openConsentTab) void chrome.tabs.create({ url: start.verifyUrl }).catch(() => {});
    return { ok: true, data: { userCode: start.userCode, verifyUrl: start.verifyUrl } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** One poll step, driven by the UI so the worker can be killed between
 *  polls (MV3) without losing the session — it lives in session storage. */
async function chatgptLoginPoll(label: string): Promise<AIResult<AIChatgptPoll>> {
  try {
    const pending = (await chrome.storage.session.get(CHATGPT_PENDING))[CHATGPT_PENDING] as
      | (DeviceStart & { slowDowns: number })
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
    if (Date.now() > pending.expiresAt) {
      await chrome.storage.session.remove(CHATGPT_PENDING);
      throw new Error('Sign-in timed out after 15 minutes — start again.');
    }
    const poll = await pollDevice(pending.deviceAuthId, pending.userCode);
    if (poll.status === 'pending') return { ok: true, data: { status: 'pending' } };
    if (poll.status === 'slow_down') {
      await chrome.storage.session.set({
        [CHATGPT_PENDING]: { ...pending, slowDowns: pending.slowDowns + 1 },
      });
      return { ok: true, data: { status: 'pending' } };
    }
    if (poll.status === 'denied') {
      await chrome.storage.session.remove(CHATGPT_PENDING);
      throw new Error(poll.error);
    }
    const tokens = await exchangeDeviceCode({
      authorizationCode: poll.authorizationCode,
      codeVerifier: poll.codeVerifier,
    });
    await chrome.storage.session.remove(CHATGPT_PENDING);
    // The catalog's first model is the one the backend puts forward for this account.
    const catalog = await codexModels({ accessToken: tokens.accessToken, accountId: tokens.accountId }).catch(() => []);
    const conn: StoredConnection = {
      id: crypto.randomUUID(),
      kind: 'chatgpt',
      auth: 'oauth',
      label: label || 'ChatGPT (subscription)',
      baseUrl: '',
      model: catalog[0]?.id ?? CODEX_MODELS[0] ?? '',
      apiKeyEnc: await encryptString(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? await encryptString(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      accountId: tokens.accountId,
    };
    await addConnection(conn);
    return { ok: true, data: { status: 'created', id: conn.id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** How long the UI should wait before the next poll. */
export function chatgptPollDelay(intervalSec: number, slowDowns: number): number {
  return nextPollDelayMs(intervalSec, slowDowns);
}

/* ── Ollama Cloud (connect device) ────────────────────────────────── */

const OLLAMA_PENDING = 'aiConnectOllamaConnect';

/** Start pairing: mint a device key under a fresh connection id, open
 *  ollama.com/connect for it, and remember the attempt in session storage
 *  (survives an SW restart while the user clicks Connect). */
async function ollamaLoginStart(deviceName: string): Promise<AIResult<AIOllamaLoginStart>> {
  try {
    const previous = (await chrome.storage.session.get(OLLAMA_PENDING))[OLLAMA_PENDING] as
      | { id: string }
      | undefined;
    if (previous) await deleteSigningKey(previous.id);
    const id = crypto.randomUUID();
    const pair = await createSigningKey(id);
    const url = connectUrl(deviceName.trim() || 'Chrome extension', await publicKeyLine(pair));
    await chrome.storage.session.set({
      [OLLAMA_PENDING]: { id, expiresAt: Date.now() + CONNECT_TIMEOUT_MS },
    });
    if (opts.openConsentTab) void chrome.tabs.create({ url }).catch(() => {});
    return { ok: true, data: { connectUrl: url, pollMs: CONNECT_POLL_MS } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** One poll, driven by the UI: is the pending key paired yet? */
async function ollamaLoginPoll(label: string): Promise<AIResult<AIOllamaPoll>> {
  try {
    const pending = (await chrome.storage.session.get(OLLAMA_PENDING))[OLLAMA_PENDING] as
      | { id: string; expiresAt: number }
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
    const pair = await getSigningKey(pending.id);
    if (!pair || Date.now() > pending.expiresAt) {
      await chrome.storage.session.remove(OLLAMA_PENDING);
      await deleteSigningKey(pending.id);
      throw new Error('Sign-in timed out after 15 minutes — start again.');
    }
    const account = await whoami(pair);
    if (!account) return { ok: true, data: { status: 'pending' } };
    await chrome.storage.session.remove(OLLAMA_PENDING);
    await addConnection({
      id: pending.id,
      kind: 'openai-compatible',
      auth: 'device-key',
      label: label || (account.name ? `Ollama Cloud (${account.name})` : 'Ollama Cloud'),
      baseUrl: `${OLLAMA_BASE}/v1`,
      model: '',
      apiKeyEnc: null,
      account: account.name,
    });
    return { ok: true, data: { status: 'created', id: pending.id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/* ── OpenCode Console (device flow) ───────────────────────────────── */

const OPENCODE_PENDING = 'aiConnectOpencodeDevice';

/** Start the device grant and stash it in session storage; the UI shows the code and polls. */
async function opencodeLoginStart(): Promise<AIResult<AIOpencodeLoginStart>> {
  try {
    const start = await startOpencodeLogin(opts.opencodeClientId);
    await chrome.storage.session.set({ [OPENCODE_PENDING]: { ...start, slowDowns: 0 } });
    if (opts.openConsentTab) void chrome.tabs.create({ url: start.verifyUrl }).catch(() => {});
    return { ok: true, data: { userCode: start.userCode, verifyUrl: start.verifyUrl, pollMs: opencodePollDelayMs(start.intervalSec, 0) } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** One poll, driven by the UI so the worker may die between polls; the grant lives in session storage. */
async function opencodeLoginPoll(label: string): Promise<AIResult<AIOpencodePoll>> {
  try {
    const pending = (await chrome.storage.session.get(OPENCODE_PENDING))[OPENCODE_PENDING] as
      | (OpencodeDeviceStart & { slowDowns: number })
      | undefined;
    if (!pending) throw new Error('Sign-in expired — start again.');
    if (Date.now() > pending.expiresAt) {
      await chrome.storage.session.remove(OPENCODE_PENDING);
      throw new Error('The code expired — start the sign-in again.');
    }
    const poll = await pollOpencode(pending.deviceCode, opts.opencodeClientId);
    if (poll.status === 'pending') return { ok: true, data: { status: 'pending', pollMs: opencodePollDelayMs(pending.intervalSec, pending.slowDowns) } };
    if (poll.status === 'slow_down') {
      const slowDowns = pending.slowDowns + 1;
      await chrome.storage.session.set({ [OPENCODE_PENDING]: { ...pending, slowDowns } });
      return { ok: true, data: { status: 'pending', pollMs: opencodePollDelayMs(pending.intervalSec, slowDowns) } };
    }
    if (poll.status === 'denied') {
      await chrome.storage.session.remove(OPENCODE_PENDING);
      throw new Error(poll.error);
    }
    await chrome.storage.session.remove(OPENCODE_PENDING);
    const account = await opencodeAccount(poll.tokens);
    const conn: StoredConnection = {
      id: crypto.randomUUID(),
      kind: 'openai-compatible',
      auth: 'oauth',
      issuer: 'opencode',
      label: label || 'OpenCode',
      baseUrl: OPENCODE_BASE,
      model: '',
      apiKeyEnc: await encryptString(poll.tokens.accessToken),
      refreshTokenEnc: poll.tokens.refreshToken ? await encryptString(poll.tokens.refreshToken) : null,
      expiresAt: poll.tokens.expiresAt,
      ...(poll.tokens.orgId ? { orgId: poll.tokens.orgId } : {}),
      ...(account ? { account } : {}),
    };
    await addConnection(conn);
    return { ok: true, data: { status: 'created', id: conn.id } };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

/** Refresh an OAuth connection's token if it's near expiry, persisting the
 *  rotated pair through the one writer. Returns the usable access token. */
async function freshToken(connId: string): Promise<string> {
  return withConfig(async (cfg) => {
    const conn = cfg.connections.find((c) => c.id === connId);
    if (!conn) throw new Error('That AI connection no longer exists.');
    const access = await decryptBlob(conn.apiKeyEnc);
    if (conn.auth !== 'oauth') return access; // setup-token / key / device-key: no refresh
    const skewMs = 5 * 60_000;
    if (conn.expiresAt && Date.now() < conn.expiresAt - skewMs) return access;
    const refresh = await decryptBlob(conn.refreshTokenEnc);
    if (!refresh) return access; // can't refresh; try the current token
    const tokens =
      conn.issuer === 'opencode' ? await refreshOpencodeTokens(refresh, opts.opencodeClientId)
        : conn.kind === 'chatgpt' ? await refreshOpenAiTokens(refresh) : await refreshTokens(refresh);
    conn.apiKeyEnc = await encryptString(tokens.accessToken);
    conn.refreshTokenEnc = await encryptString(tokens.refreshToken);
    conn.expiresAt = tokens.expiresAt;
    const accountId = (tokens as { accountId?: string }).accountId;
    if (accountId) conn.accountId = accountId;
    await save(cfg); // persist rotated single-use token immediately
    return tokens.accessToken;
  });
}

async function deleteConnection(req: AIDeleteConnectionRequest): Promise<AIResult<null>> {
  const gone = (await load()).connections.find((c) => c.id === req.id);
  if (gone?.auth === 'device-key') {
    // Un-pair on ollama.com, then drop the key; a failed un-pair still drops it.
    const pair = await getSigningKey(gone.id);
    if (pair) await ollamaDisconnect(pair).catch(() => {});
    await deleteSigningKey(gone.id);
  }
  return withConfig(async (cfg) => {
    cfg.connections = cfg.connections.filter((c) => c.id !== req.id);
    if (cfg.activeId === req.id) cfg.activeId = null;
    await save(cfg);
    return { ok: true };
  });
}

async function listModels(req: AIListModelsRequest): Promise<AIResult<ModelInfo[]>> {
  try {
    const cfg = await load();
    const stored = req.id ? cfg.connections.find((c) => c.id === req.id) : undefined;
    // Subscription connections carry no baseUrl but authenticate via Bearer.
    const subscription = stored ? stored.auth === 'oauth' || stored.auth === 'setup-token' : false;
    if (req.kind === 'chrome-builtin') {
      return { ok: true, data: [{ id: 'gemini-nano', name: 'Chrome on-device model' }] };
    }
    // The Codex catalog, for the signed-in account; the curated list when it cannot be fetched.
    if (req.kind === 'chatgpt') {
      return { ok: true, data: stored ? await codexModelsFor(stored) : fallbackCodexModels() };
    }
    const apiKey = req.apiKey || (stored ? await freshToken(stored.id) : '');
    if (req.kind === 'anthropic' && !apiKey) throw new Error('Enter an API key first.');
    const base = req.kind === 'openai-compatible' ? apiRoot(req.baseUrl) : '';
    const models =
      req.kind === 'anthropic'
        ? await anthropicModels(apiKey, subscription)
        : isGemini(base)
          ? await geminiModels(apiKey, new URL(base).origin)
          : workersAiAccount(base)
            ? await workersAiModels(apiKey, workersAiAccount(base)!)
            : await openaiModels(
              stored && !req.apiKey ? await authorizerFor(stored, apiKey) : bearerAuth(apiKey),
              base,
            );
    return { ok: true, data: models };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

async function complete(req: AICompleteRequest): Promise<AIResult<string>> {
  const cfg = await load();
  const conn = cfg.connections.find((c) => c.id === cfg.activeId);
  // The on-device model runs in a page context (needs the page + user gesture); the worker should never be asked to do it.
  if (conn?.kind === 'chrome-builtin') return { ok: false, error: 'The on-device model runs in the page, not the worker.' };
  const result = await chat({
    system: req.system,
    messages: [{ role: 'user', content: req.prompt }],
    maxTokens: req.maxTokens ?? 1024,
    timeoutMs: COMPLETE_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error === TIMED_OUT
        ? 'Timed out — the model took too long (a large local model can hang your machine; pick a smaller one).'
        : (result.error ?? 'The model gave no answer.'),
    };
  }
  const text = stripThinking(result.text ?? '');
  if (await debugOn()) dlog('result', { raw: result.text, afterStripThinking: text });
  return { ok: true, data: text };
}

/* ── chat with tools ─────────────────────────────────────────────── */

/** Whole-request default for chat(); the stream itself keeps the worker's fetch alive. */
const CHAT_TIMEOUT_MS = 120_000;
const TIMED_OUT = 'Timed out waiting for the model.';

/** Request bodies for the debug log, with image bytes replaced (they are never logged). */
function redactImages(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body, (key, value: unknown) =>
    (key === 'data' || key === 'url') && typeof value === 'string' && (value.length > 200 || value.startsWith('data:'))
      ? `[${value.length} chars redacted]` : value));
}

/**
 * One model turn with tools, called directly inside the worker (D4).
 *
 * Streams the response (SSE) and returns it only after the provider's terminal
 * event. Uses the pinned connection when `connectionId` is given; if that
 * connection is gone, or its `revision` moved since the run started, the call
 * fails rather than send the conversation somewhere the run did not start.
 */
export async function chat(req: AIChatRequest, options: { signal?: AbortSignal } = {}): Promise<AIChatResult> {
  let used: { kind: string; baseUrl: string } | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), req.timeoutMs ?? CHAT_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const cfg = await load();
    const id = req.connectionId ?? cfg.activeId;
    const conn = cfg.connections.find((c) => c.id === id);
    if (!conn) {
      throw new Error(req.connectionId
        ? 'The AI connection this run started with no longer exists. Start a new run.'
        : `No AI connection selected. ${opts.settingsHint}`);
    }
    used = conn;
    if (req.connectionRevision !== undefined && (conn.revision ?? 0) !== req.connectionRevision) {
      throw new Error('The AI connection was changed during this run. Start a new run to use the new settings.');
    }
    if (conn.kind === 'chrome-builtin') throw new Error('The on-device model has no tool calling.');
    const model = req.model ?? conn.model;
    if (!model) throw new Error(`The AI connection has no model selected. ${opts.settingsHint}`);
    const token = await freshToken(conn.id);
    const debug = await debugOn();
    const signal = controller.signal;

    // A server that serves the model on another protocol says so: the next candidate is tried.
    const candidates = protocolCandidates(conn, model);
    let mismatch: ProtocolMismatch | undefined;
    for (const protocol of candidates) {
      try {
        const result = await turn(protocol, conn, token, model, req, signal, debug);
        if (candidates.length > 1) learnedProtocols.set(`${conn.id}:${model}`, protocol);
        if (debug) dlog('chat result', result);
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
    // A dropped connection or a server-side failure: nothing was acted on, so the caller may send the same request again.
    if (error instanceof TypeError) return { ok: false, error: chatNetworkError(used), retryable: true };
    const message = errMessage(error);
    return { ok: false, error: message, ...(/^HTTP (5\d\d|529)\b|overloaded|backend failed/i.test(message) ? { retryable: true } : {}) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/* ── protocols ───────────────────────────────────────────────────── */

/** The protocol a connection's requests are written in: by its kind, or as saved for an openai-compatible one. */
function protocolOf(conn: StoredConnection): Protocol {
  if (conn.kind === 'anthropic') return 'anthropic';
  if (conn.kind === 'chatgpt') return 'responses';
  return conn.protocol ?? 'chat-completions';
}

/**
 * Some servers serve a model on another protocol than the connection's and
 * say so with HTTP 400. OpenCode serves each model on its origin's — Claude
 * on Messages, GPT on Responses, most others on Chat Completions — and
 * answers "Model does not support this protocol" to any other; OpenAI's newer
 * models take function tools on Responses only ("use /v1/responses"). The
 * candidates are tried in order, and what a model answered to is kept for the
 * worker's lifetime.
 */
const learnedProtocols = new Map<string, Protocol>();
const PROTOCOLS: readonly Protocol[] = ['chat-completions', 'anthropic', 'responses'];

const isOpenAi = (baseUrl: string): boolean => {
  try { return new URL(baseUrl).hostname === 'api.openai.com'; } catch { return false; }
};

function protocolCandidates(conn: StoredConnection, model: string): Protocol[] {
  const learned = learnedProtocols.get(`${conn.id}:${model}`);
  if (conn.issuer === 'opencode') {
    const first = learned
      ?? (/^claude-/.test(model) ? 'anthropic' : /^(gpt-|grok-|muse-)/.test(model) ? 'responses' : 'chat-completions');
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

/** An HTTP failure as an error: a protocol mismatch when the server says so, else the text in words. */
function httpError(status: number, text: string): Error {
  const message = describeHttpText(status, text);
  const mismatch = status === 400 && (/does not support this protocol/i.test(text) || /use \/v1\/responses/i.test(text));
  return mismatch ? new ProtocolMismatch(message) : new Error(message);
}

/** A failure event in a Responses stream from a server other than ChatGPT, in its own words. */
const providerFailure = (body: string): string => describeHttpText(0, body).replace(/^HTTP 0:? ?/, '') || 'The provider reported an error.';

/** One model turn in `protocol`, against the connection's server with its credentials. */
async function turn(
  protocol: Protocol, conn: StoredConnection, token: string, model: string, req: AIChatRequest, signal: AbortSignal, debug: boolean,
): Promise<AIChatResult> {
  if (protocol === 'anthropic') return anthropicTurn(conn, token, model, req, signal, debug);
  if (protocol === 'responses') return responsesTurn(conn, token, model, req, signal, debug);
  return chatCompletionsTurn(conn, token, model, req, signal, debug);
}

/** Messages API: Anthropic itself (key or subscription), or another server serving it, such as OpenCode. */
async function anthropicTurn(conn: StoredConnection, token: string, model: string, req: AIChatRequest, signal: AbortSignal, debug: boolean): Promise<AIChatResult> {
  const native = conn.kind === 'anthropic';
  const subscription = native && (conn.auth === 'oauth' || conn.auth === 'setup-token');
  if (native && !token) throw new Error(`The AI connection has no key. ${opts.settingsHint}`);
  const system = subscription ? withClaudeCodeSystem(req.system).system : req.system ? [{ type: 'text' as const, text: req.system }] : [];
  const body = anthropicBody(req, model, system);
  const url = new URL(native ? `${ANTHROPIC_BASE}/v1/messages` : `${apiRoot(conn.baseUrl)}/messages`);
  const headers = native
    ? anthropicHeaders(token, subscription)
    : { ...(await (await authorizerFor(conn, token))('POST', url)), 'anthropic-version': ANTHROPIC_VERSION };
  if (debug) dlog('chat request', { connection: conn.label, url: url.origin + url.pathname, body: redactImages(body) });
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res.status, await res.text());
  if (!res.body) throw new Error('The provider sent no response body.');
  return anthropicResult(readSse(res.body));
}

/** Responses API: the Codex backend for a ChatGPT sign-in, else `${baseUrl}/responses`. */
async function responsesTurn(conn: StoredConnection, token: string, model: string, req: AIChatRequest, signal: AbortSignal, debug: boolean): Promise<AIChatResult> {
  const codex = conn.kind === 'chatgpt';
  if (codex && !token) throw new Error(`The ChatGPT sign-in is missing. ${opts.settingsHint}`);
  const body = codexBody(req, model, { maxOutputTokens: !codex });
  const url = new URL(codex ? CODEX_RESPONSES_URL : `${apiRoot(conn.baseUrl)}/responses`);
  const headers = codex
    ? {
        authorization: `Bearer ${token}`,
        ...(conn.accountId ? { 'chatgpt-account-id': conn.accountId } : {}),
        originator: 'codex_cli_rs', 'openai-beta': 'responses=experimental',
      }
    : await (await authorizerFor(conn, token))('POST', url);
  if (debug) dlog('chat request', { connection: conn.label, url: url.origin + url.pathname, body: redactImages(body) });
  const res = await fetch(url, {
    method: 'POST', signal,
    headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw codex ? new Error(codexHttpError(res.status, text)) : httpError(res.status, text);
  }
  if (!res.body) throw new Error('The provider sent no response body.');
  return codexResult(readSse(res.body), codex ? codexFailure : providerFailure);
}

/** Chat Completions at `${baseUrl}/chat/completions`. */
async function chatCompletionsTurn(conn: StoredConnection, token: string, model: string, req: AIChatRequest, signal: AbortSignal, debug: boolean): Promise<AIChatResult> {
  const base = apiRoot(conn.baseUrl);
  const authorize = await authorizerFor(conn, token);
  const omit = new Set<OptionalField>();
  const send = async () => {
    const url = new URL(`${base}/chat/completions`);
    const body = openaiBody(req, model, base, omit);
    if (debug) dlog('chat request', { connection: conn.label, url: url.origin + url.pathname, body: redactImages(body) });
    return fetch(url, {
      method: 'POST', signal,
      headers: { ...(await authorize('POST', url)), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  };
  // A server that rejects an optional field gets the request again without it, once per field.
  let res = await send();
  while (!res.ok) {
    const text = await res.text();
    const field = rejectedField(res.status, text);
    if (!field || omit.has(field)) throw httpError(res.status, text);
    omit.add(field);
    res = await send();
  }
  if (!res.body) throw new Error('The provider sent no response body.');
  return openaiResult(readSse(res.body));
}

/* ── provider HTTP ───────────────────────────────────────────────── */

function bearer(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Auth headers for one openai-compatible request; may also edit the URL
 *  (a device-key signature adds `ts` to the query). */
type Authorizer = (method: string, url: URL) => Promise<Record<string, string>>;

function bearerAuth(apiKey: string): Authorizer {
  return async () => bearer(apiKey);
}

async function authorizerFor(conn: StoredConnection, apiKey: string): Promise<Authorizer> {
  if (conn.issuer === 'opencode') return async () => opencodeHeaders(apiKey, conn.orgId);
  if (conn.auth !== 'device-key') return bearerAuth(apiKey);
  const pair = await getSigningKey(conn.id);
  if (!pair) throw new Error('This Ollama device key is gone — remove the connection and sign in again.');
  return (method, url) => signRequest(pair, method, url);
}

/**
 * Anthropic headers. Subscription tokens ride in Authorization (x-api-key
 * 401s for them); API keys use x-api-key.
 *
 * The `dangerous-direct-browser-access` header opts a request into CORS
 * (browser) handling — API keys NEED it (else 401 "must set the header"),
 * but subscription orgs REJECT it ("CORS requests are not allowed for this
 * Organization"). Subscription requests instead go out as plain server
 * requests: no such header, and the host extension's DNR ruleset (see
 * manifest/dnr-rules.json) strips Origin/Sec-Fetch on api.anthropic.com so
 * Anthropic doesn't classify them as CORS.
 */
function anthropicHeaders(token: string, subscription: boolean): Record<string, string> {
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

function fallbackCodexModels(): ModelInfo[] {
  return CODEX_MODELS.map((id) => ({ id, name: id }));
}

/** The Codex catalog for a ChatGPT connection, or the curated list when the request fails (the picker never comes up empty). */
async function codexModelsFor(conn: StoredConnection): Promise<ModelInfo[]> {
  try {
    return await codexModels({ accessToken: await freshToken(conn.id), accountId: conn.accountId });
  } catch (error) {
    console.warn('Codex model catalog unavailable, using the built-in list:', errMessage(error));
    return fallbackCodexModels();
  }
}

async function anthropicModels(token: string, subscription: boolean): Promise<ModelInfo[]> {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=100`, {
    headers: anthropicHeaders(token, subscription),
  });
  if (!res.ok) throw new Error(await describeHttp(res));
  const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
}

const isGemini = (base: string): boolean => {
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
function workersAiAccount(base: string): string | undefined {
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

async function describeHttp(res: Response): Promise<string> {
  return describeHttpText(res.status, await res.text());
}

function describeHttpText(status: number, body: string): string {
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

/** A stream cut short or an overloaded provider mid-answer: worth one more try, like a dropped connection. */
function transient(result: AIChatResult): AIChatResult {
  return !result.ok && /ended before it finished|overloaded/i.test(result.error ?? '') ? { ...result, retryable: true } : result;
}

/** A network failure in chat(), naming who could not be reached; the local-server hint only for local servers. */
function chatNetworkError(conn: { kind: string; baseUrl: string } | undefined): string {
  if (conn?.kind === 'anthropic') return 'The connection to Anthropic dropped (network error).';
  if (conn?.kind === 'chatgpt') return 'The connection to ChatGPT dropped (network error).';
  let host = '';
  try { host = new URL(conn?.baseUrl ?? '').hostname; } catch { /* no URL */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return `Could not reach the model server on this computer (${conn?.baseUrl}). Check that it is running; it may also need CORS opened for the extension, e.g. OLLAMA_ORIGINS.`;
  }
  return `The connection to ${host || 'the provider'} dropped (network error).`;
}

function errMessage(error: unknown): string {
  if (error instanceof TypeError)
    return 'Network error: the server could not be reached, or the extension has no host permission for it.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a message handler for composing with an existing onMessage listener.
 * Returns true if it handled the message (and will call sendResponse
 * asynchronously) — propagate that return so Chrome keeps the channel open.
 */
export function createAiMessageHandler(
  options: AiHandlerOptions = {},
): (message: { type?: string }, sendResponse: (r: unknown) => void) => boolean {
  opts = resolve(options);
  configureCryptoDb(opts.cryptoDbName);
  const p = opts.prefix;
  return (message, sendResponse) => {
    // A UI built against a newer protocol than this worker: refuse, and say how to fix it.
    const version = (message as { v?: unknown } | undefined)?.v;
    if (typeof message?.type === 'string' && message.type.startsWith(`${p}:ai-`) && typeof version === 'number' && version > PROTOCOL_VERSION) {
      sendResponse({ ok: false, error: `This page speaks a newer version of the AI messages (${version}) than the extension's background (${PROTOCOL_VERSION}). Reload the extension.` });
      return false;
    }
    switch (message?.type) {
      case `${p}:ai-get`:
        void getView().then(sendResponse);
        return true;
      case `${p}:ai-set-active`:
        void setActive(message as AISetActiveRequest).then(sendResponse);
        return true;
      case `${p}:ai-save-connection`:
        void saveConnection(message as AISaveConnectionRequest).then(sendResponse);
        return true;
      case `${p}:ai-delete-connection`:
        void deleteConnection(message as AIDeleteConnectionRequest).then(sendResponse);
        return true;
      case `${p}:ai-list-models`:
        void listModels(message as AIListModelsRequest).then(sendResponse);
        return true;
      case `${p}:ai-complete`:
        void complete(message as AICompleteRequest).then(sendResponse);
        return true;
      case `${p}:ai-chat`: {
        const { type: _type, ...request } = message as AIChatMessageRequest;
        void chat(request).then(sendResponse);
        return true;
      }
      case `${p}:ai-anthropic-login-start`:
        void anthropicLoginStart().then(sendResponse);
        return true;
      case `${p}:ai-anthropic-login-complete`:
        void anthropicLoginComplete(message as AIAnthropicLoginCompleteRequest).then(sendResponse);
        return true;
      case `${p}:ai-anthropic-paste-token`:
        void anthropicPasteToken(message as AIAnthropicPasteTokenRequest).then(sendResponse);
        return true;
      case `${p}:ai-chatgpt-login-start`:
        void chatgptLoginStart().then(sendResponse);
        return true;
      case `${p}:ai-chatgpt-login-poll`:
        void chatgptLoginPoll((message as { label?: string }).label ?? '').then(sendResponse);
        return true;
      case `${p}:ai-ollama-login-start`:
        void ollamaLoginStart((message as { deviceName?: string }).deviceName ?? '').then(sendResponse);
        return true;
      case `${p}:ai-ollama-login-poll`:
        void ollamaLoginPoll((message as { label?: string }).label ?? '').then(sendResponse);
        return true;
      case `${p}:ai-opencode-login-start`:
        void opencodeLoginStart().then(sendResponse);
        return true;
      case `${p}:ai-opencode-login-poll`:
        void opencodeLoginPoll((message as { label?: string }).label ?? '').then(sendResponse);
        return true;
      default:
        return false;
    }
  };
}

/** One-call wiring: adds its own chrome.runtime.onMessage listener. */
export function registerAiHandlers(options: AiHandlerOptions = {}): void {
  const handle = createAiMessageHandler(options);
  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) =>
    handle(message, sendResponse),
  );
}

export { CODEX_MODELS, CODEX_CLIENT_VERSION } from './openai-oauth.js';
export { OPENCODE_BASE } from './opencode-oauth.js';
