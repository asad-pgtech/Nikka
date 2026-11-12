/**
 * Cross-implementation test: the frontend's real crypto + protocol code against a running backend.
 * Skipped unless E2E_API_URL is set, e.g.:
 *   E2E_API_URL=http://127.0.0.1:8000 npx vitest run src/test/interop.e2e.test.ts
 *
 * Covers register → challenge auth → request → accept → message → offline queue → reconnect →
 * sync → ack → delivered/read receipts → encrypted media round trip.
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  authStatement,
  friendStatement,
  generateIdentityKeys,
  identityFromKeys,
  publicKeysOf,
  sign,
  verifyPeerKeys,
  type Identity,
} from '@/lib/crypto/identity';
import { decryptMessage, deriveFriendKey, encryptMessage } from '@/lib/crypto/message';
import { chunkCount, decryptChunk, encryptChunk, newFileKey } from '@/lib/crypto/media';
import { b64encode, bytesEqual, concatBytes, randomId } from '@/lib/encoding';

const BASE = process.env.E2E_API_URL;

async function http<T>(path: string, init: { method?: string; body?: unknown; token?: string; raw?: Uint8Array } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.raw) headers['Content-Type'] = 'application/octet-stream';
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())) as T;
}

async function newUser(name: string) {
  const id = await identityFromKeys(generateIdentityKeys());
  const pub = publicKeysOf(id);
  await http('/register', {
    method: 'POST',
    body: {
      code: id.code,
      display_name: name,
      identity_key: pub.identityKey,
      agreement_key: pub.agreementKey,
      agreement_key_sig: pub.agreementKeySig,
      discoverable: true,
    },
  });
  const { nonce } = await http<{ nonce: string }>('/auth/challenge', { method: 'POST', body: { code: id.code } });
  const { token } = await http<{ token: string }>('/auth/session', {
    method: 'POST',
    body: { code: id.code, nonce, signature: b64encode(sign(authStatement(nonce), id.signPriv)) },
  });
  return { id, pub, token };
}

/** Minimal WS client mirroring lib/api/socket.ts. */
class Client {
  ws!: WebSocket;
  events: any[] = [];
  private waiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = [];

  static async connect(id: Identity): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`${BASE!.replace(/^http/, 'ws')}/api/ws`);
    c.ws.on('message', (data) => {
      const ev = JSON.parse(String(data));
      if (ev.type === 'challenge') {
        c.ws.send(JSON.stringify({ type: 'auth', code: id.code, signature: b64encode(sign(authStatement(ev.nonce), id.signPriv)) }));
      }
      c.events.push(ev);
      c.waiters = c.waiters.filter((w) => (w.pred(ev) ? (w.resolve(ev), false) : true));
    });
    await c.wait((e) => e.type === 'ready');
    return c;
  }

  wait(pred: (e: any) => boolean, ms = 5000): Promise<any> {
    const hit = this.events.find(pred);
    if (hit) {
      this.events = this.events.filter((e) => e !== hit);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for event')), ms);
      this.waiters.push({ pred, resolve: (e) => (clearTimeout(t), (this.events = this.events.filter((x) => x !== e)), resolve(e)) });
    });
  }

  send(ev: unknown) {
    this.ws.send(JSON.stringify(ev));
  }

  close() {
    this.ws.close();
  }
}

