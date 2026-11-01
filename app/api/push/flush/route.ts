// Skickar väntande notiser som push. Anropas av appen efter handlingar som
// skapar notiser (larm, driftmeddelanden, krisläge), med jämna mellanrum från
// ledningens telefoner, och av morgonkörningen. Skickar bara det som redan
// väntar i databasen, så anropet kan inte användas till något annat.
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { supabaseUrl } from '@/lib/supabase/env';
import { flushPushes } from '@/lib/push';

export async function POST(req: Request) {
  const cron = process.env.CRON_SECRET && req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Ej inloggad' }, { status: 401 });
  }
  const service = createSupabase(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  try {
    return NextResponse.json(await flushPushes(service, new URL(req.url).origin));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Fel' }, { status: 500 });
  }
}
