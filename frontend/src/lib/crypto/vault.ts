/**
 * Password vault (spec 6.2).
 *
 * A random 256-bit vault key is wrapped (AES-GCM) under a KEK derived from the password with
 * PBKDF2-SHA-256. No password hash exists anywhere: a password is "correct" only if the GCM tag
 * verifies on unwrap. The unwrapped raw key is immediately imported as non-extractable HKDF material,
 * from which the record-encryption key and the index HMAC key are derived; the raw bytes are zeroed.
 */
import { b64decode, b64encode, randomBytes, toBuffer, utf8 } from '../encoding';
import { aesDecrypt, aesEncrypt } from './aead';

export const PBKDF2_ITERATIONS = 600_000;

export interface VaultMeta {
  v: 1;
  salt: string;
  iterations: number;
  iv: string;
  wrapped: string;
}

export interface VaultKeys {
  /** AES-GCM key encrypting every local record. Non-extractable. */
  enc: CryptoKey;
  /** HMAC key used to derive opaque IndexedDB keys/index values. Non-extractable. */
  idx: CryptoKey;
}

const WRAP_AAD = utf8('lanchat-vault-v1');

export async function deriveKek(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', toBuffer(utf8(password.normalize('NFKC'))), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toBuffer(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function keysFromRaw(raw: Uint8Array): Promise<VaultKeys> {
  const base = await crypto.subtle.importKey('raw', toBuffer(raw), 'HKDF', false, ['deriveKey']);
  const hkdf = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32),
    info: toBuffer(utf8(info)),
  });
  const enc = await crypto.subtle.deriveKey(hkdf('lanchat-vault-enc'), base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const idx = await crypto.subtle.deriveKey(
    hkdf('lanchat-vault-idx'),
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return { enc, idx };
}

async function wrap(raw: Uint8Array, password: string, iterations: number): Promise<VaultMeta> {
  const salt = randomBytes(16);
  const kek = await deriveKek(password, salt, iterations);
  const { iv, ct } = await aesEncrypt(kek, raw, WRAP_AAD);
  return { v: 1, salt: b64encode(salt), iterations, iv: b64encode(iv), wrapped: b64encode(ct) };
}

/** Run KDF + unwrap. Returns raw key bytes or null. Same work is done for right and wrong passwords. */
async function unwrapRaw(meta: VaultMeta, password: string): Promise<Uint8Array | null> {
  const kek = await deriveKek(password, b64decode(meta.salt), meta.iterations);
  try {
    return await aesDecrypt(kek, b64decode(meta.iv), b64decode(meta.wrapped), WRAP_AAD);
  } catch {
    return null;
  }
}

export async function createVault(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<{ meta: VaultMeta; keys: VaultKeys }> {
  const raw = randomBytes(32);
  try {
    const meta = await wrap(raw, password, iterations);
    return { meta, keys: await keysFromRaw(raw) };
  } finally {
    raw.fill(0);
  }
}

export async function unlockVault(meta: VaultMeta, password: string): Promise<VaultKeys | null> {
  const raw = await unwrapRaw(meta, password);
  if (!raw) {
    // Equalize work with the success path (spec F2: indistinguishable timing).
    await keysFromRaw(randomBytes(32));
    return null;
  }
  try {
    return await keysFromRaw(raw);
  } finally {
    raw.fill(0);
  }
}

/** Change password: re-wrap the same vault key. Existing records are untouched. */
export async function rewrapVault(meta: VaultMeta, oldPassword: string, newPassword: string): Promise<VaultMeta | null> {
  const raw = await unwrapRaw(meta, oldPassword);
  if (!raw) return null;
  try {
    return await wrap(raw, newPassword, meta.iterations);
  } finally {
    raw.fill(0);
  }
}

/** Rough strength hint for onboarding; not a security control. */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length >= 16) score = Math.min(4, score + 1);
  const s = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  return { score: s, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][s] };
}
