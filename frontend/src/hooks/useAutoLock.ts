/**
 * Auto-lock (spec F3): lock when the page is hidden and after an idle timeout.
 * The native file/camera picker on iOS hides the page; that case is exempted via markPickerActive().
 */
import { useEffect } from 'react';
import { clearPickerActive, isPickerActive } from '@/lib/platform';
import { lock } from '@/services/session';
import { useChat } from '@/state/chat';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'app-activity'] as const;

export function useAutoLock(enabled: boolean): void {
  const timeoutSec = useChat((s) => s.settings.autoLockSeconds);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      if (timeoutSec > 0) timer = setTimeout(lock, timeoutSec * 1000);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!isPickerActive()) lock();
      } else {
        clearPickerActive();
        arm();
      }
    };
    const onPageHide = () => {
      if (!isPickerActive()) lock();
    };
    arm();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      if (timer) clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, arm));
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [enabled, timeoutSec]);
}
