const CACHE_NAME = 'kma-booth-v6';

// Install: บังคับให้อัปเดตและข้ามการรอทันที
self.addEventListener('install', event => {
  self.skipWaiting();
});

// Activate: ล้าง Cache เก่าทั้งหมดทันที เพื่อไม่ให้ค้าง UI รุ่นเก่า
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: HTML ใช้ Network-First เสมอ เพื่อให้ได้เวอร์ชันล่าสุด 100%
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // สำหรับ API: Network-First (ถ้าออฟไลน์ถึงดึงแคช)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // สำหรับหน้าเว็บ HTML และ Navigation: บังคับ Network-First เสมอ ป้องกันแคชเก่าใน LINE
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // สำหรับ Assets ทั่วไป: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
