// Tvåfaktor: hjälpfunktioner för servern.
//
// Den riktiga spärren sitter i databasen (del 24): utan kod räknas en känslig
// roll som volontär i alla regler. Det här är appens sida av samma sak –
// att skicka vidare till kodsidan, och att API-vägarna räknar med samma nivå
// som databasen.
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { tierOf, type Role } from '@/lib/types';

// Roller på nivå 4 och uppåt: ledning, admin, koordinator, säkerhetsansvarig, ekonomi
export const MFA_TIER = 4;

// Nivån som databasen räknar med just nu. Utan del 24 är det rollens nivå.
export async function effectiveTier(supabase: SupabaseClient, role: Role | null | undefined): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('my_tier');
    if (!error && typeof data === 'number') return data;
  } catch { /* faller tillbaka på rollen */ }
  return tierOf(role ?? 'volunteer');
}

// aal ur åtkomsttoken: aal1 = lösenord, aal2 = lösenord och kod
export function tokenAal(token: string | undefined | null): string {
  try {
    const part = (token ?? '').split('.')[1];
    if (!part) return 'aal1';
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.aal === 'string' ? json.aal : 'aal1';
  } catch {
    return 'aal1';
  }
}

export const hasVerifiedFactor = (user: User | null | undefined) =>
  !!user?.factors?.some((f) => f.status === 'verified');

// Kräver turneringen tvåfaktor för den här rollen? Saknas kolumnen (del 24
// inte körd) är svaret nej, så att appen fungerar som förut.
export async function mfaRequired(supabase: SupabaseClient, role: Role, tenantId: string | null | undefined): Promise<boolean> {
  if (tierOf(role) < MFA_TIER || !tenantId) return false;
  const { data, error } = await supabase.from('tenants').select('require_mfa').eq('id', tenantId).maybeSingle();
  if (error || !data) return false;
  return (data as { require_mfa?: boolean }).require_mfa !== false;
}

// Ska den inloggade till kodsidan? Ja om rollen kräver det, eller om
// personen själv har slagit på tvåfaktor, och koden inte är angiven än.
export async function needsCode(supabase: SupabaseClient, user: User, role: Role, tenantId: string | null | undefined): Promise<boolean> {
  const { data: { session } } = await supabase.auth.getSession();
  if (tokenAal(session?.access_token) === 'aal2') return false;
  if (hasVerifiedFactor(user)) return true;
  return mfaRequired(supabase, role, tenantId);
}
