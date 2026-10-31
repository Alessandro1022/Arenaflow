// Inbjudningar: admin anger e-post + roll + scope.
// Supabase skickar inbjudningsmejlet; apply_invite-triggern sätter roll,
// turnering och scope vid första inloggningen.
//
// Tenant-regeln: en admin bjuder in till SIN egen turnering. Bara
// plattformsägaren får bjuda in till en annan - det är så en ny
// turneringschef får sitt konto.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { tierOf, type Role } from '@/lib/types';
import { supabaseUrl } from '@/lib/supabase/env';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role, tenant_id, platform_owner').eq('id', user.id).single();

  if (tierOf((profile?.role ?? 'volunteer') as Role) < 5) {
    return NextResponse.json({ error: 'Endast admin kan bjuda in' }, { status: 403 });
  }

  const { email, role, areaId, locationType, locationId, tenantId, fullName } = await req.json().catch(() => ({}));
  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: 'Ogiltig e-post' }, { status: 400 });
  }
  // Ingen kan bjuda in någon med högre roll än sin egen
  const inviterTier = tierOf((profile?.role ?? 'volunteer') as Role);
  if (role && tierOf(role as Role) > inviterTier && !profile?.platform_owner) {
    return NextResponse.json({ error: 'Du kan inte bjuda in någon med högre roll än din egen' }, { status: 403 });
  }

  // Vilken turnering hamnar personen i?
  const isOwner = !!profile?.platform_owner;
  const targetTenant = tenantId && isOwner ? tenantId : profile?.tenant_id;

  if (!targetTenant) {
    return NextResponse.json({ error: 'Ingen turnering kopplad till ditt konto' }, { status: 400 });
  }
  if (tenantId && !isOwner && tenantId !== profile?.tenant_id) {
    return NextResponse.json(
      { error: 'Du kan bara bjuda in till din egen turnering' }, { status: 403 }
    );
  }

  // Scope hör till en plats i den egna turneringen – skicka inte med det
  // när ägaren bjuder in en chef till en annan turnering.
  const crossTenant = targetTenant !== profile?.tenant_id;

  const service = createSupabase(
    supabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // 1) Stage:a turnering + roll + scope
  const { data: inv, error: invErr } = await service.from('invites').insert({
    email,
    role: role || 'volunteer',
    tenant_id: targetTenant,
    area_id: crossTenant ? null : (areaId || null),
    location_type: crossTenant ? null : (locationType || null),
    location_id: crossTenant ? null : (locationId || null),
    invited_by: user.id
  }).select('id').single();
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

  // 2) Skicka Supabase-inbjudan. Namnet följer med och hamnar i profilen.
  const origin = req.headers.get('origin') ?? new URL(req.url).origin;
  const { error } = await service.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/callback`,
    data: fullName ? { full_name: String(fullName).slice(0, 120) } : undefined
  });
  if (error) {
    // Gick mejlet inte iväg ska inbjudan inte ligga kvar som skickad,
    // annars hoppas personen över när importen körs igen
    if (inv?.id) await service.from('invites').delete().eq('id', inv.id);
    const limited = error.status === 429 || /rate limit/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: limited ? 429 : 500 });
  }

  return NextResponse.json({ ok: true });
}
