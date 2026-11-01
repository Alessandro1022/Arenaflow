// Appens sida av offlineläget: pratar med service workern (lib/offline/swSource.ts).
// Allt här är frivilligt – utan worker fungerar appen som vanligt, bara utan offline.

// Sidorna som sparas i förväg, så att de öppnas utan täckning även om man inte
// besökt dem. Bara sidan och programfilerna, inte datan. Shell väljer bort det
// personen inte har tillgång till.
export const WARM_PAGES = ['/dashboard', '/shifts', '/incidents', '/chat', '/sjukvard', '/staffing', '/schools', '/map', '/news', '/tasks'];

const WARM_KEY = 'tops-warm';
const BUILD = process.env.TOPS_BUILD || 'dev';

async function activeWorker(): Promise<ServiceWorker | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), 3000))
    ]);
    return reg?.active ?? null;
  } catch {
    return null;
  }
}

// Fråga workern och vänta på svar. null om ingen worker eller inget svar.
export async function askWorker<T>(msg: unknown, ms = 2000): Promise<T | null> {
  const w = await activeWorker();
  if (!w) return null;
  return new Promise<T | null>((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), ms);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data as T); };
    try { w.postMessage(msg, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
  });
}

async function tellWorker(msg: unknown) {
  const w = await activeWorker();
  try { w?.postMessage(msg); } catch { /* ignorera */ }
}

// Programfilerna den här sidan använder. Första sidladdningen sker innan
// workern tagit över och går då förbi den – utan det här kunde den sparade
// sidan inte starta utan nät.
export function warmThisPage() {
  const urls = new Set<string>();
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (e.name.includes('/_next/static/')) urls.add(e.name);
    }
    document.querySelectorAll('script[src], link[href]').forEach((el) => {
      const u = (el as HTMLScriptElement).src || (el as HTMLLinkElement).href;
      if (u && u.includes('/_next/static/')) urls.add(u);
    });
  } catch { /* ingen lista: workern sparar ändå det som hämtas härefter */ }
  if (urls.size) tellWorker({ type: 'tops-static', urls: [...urls] });
}

// De viktigaste sidorna i förväg: högst var sjätte timme, och direkt efter
// en ny version av appen
export async function warmPages(paths: string[]) {
  const sig = paths.join(',');
  try {
    const last = JSON.parse(localStorage.getItem(WARM_KEY) || 'null');
    if (last && last.v === BUILD && last.p === sig && Date.now() - last.at < 6 * 3600e3) return;
  } catch { /* kör */ }
  const n = await askWorker<number>({ type: 'tops-pages', paths }, 180000);
  if (n === null) return;
  try { localStorage.setItem(WARM_KEY, JSON.stringify({ at: Date.now(), v: BUILD, p: sig })); } catch { /* ignorera */ }
}

// Utloggning: allt personligt bort ur telefonen. Workern gör samma sak när
// den ser utloggningen, det här är för säkerhets skull.
export async function forgetOffline() {
  try { localStorage.removeItem(WARM_KEY); } catch { /* ignorera */ }
  try {
    if (typeof caches !== 'undefined') {
      await Promise.all(['tops-offline-pages', 'tops-offline-data', 'tops-offline-meta'].map((k) => caches.delete(k)));
    }
  } catch { /* ignorera */ }
  await askWorker({ type: 'tops-forget' }, 1500);
}
