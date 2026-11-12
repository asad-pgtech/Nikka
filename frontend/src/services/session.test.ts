/**
 * Disguise test (spec §12): the wrong-password path always lands on the same decoy, with no error
 * state, and the screen changes at a time comparable to the correct path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVault } from '@/lib/crypto/vault';
import { deleteDatabase, setVaultMeta } from '@/lib/storage/db';
import { ensureSeeded, listTodos } from '@/lib/storage/decoy';
import { useSession } from '@/state/session';
import { attemptUnlock, lock, UNLOCK_FLOOR_MS } from './session';

vi.mock('./config', () => ({
  getServerConfig: async () => ({
    max_file_bytes: 1, chunk_bytes: 1, max_payload_bytes: 1, autolock_default_seconds: 120, media_ttl_days: 30, vapid_public_key: null,
  }),
}));

const PASSWORD = 'the-real-password';

/** Time from submit until the app leaves the lock screen. */
async function timeTransition(pw: string): Promise<{ ms: number; firstPhase: string }> {
  useSession.setState({ phase: 'lock' });
  const start = performance.now();
  let firstPhase = '';
  let ms = 0;
  const unsub = useSession.subscribe((s) => {
    if (!firstPhase && s.phase !== 'lock') {
      firstPhase = s.phase;
      ms = performance.now() - start;
    }
  });
  await attemptUnlock(pw).catch(() => false);
  unsub();
  lock();
  return { ms, firstPhase };
}

beforeEach(async () => {
  await deleteDatabase();
  const { meta } = await createVault(PASSWORD, 50_000);
  await setVaultMeta(meta);
  await ensureSeeded();
});

describe('password gate disguise', () => {
  it('wrong passwords always show the same decoy list and clear the notification ref', async () => {
    const decoy = await listTodos();
    for (const pw of ['wrong', 'the-real-passwor', 'THE-REAL-PASSWORD', '']) {
      useSession.setState({ phase: 'lock', pendingRef: 'abc' });
      expect(await attemptUnlock(pw)).toBe(false);
      expect(useSession.getState().phase).toBe('tasks');
      expect(useSession.getState().pendingRef).toBeNull();
      expect(await listTodos()).toEqual(decoy);
    }
  });

  it('screen transition timing is comparable for right and wrong passwords', async () => {
    await timeTransition('warmup');
    const wrong: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await timeTransition('nope');
      expect(w.firstPhase).toBe('tasks');
      wrong.push(w.ms);
      const r = await timeTransition(PASSWORD);
      expect(r.firstPhase).toBe('unlocking');
      right.push(r.ms);
    }
    for (const t of [...wrong, ...right]) expect(t).toBeGreaterThanOrEqual(UNLOCK_FLOOR_MS - 5);
    const med = (a: number[]) => a.sort((x, y) => x - y)[1];
    expect(Math.abs(med(right) - med(wrong))).toBeLessThan(150);
  }, 30_000);
});
