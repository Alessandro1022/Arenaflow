// Nollställ någons tvåfaktor, t.ex. när telefonen är borttappad.
// Admin och uppåt, i den egna turneringen, och bara för någon som inte har
// högre roll än en själv. Personen får slå på tvåfaktor igen vid nästa
// inloggning.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { tierOf, type Role } from '@/lib/types';
import { supabaseUrl } from '@/lib/supabase/env';
import { effectiveTier } from '@/lib/mfa';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });

  const { data: me } = await supabase.from('profiles').select('role, tenant_id').eq('id', user.id).single();
  const myTier = await effectiveTier(supabase, me?.role as Role);
  if (myTier < 5) return NextResponse.json({ error: 'Endast admin kan nollställa tvåfaktor' }, { status: 403 });

  const { userId } = await req.json().catch(() => ({}));
  if (!userId || typeof userId !== 'string') return NextResponse.json({ error: 'Person saknas' }, { status: 400 });

  // RLS ger bara personer i den egna turneringen
  const { data: target } = await supabase.from('profiles').select('role, tenant_id').eq('id', userId).maybeSingle();
  if (!target || target.tenant_id !== me?.tenant_id) return NextResponse.json({ error: 'Personen hittades inte' }, { status: 404 });
  if (tierOf(target.role as Role) > myTier) {
    return NextResponse.json({ error: 'Du kan inte nollställa för någon med högre roll än din egen' }, { status: 403 });
  }

  const service = createSupabase(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await service.auth.admin.mfa.listFactors({ userId });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  let removed = 0;
  for (const f of data?.factors ?? []) {
    const { error: e } = await service.auth.admin.mfa.deleteFactor({ userId, id: f.id });
    if (e) return NextResponse.json({ error: e.message }, { status: 500 });
    removed++;
  }
  return NextResponse.json({ ok: true, removed });
}
