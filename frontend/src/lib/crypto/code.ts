/**
 * User code derivation (docs/PROTOCOL.md "Keys and code derivation").
 * code = first 60 bits of SHA-256(identity public key) in a 32-char alphabet without 0/1/I/O.
 */
import { toBuffer } from '../encoding';

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 12;

export async function deriveCode(identityPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(identityPublicKey)));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i]);
  n >>= 4n; // keep the top 60 bits
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const shift = BigInt(5 * (CODE_LENGTH - 1 - i));
    out += CODE_ALPHABET[Number((n >> shift) & 31n)];
  }
  return out;
}

/** Case-insensitive and tolerant of dashes/spaces. Returns null when not a syntactically valid code. */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}
