/** AES-GCM helpers on top of WebCrypto. */
import { concatBytes, randomBytes, toBuffer } from '../encoding';

export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export async function aesEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
  iv: Uint8Array = randomBytes(IV_BYTES),
): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv), ...(aad ? { additionalData: toBuffer(aad) } : {}) },
    key,
    toBuffer(plaintext),
  );
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws on authentication failure. */
export async function aesDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ct: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv), ...(aad ? { additionalData: toBuffer(aad) } : {}) },
    key,
    toBuffer(ct),
  );
  return new Uint8Array(pt);
}

/** iv || ciphertext packing used for wire payloads. */
export async function seal(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const { iv, ct } = await aesEncrypt(key, plaintext, aad);
  return concatBytes(iv, ct);
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('sealed data too short');
  return aesDecrypt(key, sealed.subarray(0, IV_BYTES), sealed.subarray(IV_BYTES), aad);
}

export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toBuffer(raw), { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}
