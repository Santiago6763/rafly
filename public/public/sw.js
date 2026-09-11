const CACHE_NAME = 'rafly-v8';
const ASSETS = [
  '/',
  '/index.html',
  '/trivia.html',
  '/raspadita.html',
  '/legal.html',
  '/engagement.html',
  '/landing.html',
  '/pricing.html',
  '/qr.html',
  '/dashboard.html',
  '/admin.html',
  '/overlay.html',
  '/countdown.html',
  '/api-docs.html',
  '/manifest.json',
  '/offline.html'
];

// Install — cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Push — show notification
self.addEventListener('push', event => {
  let data = { title: 'RAFLY', body: 'Tenes una notificacion', icon: '/manifest.json' };
  try {
    data = Object.assign(data, event.data.json());
  } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/og-image.png',
      badge: '/og-image.png',
      data: data.url || '/',
      vibrate: [200, 100, 200]
    })
  );
});

// Notification click — open app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// Fetch — network first, cache fallback, offline page for navigations
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // API requests: network only, no caching
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Sin conexion' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached => {
          if (cached) return cached;
          // If it's a navigation, show offline page
          if (event.request.mode === 'navigate') {
            return caches.match('/offline.html');
          }
          return new Response('', { status: 503 });
        })
      )
  );
});
