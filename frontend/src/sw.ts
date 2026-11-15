/// <reference lib="webworker" />
/**
 * Service worker: offline app shell (spec §10) and disguised push notifications (spec F9).
 * Every push shows a notification (iOS revokes permission for silent pushes) with fixed text and an
 * opaque reference only.
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

const TITLE = 'Tasks';
const BODY = 'You have a task pending.';
const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface DecoyTask {
  id: string;
  title: string;
  done: boolean;
}

/**
 * Pick a random open task from the plaintext decoy list so the notification reads like a reminder
 * ("<task> is due today"). Opens the existing "tasks" database read-only; never creates it.
 */
function pickDueTask(): Promise<DecoyTask | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open('tasks');
    } catch {
      resolve(null);
      return;
    }
    // Database missing: abort so we don't create an empty v1 the app could never upgrade.
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const all = db.transaction('todos', 'readonly').objectStore('todos').getAll();
        all.onsuccess = () => {
          db.close();
          const open = (all.result as DecoyTask[]).filter(
            (t) => !t.done && typeof t.title === 'string' && REF_RE.test(t.id),
          );
          resolve(open.length ? open[Math.floor(Math.random() * open.length)]! : null);
        };
        all.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

self.addEventListener('push', (event) => {
  let ref: string | undefined;
  try {
    const data = event.data?.json() as { ref?: unknown } | undefined;
    if (typeof data?.ref === 'string' && REF_RE.test(data.ref)) ref = data.ref;
  } catch {
    /* always show a notification regardless of payload */
  }
  event.waitUntil(
    (async () => {
      const task = await pickDueTask().catch(() => null);
      await self.registration.showNotification(TITLE, {
        body: task ? `"${truncate(task.title)}" is due today.` : BODY,
        tag: 'tasks',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { ref, task: task?.id },
        // `renotify` re-alerts even though the tag collapses the previous notification.
        ...({ renotify: true } as NotificationOptions),
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { ref?: string; task?: string } | null;
  const ref = data?.ref;
  const task = data?.task;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        if (ref || task) existing.postMessage({ type: 'open-ref', ref, task });
        return;
      }
      const params = new URLSearchParams();
      if (ref) params.set('ref', ref);
      if (task) params.set('task', task);
      const qs = params.toString();
      await self.clients.openWindow(qs ? `/?${qs}` : '/');
    })(),
  );
});
