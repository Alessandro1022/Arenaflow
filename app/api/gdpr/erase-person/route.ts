// Radera en person ur personalen: databasen gör personen anonym (och prövar
// behörigheten), servern spärrar inloggningen och byter e-posten i kontot.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { supabaseUrl } from '@/lib/supabase/env';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });
  const { userId } = await req.json().catch(() => ({}));
  if (!userId || typeof userId !== 'string') return NextResponse.json({ error: 'Person saknas' }, { status: 400 });

  // Behörigheten prövas i databasen: admin, samma turnering, inte högre roll, inte sig själv
  const { error } = await supabase.rpc('anonymize_person', { p: userId });
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });

  const service = createSupabase(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { error: e2 } = await service.auth.admin.updateUserById(userId, {
    email: `raderad-${userId.slice(0, 8)}@raderad.invalid`,
    user_metadata: { full_name: 'Raderad person' },
    ban_duration: '876000h'
  });
  if (e2) {
    return NextResponse.json({ error: `Uppgifterna är raderade, men inloggningen kunde inte spärras: ${e2.message}. Försök igen.` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
