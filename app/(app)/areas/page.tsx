import AreasClient from '@/components/areas/AreasClient';
import { createClient } from '@/lib/supabase/server';
import { assertModule } from '@/lib/modules';
import { tierOf, type Role } from '@/lib/types';

export default async function AreasPage() {
  await assertModule('areas');
  // Admin och uppåt får veta var områdesansvariga väljs (under Personal)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user!.id).single();
  const tier = tierOf((profile?.role ?? 'volunteer') as Role);
  return <AreasClient canPickManagers={tier >= 5} />;
}