describe.skipIf(!BASE)('frontend ⇄ backend interop', () => {
  it('full flow', async () => {
    const alice = await newUser('Alice');
    const bob = await newUser('Bob');

    // Lookup returns verifiable keys.
    const found = await http<any>(`/users/${bob.id.code}`, { token: alice.token });
    expect(
      await verifyPeerKeys(found.code, {
        identityKey: found.identity_key,
        agreementKey: found.agreement_key,
        agreementKeySig: found.agreement_key_sig,
      }),
    ).toBe(true);

    // Friend request + accept with signed statements.
    const bobWs = await Client.connect(bob.id);
    const ts = Date.now();
    await http('/friends/request', {
      method: 'POST',
      token: alice.token,
      body: {
        to: bob.id.code,
        ts,
        signature: b64encode(sign(friendStatement('freq', alice.id.code, bob.id.code, alice.pub.identityKey, alice.pub.agreementKey, ts), alice.id.signPriv)),
      },
    });
    await bobWs.wait((e) => e.type === 'friends_changed');
    const bobFriends = await http<any>('/friends', { token: bob.token });
    expect(bobFriends.friends[0]).toMatchObject({ code: alice.id.code, status: 'pending', direction: 'incoming' });
    const ts2 = Date.now();
    await http(`/friends/${alice.id.code}/accept`, {
      method: 'POST',
      token: bob.token,
      body: {
        ts: ts2,
        signature: b64encode(sign(friendStatement('facc', bob.id.code, alice.id.code, bob.pub.identityKey, bob.pub.agreementKey, ts2), bob.id.signPriv)),
      },
    });

    const kA = await deriveFriendKey(alice.id.dhPriv, bob.id.dhPub, alice.id.code, bob.id.code);
    const kB = await deriveFriendKey(bob.id.dhPriv, alice.id.dhPub, bob.id.code, alice.id.code);

    // Online delivery.
    const aliceWs = await Client.connect(alice.id);
    const id1 = randomId();
    aliceWs.send({ type: 'send', id: id1, to: bob.id.code, payload: await encryptMessage(kA, id1, alice.id.code, bob.id.code, { t: 'text', ts: 1, body: 'hi bob' }) });
    expect((await aliceWs.wait((e) => e.type === 'sent')).id).toBe(id1);
    const live = await bobWs.wait((e) => e.type === 'item');
    expect(await decryptMessage(kB, live.item.msg_id, live.item.from, bob.id.code, live.item.payload)).toMatchObject({ body: 'hi bob' });
    bobWs.send({ type: 'ack', qids: [live.item.qid] });
    expect((await aliceWs.wait((e) => e.type === 'item' && e.item.kind === 'delivered')).item.msg_id).toBe(id1);

    // Offline queue → reconnect → sync.
    bobWs.close();
    await new Promise((r) => setTimeout(r, 300));
    const id2 = randomId();
    aliceWs.send({ type: 'send', id: id2, to: bob.id.code, payload: await encryptMessage(kA, id2, alice.id.code, bob.id.code, { t: 'text', ts: 2, body: 'while offline' }) });
    await aliceWs.wait((e) => e.type === 'sent' && e.id === id2);
    const bob2 = await Client.connect(bob.id);
    bob2.send({ type: 'sync' });
    const sync = await bob2.wait((e) => e.type === 'sync');
    const queued = sync.items.find((i: any) => i.msg_id === id2);
    expect(queued.ref).toBeTruthy();
    expect(await decryptMessage(kB, id2, alice.id.code, bob.id.code, queued.payload)).toMatchObject({ body: 'while offline' });
    bob2.send({ type: 'ack', qids: [queued.qid] });
    bob2.send({ type: 'read', to: alice.id.code, ids: [id1, id2] });
    expect((await aliceWs.wait((e) => e.type === 'item' && e.item.kind === 'read')).item.msg_ids).toEqual([id1, id2]);

    // Typing indicator.
    bob2.send({ type: 'typing', to: alice.id.code, active: true });
    expect(await aliceWs.wait((e) => e.type === 'typing')).toMatchObject({ from: bob.id.code, active: true });

    // Encrypted media round trip.
    const data = new Uint8Array(1_300_000).map((_, i) => (i * 7) % 256);
    const cfg = await http<any>('/config');
    const count = chunkCount(data.length, cfg.chunk_bytes);
    const fk = await newFileKey();
    const { blob_id } = await http<any>('/media', { method: 'POST', token: alice.token, body: { to: bob.id.code, size: data.length + count * 16, chunk_count: count } });
    for (let i = 0; i < count; i++) {
      const ct = await encryptChunk(fk, blob_id, i, count, data.subarray(i * cfg.chunk_bytes, (i + 1) * cfg.chunk_bytes));
      await http(`/media/${blob_id}/chunks/${i}`, { method: 'PUT', token: alice.token, raw: ct });
    }
    await http(`/media/${blob_id}/complete`, { method: 'POST', token: alice.token });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const ct = await http<Uint8Array>(`/media/${blob_id}/chunks/${i}`, { token: bob.token });
      parts.push(await decryptChunk(fk, blob_id, i, count, ct));
    }
    expect(bytesEqual(concatBytes(...parts), data)).toBe(true);
    await http(`/media/${blob_id}/downloaded`, { method: 'POST', token: bob.token });

    // Block stops relay.
    await http(`/friends/${alice.id.code}/block`, { method: 'POST', token: bob.token });
    const id3 = randomId();
    aliceWs.send({ type: 'send', id: id3, to: bob.id.code, payload: await encryptMessage(kA, id3, alice.id.code, bob.id.code, { t: 'text', ts: 3, body: 'x' }) });
    expect(await aliceWs.wait((e) => e.type === 'error' && e.id === id3)).toMatchObject({ code: 'not_friends' });

    aliceWs.close();
    bob2.close();
  }, 30_000);
});
