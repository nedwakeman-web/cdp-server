// CDP v19 service worker, Day 5
// Minimal but real. v19 ships:
//   - install/activate that take control immediately
//   - push event handler (renders a notification when a push arrives)
//   - notificationclick handler (focuses or opens the app)
//
// The actual server-side push-send (VAPID keys, payload construction
// tied to the morning ritual cron) is v20 work. v19's role is to
// prove the registration path and have the worker ready to receive
// pushes when v20 starts sending them.

const CDP_SW_VERSION = 'v19-1';

self.addEventListener('install', (event) => {
  // Skip waiting so the new worker takes effect immediately on update
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Claim all clients so the worker is in control without a reload
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Default payload if push arrives without data (rare)
  let title = 'Cosmic Daily Planner';
  let body = 'Today\'s compass is ready.';
  let url = '/';
  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload.title) title = payload.title;
      if (payload.body) body = payload.body;
      if (payload.url) url = payload.url;
    } catch (e) {
      // Non-JSON payload; use the raw text as the body
      body = event.data.text() || body;
    }
  }
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'cdp-morning',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if (client.url.includes(url) && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

console.log(`[CDP SW ${CDP_SW_VERSION}] active`);
