/** Web Push subscription management (spec F9). Must be triggered from a user gesture. */
import { Api } from '@/lib/api/endpoints';
import { b64decode } from '@/lib/encoding';
import { isIOS, isStandalone, pushSupported } from '@/lib/platform';
import type { ChatController } from './controller';
import { refreshServerConfig } from './config';

const SW_READY_TIMEOUT_MS = 10_000;

/** Why push cannot be enabled on this device, or null if it can. */
export function pushUnavailableReason(vapidKey: string | null): string | null {
  if (isIOS() && !isStandalone()) return 'On iPhone, open Tasks from the Home Screen icon to enable notifications.';
  if (!pushSupported())
    return isIOS()
      ? 'This iPhone does not support web notifications. Update to iOS 16.4 or later.'
      : 'This browser does not support notifications.';
  if (!vapidKey) return 'The server has no notification keys configured.';
  return null;
}

async function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Background service did not start. Close the app fully and reopen it, then try again.')),
        SW_READY_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function vapidKey(ctrl: ChatController): Promise<string | null> {
  return ctrl.config.vapid_public_key ?? (await refreshServerConfig()).vapid_public_key;
}

/**
 * Call synchronously from a click handler: the permission request must be the first await so
 * iOS still treats it as a user gesture.
 */
export async function enablePush(ctrl: ChatController): Promise<void> {
  const early = pushUnavailableReason(ctrl.config.vapid_public_key ?? 'pending');
  if (early) throw new Error(early);
  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new Error(
      isIOS()
        ? 'Notifications are blocked. Allow them in iPhone Settings → Notifications → Tasks, then try again.'
        : 'Notifications are blocked for this site. Allow them in the browser settings, then try again.',
    );
  }
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  const key = await vapidKey(ctrl);
  if (!key) throw new Error('The server has no notification keys configured.');
  await syncSubscription(ctrl, true, key);
  await ctrl.updateSettings({ notifications: true });
}

/** Ensure the browser subscription exists and the server knows it. */
export async function syncSubscription(ctrl: ChatController, create = false, key?: string | null): Promise<void> {
  const vapid = key ?? (await vapidKey(ctrl));
  if (!pushSupported() || !vapid || Notification.permission !== 'granted') return;
  const reg = await serviceWorkerReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64decode(vapid) as BufferSource,
      });
    } catch (e) {
      throw new Error(`Could not subscribe to notifications (${e instanceof Error ? e.message : 'unknown error'}).`);
    }
  }
  if (!sub) return;
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('The browser returned an invalid subscription.');
  await Api.pushSubscribe(json.endpoint, { p256dh: json.keys.p256dh, auth: json.keys.auth });
}

export async function disablePush(ctrl: ChatController): Promise<void> {
  await ctrl.updateSettings({ notifications: false });
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await Api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

/** Ask the server to push to this user's devices; returns a human-readable result. */
export async function sendTestPush(): Promise<string> {
  const res = await Api.pushTest();
  if (!res.enabled) return 'The server has notifications turned off (no VAPID keys).';
  if (res.subscriptions === 0) return 'This account has no registered devices. Enable notifications first.';
  const ok = res.statuses.filter((s) => s !== null && s >= 200 && s < 300).length;
  if (ok === res.subscriptions)
    return `Sent. A “Tasks” notification should appear within a few seconds${isIOS() ? ' (lock the phone or switch apps to see it)' : ''}.`;
  return `Push service rejected it (status ${res.statuses.join(', ')}). Turn notifications off and on again.`;
}
