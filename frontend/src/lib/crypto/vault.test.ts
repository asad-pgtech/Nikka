import { describe, expect, it } from 'vitest';
import { aesDecrypt, aesEncrypt } from './aead';
import { createVault, rewrapVault, unlockVault } from './vault';

const ITER = 1000; // keep tests fast; production uses PBKDF2_ITERATIONS

describe('vault', () => {
  it('unlocks with the right password and yields the same key', async () => {
    const { meta, keys } = await createVault('correct horse', ITER);
    const sealed = await aesEncrypt(keys.enc, new Uint8Array([1, 2, 3]));
    const again = await unlockVault(meta, 'correct horse');
    expect(again).not.toBeNull();
    expect(Array.from(await aesDecrypt(again!.enc, sealed.iv, sealed.ct))).toEqual([1, 2, 3]);
  });

  it('returns null (no exception, no hint) for a wrong password', async () => {
    const { meta } = await createVault('correct horse', ITER);
    expect(await unlockVault(meta, 'wrong horse')).toBeNull();
    expect(await unlockVault(meta, '')).toBeNull();
  });

  it('stores no password hash, only the wrapped key', async () => {
    const { meta } = await createVault('pw-12345678', ITER);
    expect(Object.keys(meta).sort()).toEqual(['iterations', 'iv', 'salt', 'v', 'wrapped']);
  });

  it('keys are non-extractable', async () => {
    const { keys } = await createVault('pw-12345678', ITER);
    expect(keys.enc.extractable).toBe(false);
    expect(keys.idx.extractable).toBe(false);
  });

  it('change password re-wraps the same vault key', async () => {
    const { meta, keys } = await createVault('old-password', ITER);
    const sealed = await aesEncrypt(keys.enc, new Uint8Array([9]));
    expect(await rewrapVault(meta, 'not-it', 'new-password')).toBeNull();
    const next = await rewrapVault(meta, 'old-password', 'new-password');
    expect(next).not.toBeNull();
    expect(await unlockVault(next!, 'old-password')).toBeNull();
    const k = await unlockVault(next!, 'new-password');
    expect(Array.from(await aesDecrypt(k!.enc, sealed.iv, sealed.ct))).toEqual([9]);
  });

  it('wrong and right paths do comparable work', async () => {
    const { meta } = await createVault('timing-pass', 20_000);
    const time = async (pw: string) => {
      const t = performance.now();
      await unlockVault(meta, pw);
      return performance.now() - t;
    };
    await time('warmup');
    const right: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 5; i++) {
      right.push(await time('timing-pass'));
      wrong.push(await time('nope'));
    }
    const median = (a: number[]) => a.sort((x, y) => x - y)[2];
    const ratio = median(right) / median(wrong);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });
});
