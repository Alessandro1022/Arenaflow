'use client';
// Raden högst upp i appen när servern inte nås. Appen fortsätter fungera med
// det som är sparat i telefonen, och raden säger det rakt ut: att det är
// sparat och från när. När täckningen kommer tillbaka skickas det som väntar
// (lib/offline/outbox.ts) och raden erbjuder att uppdatera sidan.
//
// Tre signaler, eftersom ingen ensam räcker på iPhone:
//  - webbläsarens online/offline (flygplansläge)
//  - service workern, som vet när den svarat med något sparat
//  - en liten koll mot /api/ping var tionde sekund medan täckningen är borta
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { RefreshCw, Send, Wifi, WifiOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { askWorker } from '@/lib/offline/client';
import { netState, setNetState, useNetState } from '@/lib/offline/status';
import { flushOutbox, pruneOutbox, readOutbox, OUTBOX_EVENT } from '@/lib/offline/outbox';

type NetReply = { down: boolean; savedAt: number | null; page: number | null };

const PING_MS = 10000;
const FLUSH_MS = 30000;

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function when(at: number) {
  const d = new Date(at);
  const hm = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400e3);
  if (days <= 0) return hm;
  if (days === 1) return `i går ${hm}`;
  return `${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} ${hm}`;
}

function goOffline(at: number | null) {
  const cur = netState();
  const savedAt = at && (!cur.savedAt || at < cur.savedAt) ? at : cur.savedAt;
  setNetState({ offline: true, back: false, savedAt });
}

export default function OfflineBar({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const net = useNetState();
  const pathname = usePathname();
  const [waiting, setWaiting] = useState(0);
  const [failed, setFailed] = useState(0);
  const flushRef = useRef<() => void>(() => {});

  // Det som väntar på att skickas
  useEffect(() => {
    const count = () => {
      const items = readOutbox(userId);
      setWaiting(items.filter((i) => !i.error).length);
      setFailed(items.filter((i) => i.error).length);
    };
    const flush = async () => {
      if (!readOutbox(userId).some((i) => !i.error)) return;
      const sent = await flushOutbox(supabase);
      count();
      if (sent > 0) window.dispatchEvent(new Event('tops:outbox-sent'));
    };
    flushRef.current = flush;
    let soon: ReturnType<typeof setTimeout> | null = null;
    // Något nytt i kön (eller "Försök igen"): skicka direkt om det går
    const changed = () => {
      count();
      if (soon) clearTimeout(soon);
      soon = setTimeout(() => { if (!netState().offline) flush(); }, 800);
    };
    pruneOutbox(userId);
    count();
    flush();
    window.addEventListener(OUTBOX_EVENT, changed);
    window.addEventListener('storage', count);
    const t = setInterval(() => { if (!netState().offline) flush(); }, FLUSH_MS);
    return () => {
      clearInterval(t);
      if (soon) clearTimeout(soon);
      window.removeEventListener(OUTBOX_EVENT, changed);
      window.removeEventListener('storage', count);
    };
  }, [supabase, userId]);

  // Täckningsläget
  useEffect(() => {
    let alive = true;
    let pinging = false;
    const back = () => {
      if (!netState().offline) return;
      setNetState({ offline: false, back: true, savedAt: null, miss: false });
      flushRef.current();
    };
    const ping = async () => {
      if (pinging) return;
      pinging = true;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      try {
        const res = await fetch(`/api/ping?t=${Date.now()}`, { cache: 'no-store', signal: ctl.signal });
        if (res.ok && alive) back();
      } catch { /* fortfarande ingen täckning */ }
      clearTimeout(t);
      pinging = false;
    };

    if (!navigator.onLine) goOffline(null);
    askWorker<NetReply>({ type: 'tops-net?' }).then((r) => {
      if (!alive || !r) return;
      if (r.page) goOffline(r.page);
      if (r.down) goOffline(r.savedAt);
    });

    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'tops-net') {
        if (d.down) goOffline(typeof d.savedAt === 'number' ? d.savedAt : null);
        else back();
      }
      if (d.type === 'tops-miss') { goOffline(null); setNetState({ miss: true }); }
    };
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    sw?.addEventListener('message', onMsg);
    const onOffline = () => goOffline(null);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', ping);
    const timer = setInterval(() => { if (netState().offline) ping(); }, PING_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      sw?.removeEventListener('message', onMsg);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', ping);
    };
  }, []);

  // Ny sida: det som saknades på den förra spelar ingen roll längre
  useEffect(() => { if (netState().miss) setNetState({ miss: false }); }, [pathname]);

  if (net.offline) {
    const what = net.miss
      ? 'allt finns inte sparat i telefonen'
      : net.savedAt ? `visar läget från ${when(net.savedAt)}` : 'visar senast sparade läge';
    return (
      <div className="net-bar off" role="status">
        <WifiOff size={15} />
        <span className="net-text">
          <b>Ingen täckning</b> · {what}
          {waiting > 0 && <> · {waiting} väntar på att skickas</>}
        </span>
        <a className="net-link" href="/offline.html">Nödinfo</a>
      </div>
    );
  }
  if (net.back) {
    return (
      <div className="net-bar back" role="status">
        <Wifi size={15} />
        <span className="net-text"><b>Täckningen är tillbaka</b>{waiting > 0 ? ' · skickar det som väntade' : ''}</span>
        <button type="button" className="net-btn" onClick={() => window.location.reload()}>
          <RefreshCw size={14} /> Uppdatera
        </button>
      </div>
    );
  }
  if (waiting > 0 || failed > 0) {
    return (
      <div className={`net-bar ${failed ? 'fail' : 'queue'}`} role="status">
        <Send size={15} />
        <span className="net-text">
          {waiting > 0 && <>{waiting} väntar på att skickas</>}
          {waiting > 0 && failed > 0 && ' · '}
          {failed > 0 && <><b>{failed} kunde inte skickas</b> – se chatten eller incidenterna</>}
        </span>
        {waiting > 0 && (
          <button type="button" className="net-btn" onClick={() => flushRef.current()}>Skicka nu</button>
        )}
      </div>
    );
  }
  return null;
}
