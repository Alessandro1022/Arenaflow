// Källkoden till service workern, som text. Den serveras av
// app/offline-sw.js/route.ts med en version per driftsättning, så att varje
// ny version installeras på telefonerna av sig själv.
//
// Utan täckning ska APPEN fungera, inte en nödsida. Därför sparas på vägen:
//  - sidorna man öppnat, och de viktigaste i förväg
//  - datan sidorna hämtade från Supabase, märkt med vems den är
//  - appens programfiler, som har unika namn per version
//  - kartbilderna man tittat på
//
// Reglerna, efter att en trasig worker låste appen i oktober:
//  1. Nätet först för allt som kan ändras. Med täckning beter sig appen som
//     utan worker – svaren sparas bara på vägen förbi.
//  2. Det sparade visas bara när nätet inte svarar, och appen säger då
//     tydligt att det är sparat och från när. Aldrig tyst som om det vore färskt.
//  3. respondWith får aldrig något annat än ett Response. Går något fel i
//     workern går anropet till nätet som vanligt.
//  4. Byte av person och utloggning tömmer allt personligt, och inget sparat
//     är äldre än sju dagar. Sjukvårdsärenden, deltagare och ekonomi sparas
//     aldrig i telefonen (bara tabellerna i OFFLINE_TABLES sparas).
//  5. Nödutgångarna finns kvar: OFFLINE_SW=off, ?sw=off och "Återställ appen".

export const OFFLINE_CACHE_PREFIX = 'tops-offline-';

// Det som får sparas i telefonen för användning utan täckning. Medvetet en
// lista över det som behövs i fält, inte allt: en ny tabell sparas inte förrän
// den läggs till här.
export const OFFLINE_TABLES = [
  // Turneringen och personerna i driften
  'tenants', 'profiles', 'areas', 'staff_scope', 'crisis_state', 'emergency_contacts',
  'on_call_shifts', 'on_call_now',
  // Pass och bemanning
  'shifts', 'shift_swaps', 'availability', 'staffing_gaps', 'security_coverage',
  'onboarding_items', 'onboarding_done', 'onboarding_status',
  'checklist_templates', 'checklist_runs', 'checklist_items', 'checklist_due_today',
  // Platser, boenden och lag
  'schools', 'arenas', 'classrooms', 'room_issues', 'room_keys', 'team_assignments',
  'school_stats', 'area_stats', 'team_roster_stats', 'medical_points', 'dining_halls',
  'crowd_counts', 'night_rounds', 'security_logs', 'security_cars', 'car_routes',
  // Matcher
  'arena_matches', 'referees', 'group_standings',
  // Händelser, uppgifter och kommunikation
  'incidents', 'incident_comments', 'tasks', 'task_comments', 'news_posts', 'news_acks',
  'news_ack_status', 'channels', 'channel_members', 'channel_reads', 'channel_unread',
  'messages', 'attachments', 'documents', 'notifications',
  // Logistik
  'vehicles', 'transport_jobs', 'transport_job_items', 'transport_board',
  'stock_items', 'stock_totals', 'stock_balances', 'stock_movements',
  'meal_services', 'meal_teams', 'meal_board', 'meal_forecast', 'meal_checkin_counts'
];

// Databasfunktioner som bara läser och därför får sparas
export const OFFLINE_RPCS = ['my_tenant_row', 'my_modules', 'my_tier', 'can_module'];

export type SwConfig = {
  // Supabase-adressens ursprung, t.ex. https://abc.supabase.co
  supabase: string;
  // Kartbildernas värd. "*.exempel.se" betyder alla underdomäner.
  tiles: string[];
};

