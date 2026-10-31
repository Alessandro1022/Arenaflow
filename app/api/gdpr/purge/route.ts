// Gallra nu, eller visa vad som skulle gallras (dry). Admin i den egna turneringen.
// Databasen avgör vad som får gallras; servern behövs för att ta bort filerna.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { supabaseUrl } from '@/lib/supabase/env';
import { effectiveTier } from '@/lib/mfa';
import { purgeTenant } from '@/lib/gdpr';
import type { Role } from '@/lib/types';

export const maxDuration = 120;

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });
  const { data: me } = await supabase.from('profiles').select('role, tenant_id').eq('id', user.id).single();
  if (!me?.tenant_id || (await effectiveTier(supabase, me.role as Role)) < 5) {
    return NextResponse.json({ error: 'Endast admin kan gallra' }, { status: 403 });
  }
  const { dry } = await req.json().catch(() => ({}));
  try {
    if (dry) {
      const [{ data: result, error }, { data: paths }] = await Promise.all([
        supabase.rpc('run_retention', { t: me.tenant_id, dry: true }),
        supabase.rpc('retention_attachment_paths', { t: me.tenant_id })
      ]);
      if (error) throw new Error(error.message);
      return NextResponse.json({ result, files: Array.isArray(paths) ? paths.length : 0 });
    }
    const service = createSupabase(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const result = await purgeTenant(service, supabase, me.tenant_id);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Gallringen misslyckades' }, { status: 500 });
  }
}
