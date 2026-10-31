// Källkoden till service workern, som text. Den serveras av
// app/offline-sw.js/route.ts med en version per driftsättning, så att varje
// ny version installeras på telefonerna av sig själv.
//
// Reglerna, efter att en trasig worker låste appen i oktober:
//  1. Bara sidladdningar (navigate) hanteras. API, Supabase, bilder och
//     skript går aldrig via workern.
//  2. Nätet först, alltid. Den sparade sidan visas bara när nätet inte svarar.
//  3. respondWith får aldrig något annat än ett Response. Går allt fel blir
//     det ett vanligt nätverksfel, precis som utan worker.
//  4. Ingen sida i appen cachas, bara offline.html. Då kan gammal data aldrig
//     visas som om den vore färsk.

export const OFFLINE_CACHE_PREFIX = 'tops-offline-';

export function offlineSwSource(version: string): string {
  const v = JSON.stringify(version);
  return `// TournamentOps · offline-worker · version ${version.replace(/[^\w.-]/g, '')}
'use strict';
const VERSION = ${v};
const CACHE = '${OFFLINE_CACHE_PREFIX}' + VERSION;
const OFFLINE_URL = '/offline.html';
// Svarar inte servern inom tio sekunder visas den sparade informationen.
// Räknas till första byte, inte till hela sidan.
const NAV_TIMEOUT_MS = 10000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' går förbi webbläsarens cache, så varje version får
    // en färsk offlinesida
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((k) => k.indexOf('${OFFLINE_CACHE_PREFIX}') === 0 && k !== CACHE)
        .map((k) => caches.delete(k)));
    } catch (e) { /* städningen får aldrig stoppa aktiveringen */ }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  try {
    if (event.data === 'version' && event.ports && event.ports[0]) {
      event.ports[0].postMessage(VERSION);
    }
  } catch (e) { /* ignorera */ }
});

async function savedPage() {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(OFFLINE_URL);
    if (hit) return hit;
    // Äldre version kvar under bytet? Ta vilken offlinesida som helst.
    const any = await caches.match(OFFLINE_URL);
    if (any) return any;
  } catch (e) { /* faller igenom */ }
  return null;
}

async function navigate(request) {
  try {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS);
    });
    // Varje svar från servern lämnas vidare som det är, även 404 och 500.
    // Bara när inget svar alls kommer visas den sparade sidan.
    const res = await Promise.race([fetch(request), timeout]);
    clearTimeout(timer);
    if (res) return res;
  } catch (e) { /* inget nät */ }
  const page = await savedPage();
  if (page) return page;
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  try {
    const req = event.request;
    if (req.mode !== 'navigate' || req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/auth/') === 0) return;
    event.respondWith(navigate(req).catch(() => fetch(req)));
  } catch (e) {
    // Utan respondWith går anropet till nätet som vanligt
  }
});
`;
}

// Serveras när OFFLINE_SW=off i Vercel. Tar bort sig själv och sin cache,
// och laddar om öppna flikar så att de kör utan worker.
export function offlineSwKillSource(): string {
  return `// TournamentOps · offline-worker avstängd
'use strict';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((k) => k.indexOf('${OFFLINE_CACHE_PREFIX}') === 0)
        .map((k) => caches.delete(k)));
    } catch (e) { /* ignorera */ }
    try { await self.registration.unregister(); } catch (e) { /* ignorera */ }
    try {
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach((c) => { try { c.navigate(c.url); } catch (e) { /* ignorera */ } });
    } catch (e) { /* ignorera */ }
  })());
});
`;
}
