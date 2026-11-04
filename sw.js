// AndyCare Erfassen – Offline-Speicher der Seite (nur die eigenen Programmdateien, nie Daten). Neue Fassung = neuer Name.
const FASSUNG = 'hausblick-handy-1.3.2';
const DATEIEN = ['./', 'index.html', 'handy.css', 'handy.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'fonts/source-sans-3-400.woff2', 'fonts/source-sans-3-500.woff2', 'fonts/source-sans-3-600.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(FASSUNG).then(c => c.addAll(DATEIEN)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== FASSUNG).map(n => caches.delete(n)))).then(() => self.clients.claim())); });
// mit Netz immer die aktuelle Fassung (und im Speicher auffrischen), ohne Netz aus dem Speicher
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(FASSUNG).then(c => fetch(e.request).then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; })
    .catch(() => c.match(e.request, { ignoreSearch: true }).then(t => t || Response.error()))));
});
