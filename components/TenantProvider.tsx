'use client';
// Läser aktiv turnering ur databasen och applicerar namn, färger och moduler
// i realtid. Faller tillbaka på lib/tenant.ts om tabellen saknas.
// event_settings läggs på sist som finjustering ovanpå turneringens tema.
//
// Viktigt: Supabase-klienten skapas INUTI effekten, aldrig under render.
// Providern omsluter hela appen – kastar den under render blir allt vitt.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { tenant as fallback } from '@/lib/tenant';
import { hasModule, type FeatureKey, type TenantRow } from '@/lib/features';

type Ctx = {
  active: TenantRow | null;
  name: string;
  shortName: string;
  sport: string;
  city: string;
  logoText: string;
  logoUrl: string | null;
  labels: {
    playingArea: string; playingAreas: string; matchStart: string;
    school: string; schools: string; area: string; areas: string;
  };
  has: (f: FeatureKey) => boolean;
  canWrite: (f: FeatureKey) => boolean;
  isOwner: boolean;
  reload: () => void;
};

const fallbackCtx = (): Ctx => ({
  active: null,
  name: fallback.event.name,
  shortName: fallback.event.shortName,
  sport: fallback.event.sport,
  city: fallback.event.city,
  logoText: fallback.event.logoText,
  logoUrl: null,
  labels: {
    playingArea: fallback.labels.playingArea,
    playingAreas: fallback.labels.playingAreas,
    matchStart: fallback.labels.matchStart,
    school: fallback.labels.school,
    schools: fallback.labels.schools,
    area: fallback.labels.area,
    areas: fallback.labels.areas
  },
  has: () => true,
  canWrite: () => true,
  isOwner: false,
  reload: () => {}
});

const TenantCtx = createContext<Ctx | null>(null);

// Fungerar även utan provider – då gäller den statiska konfigurationen
export function useTenant(): Ctx {
  return useContext(TenantCtx) ?? fallbackCtx();
}

// Typvakt: gör att TypeScript vet att värdet är en string efter kontrollen
const isHex = (v?: string | null): v is string => !!v && /^#[0-9a-fA-F]{6}$/.test(v);

export default function TenantProvider({ children }: { children: React.ReactNode }) {
  const [row, setRow] = useState<TenantRow | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  // Vad den inloggades ROLL nar. Tom karta = del 12b inte kord an,
  // och da ska tier-regeln galla som forut i stallet for att dolja allt.
  const [levels, setLevels] = useState<Record<string, string> | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    // Saknas miljövariabler ska appen fortfarande starta, bara utan tema
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch {
      return;
    }

    // Får aldrig kasta. Saknas tabellerna gäller lib/tenant.ts tyst.
    const load = async () => {
      try {
        // my_tenant_row() ger den inloggades EGEN turnering. En vanlig
        // select mot tenants duger inte: för plattformsägaren returnerar
        // den alla turneringar, och "första raden" vore fel svar.
        const { data } = await supabase
          .rpc('my_tenant_row')
          .maybeSingle()
          .then((r) => r, () => ({ data: null }));
        if (cancelled) return;

        const active = (data ?? null) as TenantRow | null;
        setRow(active);

        // Ägarflaggan styr om turneringsväxlaren och Plattform visas.
        // Egna profilraden går alltid att läsa, även före tenant_id satts.
        const { data: u } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
        if (u?.user) {
          const { data: p } = await supabase
            .from('profiles').select('platform_owner').eq('id', u.user.id).maybeSingle()
            .then((r) => r, () => ({ data: null }));
          if (!cancelled) setIsOwner(!!p?.platform_owner);
        }

        const { data: mods } = await supabase.rpc('my_modules')
          .then((r) => r, () => ({ data: null }));
        if (!cancelled) {
          const list = (mods ?? []) as { module: string; level: string }[];
          setLevels(list.length ? Object.fromEntries(list.map((m) => [m.module, m.level])) : null);
        }

        // Färger från turneringens tema. Saknas ett värde återställs
        // grundtemat – aldrig removeProperty, för variablerna sattes av
        // layout.tsx som inline-stil på <html>. Tar man bort dem blir
        // --primary odefinierad och knapparna osynliga: vit text på vitt.
        const root = document.documentElement;
        const bt = fallback.theme;
        const set = (k: string, v: string | undefined, def: string) => {
          root.style.setProperty(k, isHex(v) ? v : def);
        };
        const c = active?.colors ?? {};
        set('--primary', c.primary, bt.primary);
        set('--primary-dark', c.primaryDark, bt.primaryDark);
        set('--panel-2', c.panel2, bt.panel2);
        set('--accent', c.accent, bt.accent);
        set('--bg', c.bg, bt.bg);

        if (active?.name) document.title = `${active.name} · ArenaFlow`;
      } catch {
        // Tyst fallback – appen ska fungera utan tenants-tabellen
      }
    };

    load();

    // Inloggningen byter inte sida på riktigt, så providern ligger kvar från
    // inloggningssidan med den utloggade bilden: ingen turnering, inte ägare.
    // Utan lyssnaren syntes till exempel inte Plattform förrän man laddat om.
    let authSub: { unsubscribe: () => void } | null = null;
    try {
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
          // Inte direkt i lyssnaren: Supabase-anrop därifrån kan låsa sig
          setTimeout(() => { if (!cancelled) load(); }, 0);
        }
      });
      authSub = data.subscription;
    } catch { /* ignorera */ }

    try {
      const ch = supabase
        .channel('tenant-rt')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tenants' }, load)
        .subscribe();
      return () => {
        cancelled = true;
        authSub?.unsubscribe();
        try { supabase.removeChannel(ch); } catch { /* ignorera */ }
      };
    } catch {
      return () => { cancelled = true; authSub?.unsubscribe(); };
    }
  }, [tick]);

  const base = fallbackCtx();
  const value: Ctx = {
    active: row,
    name: row?.name || base.name,
    shortName: row?.short_name || base.shortName,
    sport: row?.sport || base.sport,
    city: row?.city || base.city,
    logoText: row?.logo_text || base.logoText,
    logoUrl: row?.logo_url ?? null,
    labels: {
      playingArea: row?.labels?.playingArea || base.labels.playingArea,
      playingAreas: row?.labels?.playingAreas || base.labels.playingAreas,
      matchStart: row?.labels?.matchStart || base.labels.matchStart,
      school: row?.labels?.school || base.labels.school,
      schools: row?.labels?.schools || base.labels.schools,
      area: row?.labels?.area || base.labels.area,
      areas: row?.labels?.areas || base.labels.areas
    },
    // Bada maste saga ja: ingar modulen i turneringens paket, och nar
    // rollen den? Paketet ar vad kunden betalat for, rollen vad personen
    // jobbar med.
    has: (f) => (row ? hasModule(row.features, f) : true) && (levels ? !!levels[f] : true),
    canWrite: (f) => (row ? hasModule(row.features, f) : true) && (levels ? levels[f] === 'write' : true),
    isOwner,
    reload
  };

  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>;
}
