/** Chunked media encryption (spec 6.5, docs/PROTOCOL.md "Media encryption"). */
import { concatBytes, randomBytes, utf8 } from '../encoding';
import { aesDecrypt, aesEncrypt, importAesKey } from './aead';

export interface FileKey {
  raw: Uint8Array;
  key: CryptoKey;
  baseIv: Uint8Array;
}

export async function newFileKey(): Promise<FileKey> {
  const raw = randomBytes(32);
  return { raw, key: await importAesKey(raw), baseIv: randomBytes(8) };
}

export async function importFileKey(raw: Uint8Array, baseIv: Uint8Array): Promise<FileKey> {
  return { raw, key: await importAesKey(raw), baseIv };
}

function chunkIv(baseIv: Uint8Array, index: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index, false);
  return concatBytes(baseIv, idx);
}

const chunkAad = (blobId: string, index: number, count: number) =>
  utf8(`lanchat-media-v1|${blobId}|${index}|${count}`);

export const chunkCount = (size: number, chunkBytes: number) => Math.max(1, Math.ceil(size / chunkBytes));

export async function encryptChunk(
  fk: FileKey,
  blobId: string,
  index: number,
  count: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const { ct } = await aesEncrypt(fk.key, plaintext, chunkAad(blobId, index, count), chunkIv(fk.baseIv, index));
  return ct;
}

export async function decryptChunk(
  fk: FileKey,
  blobId: string,
  index: number,
  count: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return aesDecrypt(fk.key, chunkIv(fk.baseIv, index), ciphertext, chunkAad(blobId, index, count));
}
