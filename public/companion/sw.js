// The companion's offline shell.
//
// iOS opens a Home Screen icon to the address it was installed from, and when that address
// does not answer it shows its own error page — the page never gets a chance to say "the PC
// is off". This worker keeps the shell and answers from the cache when the PC is
// unreachable, so the companion opens with its last known list instead of Safari's
// "the server cannot be found".
//
// It only works on a secure address. A LAN address such as http://192.168.1.20:7878/ is not
// a secure origin, so iOS refuses to install a worker for it at all — which is why the
// https address (Settings → iPhone companion → Web address) is the one to add.

const CACHE = 'rc-companion-shell-v1';
const SHELL = [
  '/',
  '/companion.css?v=2',
  '/companion.js?v=2',
  '/manifest.webmanifest',
  '/manifest-nightly.webmanifest',
  '/icons/icon-180.png?v=2',
  '/icons/icon-192.png?v=2',
];
// A dead address can hang instead of refusing: after this long, answer from the cache
// rather than leaving the person on a white screen.
const SHELL_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing icon must not throw the whole shell away.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Pairing, state and the control socket are live facts; a cached answer would be a lie.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/health') return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHELL_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response && response.ok) {
      cache.put('/', response.clone()).catch(() => {});
      return response;
    }
    throw new Error(`HTTP ${response && response.status}`);
  } catch (error) {
    const cached = await cache.match('/');
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<body style="background:#0b0f14;color:#c9d1dc;font:16px system-ui;padding:32px">' +
      '<h1 style="font-size:20px">RunContainer can\u2019t reach your PC</h1>' +
      '<p>Open RunContainer on the PC, then open this again.</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}
