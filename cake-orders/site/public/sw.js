// Lets the dashboard be installed as an app on the phone ("Add to Home Screen").
// Always uses the network (so data is never stale); falls back to a cached page when offline.
const CACHE = 'orders-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['admin.html', 'css/style.css']).catch(() => {}))); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/') || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (url.pathname.endsWith('.html') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js'))) {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request)));
});
