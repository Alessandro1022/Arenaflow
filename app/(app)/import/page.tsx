import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ImportClient from '@/components/import/ImportClient';
import { assertModule } from '@/lib/modules';
import { tierOf, type Role } from '@/lib/types';

// Import hör till grundstrukturen och kräver admin, precis som Struktur
export default async function ImportPage() {
  await assertModule('structure');
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user!.id).single();
  const tier = tierOf((profile?.role ?? 'volunteer') as Role);
  if (tier < 5) redirect('/dashboard');
  return <ImportClient tier={tier} />;
}
