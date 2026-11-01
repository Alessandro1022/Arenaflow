// Säkerhetskopior: en fil per turnering och dag i Supabase Storage (privat
// hink "backuper", bara servern kommer åt den). Gäller tabellerna, inte
// uppladdade bilder – de ligger kvar i lagringen.
//
// Återställning lägger bara tillbaka rader som saknas. Befintliga rader rörs
// aldrig, så en återställning kan inte skriva över det som gjorts sedan.
// Behörigheter, konton och inbjudningar återställs inte: det som medvetet
// tagits bort ska inte komma tillbaka den vägen.
import { gunzipSync, gzipSync } from 'zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
export { TABLE_LABEL, describeRestore } from './backupLabels';

export const BUCKET = 'backuper';
export const KEEP_DAYS = 14;

// Ordningen följer främmande nycklar: det som andra rader pekar på kommer först
export const RESTORE_TABLES = [
  'areas',
  'medical_points', 'schools', 'arenas', 'dining_halls', 'referees', 'vehicles', 'stock_items', 'security_cars',
  'checklist_templates', 'onboarding_items', 'news_posts', 'documents', 'emergency_contacts',
  'budget_lines', 'tasks', 'incidents', 'on_call_shifts', 'shifts',
  'classrooms', 'night_rounds', 'room_keys', 'crowd_counts', 'security_logs', 'meal_services',
  'stock_movements', 'checklist_runs', 'car_routes', 'task_comments', 'incident_comments',
  'arena_matches', 'absences', 'availability', 'shift_swaps',
  'team_assignments', 'room_issues', 'checklist_items',
  'participants', 'meal_entitlements', 'cost_entries', 'transport_jobs', 'channels',
  'meal_checkins', 'transport_job_items', 'messages',
  'attachments'
] as const;

// Följer med i kopian för att ha allt, men återställs inte
const EXPORT_ONLY = ['profiles', 'staff_scope', 'channel_members', 'news_acks', 'onboarding_done', 'ai_reports', 'role_rates', 'materials', 'crisis_state', 'retention_runs'];

type Row = Record<string, unknown>;
export type Backup = { version: 1; tenant_id: string; tenant: string; created_at: string; tables: Record<string, Row[]> };
export type BackupFile = { name: string; size: number; created_at: string };

async function allRows(db: SupabaseClient, table: string, tenantId: string, columns = '*'): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(columns).eq('tenant_id', tenantId).range(from, from + 999);
    if (error) {
      // En tabell som inte finns (del inte körd) hoppas över
      if (/does not exist|schema cache|Could not find/i.test(error.message)) return out;
      throw new Error(`${table}: ${error.message}`);
    }
    const list = (data ?? []) as unknown as Row[];
    out.push(...list);
    if (list.length < 1000) return out;
  }
}

