'use client';
// Sparar offlinepaketet medan det finns täckning, och visar en rad högst upp
// när nätet försvinner med en väg till den sparade informationen.
//
// Paketet byggs om när appen öppnas, var 15:e minut, när täckningen kommer
// tillbaka och när man återvänder till appen – men aldrig oftare än var
// femte minut, så att 300 telefoner inte belastar databasen i onödan.
import { useEffect, useMemo, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useTenant } from '@/components/TenantProvider';
import { useLang } from '@/components/LanguageProvider';
import { buildSnapshot, readSnapshot, saveSnapshot } from '@/lib/offline/snapshot';

const MIN_AGE_MS = 5 * 60e3;
const INTERVAL_MS = 15 * 60e3;

export default function OfflineSync({ tier, roleLabel }: { tier: number; roleLabel: string }) {
  const supabase = useMemo(() => createClient(), []);
  const tn = useTenant();
  const { lang } = useLang();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    let busy = false;
    let stopped = false;
    const run = async (force = false) => {
      if (busy || stopped || !navigator.onLine) return;
      const cur = readSnapshot();
      const fresh = cur && Date.now() - Date.parse(cur.savedAt) < MIN_AGE_MS
        && cur.tenant?.name === tn.name && cur.lang === lang;
      if (!force && fresh) return;
      busy = true;
      try {
        const s = await buildSnapshot(supabase, {
          tier, lang, roleLabel,
          tenantName: tn.name, logoText: tn.logoText, placeLabel: tn.labels.playingArea
        });
        if (s && !stopped) {
          saveSnapshot(s);
          window.dispatchEvent(new Event('tops:offline-saved'));
        }
      } catch {
        /* nästa försök gör jobbet */
      } finally {
        busy = false;
      }
    };
    // Vänta in turneringens namn och färger innan första paketet
    const first = setTimeout(() => run(), 2500);
    const timer = setInterval(() => run(), INTERVAL_MS);
    const onOnline = () => run();
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    const onForce = () => run(true);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('tops:offline-save', onForce);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('tops:offline-save', onForce);
    };
  }, [supabase, tier, lang, roleLabel, tn.name, tn.logoText, tn.labels.playingArea]);

  if (online) return null;
  return (
    <a className="offline-bar" href="/offline.html">
      <WifiOff size={15} /> Ingen täckning. Visa sparad info
    </a>
  );
}
