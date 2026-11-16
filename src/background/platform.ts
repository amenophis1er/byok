import {
  createSigningKey,
  decryptBlob,
  deleteSigningKey,
  encryptString,
  getSigningKey,
  type EncBlob,
} from './crypto.js';

/**
 * What the handlers need from where they run, apart from `fetch`: somewhere to
 * keep the connections, somewhere to keep a sign-in in progress, a way to show
 * a consent page, and the secrets (encryption at rest, device signing keys).
 *
 * In a Chrome extension's worker it is Chrome's (the default: nothing to do).
 * A host that is not an extension (a Node daemon, a desktop app) gives its own
 * with `useAiPlatform`, before the first message: the same handlers, the same
 * messages and results, with the connections kept where that host keeps
 * things.
 */
export interface AiPlatform {
  /** Kept for good (the connections, the debug flag): one value per key. */
  local: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** Kept while the host runs (a sign-in waiting for its approval): one value per key. */
  session: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  /** Show a consent page (called only when `openConsentTab` is on). A host with no browser of its own leaves it to the UI, which gets the same address in the result. */
  openTab(url: string): Promise<void>;
  /**
   * Secrets at rest. `encryptString('')` is `{ iv: '', ct: '' }` and
   * `decryptBlob` of an empty or missing blob is `''`. A signing key is an
   * Ed25519 pair kept under an id (an Ollama device key).
   */
  secrets: {
    encryptString(plain: string): Promise<EncBlob>;
    decryptBlob(blob: EncBlob | null | undefined): Promise<string>;
    createSigningKey(id: string): Promise<CryptoKeyPair>;
    getSigningKey(id: string): Promise<CryptoKeyPair | undefined>;
    deleteSigningKey(id: string): Promise<void>;
  };
}

/** Chrome's: chrome.storage.local and .session, a new tab, and crypto.ts (a non-extractable key in the worker's IndexedDB). */
export const chromePlatform: AiPlatform = {
  local: {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
  },
  session: {
    get: async (key) => (await chrome.storage.session.get(key))[key],
    set: (key, value) => chrome.storage.session.set({ [key]: value }),
    remove: (key) => chrome.storage.session.remove(key),
  },
  openTab: async (url) => { await chrome.tabs.create({ url }); },
  secrets: { encryptString, decryptBlob, createSigningKey, getSigningKey, deleteSigningKey },
};

export type { EncBlob };
