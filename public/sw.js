const CACHE_NAME = 'kma-booth-v24';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/kma-logo.png',
  '/line-qr.png',
  '/manifest.json'
];

// Install: แคชไฟล์หลักของระบบทันที พร้อมเปิดใช้งานออฟไลน์ 100%
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => console.warn('Pre-cache error:', err));
    })
  );
  self.skipWaiting();
});

// Activate: ล้าง Cache เก่าทั้งหมดทันที เพื่อไม่ให้ค้าง UI รุ่นเก่า
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: HTML ใช้ Network-First เสมอ เพื่อให้ได้เวอร์ชันล่าสุด 100%
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // สำหรับ API GET /api/products: Stale-While-Revalidate (โหลดแคชทันที 0ms อัปเดตในเบื้องหลัง)
  if (url.pathname.startsWith('/api/products') && event.request.method === 'GET') {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cachedResponse => {
          const fetchPromise = fetch(event.request).then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // สำหรับ API อื่นๆ (POST / PUT / DELETE หรือสถานะ): Network-First
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
