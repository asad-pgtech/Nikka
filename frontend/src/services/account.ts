/** Account creation, registration and device wipe (spec F1, F11). */
import { Api } from '@/lib/api/endpoints';
import {
  generateIdentityKeys,
  identityFromKeys,
  identityFromStored,
  publicKeysOf,
  serializeIdentity,
  wipeIdentity,
  type StoredIdentity,
} from '@/lib/crypto/identity';
import { createVault } from '@/lib/crypto/vault';
import { deleteDatabase, setVaultMeta } from '@/lib/storage/db';
import { ensureSeeded } from '@/lib/storage/decoy';
import { SecureStore } from '@/lib/storage/secureStore';
import { requestPersistentStorage } from '@/lib/platform';
import { DEFAULT_SETTINGS } from '@/state/chat';
import { getServerConfig } from './config';

/** Register (idempotently) the identity with the server. Returns the code. */
export async function registerIdentity(stored: StoredIdentity, username?: string, discoverable = true): Promise<string> {
  const id = await identityFromStored(stored);
  try {
    const pub = publicKeysOf(id);
    await Api.register({
      code: id.code,
      display_name: stored.displayName,
      username,
      identity_key: pub.identityKey,
      agreement_key: pub.agreementKey,
      agreement_key_sig: pub.agreementKeySig,
      discoverable,
    });
    return id.code;
  } finally {
    wipeIdentity(id);
  }
}

export async function createAccount(displayName: string, username: string, password: string): Promise<string> {
  const keys = generateIdentityKeys();
  const id = await identityFromKeys(keys);
  const stored = serializeIdentity(id, displayName.trim());
  wipeIdentity(id);
  const code = await registerIdentity(stored, username);

  const config = await getServerConfig();
  const { meta, keys: vaultKeys } = await createVault(password);
  const store = new SecureStore(vaultKeys);
  await store.setKv('identity', stored);
  await store.setKv('settings', { ...DEFAULT_SETTINGS, autoLockSeconds: config.autolock_default_seconds });
  await setVaultMeta(meta); // commit point
  await ensureSeeded();
  await requestPersistentStorage();
  return code;
}

/** Wipe everything on this device (and best-effort remove the server account). */
export async function wipeDevice(removeServerAccount: () => Promise<void>): Promise<void> {
  await removeServerAccount().catch(() => undefined);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* ignore */
  }
  await deleteDatabase();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}
