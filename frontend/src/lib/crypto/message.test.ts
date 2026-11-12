import { describe, expect, it } from 'vitest';
import { generateIdentityKeys, identityFromKeys, publicKeysOf, verifyPeerKeys } from './identity';
import { decryptMessage, deriveFriendKey, encryptMessage, safetyNumber } from './message';
import { chunkCount, decryptChunk, encryptChunk, newFileKey } from './media';

async function pair() {
  const a = await identityFromKeys(generateIdentityKeys());
  const b = await identityFromKeys(generateIdentityKeys());
  const ka = await deriveFriendKey(a.dhPriv, b.dhPub, a.code, b.code);
  const kb = await deriveFriendKey(b.dhPriv, a.dhPub, b.code, a.code);
  return { a, b, ka, kb };
}

describe('message encryption', () => {
  it('round-trips between two friends', async () => {
    const { a, b, ka, kb } = await pair();
    const payload = await encryptMessage(ka, 'm1', a.code, b.code, { t: 'text', ts: 1, body: 'hello' });
    expect(await decryptMessage(kb, 'm1', a.code, b.code, payload)).toEqual({ t: 'text', ts: 1, body: 'hello' });
  });

  it('rejects tampering with id or direction (AEAD binding)', async () => {
    const { a, b, ka, kb } = await pair();
    const payload = await encryptMessage(ka, 'm1', a.code, b.code, { t: 'text', ts: 1, body: 'hi' });
    await expect(decryptMessage(kb, 'm2', a.code, b.code, payload)).rejects.toThrow();
    await expect(decryptMessage(kb, 'm1', b.code, a.code, payload)).rejects.toThrow();
  });

  it('a third party cannot decrypt', async () => {
    const { a, b, ka } = await pair();
    const c = await identityFromKeys(generateIdentityKeys());
    const kc = await deriveFriendKey(c.dhPriv, a.dhPub, c.code, a.code);
    const payload = await encryptMessage(ka, 'm1', a.code, b.code, { t: 'text', ts: 1, body: 'secret' });
    await expect(decryptMessage(kc, 'm1', a.code, b.code, payload)).rejects.toThrow();
  });

  it('uses a unique nonce per message', async () => {
    const { a, b, ka } = await pair();
    const body = { t: 'text' as const, ts: 1, body: 'same' };
    const p1 = await encryptMessage(ka, 'm1', a.code, b.code, body);
    const p2 = await encryptMessage(ka, 'm1', a.code, b.code, body);
    expect(p1.slice(0, 16)).not.toBe(p2.slice(0, 16));
  });

  it('published keys verify against the code; forged ones do not', async () => {
    const { a, b } = await pair();
    const pub = publicKeysOf(a);
    expect(await verifyPeerKeys(a.code, pub)).toBe(true);
    expect(await verifyPeerKeys(b.code, pub)).toBe(false);
    expect(await verifyPeerKeys(a.code, { ...pub, agreementKey: publicKeysOf(b).agreementKey })).toBe(false);
  });

  it('safety number is symmetric', async () => {
    const { a, b } = await pair();
    const ia = publicKeysOf(a).identityKey;
    const ib = publicKeysOf(b).identityKey;
    expect(await safetyNumber(ia, ib)).toBe(await safetyNumber(ib, ia));
  });
});

describe('media chunks', () => {
  it('round-trips and rejects reordering', async () => {
    const fk = await newFileKey();
    const data = new Uint8Array(2500).map((_, i) => i % 251);
    const size = 1000;
    const n = chunkCount(data.length, size);
    const cts = [];
    for (let i = 0; i < n; i++) cts.push(await encryptChunk(fk, 'blob', i, n, data.subarray(i * size, (i + 1) * size)));
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(...(await decryptChunk(fk, 'blob', i, n, cts[i])));
    expect(out).toEqual(Array.from(data));
    await expect(decryptChunk(fk, 'blob', 0, n, cts[1])).rejects.toThrow();
    await expect(decryptChunk(fk, 'other', 0, n, cts[0])).rejects.toThrow();
  });
});
