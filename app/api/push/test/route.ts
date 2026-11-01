// Skickar en testnotis till den inloggade, för att se att allt fungerar
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { supabaseUrl } from '@/lib/supabase/env';
import { flushPushes, pushConfigured } from '@/lib/push';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });
  if (!pushConfigured()) return NextResponse.json({ error: 'VAPID-nycklarna saknas i Vercel' }, { status: 400 });
  const { data: me } = await supabase.from('profiles').select('tenant_id').eq('id', user.id).single();
  const service = createSupabase(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { count } = await service.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
  if (!count) return NextResponse.json({ error: 'Den här telefonen har inte slagit på notiser' }, { status: 400 });
  const { error } = await service.from('notifications').insert({
    user_id: user.id, title: 'Testnotis', body: 'Notiserna fungerar.', url: '/dashboard', tenant_id: me?.tenant_id
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    return NextResponse.json(await flushPushes(service, new URL(req.url).origin));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Fel' }, { status: 500 });
  }
}
