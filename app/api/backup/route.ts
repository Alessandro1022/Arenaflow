// Säkerhetskopior för den egna turneringen (admin). Hinken är privat, så
// allt går via servern med service-nyckeln efter att behörigheten prövats.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { supabaseUrl } from '@/lib/supabase/env';
import { effectiveTier } from '@/lib/mfa';
import { createBackup, listBackups, pruneBackups, readBackup, restoreMissing } from '@/lib/backup';
import type { Role } from '@/lib/types';

export const maxDuration = 120;

async function admin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: 'Ej inloggad' }, { status: 401 }) };
  const { data: me } = await supabase.from('profiles').select('role, tenant_id').eq('id', user.id).single();
  if (!me?.tenant_id || (await effectiveTier(supabase, me.role as Role)) < 5) {
    return { error: NextResponse.json({ error: 'Endast admin kommer åt säkerhetskopiorna' }, { status: 403 }) };
  }
  const { data: t } = await supabase.from('tenants').select('name').eq('id', me.tenant_id).maybeSingle();
  const service = createSupabase(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  return { tenantId: me.tenant_id as string, tenantName: (t?.name as string) ?? 'Turneringen', service };
}

export async function GET(req: Request) {
  const a = await admin();
  if ('error' in a) return a.error;
  try {
    const file = new URL(req.url).searchParams.get('file');
    if (file) {
      // Nedladdning som vanlig JSON, så att den går att öppna och spara i telefonen
      const backup = await readBackup(a.service, a.tenantId, file);
      return new NextResponse(JSON.stringify(backup, null, 1), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="sakerhetskopia-${file.replace(/\.json\.gz$/, '')}.json"`
        }
      });
    }
    return NextResponse.json({ files: await listBackups(a.service, a.tenantId) });
  } catch (e) {
    return failure(e);
  }
}

// Fel filnamn eller saknad kopia är fel i frågan, inte i servern
function failure(e: unknown) {
  const msg = e instanceof Error ? e.message : 'Fel';
  const status = /Ogiltigt filnamn/.test(msg) ? 400 : /hittades inte|not found|annan turnering/i.test(msg) ? 404 : 500;
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: Request) {
  const a = await admin();
  if ('error' in a) return a.error;
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === 'create') {
      const file = await createBackup(a.service, a.tenantId, a.tenantName);
      await pruneBackups(a.service, a.tenantId);
      return NextResponse.json({ file });
    }
    if (body.action === 'restore' && typeof body.file === 'string') {
      const backup = await readBackup(a.service, a.tenantId, body.file);
      const out = await restoreMissing(a.service, a.tenantId, backup, !!body.dry);
      return NextResponse.json(out);
    }
    return NextResponse.json({ error: 'Okänd åtgärd' }, { status: 400 });
  } catch (e) {
    return failure(e);
  }
}
