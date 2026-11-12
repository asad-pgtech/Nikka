/**
 * IndexedDB schema. The database is named after the disguise ("tasks").
 *
 * - todos:    decoy task list, deliberately plaintext (spec F2)
 * - meta:     non-secret metadata (wrapped vault key, decoy seeded flag)
 * - kv:       encrypted singletons (identity, settings, push refs, outbox) under opaque keys
 * - contacts: encrypted contacts, keyed by HMAC(code)
 * - messages: encrypted messages, keyed by HMAC(peer|msgId), indexed by HMAC(peer)
 * - media:    encrypted cached media, keyed by HMAC(blobId)
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { VaultMeta } from '../crypto/vault';

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

export interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

export interface TasksDB extends DBSchema {
  todos: { key: string; value: Todo };
  meta: { key: string; value: VaultMeta | boolean | number };
  kv: { key: string; value: Sealed };
  contacts: { key: string; value: Sealed & { id: string } };
  messages: { key: string; value: Sealed & { id: string; c: string }; indexes: { c: string } };
  media: { key: string; value: Sealed & { id: string } };
}

export const DB_NAME = 'tasks';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<TasksDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<TasksDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TasksDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('todos', { keyPath: 'id' });
        db.createObjectStore('meta');
        db.createObjectStore('kv');
        db.createObjectStore('contacts', { keyPath: 'id' });
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('c', 'c');
        db.createObjectStore('media', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

export async function deleteDatabase(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

export async function getVaultMeta(): Promise<VaultMeta | null> {
  const v = await (await getDb()).get('meta', 'vault');
  return v && typeof v === 'object' ? (v as VaultMeta) : null;
}

export async function setVaultMeta(meta: VaultMeta): Promise<void> {
  await (await getDb()).put('meta', meta, 'vault');
}
