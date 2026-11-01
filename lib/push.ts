// Pushnotiser: skickar notiserna som ligger i databasen till telefonerna.
// Kräver VAPID-nycklarna i Vercel (NEXT_PUBLIC_VAPID_PUBLIC_KEY och
// VAPID_PRIVATE_KEY). Saknas de skickas ingenting och notiserna ligger kvar.
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

export const pushConfigured = () => !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

type Note = { id: string; user_id: string; title: string; body: string | null; url: string | null };
type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

let lastFlush = 0;

export async function flushPushes(db: SupabaseClient, subject: string): Promise<{ sent: number; failed: number; removed: number; skipped?: string }> {
  if (!pushConfigured()) return { sent: 0, failed: 0, removed: 0, skipped: 'VAPID-nycklar saknas' };
  // Flera anrop i samma sekund behöver inte göra jobbet flera gånger
  const now = Date.now();
  if (now - lastFlush < 1000) return { sent: 0, failed: 0, removed: 0, skipped: 'nyss körd' };
  lastFlush = now;

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || subject,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );

  const { data: notes, error } = await db.rpc('claim_pushes', { n: 200 });
  if (error) throw new Error(error.message);
  const list = (notes ?? []) as Note[];
  if (!list.length) return { sent: 0, failed: 0, removed: 0 };

  const users = [...new Set(list.map((n) => n.user_id))];
  const { data: subsData } = await db.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', users);
  const subs = (subsData ?? []) as Sub[];

  let sent = 0, failed = 0;
  const gone = new Set<string>();
  await Promise.all(list.flatMap((n) => subs.filter((s) => s.user_id === n.user_id).map(async (s) => {
    const payload = JSON.stringify({ title: n.title, body: n.body ?? '', url: n.url || '/dashboard', tag: n.id });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      failed++;
      // 404/410: telefonen har avslutat prenumerationen – ta bort den
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.add(s.id);
    }
  })));
  if (gone.size) await db.from('push_subscriptions').delete().in('id', [...gone]);
  return { sent, failed, removed: gone.size };
}