export function offlineSwSource(version: string, cfg: SwConfig): string {
  const j = (v: unknown) => JSON.stringify(v);
  return String.raw`// TournamentOps · offline-worker · version ${version.replace(/[^\w.-]/g, '')}
'use strict';
const VERSION = ${j(version)};
const SUPA = ${j(cfg.supabase)};
const TILE_HOSTS = ${j(cfg.tiles)};
const TABLES = ${j(OFFLINE_TABLES)};
const RPCS = ${j(OFFLINE_RPCS)};

const P = '${OFFLINE_CACHE_PREFIX}';
const SHELL = P + 'shell-' + VERSION;
const STATIC = P + 'static';
const PAGES = P + 'pages';
const DATA = P + 'data';
const TILES = P + 'tiles';
const META = P + 'meta';
const KEEP = [SHELL, STATIC, PAGES, DATA, TILES, META];
const LIMIT = {};
LIMIT[STATIC] = 1500; LIMIT[PAGES] = 80; LIMIT[DATA] = 800; LIMIT[TILES] = 800;

const OFFLINE_URL = '/offline.html';
const MAX_AGE = 7 * 86400000;
// Väntetider innan det sparade visas. Räknas till första byte.
const NAV_TIMEOUT_MS = 10000;   // sida som inte finns sparad, sedan offlinesidan
const SAVED_TIMEOUT_MS = 6000;  // det finns en sparad version
const QUICK_TIMEOUT_MS = 2000;  // nätet svek för mindre än 30 sekunder sedan
const DATA_SAVED_TIMEOUT_MS = 8000;  // data som finns sparad
const DATA_TIMEOUT_MS = 25000;  // data som inte finns sparad
const NO_PAGE = /^\/(api|auth|login|tvafaktor|checkin|integritet|offline\.html|offline-sw\.js)(\/|$)/;
const MSG_READ = 'Ingen täckning – det här finns inte sparat i telefonen än.';
const MSG_WRITE = 'Ingen täckning – det gick inte att spara. Försök igen när du har täckning.';

// ---------- Pågående arbete ----------
// Vad workern håller på med just nu. En ny version tar över först när den
// gamla är klar, så inget här får kunna hänga för evigt (se warmPages).
const work = new Map();
let workSeq = 0;
function track(label, p) {
  const id = ++workSeq;
  work.set(id, { label, at: Date.now() });
  Promise.resolve(p).then(() => work.delete(id), () => work.delete(id));
  return p;
}
const stayAlive = (event, label, p) => event.waitUntil(track(label, p));
const respondTracked = (event, label, p) => event.respondWith(track(label, p));

// ---------- Läget: fungerar nätet? ----------
let downAt = 0;         // när nätet senast svek, 0 = fungerar
let downSaved = 0;      // äldsta sparade som visats sedan dess
let lastSent = 0;
const servedPages = new Map();  // klient -> när sidan den fick sparades

const recentlyDown = () => downAt > 0 && Date.now() - downAt < 30000;
const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
// Workerns egna hämtningar i förväg får aldrig hänga kvar: en ny version tar
// över först när den gamla är klar med allt den håller på med.
function fetchTimed(url, init, ms) {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return fetch(url, Object.assign({}, init, { signal: ctl.signal }));
}
const updateWaiting = () => !!(self.registration && (self.registration.waiting || self.registration.installing));
// Ett svar som kom för sent och inte används: släpp det, så att anslutningen
// frigörs direkt i stället för när webbläsaren städar
const drop = (res) => { try { if (res && res.body) res.body.cancel(); } catch (e) { /* redan läst */ } };

async function tell(msg, clientId) {
  try {
    if (clientId) {
      const c = await self.clients.get(clientId);
      if (c) c.postMessage(msg);
      return;
    }
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach((c) => { try { c.postMessage(msg); } catch (e) { /* stängd */ } });
  } catch (e) { /* ingen att berätta för */ }
}
function markDown(savedAt) {
  const first = !downAt;
  downAt = Date.now();
  if (savedAt && (!downSaved || savedAt < downSaved)) downSaved = savedAt;
  if (first || Date.now() - lastSent > 1000) {
    lastSent = Date.now();
    tell({ type: 'tops-net', down: true, savedAt: downSaved || null });
  }
}
function markUp() {
  if (!downAt) return;
  downAt = 0; downSaved = 0;
  tell({ type: 'tops-net', down: false });
}

// ---------- Vems är det sparade? ----------
// Läser användaren ur Authorization-huvudet, bara för att märka det sparade.
// Servern kontrollerar alltid den riktiga behörigheten.
function userOf(req) {
  try {
    const h = req.headers.get('authorization') || '';
    const t = h.replace(/^Bearer\s+/i, '').split('.')[1];
    if (!t) return null;
    const b = t.replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b + '==='.slice((b.length + 3) % 4)));
    return p && p.role === 'authenticated' && typeof p.sub === 'string' ? p.sub : null;
  } catch (e) { return null; }
}
let owner;              // undefined = inte läst än
let switching = null;
async function getOwner() {
  if (owner !== undefined) return owner;
  try {
    const r = await (await caches.open(META)).match('/__tops/owner');
    owner = r ? await r.text() : null;
  } catch (e) { owner = null; }
  return owner;
}
function setOwner(uid) {
  if (switching) return switching;
  switching = (async () => {
    const prev = await getOwner();
    if (prev === uid) return;
    // Ny person i telefonen: inget från den förra får finnas kvar
    if (prev) await Promise.all([caches.delete(PAGES), caches.delete(DATA)]);
    servedPages.clear();
    await (await caches.open(META)).put('/__tops/owner', new Response(uid));
    owner = uid;
  })().catch(() => {}).then(() => { switching = null; });
  return switching;
}
async function forget() {
  owner = null;
  servedPages.clear();
  await Promise.all([caches.delete(PAGES), caches.delete(DATA), caches.delete(META)]);
}

// ---------- Städning ----------
const puts = {};
function counted(name) {
  puts[name] = (puts[name] || 0) + 1;
  if (puts[name] % 40 === 0) prune(name, false).catch(() => {});
}
// Äldst först: cachen behåller ordningen saker sparades i
async function prune(name, byAge) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const doomed = new Set(keys.slice(0, Math.max(0, keys.length - (LIMIT[name] || 500))));
  if (byAge && (name === DATA || name === PAGES)) {
    for (const k of keys) {
      if (doomed.has(k)) continue;
      const r = await cache.match(k);
      const at = r ? Number(r.headers.get('x-tops-at')) || 0 : 0;
      if (Date.now() - at > MAX_AGE) doomed.add(k);
    }
  }
  await Promise.all([...doomed].map((k) => cache.delete(k)));
}
const pruneAll = () => Promise.all([STATIC, PAGES, DATA, TILES].map((n) => prune(n, true).catch(() => {})));

// ---------- Installation ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
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
        .filter((k) => k.indexOf(P) === 0 && KEEP.indexOf(k) < 0)
        .map((k) => caches.delete(k)));
    } catch (e) { /* städningen får aldrig stoppa aktiveringen */ }
    await self.clients.claim();
    await pruneAll();
  })());
});

// ---------- Meddelanden från appen ----------
self.addEventListener('message', (event) => {
  const d = event.data;
  const port = event.ports && event.ports[0];
  const reply = (v) => { try { if (port) port.postMessage(v); } catch (e) { /* stängd */ } };
  try {
    if (d === 'version') return reply(VERSION);
    if (!d || typeof d !== 'object') return;
    // Appen ber en väntande ny version att ta över. Behövs ibland: Chrome kan
    // låta den vänta tills alla flikar stängts trots skipWaiting i install.
    if (d.type === 'tops-skip') { self.skipWaiting(); return reply(true); }
    if (d.type === 'tops-net?') {
      const id = event.source && event.source.id;
      return reply({ down: recentlyDown(), savedAt: downSaved || null, page: (id && servedPages.get(id)) || null });
    }
    if (d.type === 'tops-work') {
      const now = Date.now();
      return reply([...work.values()].map((w) => w.label + ' ' + (now - w.at) + ' ms'));
    }
    if (d.type === 'tops-static' && Array.isArray(d.urls)) stayAlive(event, 'warm-static', warmStatic(d.urls).catch(() => {}));
    if (d.type === 'tops-pages' && Array.isArray(d.paths)) stayAlive(event, 'warm-pages', warmPages(d.paths).then(reply, () => reply(0)));
    if (d.type === 'tops-forget') stayAlive(event, 'forget', forget().then(() => reply(true), () => reply(false)));
    if (d.type === 'tops-prune') stayAlive(event, 'prune', pruneAll());
  } catch (e) { /* ignorera */ }
});

// ---------- Programfiler (/_next/static): unika namn, sparas direkt ----------
async function staticFile(event) {
  const req = event.request;
  let cache = null;
  try {
    cache = await caches.open(STATIC);
    const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
  } catch (e) { /* hämta från nätet */ }
  const res = await fetch(req);
  if (cache && res.ok && res.status === 200 && res.type === 'basic') {
    stayAlive(event, 'static-put', cache.put(req, res.clone()).then(() => counted(STATIC), () => {}));
  }
  return res;
}

const STATIC_RE = /static\/(?:chunks|css|media)\/[\w\-.~()[\]@%\/]+?\.(?:js|css|woff2?|ttf|otf|png|svg|jpg|webp)/g;
function staticUrls(text) {
  const out = [];
  (text.match(STATIC_RE) || []).forEach((p) => { const u = '/_next/' + p; if (out.indexOf(u) < 0) out.push(u); });
  return out;
}
async function warmStatic(urls) {
  const cache = await caches.open(STATIC);
  const list = [];
  urls.forEach((u) => {
    try {
      const x = new URL(u, self.location.origin);
      if (x.origin === self.location.origin && x.pathname.indexOf('/_next/static/') === 0 && list.indexOf(x.href) < 0) list.push(x.href);
    } catch (e) { /* ogiltig adress */ }
  });
  let i = 0;
  const worker = async () => {
    while (i < list.length && i < 400 && !updateWaiting()) {
      const u = list[i++];
      try {
        if (await cache.match(u, { ignoreSearch: true })) continue;
        const res = await fetchTimed(u, { credentials: 'same-origin' }, 20000);
        if (res.ok && res.status === 200 && res.type === 'basic') { await cache.put(u, res); counted(STATIC); }
      } catch (e) { i = list.length; }   // inget nät: försök nästa gång
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- Sidor: nätet först, annars den sparade versionen ----------
function pageKey(url) {
  const u = new URL(url.href);
  u.searchParams.delete('sw');
  const q = u.searchParams.toString();
  return u.origin + u.pathname + (q ? '?' + q : '');
}
async function lookupPage(key, url) {
  try {
    const cache = await caches.open(PAGES);
    let hit = await cache.match(key, { ignoreVary: true });
    // ?tab=jour och liknande: hellre sidan utan val än ingen sida alls
    if (!hit && url.search) hit = await cache.match(url.origin + url.pathname, { ignoreVary: true });
    if (!hit) return null;
    const at = Number(hit.headers.get('x-tops-at')) || 0;
    if (Date.now() - at > MAX_AGE) return null;
    return { at, response: hit };
  } catch (e) { return null; }
}
const isHtml = (res) => res.status === 200 && res.type === 'basic' && !res.redirected
  && /text\/html/.test(res.headers.get('content-type') || '');
async function storePage(key, res) {
  const html = await res.text();
  if (html.length > 3000000) return;
  const cache = await caches.open(PAGES);
  await cache.put(key, new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-tops-at': String(Date.now()) }
  }));
  counted(PAGES);
  // Programfilerna sidan behöver, så att den kan starta utan nät
  await warmStatic(staticUrls(html));
}
// De viktigaste sidorna i förväg (sidan och programfilerna, inte datan)
async function warmPages(paths) {
  let n = 0;
  for (const p of paths.slice(0, 12)) {
    // En ny version väntar: låt den ta över i stället, den sparar själv
    if (updateWaiting()) return n;
    if (typeof p !== 'string' || p.charAt(0) !== '/' || p.charAt(1) === '/') continue;
    const url = new URL(p, self.location.origin);
    if (NO_PAGE.test(url.pathname)) continue;
    const key = pageKey(url);
    const have = await lookupPage(key, { origin: url.origin, pathname: url.pathname, search: '' });
    if (have && Date.now() - have.at < 3600000) continue;
    let res;
    try { res = await fetchTimed(url.href, { credentials: 'same-origin', redirect: 'manual', headers: { accept: 'text/html' } }, 20000); }
    catch (e) { return n; }   // inget nät: försök nästa gång
    if (!isHtml(res)) { try { await res.body?.cancel(); } catch (e) { /* ignorera */ } continue; }
    try { await storePage(key, res); n++; } catch (e) { /* fullt minne */ }
  }
  return n;
}

async function page(event) {
  const req = event.request;
  const url = new URL(req.url);
  const keepPage = !NO_PAGE.test(url.pathname);
  const key = pageKey(url);
  let late = false;
  const net = fetch(req);
  stayAlive(event, 'page-store ' + url.pathname, net.then((res) => {
    markUp();
    // Inloggningssidan visas bara för den som är utloggad: töm det personliga
    if (url.pathname === '/login' && isHtml(res)) { if (late) drop(res); return forget(); }
    const copy = keepPage && isHtml(res) ? res.clone() : null;
    if (late) drop(res);
    if (copy) return storePage(key, copy);
  }).catch(() => {}));

  const saved = keepPage ? await lookupPage(key, url) : null;
  let res = null;
  try {
    res = await Promise.race([net, timeout(saved ? (recentlyDown() ? QUICK_TIMEOUT_MS : SAVED_TIMEOUT_MS) : NAV_TIMEOUT_MS)]);
  } catch (e) { res = null; }
  if (res) return res;
  late = true;

  if (saved) {
    markDown(saved.at);
    if (event.resultingClientId) servedPages.set(event.resultingClientId, saved.at);
    return saved.response;
  }
  // Startsidan "/" skickar vidare till översikten, även utan nät
  if (url.pathname === '/') {
    const dash = await lookupPage(url.origin + '/dashboard', { origin: url.origin, pathname: '/dashboard', search: '' });
    if (dash) return Response.redirect('/dashboard', 302);
  }
  markDown(0);
  try {
    const cache = await caches.open(SHELL);
    const hit = (await cache.match(OFFLINE_URL)) || (await caches.match(OFFLINE_URL));
    if (hit) return hit;
  } catch (e) { /* faller igenom */ }
  return Response.error();
}

// ---------- Sidbyten inne i appen ----------
// Appen hämtar nästa sida i bakgrunden. Svarar inte nätet ger vi upp efter en
// stund, och då laddar appen om sidan på vanligt sätt – som ovan, med den
// sparade versionen. Annars hade ett tryck i menyn inte gjort något alls.
async function rsc(event) {
  let late = false;
  const net = fetch(event.request);
  net.then((r) => { markUp(); if (late) drop(r); }, () => {});
  const res = await Promise.race([net.catch(() => null), timeout(recentlyDown() ? QUICK_TIMEOUT_MS : SAVED_TIMEOUT_MS)]);
  if (res) return res;
  late = true;
  markDown(0);
  return Response.error();
}

// ---------- Data från Supabase ----------
function target(url) {
  const rest = url.pathname.slice('/rest/v1/'.length);
  if (rest.indexOf('rpc/') === 0) return { rpc: true, name: rest.slice(4) };
  return { rpc: false, name: rest.split('/')[0] };
}
// Tidsstämplar i frågan (t.ex. "pass som slutar efter nu") byts mot ett
// tecken, så att samma fråga hittar det sparade svaret en stund senare.
const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
function dataKey(req, url, body) {
  const q = [];
  url.searchParams.forEach((v, k) => { q.push(k + '=' + v.replace(TS, '@')); });
  const h = (n) => req.headers.get(n) || '';
  const id = req.method + ' ' + url.pathname + '?' + q.join('&') + '|' + h('accept') + '|' + h('range')
    + '|' + h('prefer') + '|' + h('accept-profile') + '|' + body.replace(TS, '@');
  return self.location.origin + '/__tops/data?k=' + encodeURIComponent(id);
}
async function lookupData(key, who) {
  try {
    const hit = await (await caches.open(DATA)).match(key);
    if (!hit) return null;
    const at = Number(hit.headers.get('x-tops-at')) || 0;
    if (hit.headers.get('x-tops-user') !== who || Date.now() - at > MAX_AGE) return null;
    return { at, hit };
  } catch (e) { return null; }
}
function rebuild(hit, head) {
  const status = Number(hit.headers.get('x-tops-status')) || 200;
  const h = new Headers();
  hit.headers.forEach((v, k) => { if (k.indexOf('x-tops-') !== 0) h.set(k, v); });
  h.set('x-tops-saved', hit.headers.get('x-tops-at') || '');
  return new Response(head || status === 204 ? null : hit.body, { status, headers: h });
}
async function storeData(key, res, uid, head) {
  const buf = head ? new ArrayBuffer(0) : await res.arrayBuffer();
  if (buf.byteLength > 3000000) return;
  // Har någon annan hunnit logga in under tiden sparas inget
  if ((await getOwner()) !== uid) return;
  const h = new Headers();
  ['content-type', 'content-range', 'preference-applied', 'content-profile'].forEach((n) => {
    const v = res.headers.get(n);
    if (v) h.set(n, v);
  });
  h.set('x-tops-status', String(res.status));
  h.set('x-tops-at', String(Date.now()));
  h.set('x-tops-user', uid);
  await (await caches.open(DATA)).put(key, new Response(buf, { status: 200, headers: h }));
  counted(DATA);
}
function offline(msg, status) {
  return new Response(JSON.stringify({ message: msg, code: 'TOPS_OFFLINE', details: null, hint: null, statusCode: '503', error: 'offline' }), {
    status: status || 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-tops-offline': '1' }
  });
}

// Skrivningar går alltid till nätet. Utan nät ett tydligt svar på svenska
// i stället för "Load failed".
async function write(event) {
  try {
    const res = await fetch(event.request);
    markUp();
    return res;
  } catch (e) {
    markDown(0);
    return offline(MSG_WRITE);
  }
}

function data(event) {
  const req = event.request;
  const url = new URL(req.url);
  const t = target(url);
  const head = req.method === 'HEAD';
  const read = req.method === 'GET' || head || (req.method === 'POST' && t.rpc && RPCS.indexOf(t.name) >= 0);
  if (!read) return write(event);

  const uid = userOf(req);
  const ready = uid ? setOwner(uid) : Promise.resolve();
  const keepData = t.rpc ? RPCS.indexOf(t.name) >= 0 : TABLES.indexOf(t.name) >= 0;
  const bodyP = req.method === 'POST' ? req.clone().text() : Promise.resolve('');
  const keyP = keepData ? bodyP.then((b) => dataKey(req, url, b)) : Promise.resolve(null);
  let late = false;
  const net = fetch(req);
  stayAlive(event, 'data-store ' + t.name, net.then((res) => {
    markUp();
    const copy = keepData && uid && res.ok ? res.clone() : null;
    if (late) drop(res);
    if (!copy) return;
    return Promise.all([keyP, ready]).then((v) => (v[0] ? storeData(v[0], copy, uid, head) : drop(copy)));
  }).catch(() => {}));

  return (async () => {
    let key = null, saved = null;
    try {
      key = await keyP;
      await ready;
      const who = uid || await getOwner();
      saved = key && who ? await lookupData(key, who) : null;
    } catch (e) { saved = null; }
    let res = null;
    try {
      res = await Promise.race([net, timeout(saved ? (recentlyDown() ? QUICK_TIMEOUT_MS : DATA_SAVED_TIMEOUT_MS) : DATA_TIMEOUT_MS)]);
    } catch (e) { res = null; }
    if (res) return res;
    late = true;
    if (saved) {
      markDown(saved.at);
      return rebuild(saved.hit, head);
    }
    markDown(0);
    tell({ type: 'tops-miss' }, event.clientId);
    return offline(MSG_READ);
  })();
}

// ---------- Kartbilder: nätet först, de man sett sparas ----------
const isTile = (host) => TILE_HOSTS.some((h) => host === h || (h.indexOf('*.') === 0 && host.slice(-(h.length - 1)) === h.slice(1)));
async function tile(event) {
  const req = event.request;
  let hit = null;
  try { hit = await caches.match(req.url, { cacheName: TILES }); } catch (e) { hit = null; }
  let late = false;
  const net = fetch(req);
  // Bara svar som går att läsa (CORS) sparas. Ogenomskinliga svar tar
  // orimligt mycket lagringsutrymme i webbläsaren.
  stayAlive(event, 'tile-store', net.then((res) => {
    const copy = res.ok && (res.type === 'cors' || res.type === 'basic') ? res.clone() : null;
    if (late) drop(res);
    if (!copy) return;
    return caches.open(TILES).then((c) => c.put(req.url, copy)).then(() => counted(TILES));
  }).catch(() => {}));
  if (!hit) return net;
  const res = await Promise.race([net.catch(() => null), timeout(recentlyDown() ? QUICK_TIMEOUT_MS : SAVED_TIMEOUT_MS)]);
  if (!res) late = true;
  return res || hit;
}

// ---------- Pushnotiser ----------
// iOS kräver att varje push visar en notis, så det görs alltid.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  stayAlive(event, 'push', self.registration.showNotification(d.title || 'Work Cup', {
    body: d.body || '',
    tag: d.tag || undefined,
    data: { url: typeof d.url === 'string' && d.url.charAt(0) === '/' ? d.url : '/dashboard' },
    icon: '/icon-192.png',
    badge: '/icon-192.png'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard';
  stayAlive(event, 'notificationclick', (async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      try {
        await w.focus();
        if ('navigate' in w) await w.navigate(url);
        return;
      } catch (e) { /* prova nästa */ }
    }
    await self.clients.openWindow(url);
  })());
});

// ---------- Vägvalet ----------
self.addEventListener('fetch', (event) => {
  try {
    const req = event.request;
    const url = new URL(req.url);
    const same = url.origin === self.location.origin;

    // Utloggning: töm allt personligt. Själva anropet går till servern som vanligt.
    if (same && url.pathname === '/auth/signout') { stayAlive(event, 'signout', forget().catch(() => {})); return; }

    if (req.mode === 'navigate') {
      if (!same || req.method !== 'GET') return;
      if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/auth/') === 0) return;
      respondTracked(event, 'page ' + url.pathname, page(event).catch(() => fetch(req)));
      return;
    }

    if (same) {
      if (req.method !== 'GET') return;
      if (url.pathname.indexOf('/_next/static/') === 0) {
        respondTracked(event, 'static', staticFile(event).catch(() => fetch(req)));
      } else if ((req.headers.get('rsc') === '1' || url.searchParams.has('_rsc'))
        && url.pathname.indexOf('/api/') !== 0) {
        respondTracked(event, 'rsc ' + url.pathname, rsc(event).catch(() => Response.error()));
      }
      return;
    }

    if (SUPA && url.origin === SUPA) {
      if (url.pathname.indexOf('/rest/v1/') === 0) {
        respondTracked(event, 'data ' + url.pathname, data(event).catch(() => (req.method === 'GET' ? fetch(req) : offline(MSG_WRITE))));
      } else if (url.pathname.indexOf('/storage/v1/') === 0 && req.method !== 'GET' && req.method !== 'HEAD') {
        respondTracked(event, 'storage-write', write(event));
      }
      return;
    }

    if (req.method === 'GET' && isTile(url.host)) {
      respondTracked(event, 'tile', tile(event).catch(() => fetch(req)));
    }
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