export async function ensureBucket(db: SupabaseClient) {
  const { error } = await db.storage.getBucket(BUCKET);
  if (!error) return;
  const { error: e2 } = await db.storage.createBucket(BUCKET, { public: false });
  if (e2 && !/exists|duplicate/i.test(e2.message)) throw new Error(`Hinken för säkerhetskopior gick inte att skapa: ${e2.message}`);
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

export async function createBackup(db: SupabaseClient, tenantId: string, tenantName: string, label = today()): Promise<BackupFile & { rows: number }> {
  await ensureBucket(db);
  const tables: Record<string, Row[]> = {};
  let rows = 0;
  for (const t of [...RESTORE_TABLES, ...EXPORT_ONLY]) {
    const list = await allRows(db, t, tenantId);
    if (list.length) { tables[t] = list; rows += list.length; }
  }
  if (rows === 0) return { name: '', size: 0, created_at: '', rows: 0 };
  const backup: Backup = { version: 1, tenant_id: tenantId, tenant: tenantName, created_at: new Date().toISOString(), tables };
  const gz = gzipSync(Buffer.from(JSON.stringify(backup)));
  const name = `${label}.json.gz`;
  const { error } = await db.storage.from(BUCKET).upload(`${tenantId}/${name}`, gz, { contentType: 'application/gzip', upsert: true });
  if (error) throw new Error(`Säkerhetskopian gick inte att spara: ${error.message}`);
  return { name, size: gz.length, created_at: backup.created_at, rows };
}

export async function listBackups(db: SupabaseClient, tenantId: string): Promise<BackupFile[]> {
  await ensureBucket(db);
  const { data, error } = await db.storage.from(BUCKET).list(tenantId, { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((f) => /\.json\.gz$/.test(f.name))
    .map((f) => ({ name: f.name, size: Number((f.metadata as { size?: number } | null)?.size ?? 0), created_at: String(f.created_at ?? f.updated_at ?? '') }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export async function removeBackups(db: SupabaseClient, tenantId: string, names: string[]) {
  if (!names.length) return;
  const { error } = await db.storage.from(BUCKET).remove(names.map((n) => `${tenantId}/${n}`));
  if (error) throw new Error(error.message);
}

// Behåll de senaste KEEP_DAYS kopiorna
export async function pruneBackups(db: SupabaseClient, tenantId: string) {
  const files = await listBackups(db, tenantId);
  await removeBackups(db, tenantId, files.slice(KEEP_DAYS).map((f) => f.name));
}

export async function readBackup(db: SupabaseClient, tenantId: string, name: string): Promise<Backup> {
  if (!/^[\w.-]+\.json\.gz$/.test(name)) throw new Error('Ogiltigt filnamn');
  const { data, error } = await db.storage.from(BUCKET).download(`${tenantId}/${name}`);
  if (error || !data) throw new Error(error?.message ?? 'Kopian hittades inte');
  const json = JSON.parse(gunzipSync(Buffer.from(await data.arrayBuffer())).toString('utf8')) as Backup;
  if (json.tenant_id !== tenantId) throw new Error('Kopian hör till en annan turnering');
  return json;
}

// Lägger tillbaka rader som finns i kopian men inte i databasen.
// dry = true räknar bara.
export async function restoreMissing(db: SupabaseClient, tenantId: string, backup: Backup, dry: boolean) {
  const result: Record<string, number> = {};
  const failed: Record<string, string> = {};
  for (const t of RESTORE_TABLES) {
    const rows = (backup.tables[t] ?? []).filter((r) => r.tenant_id === tenantId && typeof r.id === 'string');
    if (!rows.length) continue;
    const existing = new Set((await allRows(db, t, tenantId, 'id')).map((r) => String(r.id)));
    const missing = rows.filter((r) => !existing.has(String(r.id)));
    if (!missing.length) continue;
    if (dry) { result[t] = missing.length; continue; }
    let n = 0;
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = missing.slice(i, i + 500);
      const { data, error } = await db.from(t).upsert(chunk, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (!error) { n += (data ?? []).length; continue; }
      // Krock på en annan unik nyckel (t.ex. en kostnad som redan bokats om
      // för ett återställt pass): ta raderna en och en och hoppa över dubbletterna
      if (error.code !== '23505' && !/duplicate key/i.test(error.message)) { failed[t] = error.message; break; }
      for (const row of chunk) {
        const { data: d1, error: e1 } = await db.from(t).upsert(row, { onConflict: 'id', ignoreDuplicates: true }).select('id');
        if (!e1) n += (d1 ?? []).length;
        else if (e1.code !== '23505' && !/duplicate key/i.test(e1.message)) { failed[t] = e1.message; break; }
      }
    }
    if (n) result[t] = n;
  }
  return { result, failed };
}

// Efter en gallring som raderade något innehåller de äldre kopiorna uppgifter
// som inte längre får finnas. De tas bort och en ny, gallrad kopia tas.
export async function afterPurge(db: SupabaseClient, tenantId: string, tenantName: string, purged: Record<string, unknown>) {
  const anything = Object.values(purged ?? {}).some((v) => typeof v === 'number' && v > 0);
  if (!anything) return false;
  const files = await listBackups(db, tenantId);
  await removeBackups(db, tenantId, files.map((f) => f.name));
  await createBackup(db, tenantId, tenantName);
  return true;
}
