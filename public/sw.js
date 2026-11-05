const CACHE_NAME = 'kma-booth-v28';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/tailwind.min.js',
  '/lucide.min.js',
  '/sweetalert2.all.min.js',
  '/kma-logo.png',
  '/line-qr.png',
  '/manifest.json'
];

// Install: แคชไฟล์หลักทั้งหมดทันทีแบบ Offline-Ready 100%
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => console.warn('Pre-cache warning:', err));
    })
  );
  self.skipWaiting();
});

// Activate: ล้าง Cache เก่าทั้งหมดทันทีเพื่ออัปเดตระบบ
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

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. สำหรับ API GET /api/products
  if (url.pathname.startsWith('/api/products') && event.request.method === 'GET') {
    const isForceRefresh = url.searchParams.has('_t');

    // ถ้าเป็นการ Force Refresh (เช่น หลังเพิ่ม/แก้/ลบสินค้า หรือสั่งดึงสด): บังคับข้ามแคชดึงฐานข้อมูลจริงทันที
    if (isForceRefresh) {
      event.respondWith(
        fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put('/api/products', clone);
            });
          }
          return networkResponse;
        }).catch(() => caches.match('/api/products'))
      );
      return;
    }

    // กรณีโหลดปกติ: Stale-While-Revalidate (ตอบแคชทันที 0ms อัปเดตในเบื้องหลัง)
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

  // 2. สำหรับ API อื่นๆ (POST / PUT / DELETE หรือสถานะ): Network-First พร้อมล้างแคชสินค้าทันทีเมื่อข้อมูลเปลี่ยน
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).then(response => {
        // หากเป็นการเพิ่ม แก้ไข หรือลบสินค้า ให้ล้างแคชเก่าทิ้งทันที
        if (event.request.method !== 'GET') {
          caches.open(CACHE_NAME).then(cache => {
            cache.delete('/api/products');
            cache.keys().then(keys => {
              keys.forEach(k => {
                if (k.url.includes('/api/products')) cache.delete(k);
              });
            });
          });
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // 3. สำหรับ Static Assets ท้องถิ่น (.js, .css, .png, .jpg, .svg, .json): Cache-First ตอบทันที 0ms!
  if (
    url.origin === self.location.origin &&
    (url.pathname.endsWith('.js') ||
     url.pathname.endsWith('.png') ||
     url.pathname.endsWith('.jpg') ||
     url.pathname.endsWith('.jpeg') ||
     url.pathname.endsWith('.svg') ||
     url.pathname.endsWith('.json') ||
     url.pathname.endsWith('.css')) &&
    url.pathname !== '/sw.js'
  ) {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) {
          // มีในแคช ส่งกลับทันที 0ms แล้วอัปเดตในเบื้องหลัง (SWR)
          fetch(event.request).then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResponse));
            }
          }).catch(() => {});
          return cachedResponse;
        }
        return fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 4. สำหรับหน้าเว็บ HTML และ Navigation: พยายามดึงเน็ต แต่ถ้าเกิน 1.5 วินาที ดึง Cache ทันที ไม่ให้หน้าค้าง!
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      new Promise(resolve => {
        let isResolved = false;
        const timeoutTimer = setTimeout(() => {
          if (!isResolved) {
            caches.match(event.request).then(cached => {
              if (cached && !isResolved) {
                isResolved = true;
                resolve(cached);
              }
            });
          }
        }, 1500);

        fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeoutTimer);
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
              resolve(networkResponse);
            } else {
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResponse.clone()));
            }
          } else {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeoutTimer);
              caches.match(event.request).then(cached => resolve(cached || networkResponse));
            }
          }
        }).catch(() => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutTimer);
            caches.match(event.request).then(cached => resolve(cached));
          }
        });
      })
    );
    return;
  }

  // 5. Assets อื่นๆ: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
