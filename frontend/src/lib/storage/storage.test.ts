import { beforeEach, describe, expect, it } from 'vitest';
import { createVault } from '../crypto/vault';
import { deleteDatabase, getDb } from './db';
import { addTodo, ensureSeeded, listTodos, SEED_TASKS } from './decoy';
import { SecureStore } from './secureStore';

beforeEach(async () => {
  await deleteDatabase();
});

describe('decoy tasks', () => {
  it('seeds a fixed list exactly once', async () => {
    await ensureSeeded();
    await ensureSeeded();
    const first = await listTodos();
    expect(first.map((t) => t.title)).toEqual(SEED_TASKS.map((t) => t.title));
    await addTodo('my own task');
    await ensureSeeded();
    expect((await listTodos()).length).toBe(SEED_TASKS.length + 1);
  });

  it('decoy is identical across repeated reads (consistent across attempts)', async () => {
    await ensureSeeded();
    expect(await listTodos()).toEqual(await listTodos());
  });
});

describe('secure store', () => {
  it('encrypts records at rest and reads them back', async () => {
    const { keys } = await createVault('pw-12345678', 1000);
    const store = new SecureStore(keys);
    await store.putMessage({ id: 'm1', peer: 'EE8WUCD8SJTQ', dir: 'in', ts: 5, kind: 'text', body: 'plain secret', status: 'received' });
    const raw = await (await getDb()).getAll('messages');
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain('plain secret');
    expect(JSON.stringify(raw)).not.toContain('EE8WUCD8SJTQ');
    expect((await store.listMessages('EE8WUCD8SJTQ'))[0].body).toBe('plain secret');
  });

  it('a different vault key cannot read the records', async () => {
    const a = new SecureStore((await createVault('a-password', 1000)).keys);
    const b = new SecureStore((await createVault('b-password', 1000)).keys);
    await a.setKv('identity', { x: 1 });
    expect(await b.getKv('identity')).toBeUndefined();
  });
});
