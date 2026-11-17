// Trip Wallet — Service Worker
// เก็บไฟล์แอปไว้ในเครื่อง ทำให้เปิดได้แม้ไม่มีเน็ต
// ทุกครั้งที่อัปเดตไฟล์แอป ต้องเปลี่ยนเลข VERSION เพื่อให้มือถือโหลดชุดใหม่
const VERSION = '1.0.0';
const CACHE = 'tripwallet-' + VERSION;
const FILES = ['./', './index.html', './tripwallet-core.js', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tripwallet-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ใช้ไฟล์ในเครื่องก่อนเสมอ (เร็ว และไม่พังตอนเน็ตญี่ปุ่นช้าหรือไม่มีสัญญาณ)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() =>
      req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
