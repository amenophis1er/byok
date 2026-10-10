/**
 * At-rest encryption and device signing keys against an in-memory IndexedDB:
 * round trips, the key surviving a worker restart, non-extractability, and
 * tampered or foreign ciphertext being refused.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CryptoModule = typeof import('../src/background/crypto.js');

/** A fresh module (no cached key), as after the service worker is killed. */
async function load(): Promise<CryptoModule> {
  vi.resetModules();
  return import('../src/background/crypto.js');
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('encryptString / decryptBlob', () => {
  it('round-trips, including non-ASCII text', async () => {
    const { encryptString, decryptBlob } = await load();
    for (const plain of ['sk-ant-api03-abc', 'clé · 鍵 · 🔑']) {
      expect(await decryptBlob(await encryptString(plain))).toBe(plain);
    }
  });

  it('maps empty input to an empty blob and back', async () => {
    const { encryptString, decryptBlob } = await load();
    expect(await encryptString('')).toEqual({ iv: '', ct: '' });
    expect(await decryptBlob({ iv: '', ct: '' })).toBe('');
    expect(await decryptBlob(null)).toBe('');
    expect(await decryptBlob(undefined)).toBe('');
  });

  it('uses a fresh 12-byte IV each time and never stores the plaintext', async () => {
    const { encryptString } = await load();
    const a = await encryptString('same secret');
    const b = await encryptString('same secret');
    expect(atob(a.iv)).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(atob(a.ct)).not.toContain('same secret');
  });

  it('decrypts after a restart: the key persists in IndexedDB', async () => {
    const blob = await (await load()).encryptString('survives restarts');
    expect(await (await load()).decryptBlob(blob)).toBe('survives restarts');
  });

  it('stores the key non-extractable', async () => {
    const { encryptString } = await load();
    await encryptString('x');
    const key = await new Promise<CryptoKey>((resolve, reject) => {
      const open = indexedDB.open('ai-connect-crypto', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction('keys', 'readonly').objectStore('keys').get('aes-key');
        get.onsuccess = () => resolve(get.result as CryptoKey);
        get.onerror = () => reject(get.error);
      };
    });
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('refuses tampered ciphertext', async () => {
    const { encryptString, decryptBlob } = await load();
    const blob = await encryptString('integrity');
    const bytes = Uint8Array.from(atob(blob.ct), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    await expect(decryptBlob({ iv: blob.iv, ct: btoa(String.fromCharCode(...bytes)) })).rejects.toThrow();
  });

  it('keeps each configured database separate', async () => {
    const mod = await load();
    mod.configureCryptoDb('host-a');
    const blob = await mod.encryptString('from host-a');
    mod.configureCryptoDb('host-b');
    await expect(mod.decryptBlob(blob)).rejects.toThrow();
    mod.configureCryptoDb('host-a');
    expect(await mod.decryptBlob(blob)).toBe('from host-a');
  });
});

describe('device signing keys', () => {
  it('creates a pair whose private half cannot be exported, and signs with it', async () => {
    const { createSigningKey } = await load();
    const pair = await createSigningKey('device-1');
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
    const data = new TextEncoder().encode('GET,/api/me');
    const sig = await crypto.subtle.sign('Ed25519', pair.privateKey, data);
    expect(await crypto.subtle.verify('Ed25519', pair.publicKey, sig, data)).toBe(true);
  });

  it('gets the stored pair after a restart and deletes it', async () => {
    const created = await (await load()).createSigningKey('device-1');
    const data = new TextEncoder().encode('payload');
    const sig = await crypto.subtle.sign('Ed25519', created.privateKey, data);

    const mod = await load();
    const stored = await mod.getSigningKey('device-1');
    expect(stored).toBeDefined();
    expect(await crypto.subtle.verify('Ed25519', stored!.publicKey, sig, data)).toBe(true);
    expect(await mod.getSigningKey('device-2')).toBeUndefined();

    await mod.deleteSigningKey('device-1');
    expect(await mod.getSigningKey('device-1')).toBeUndefined();
  });

  it('does not collide with the encryption key', async () => {
    const mod = await load();
    const blob = await mod.encryptString('still decrypts');
    await mod.createSigningKey('aes-key');
    expect(await (await load()).decryptBlob(blob)).toBe('still decrypts');
  });
});
