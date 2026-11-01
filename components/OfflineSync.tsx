'use client';
// Sparar det som behövs utan täckning, medan det finns täckning:
//  - offlinepaketet (nödnummer, jour, egna pass och platser) som offlinesidan
//    och jourpanelen läser när nätet är borta
//  - de viktigaste sidorna och appens programfiler, via service workern
//
// Paketet byggs om när appen öppnas, var 15:e minut, när täckningen kommer
// tillbaka och när man återvänder till appen – men aldrig oftare än var
// femte minut, så att 300 telefoner inte belastar databasen i onödan.
import { useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTenant } from '@/components/TenantProvider';
import { useLang } from '@/components/LanguageProvider';
import { buildSnapshot, readSnapshot, saveSnapshot } from '@/lib/offline/snapshot';
import { warmPages, warmThisPage } from '@/lib/offline/client';

const MIN_AGE_MS = 5 * 60e3;
const INTERVAL_MS = 15 * 60e3;

export default function OfflineSync({ tier, roleLabel, warmPaths }: { tier: number; roleLabel: string; warmPaths: string[] }) {
  const supabase = useMemo(() => createClient(), []);
  const tn = useTenant();
  const { lang } = useLang();
  const warmSig = warmPaths.join(',');

  useEffect(() => {
    let busy = false;
    let stopped = false;
    const run = async (force = false) => {
      if (busy || stopped || !navigator.onLine) return;
      busy = true;
      try {
        // Ett paket som någon annan sparade på telefonen räknas aldrig som färskt
        const { data: sess } = await supabase.auth.getSession();
        const cur = readSnapshot();
        const fresh = cur && Date.now() - Date.parse(cur.savedAt) < MIN_AGE_MS
          && cur.userId === sess.session?.user.id
          && cur.tenant?.name === tn.name && cur.lang === lang;
        if (!force && fresh) return;
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

  // Sidorna och programfilerna, en stund efter att sidan laddats så att det
  // inte konkurrerar med det man faktiskt tittar på
  useEffect(() => {
    const paths = warmSig ? warmSig.split(',') : [];
    const t = setTimeout(() => {
      if (!navigator.onLine) return;
      warmThisPage();
      if (paths.length) warmPages(paths);
    }, 6000);
    return () => clearTimeout(t);
  }, [warmSig]);

  return null;
}
