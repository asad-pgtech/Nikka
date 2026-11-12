/** Byte/string encoding helpers. All wire binary is base64url without padding. */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const utf8 = (s: string): Uint8Array => textEncoder.encode(s);
export const fromUtf8 = (b: BufferSource): string => textDecoder.decode(b);

export function b64encode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < arr.length; i += step) {
    bin += String.fromCharCode(...arr.subarray(i, i + step));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64decode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export const randomId = (bytes = 16): string => b64encode(randomBytes(bytes));

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects some shared/offset views in older Safari). */
export function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}
