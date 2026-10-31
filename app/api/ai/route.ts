// AI-endpoint: generera rapporter/rutter på begäran + fråga AI:n.
// Kör med användarens egen klient, så RLS begränsar redan till rätt
// turnering. tenant skickas ändå med: promptet behöver turneringens namn,
// och filtret i frågorna är ett andra lager om en policy skulle fallera.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { type Role } from '@/lib/types';
import { effectiveTier } from '@/lib/mfa';
import { callGemini, gatherContext, generateReport, reportPrompt, type TenantInfo } from '@/lib/ai';

export const maxDuration = 60;

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role, tenant_id').eq('id', user.id).single();
  const tier = await effectiveTier(supabase, profile?.role as Role);

  if (!profile?.tenant_id) {
    return NextResponse.json({ error: 'Ingen turnering kopplad till ditt konto' }, { status: 400 });
  }

  const { data: t } = await supabase
    .from('tenants').select('id,name,sport,city,labels').eq('id', profile.tenant_id).maybeSingle();

  const tenant: TenantInfo = {
    id: profile.tenant_id,
    name: t?.name ?? 'Turneringen',
    sport: t?.sport,
    city: t?.city,
    playingAreas: (t?.labels as { playingAreas?: string } | null)?.playingAreas
  };

  const body = await req.json().catch(() => ({}));
  const action = body.action as string;

  try {
    if (action === 'report') {
      if (tier < 3) return NextResponse.json({ error: 'Behörighet saknas' }, { status: 403 });
      const kind = ['overview', 'schools', 'security', 'matches'].includes(body.kind) ? body.kind : 'overview';
      const slot = ['morning', 'evening'].includes(body.slot) ? body.slot : 'manual';
      const text = await generateReport(supabase, kind, slot, tenant);
      return NextResponse.json({ body: text });
    }
    if (action === 'ask') {
      if (tier < 2) return NextResponse.json({ error: 'Behörighet saknas' }, { status: 403 });
      const q = String(body.question ?? '').slice(0, 500);
      if (!q) return NextResponse.json({ error: 'Ingen fråga' }, { status: 400 });
      const ctx = await gatherContext(supabase, tenant.id);
      const text = await callGemini(
        `${reportPrompt('overview', 'manual', ctx, undefined, tenant).split('\n\nSkriv en')[0]}\n\nBesvara frågan kort och konkret utifrån lägesbilden. Fråga: "${q}"\n\nLÄGESBILD (JSON):\n${JSON.stringify(ctx, null, 1)}`
      );
      return NextResponse.json({ body: text });
    }
    return NextResponse.json({ error: 'Okänd action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Fel' }, { status: 500 });
  }
}
