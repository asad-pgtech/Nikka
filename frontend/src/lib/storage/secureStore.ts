/**
 * Encrypted local history (spec F10). Every record is AES-GCM encrypted under the vault key with
 * AAD = store|id, so records cannot be swapped between slots. Keys/index values are HMACs, so the
 * database does not reveal codes or conversation structure in the clear.
 */
import type { Contact, ChatMessage } from '@/domain/types';
import { aesDecrypt, aesEncrypt } from '../crypto/aead';
import type { VaultKeys } from '../crypto/vault';
import { b64encode, fromUtf8, toBuffer, utf8 } from '../encoding';
import { getDb, type Sealed } from './db';

type StoreName = 'kv' | 'contacts' | 'messages' | 'media';

export class SecureStore {
  constructor(private readonly keys: VaultKeys) {}

  /** Opaque, deterministic identifier for a logical key. */
  async tag(label: string): Promise<string> {
    const mac = await crypto.subtle.sign('HMAC', this.keys.idx, toBuffer(utf8(label)));
    return b64encode(new Uint8Array(mac).subarray(0, 20));
  }

  private async sealBytes(store: StoreName, id: string, data: Uint8Array): Promise<Sealed> {
    return aesEncrypt(this.keys.enc, data, utf8(`${store}|${id}`));
  }

  private async openBytes(store: StoreName, id: string, rec: Sealed): Promise<Uint8Array> {
    return aesDecrypt(this.keys.enc, rec.iv, rec.ct, utf8(`${store}|${id}`));
  }

  private sealJson = (store: StoreName, id: string, value: unknown) =>
    this.sealBytes(store, id, utf8(JSON.stringify(value)));

  private async openJson<T>(store: StoreName, id: string, rec: Sealed): Promise<T> {
    return JSON.parse(fromUtf8(await this.openBytes(store, id, rec))) as T;
  }

  // ---- kv -----------------------------------------------------------------------------------------

  async getKv<T>(name: string): Promise<T | undefined> {
    const id = await this.tag(`kv:${name}`);
    const rec = await (await getDb()).get('kv', id);
    return rec ? this.openJson<T>('kv', id, rec) : undefined;
  }

  async setKv(name: string, value: unknown): Promise<void> {
    const id = await this.tag(`kv:${name}`);
    await (await getDb()).put('kv', await this.sealJson('kv', id, value), id);
  }

  // ---- contacts -------------------------------------------------------------------------------------

  async putContact(contact: Contact): Promise<void> {
    const id = await this.tag(`contact:${contact.code}`);
    await (await getDb()).put('contacts', { id, ...(await this.sealJson('contacts', id, contact)) });
  }

  async deleteContact(code: string): Promise<void> {
    await (await getDb()).delete('contacts', await this.tag(`contact:${code}`));
  }

  async listContacts(): Promise<Contact[]> {
    const recs = await (await getDb()).getAll('contacts');
    const out: Contact[] = [];
    for (const r of recs) {
      try {
        out.push(await this.openJson<Contact>('contacts', r.id, r));
      } catch {
        /* undecryptable record: skip */
      }
    }
    return out;
  }

  // ---- messages -----------------------------------------------------------------------------------

  private messageId = (peer: string, msgId: string) => this.tag(`msg:${peer}:${msgId}`);

  async putMessage(msg: ChatMessage): Promise<void> {
    const id = await this.messageId(msg.peer, msg.id);
    const c = await this.tag(`conv:${msg.peer}`);
    await (await getDb()).put('messages', { id, c, ...(await this.sealJson('messages', id, msg)) });
  }

  async getMessage(peer: string, msgId: string): Promise<ChatMessage | undefined> {
    const id = await this.messageId(peer, msgId);
    const rec = await (await getDb()).get('messages', id);
    return rec ? this.openJson<ChatMessage>('messages', id, rec) : undefined;
  }

  async deleteMessage(peer: string, msgId: string): Promise<void> {
    await (await getDb()).delete('messages', await this.messageId(peer, msgId));
  }

  async listMessages(peer: string): Promise<ChatMessage[]> {
    const c = await this.tag(`conv:${peer}`);
    const recs = await (await getDb()).getAllFromIndex('messages', 'c', c);
    const out: ChatMessage[] = [];
    for (const r of recs) {
      try {
        out.push(await this.openJson<ChatMessage>('messages', r.id, r));
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  async deleteConversation(peer: string): Promise<void> {
    const db = await getDb();
    const c = await this.tag(`conv:${peer}`);
    const keys = await db.getAllKeysFromIndex('messages', 'c', c);
    const tx = db.transaction('messages', 'readwrite');
    await Promise.all(keys.map((k) => tx.store.delete(k)));
    await tx.done;
  }

  // ---- media cache ----------------------------------------------------------------------------------

  async putMedia(blobId: string, data: Uint8Array): Promise<void> {
    const id = await this.tag(`media:${blobId}`);
    await (await getDb()).put('media', { id, ...(await this.sealBytes('media', id, data)) });
  }

  async getMedia(blobId: string): Promise<Uint8Array | undefined> {
    const id = await this.tag(`media:${blobId}`);
    const rec = await (await getDb()).get('media', id);
    return rec ? this.openBytes('media', id, rec) : undefined;
  }

  async hasMedia(blobId: string): Promise<boolean> {
    const id = await this.tag(`media:${blobId}`);
    return (await (await getDb()).getKey('media', id)) !== undefined;
  }

  async deleteMedia(blobId: string): Promise<void> {
    await (await getDb()).delete('media', await this.tag(`media:${blobId}`));
  }
}
