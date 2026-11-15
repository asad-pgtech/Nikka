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

const PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Notification taps arrive as `/?ref=…&task=…` (cold start) or a service-worker message (warm).
 * `task` is the decoy task the notification said is due today.
 */
function takeNotificationParams(): { ref: string | null; task: string | null } {
  const url = new URL(location.href);
  const ref = url.searchParams.get('ref');
  const task = url.searchParams.get('task');
  if (ref || task) {
    url.searchParams.delete('ref');
    url.searchParams.delete('task');
    history.replaceState(null, '', url.pathname + url.search);
  }
  return {
    ref: ref && PARAM_RE.test(ref) ? ref : null,
    task: task && PARAM_RE.test(task) ? task : null,
  };
}

export function App() {
  const phase = useSession((s) => s.phase);
  const setPhase = useSession((s) => s.setPhase);
  const setPendingRef = useSession((s) => s.setPendingRef);
  const setDueTodayTaskId = useSession((s) => s.setDueTodayTaskId);

  useAutoLock(phase === 'unlocked' || phase === 'unlocking');

  useEffect(() => {
    void (async () => {
      const { ref, task } = takeNotificationParams();
      if (task) setDueTodayTaskId(task);
      if (!(await getVaultMeta())) {
        setPhase('onboarding');
        return;
      }
      // A notification tap lands on the task list (owner's choice); the ref is kept so a later
      // manual unlock opens that conversation.
      if (ref) setPendingRef(ref);
      setPhase('tasks');
    })();
  }, [setPhase, setPendingRef, setDueTodayTaskId]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; ref?: string; task?: string } | null;
      if (data?.type !== 'open-ref') return;
      if (typeof data.task === 'string' && PARAM_RE.test(data.task)) setDueTodayTaskId(data.task);
      if (typeof data.ref !== 'string' || !PARAM_RE.test(data.ref)) return;
      setPendingRef(data.ref);
      const current = useSession.getState().phase;
      if (current === 'unlocked' && hasController()) getController().resolvePendingRef();
      // Locked: stay on whatever is showing (normally the task list).
      // While unlocking, the controller resolves the ref after its first sync.
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [setPhase, setPendingRef, setDueTodayTaskId]);

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
