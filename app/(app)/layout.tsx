import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Shell from '@/components/Shell';
import { needsCode } from '@/lib/mfa';
import type { Role } from '@/lib/types';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, role, tenant_id')
    .eq('id', user.id)
    .single();
  const role = (profile?.role ?? 'volunteer') as Role;

  // Tvåfaktor: känsliga roller (och den som själv slagit på det) måste ange
  // koden innan appen visas. Databasen spärrar ändå, det här är vägen dit.
  if (await needsCode(supabase, user, role, profile?.tenant_id)) redirect('/tvafaktor');

  return (
    <Shell role={role} name={profile?.full_name || user.email || ''} userId={user.id}>
      {children}
    </Shell>
  );
}
