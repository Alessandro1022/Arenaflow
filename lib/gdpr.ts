// GDPR: lagringstider och gallring. Samma lista används av inställningarna,
// integritetssidan och morgonkörningen, så att det som visas är det som görs.
import type { SupabaseClient } from '@supabase/supabase-js';

export type RetentionKey = 'deltagare' | 'lagkontakter' | 'chatt' | 'arenden' | 'pass' | 'ronder' | 'domare' | 'historik' | 'incidenter' | 'sjukvard';

export const RETENTION: { key: RetentionKey; label: string; what: string; days: number }[] = [
  { key: 'deltagare', label: 'Deltagare', what: 'spelare och ledare: namn, födelseår, lag och tröjnummer', days: 90 },
  { key: 'lagkontakter', label: 'Lagledares kontaktuppgifter', what: 'lagledarens namn och telefonnummer (laget finns kvar)', days: 90 },
  { key: 'chatt', label: 'Chatt', what: 'meddelanden och bilder i chatten', days: 180 },
  { key: 'arenden', label: 'Uppgifter och felanmälningar', what: 'uppgifter, kommentarer, felanmälningar och deras bilder', days: 365 },
  { key: 'pass', label: 'Pass och bemanning', what: 'arbetspass, frånvaro, tillgänglighet, jour, kvittenser, inbjudningar och förarnas position', days: 365 },
  { key: 'ronder', label: 'Ronder och loggar', what: 'nattronder, säkerhetslogg och publikräkning', days: 365 },
  { key: 'domare', label: 'Domarregistret', what: 'domarnas namn och kontaktuppgifter', days: 365 },
  { key: 'historik', label: 'Ändringshistorik', what: 'loggen över vem som ändrade vad', days: 365 },
  { key: 'incidenter', label: 'Incidenter', what: 'incidentrapporter, kommentarer och bilder', days: 730 },
  { key: 'sjukvard', label: 'Begäran om sjukvård', what: 'plats, hur bråttom och kort vad som hänt', days: 30 }
];

export const RESULT_LABEL: Record<string, string> = {
  deltagare: 'deltagare', lagkontakter: 'lagkontakter', chatt: 'chattmeddelanden', chatt_bilagor: 'bilder i chatten',
  uppgifter: 'uppgifter', arenden_bilagor: 'bilder på uppgifter', felanmalningar: 'felanmälningar',
  incidenter: 'incidenter', incidenter_bilagor: 'bilder på incidenter', pass: 'pass', nattronder: 'nattronder',
  domare: 'domare', historik: 'rader i historiken', sjukvard: 'begäran om sjukvård'
};

export function describeResult(r: Record<string, unknown> | null | undefined): string {
  if (!r) return '';
  if (typeof r.hoppades_over === 'string') return r.hoppades_over;
  const parts = Object.entries(r)
    .filter(([k, v]) => k in RESULT_LABEL && typeof v === 'number' && v > 0)
    .map(([k, v]) => `${v} ${RESULT_LABEL[k]}`);
  return parts.length ? parts.join(', ') : 'Inget att gallra';
}

// Gallrar en turnering: först filerna via Storage-API:t (att bara radera
// raden lämnar filen kvar), sedan raderna. db ska ha service-nyckeln för
// filerna; rows är klienten som kör själva gallringen (servern eller admin).
export async function purgeTenant(
  files: SupabaseClient,
  rows: SupabaseClient,
  tenantId: string
): Promise<Record<string, unknown>> {
  const { data: paths, error: pErr } = await rows.rpc('retention_attachment_paths', { t: tenantId });
  if (pErr) throw new Error(pErr.message);
  const list = ((paths ?? []) as unknown[]).map(String).filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await files.storage.from('bilagor').remove(list.slice(i, i + 100));
    if (error) throw new Error(`Filerna gick inte att ta bort: ${error.message}`);
  }
  const { data, error } = await rows.rpc('run_retention', { t: tenantId, dry: false });
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, unknown>;
}
