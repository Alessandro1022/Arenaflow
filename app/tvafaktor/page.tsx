import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import TwoFactorClient from '@/components/auth/TwoFactorClient';
import { hasVerifiedFactor, mfaRequired, tokenAal } from '@/lib/mfa';
import type { Role } from '@/lib/types';

// Kodsidan ligger utanför appens layout, så att den inte skickar vidare till sig själv
export const dynamic = 'force-dynamic';

export default async function TwoFactorPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role, tenant_id').eq('id', user.id).single();
  const role = (profile?.role ?? 'volunteer') as Role;
  const required = await mfaRequired(supabase, role, profile?.tenant_id);
  const { data: { session } } = await supabase.auth.getSession();
  const verified = tokenAal(session?.access_token) === 'aal2';

  let tenantName = 'Work Cup';
  if (profile?.tenant_id) {
    const { data: t } = await supabase.from('tenants').select('name').eq('id', profile.tenant_id).maybeSingle();
    if (t?.name) tenantName = t.name;
  }

  return (
    <TwoFactorClient
      required={required}
      enrolled={hasVerifiedFactor(user)}
      verified={verified}
      email={user.email ?? ''}
      issuer={tenantName}
    />
  );
}
