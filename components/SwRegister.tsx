'use client';
// Registrerar offline-workern (/offline-sw.js) och städar bort allt annat,
// bland annat den gamla /sw.js som låste appen i oktober.
//
// Tre sätt att stänga av, utan att någon behöver rensa webbplatsdata:
//  - OFFLINE_SW=off i Vercel + Redeploy: av för alla
//  - ?sw=off i adressen: av på den här enheten (?sw=on slår på igen)
//  - "Återställ appen" på offlinesidan
import { useEffect } from 'react';

export const SW_OFF_KEY = 'tops-sw-off';
const SW_URL = '/offline-sw.js';

export default function SwRegister({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let off = !enabled;
    try {
      const q = new URLSearchParams(window.location.search).get('sw');
      if (q === 'off') localStorage.setItem(SW_OFF_KEY, '1');
      if (q === 'on') localStorage.removeItem(SW_OFF_KEY);
      if (localStorage.getItem(SW_OFF_KEY) === '1') off = true;
    } catch {
      /* utan localStorage gäller serverns inställning */
    }

    (async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => {
        const w = r.active || r.waiting || r.installing;
        const ours = !!w && new URL(w.scriptURL).pathname === SW_URL;
        return off || !ours ? r.unregister() : Promise.resolve(true);
      }));
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys
          .filter((k) => off || !k.startsWith('tops-offline-'))
          .map((k) => caches.delete(k)));
      }
      if (off) return;
      // updateViaCache: 'none' – kontrollen av ny version går alltid mot
      // servern, så en rättad worker når telefonerna vid nästa sidladdning
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });

      // En ny version som väntar ska ta över direkt, inte först när alla
      // flikar stängts. Den ber om det själv vid installationen, men Chrome
      // glömmer det ibland – då puffar sidan på.
      const nudge = () => {
        const w = reg.waiting;
        if (w && new URL(w.scriptURL).pathname === SW_URL) {
          try { w.postMessage({ type: 'tops-skip' }); } catch { /* ignorera */ }
        }
      };
      nudge();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed') nudge(); });
      });
      timer = setInterval(nudge, 5000);
    })().catch(() => {
      /* utan worker fungerar appen precis som förut, bara utan offline */
    });
    return () => { if (timer) clearInterval(timer); };
  }, [enabled]);

  return null;
}
