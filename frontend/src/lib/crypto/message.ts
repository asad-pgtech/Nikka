/**
 * Per-friendship key and message envelopes (spec 6.4, docs/PROTOCOL.md "Message encryption").
 *
 * Authenticity: AEAD binding. The friendship key is known only to the two friends, and the AAD binds
 * message id + direction, so a valid ciphertext with from=peer,to=me can only come from the peer.
 */
import { b64decode, b64encode, fromUtf8, toBuffer, utf8 } from '../encoding';
import { open, seal } from './aead';
import { x25519Shared } from './identity';

export async function deriveFriendKey(
  myDhPriv: Uint8Array,
  peerDhPub: Uint8Array,
  myCode: string,
  peerCode: string,
): Promise<CryptoKey> {
  const shared = x25519Shared(myDhPriv, peerDhPub);
  try {
    const base = await crypto.subtle.importKey('raw', toBuffer(shared), 'HKDF', false, ['deriveKey']);
    const [a, b] = [myCode, peerCode].sort();
    return await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toBuffer(utf8(`${a}|${b}`)), info: toBuffer(utf8('lanchat-friend-v1')) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    shared.fill(0);
  }
}

const msgAad = (id: string, from: string, to: string) => utf8(`lanchat-msg-v1|${id}|${from}|${to}`);

export interface MediaDescriptor {
  blobId: string;
  key: string;
  baseIv: string;
  mime: string;
  name?: string;
  kind: 'image' | 'video' | 'audio' | 'gif' | 'file';
  size: number;
  chunkBytes: number;
  chunks: number;
  thumb?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export type MessageBody =
  | { t: 'text'; ts: number; body: string; reply_to?: string }
  | { t: 'media'; ts: number; media: MediaDescriptor; caption?: string; reply_to?: string }
  | { t: 'delete'; ts: number; target: string }
  /** Profile picture update; never shown in the chat. `avatar` is a data: URL or null (removed). */
  | { t: 'profile'; ts: number; avatar: string | null }
  /** Nickname for `target` (sender or recipient) in this chat, shown on both phones; null clears it. */
  | { t: 'nickname'; ts: number; target: string; name: string | null }
  /** Sender's emoji reaction to message `target` (either direction); null removes it. */
  | { t: 'react'; ts: number; target: string; emoji: string | null };

export async function encryptMessage(
  key: CryptoKey,
  id: string,
  from: string,
  to: string,
  body: MessageBody,
): Promise<string> {
  return b64encode(await seal(key, utf8(JSON.stringify(body)), msgAad(id, from, to)));
}

export async function decryptMessage(
  key: CryptoKey,
  id: string,
  from: string,
  to: string,
  payload: string,
): Promise<MessageBody> {
  const pt = await open(key, b64decode(payload), msgAad(id, from, to));
  const body = JSON.parse(fromUtf8(pt)) as MessageBody;
  if (!body || typeof body !== 'object' || typeof body.ts !== 'number') throw new Error('malformed message');
  if (!['text', 'media', 'delete', 'profile', 'nickname', 'react'].includes(body.t)) throw new Error('unknown message type');
  return body;
}

/** Safety number: short fingerprint of both identity keys (order independent). */
export async function safetyNumber(identityKeyA: string, identityKeyB: string): Promise<string> {
  const [a, b] = [identityKeyA, identityKeyB].sort();
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toBuffer(utf8(`lanchat-safety-v1|${a}|${b}`))),
  );
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const n = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % 100000;
    groups.push(n.toString().padStart(5, '0'));
  }
  return groups.join(' ');
}
