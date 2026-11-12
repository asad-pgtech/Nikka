import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { ChatShell } from '@/features/chats/ChatShell';
import { LockScreen } from '@/features/lock/LockScreen';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { TasksScreen } from '@/features/tasks/TasksScreen';
import { useAutoLock } from '@/hooks/useAutoLock';
import { getVaultMeta } from '@/lib/storage/db';
import { useSession } from '@/state/session';
import { getController, hasController } from '@/services/session';

/** Notification taps arrive as `/?ref=…` (cold start) or a service-worker message (warm). */
function takeRefFromUrl(): string | null {
  const url = new URL(location.href);
  const ref = url.searchParams.get('ref');
  if (ref) {
    url.searchParams.delete('ref');
    history.replaceState(null, '', url.pathname + url.search);
  }
  return ref && /^[A-Za-z0-9_-]{1,64}$/.test(ref) ? ref : null;
}

export function App() {
  const phase = useSession((s) => s.phase);
  const setPhase = useSession((s) => s.setPhase);
  const setPendingRef = useSession((s) => s.setPendingRef);

  useAutoLock(phase === 'unlocked' || phase === 'unlocking');

  useEffect(() => {
    void (async () => {
      const ref = takeRefFromUrl();
      if (!(await getVaultMeta())) {
        setPhase('onboarding');
        return;
      }
      // A notification tap lands on the task list (owner's choice); the ref is kept so a later
      // manual unlock opens that conversation.
      if (ref) setPendingRef(ref);
      setPhase('tasks');
    })();
  }, [setPhase, setPendingRef]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; ref?: string } | null;
      if (data?.type !== 'open-ref' || typeof data.ref !== 'string') return;
      setPendingRef(data.ref);
      const current = useSession.getState().phase;
      if (current === 'unlocked' && hasController()) getController().resolvePendingRef();
      // Locked: stay on whatever is showing (normally the task list).
      // While unlocking, the controller resolves the ref after its first sync.
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [setPhase, setPendingRef]);

  switch (phase) {
    case 'boot':
      return null;
    case 'onboarding':
      return <Onboarding />;
    case 'tasks':
      return <TasksScreen />;
    case 'lock':
      return <LockScreen />;
    case 'unlocking':
      return (
        <div className="screen center">
          <Spinner label="Opening" />
        </div>
      );
    case 'unlocked':
      return hasController() ? <ChatShell /> : null;
  }
}
