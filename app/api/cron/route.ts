// Körs av Vercel Cron 05:00 och 19:00 UTC (07/21 svensk sommartid).
// Genererar morgon-/kvällsrapporter: översikt, skolor, säkerhetsrutter,
// samt matchrapport när det finns gula/röda matcher.
//
// Kör med service-nyckeln, som kringgår RLS. Därför loopas turneringarna
// explicit och varje fråga filtreras på tenant_id – utan det hade alla
// turneringars data hamnat i samma rapport.
import { NextResponse } from 'next/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { generateReport, type TenantInfo } from '@/lib/ai';
import { supabaseUrl } from '@/lib/supabase/env';
import { purgeTenant } from '@/lib/gdpr';
import { afterPurge, createBackup, pruneBackups } from '@/lib/backup';

export const maxDuration = 300;

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = createSupabase(
    supabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const hour = new Date().getUTCHours();
  const slot = hour < 12 ? 'morning' : 'evening';

  // Gallring enligt lagringstiderna, en gång per dygn. Gäller alla turneringar
  // med en sista dag – även de som inte pågår, det är just då det blir dags.
  // Därefter en säkerhetskopia per turnering. Raderade gallringen något tas
  // de äldre kopiorna bort, så att det raderade inte finns kvar i dem.
  const gallring: Record<string, unknown> = {};
  const backuper: Record<string, unknown> = {};
  const q = new URL(req.url).searchParams;
  if (slot === 'morning' || q.get('gallra') === '1') {
    const { data: all } = await db.from('tenants').select('id,name,ends_on');
    for (const t of all ?? []) {
      let purged: Record<string, unknown> = {};
      if (t.ends_on) {
        try { purged = await purgeTenant(db, db, t.id); gallring[t.name] = purged; }
        catch (e) { gallring[t.name] = { fel: e instanceof Error ? e.message : 'fel' }; }
      }
      try {
        if (!(await afterPurge(db, t.id, t.name, purged))) await createBackup(db, t.id, t.name);
        await pruneBackups(db, t.id);
        backuper[t.name] = 'ok';
      } catch (e) { backuper[t.name] = e instanceof Error ? e.message : 'fel'; }
    }
  }

  // Bara turneringar som pågår – ingen vits att skriva rapport för en
  // turnering som ligger i malpåse till nästa år.
  const { data: tenants, error: tErr } = await db
    .from('tenants').select('id,name,sport,city,labels').eq('active', true);

  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
  if (!tenants?.length) return NextResponse.json({ slot, gallring, backuper, note: 'inga pågående turneringar' });

  const out: Record<string, Record<string, string>> = {};

  for (const row of tenants) {
    const tenant: TenantInfo = {
      id: row.id,
      name: row.name,
      sport: row.sport,
      city: row.city,
      playingAreas: (row.labels as { playingAreas?: string } | null)?.playingAreas
    };
    const results: Record<string, string> = {};

    for (const kind of ['overview', 'schools', 'security'] as const) {
      try { await generateReport(db, kind, slot, tenant); results[kind] = 'ok'; }
      catch (e) { results[kind] = e instanceof Error ? e.message : 'fel'; }
    }

    // Matchrapport endast när flaggade matcher finns idag
    try {
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      const t1 = new Date(); t1.setHours(23, 59, 59, 999);
      const { count } = await db.from('arena_matches')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .neq('risk_level', 'green').neq('status', 'cancelled')
        .gte('starts_at', t0.toISOString()).lte('starts_at', t1.toISOString());
      if ((count ?? 0) > 0) { await generateReport(db, 'matches', slot, tenant); results.matches = 'ok'; }
      else results.matches = 'inga flaggade';
    } catch (e) { results.matches = e instanceof Error ? e.message : 'fel'; }

    out[row.name] = results;
  }

  return NextResponse.json({ slot, gallring, backuper, tenants: out });
}
