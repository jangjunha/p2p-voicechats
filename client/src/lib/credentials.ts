/**
 * Credential storage. Secrets (identity private keys + auth tokens) live in
 * the OS keychain via the Rust `keychain_*` commands; in a plain browser dev
 * build (vite, no Tauri) they fall back to localStorage. Non-secret values
 * (server URL, user id, display name) are always kept in localStorage as the
 * account index (the "vault") so the UI can list servers without unlocking the
 * keychain.
 */
import { invoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const LS_VAULT = 'vc.vault';
const LS_SECRET_PREFIX = 'vc.secret.'; // browser-dev fallback only

async function backendGet(key: string): Promise<string | null> {
  if (isTauri) return (await invoke<string | null>('keychain_get', { key })) ?? null;
  return localStorage.getItem(LS_SECRET_PREFIX + key);
}

async function backendSet(key: string, value: string): Promise<void> {
  if (isTauri) await invoke('keychain_set', { key, value });
  else localStorage.setItem(LS_SECRET_PREFIX + key, value);
}

async function backendDelete(key: string): Promise<void> {
  if (isTauri) await invoke('keychain_delete', { key });
  else localStorage.removeItem(LS_SECRET_PREFIX + key);
}

/** Non-secret account record, listed in the vault index in localStorage. */
export interface AccountIndex {
  id: string; // stable, client-generated
  serverUrl: string;
  userId: string;
  name: string;
}

/** Secret half of an account, stored in the OS keychain. */
export interface AccountSecret {
  identity: string; // serializeIdentity() JSON
  token: string | null;
}

function secretKey(id: string): string {
  return `account.${id}`;
}

export const credentials = {
  loadVault(): AccountIndex[] {
    try {
      const raw = localStorage.getItem(LS_VAULT);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  },

  saveVault(accounts: AccountIndex[]): void {
    localStorage.setItem(LS_VAULT, JSON.stringify(accounts));
  },

  async getSecret(id: string): Promise<AccountSecret | null> {
    const raw = await backendGet(secretKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AccountSecret;
    } catch {
      return null;
    }
  },

  async setSecret(id: string, secret: AccountSecret): Promise<void> {
    await backendSet(secretKey(id), JSON.stringify(secret));
  },

  async deleteSecret(id: string): Promise<void> {
    await backendDelete(secretKey(id));
  },
};

/**
 * Migrate the single-account POC layout (vc.identity / vc.userId / vc.token /
 * vc.serverUrl in localStorage) into the multi-account vault. Idempotent: it
 * runs only while the vault is empty and the legacy keys are present.
 */
export async function migrateLegacyAccount(): Promise<void> {
  if (credentials.loadVault().length > 0) return;
  const identity = localStorage.getItem('vc.identity');
  const userId = localStorage.getItem('vc.userId');
  if (!identity || !userId) return;
  const serverUrl = (localStorage.getItem('vc.serverUrl') ?? 'http://localhost:8787').replace(/\/+$/, '');
  const token = localStorage.getItem('vc.token');
  const id = crypto.randomUUID();
  await credentials.setSecret(id, { identity, token });
  credentials.saveVault([{ id, serverUrl, userId, name: userId.slice(0, 8) }]);
  for (const k of ['vc.identity', 'vc.userId', 'vc.token']) localStorage.removeItem(k);
}
