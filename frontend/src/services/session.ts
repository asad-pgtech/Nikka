/**
 * Unlock / lock orchestration (spec F2, F3).
 *
 * Unlock timing: the password is checked by KDF + AES-GCM unwrap only; the wrong path performs the
 * same derivation work, and both paths are padded to the same floor before the screen changes. The
 * slower decrypt-and-load work happens only after the transition.
 */
import { Api } from '@/lib/api/endpoints';
import { rewrapVault, unlockVault } from '@/lib/crypto/vault';
import { getVaultMeta, setVaultMeta } from '@/lib/storage/db';
import { useChat } from '@/state/chat';
import { useSession } from '@/state/session';
import { wipeDevice } from './account';
import { getServerConfig } from './config';
import { ChatController } from './controller';
import { markInterruptedUploads } from './media';
import { syncSubscription } from './push';

export const UNLOCK_FLOOR_MS = 1200;

let controller: ChatController | null = null;

export function getController(): ChatController {
  if (!controller) throw new Error('locked');
  return controller;
}

export const hasController = () => controller !== null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function attemptUnlock(password: string): Promise<boolean> {
  const started = performance.now();
  const meta = await getVaultMeta();
  const keys = meta ? await unlockVault(meta, password) : null;
  const elapsed = performance.now() - started;
  if (elapsed < UNLOCK_FLOOR_MS) await sleep(UNLOCK_FLOOR_MS - elapsed);

  const session = useSession.getState();
  if (!keys) {
    // Duress/decoy behaviour: no error, just the task list.
    session.setPendingRef(null);
    session.setPhase('tasks');
    return false;
  }

  session.setPhase('unlocking');
  try {
    const config = await getServerConfig();
    const ctrl = await ChatController.open(keys, config);
    if (useSession.getState().phase !== 'unlocking') {
      ctrl.stop(); // locked again while loading
      return false;
    }
    controller = ctrl;
    ctrl.start();
    session.setPhase('unlocked');
    void markInterruptedUploads(ctrl);
    if (useChat.getState().settings.notifications) void syncSubscription(ctrl).catch(() => undefined);
    return true;
  } catch {
    lock();
    return false;
  }
}

/** Discard keys and decrypted state, return to the decoy (spec F3). */
export function lock(): void {
  controller?.stop();
  controller = null;
  useChat.getState().reset();
  const session = useSession.getState();
  session.setPendingRef(null);
  if (session.phase !== 'onboarding' && session.phase !== 'boot') session.setPhase('tasks');
}

export async function changePassword(current: string, next: string): Promise<boolean> {
  const meta = await getVaultMeta();
  if (!meta) return false;
  const rewrapped = await rewrapVault(meta, current, next);
  if (!rewrapped) return false;
  await setVaultMeta(rewrapped);
  return true;
}

export async function wipeAll(): Promise<void> {
  const ctrl = controller;
  await wipeDevice(async () => {
    if (ctrl) await Api.deleteMe();
  });
  lock();
  location.replace('/');
}
