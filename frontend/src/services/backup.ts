/**
 * Encrypted backup (spec F12). The whole vault is exported as one file encrypted under a separate
 * backup passphrase (PBKDF2 → AES-GCM). Importing requires the same origin, since the identity is
 * restored as-is and re-registered idempotently.
 */
import type { ChatMessage, Contact, LocalSettings } from '@/domain/types';
import { aesDecrypt, aesEncrypt } from '@/lib/crypto/aead';
import type { StoredIdentity } from '@/lib/crypto/identity';
import { createVault, deriveKek, PBKDF2_ITERATIONS } from '@/lib/crypto/vault';
import { b64decode, b64encode, fromUtf8, randomBytes, utf8 } from '@/lib/encoding';
import { setVaultMeta } from '@/lib/storage/db';
import { ensureSeeded } from '@/lib/storage/decoy';
import { SecureStore } from '@/lib/storage/secureStore';
import type { ChatController } from './controller';
import { registerIdentity } from './account';

const FORMAT = 'tasks-backup';
const AAD = utf8('lanchat-backup-v1');

interface BackupPayload {
  v: 1;
  identity: StoredIdentity;
  settings?: LocalSettings;
  contacts: Contact[];
  messages: ChatMessage[];
  media: Record<string, string>;
}

interface BackupFile {
  format: typeof FORMAT;
  v: 1;
  salt: string;
  iterations: number;
  iv: string;
  ct: string;
}

export async function exportBackup(ctrl: ChatController, passphrase: string, includeMedia: boolean): Promise<Blob> {
  const store = ctrl.store;
  const identity = await store.getKv<StoredIdentity>('identity');
  if (!identity) throw new Error('No identity');
  const contacts = await store.listContacts();
  const messages: ChatMessage[] = [];
  const media: Record<string, string> = {};
  for (const c of contacts) {
    for (const m of await store.listMessages(c.code)) {
      messages.push(m);
      if (includeMedia && m.media) {
        const data = await store.getMedia(m.media.blobId);
        if (data) media[m.media.blobId] = b64encode(data);
      }
    }
  }
  const payload: BackupPayload = {
    v: 1,
    identity,
    settings: await store.getKv<LocalSettings>('settings'),
    contacts,
    messages,
    media,
  };
  const salt = randomBytes(16);
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
  const { iv, ct } = await aesEncrypt(kek, utf8(JSON.stringify(payload)), AAD);
  const file: BackupFile = {
    format: FORMAT,
    v: 1,
    salt: b64encode(salt),
    iterations: PBKDF2_ITERATIONS,
    iv: b64encode(iv),
    ct: b64encode(ct),
  };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

/** Restore into a fresh install. Returns the restored code. Throws on wrong passphrase. */
export async function importBackup(file: File, passphrase: string, newPassword: string): Promise<string> {
  const parsed = JSON.parse(await file.text()) as BackupFile;
  if (parsed.format !== FORMAT || parsed.v !== 1) throw new Error('Not a backup file');
  const kek = await deriveKek(passphrase, b64decode(parsed.salt), parsed.iterations);
  let payload: BackupPayload;
  try {
    payload = JSON.parse(fromUtf8(await aesDecrypt(kek, b64decode(parsed.iv), b64decode(parsed.ct), AAD)));
  } catch {
    throw new Error('Wrong backup passphrase');
  }

  const code = await registerIdentity(payload.identity);
  const { meta, keys } = await createVault(newPassword);
  const store = new SecureStore(keys);
  await store.setKv('identity', payload.identity);
  if (payload.settings) await store.setKv('settings', payload.settings);
  for (const c of payload.contacts) await store.putContact(c);
  for (const m of payload.messages) await store.putMessage(m);
  for (const [blobId, data] of Object.entries(payload.media)) await store.putMedia(blobId, b64decode(data));
  await setVaultMeta(meta); // commit point: the device is now "onboarded"
  await ensureSeeded();
  return code;
}
