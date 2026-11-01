import { createClient } from '@/lib/supabase/server';
import MedicalClient from '@/components/medical/MedicalClient';
import { effectiveTier } from '@/lib/mfa';
import type { Role } from '@/lib/types';

// Alla kan larma och se närmaste hjälp. Sjukvården, säkerhetsansvariga och
// admin hanterar ärendena; koordinatorer och uppåt lägger in platserna.
// Databasen avgör till sist (del 26) – det här styr bara vad som visas.
export default async function MedicalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user!.id).single();
  const role = (profile?.role ?? 'volunteer') as Role;
  const tier = await effectiveTier(supabase, role);
  const canHandle = role === 'medic' || (role === 'security_lead' && tier >= 4) || tier >= 5;
  const canManage = canHandle || tier >= 4;
  return <MedicalClient userId={user!.id} canHandle={canHandle} canManage={canManage} />;
}
