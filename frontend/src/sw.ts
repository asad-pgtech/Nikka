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

self.addEventListener('push', (event) => {
  let ref: string | undefined;
  try {
    const data = event.data?.json() as { ref?: unknown } | undefined;
    if (typeof data?.ref === 'string' && REF_RE.test(data.ref)) ref = data.ref;
  } catch {
    /* always show a notification regardless of payload */
  }
  event.waitUntil(
    self.registration.showNotification(TITLE, {
      body: BODY,
      tag: 'tasks',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { ref },
      // `renotify` re-alerts even though the tag collapses the previous notification.
      ...({ renotify: true } as NotificationOptions),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ref = (event.notification.data as { ref?: string } | null)?.ref;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        if (ref) existing.postMessage({ type: 'open-ref', ref });
        return;
      }
      await self.clients.openWindow(ref ? `/?ref=${encodeURIComponent(ref)}` : '/');
    })(),
  );
});
