// Det som skrivs utan täckning: chattmeddelanden och incidentrapporter.
// Sparas i telefonen och skickas av sig själv när täckningen kommer tillbaka
// (components/OfflineBar.tsx sköter det).
//
// Varje rad får sitt id redan i telefonen. Ett nytt försök kan därför aldrig
// bli en dubblett: finns raden redan i databasen räknas den som skickad.
import type { SupabaseClient } from '@supabase/supabase-js';

export const OUTBOX_KEY = 'tops-outbox';
export const OUTBOX_EVENT = 'tops:outbox';

export type OutboxTable = 'messages' | 'incidents';
export type OutboxItem = {
  id: string;
  table: OutboxTable;
  row: Record<string, unknown>;
  userId: string;
  at: string;
  // Fel som inte beror på täckningen (t.ex. behörighet). Raden ligger kvar
  // tills personen tar bort den, så att inget försvinner i tysthet.
  error?: string;
};

// Service workern svarar med koden TOPS_OFFLINE när nätet inte nås
export const isOfflineError = (e: { code?: string } | null | undefined) => !!e && e.code === 'TOPS_OFFLINE';

export function newId(): string {
  try { return crypto.randomUUID(); } catch { /* äldre webbläsare */ }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function readOutbox(userId?: string): OutboxItem[] {
  try {
    const list = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(list) ? list.filter((i: OutboxItem) => i && i.id && (!userId || i.userId === userId)) : [];
  } catch {
    return [];
  }
}

function save(list: OutboxItem[]) {
  try {
    if (list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch { /* fullt minne: raden ligger kvar i minnet tills sidan laddas om */ }
  try { window.dispatchEvent(new Event(OUTBOX_EVENT)); } catch { /* ignorera */ }
}

export function addToOutbox(item: Omit<OutboxItem, 'at'>): boolean {
  const list = readOutbox();
  save([...list, { ...item, at: new Date().toISOString() }]);
  return readOutbox().some((i) => i.id === item.id);
}

export function dropFromOutbox(id: string) {
  save(readOutbox().filter((i) => i.id !== id));
}

// Försök igen efter ett fel som personen sett
export function retryOutboxItem(id: string) {
  save(readOutbox().map((i) => (i.id === id ? { ...i, error: undefined } : i)));
}

export function clearOutbox() {
  save([]);
}

// Bara den inloggades egna rader, och inget äldre än sju dagar. Har någon
// annan loggat in i telefonen ska den förras osända text inte ligga kvar.
export function pruneOutbox(userId: string) {
  const all = readOutbox();
  const keep = all.filter((i) => i.userId === userId && Date.now() - Date.parse(i.at) < 7 * 86400e3);
  if (keep.length !== all.length) save(keep);
}

let flushing: Promise<number> | null = null;

// Skickar det som väntar. Returnerar hur många som gick iväg.
export function flushOutbox(supabase: SupabaseClient): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    const { data: s } = await supabase.auth.getSession();
    const uid = s.session?.user.id;
    if (!uid) return 0;
    let sent = 0;
    for (const item of readOutbox(uid)) {
      if (item.error) continue;
      const { error } = await supabase.from(item.table).insert({ ...item.row, id: item.id });
      // 23505: raden finns redan, alltså gick ett tidigare försök fram
      if (!error || error.code === '23505') {
        dropFromOutbox(item.id);
        sent++;
        continue;
      }
      if (isOfflineError(error)) break;
      save(readOutbox().map((i) => (i.id === item.id ? { ...i, error: error.message || 'Okänt fel' } : i)));
    }
    return sent;
  })().catch(() => 0).finally(() => { flushing = null; });
  return flushing;
}
