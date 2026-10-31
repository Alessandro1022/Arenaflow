// Offlinepaketet: det viktigaste för den inloggade, sparat i telefonen medan
// det finns täckning. public/offline.html läser det när nätet är borta.
//
// Bara driftinformation: nödnummer, jour, egna pass, egna platser och lagen
// där. Inga spelare, inga hälsouppgifter. Allt hämtas med användarens egen
// behörighet, så paketet kan aldrig innehålla mer än personen redan får se.
// Det raderas vid utloggning och när det är äldre än sju dagar.
import type { SupabaseClient } from '@supabase/supabase-js';

export const SNAPSHOT_KEY = 'tops-offline';
export const SNAPSHOT_MAX_AGE_DAYS = 7;

export type OfflinePlace = {
  type: 'school' | 'arena';
  name: string;
  kind: string;
  area: string;
  address: string;
  lat: number | null;
  lng: number | null;
  contactName: string;
  contactPhone: string;
  assembly: string;
  care: string;
  note: string;
  checkIn: string;
  teams: { name: string; club: string; room: string; size: number; leader: string; phone: string; status: string }[];
};

export type OfflineSnapshot = {
  v: 1;
  savedAt: string;
  userId: string;
  lang: string;
  user: { name: string; role: string };
  tenant: { name: string; logoText: string; placeLabel: string; colors: Record<string, string> };
  crisis: { active: boolean; message: string } | null;
  emergency: { label: string; phone: string; kind: string; note: string }[];
  onCall: { fn: string; name: string; phone: string; from: string; to: string; note: string }[];
  shifts: { from: string; to: string; place: string; note: string; status: string }[];
  places: OfflinePlace[];
  news: { title: string; body: string; at: string }[];
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Ett fel i en fråga (t.ex. en del som inte är körd) ska bara ge en tom
// sektion, inte stoppa hela paketet.
async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  try {
    const { data, error } = await q;
    return !error && Array.isArray(data) ? (data as Row[]) : [];
  } catch {
    return [];
  }
}

const KIND_LABEL: Record<string, string> = {
  skola: 'Skola', hotell: 'Hotell', vandrarhem: 'Vandrarhem', camping: 'Camping'
};

const COLOR_VARS = ['bg', 'panel', 'panel-2', 'line', 'ink', 'muted', 'primary', 'primary-dark', 'accent', 'danger', 'ok'];

function themeColors(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const k of COLOR_VARS) {
      const v = cs.getPropertyValue(`--${k}`).trim();
      if (/^#[0-9a-f]{3,8}$/i.test(v)) out[k] = v;
    }
  } catch { /* standardfärger används */ }
  return out;
}

export async function buildSnapshot(
  supabase: SupabaseClient,
  opts: { tier: number; lang: string; roleLabel: string; tenantName: string; logoText: string; placeLabel: string }
): Promise<OfflineSnapshot | null> {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user.id;
  if (!uid) return null;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const in3d = new Date(now + 3 * 86400e3).toISOString();

  const [profile, scope, shifts, emergency, onCall, areas, crisis, news] = await Promise.all([
    rows(supabase.from('profiles').select('id,full_name').eq('id', uid)),
    rows(supabase.from('staff_scope').select('area_id,location_type,location_id').eq('user_id', uid)),
    rows(supabase.from('shifts').select('starts_at,ends_at,role_note,location_type,location_id,status')
      .eq('user_id', uid).gte('ends_at', nowIso).lte('starts_at', in3d).order('starts_at').limit(30)),
    rows(supabase.from('emergency_contacts').select('*').order('sort_order').limit(50)),
    rows(supabase.from('on_call_shifts').select('*')
      .gte('ends_at', nowIso).lte('starts_at', in3d).order('starts_at').limit(200)),
    rows(supabase.from('areas').select('id,name')),
    rows(supabase.from('crisis_state').select('active,message').limit(1)),
    rows(supabase.from('news_posts').select('*').order('created_at', { ascending: false }).limit(20))
  ]);

  // Mina platser: allt för admin, annars mitt scope plus platserna för mina pass
  const all = opts.tier >= 5;
  const areaIds = new Set<string>(), schoolIds = new Set<string>(), arenaIds = new Set<string>();
  for (const s of scope) {
    if (s.area_id) areaIds.add(str(s.area_id));
    if (s.location_type === 'school' && s.location_id) schoolIds.add(str(s.location_id));
    if (s.location_type === 'arena' && s.location_id) arenaIds.add(str(s.location_id));
  }
  for (const s of shifts) {
    if (s.location_type === 'school' && s.location_id) schoolIds.add(str(s.location_id));
    if (s.location_type === 'arena' && s.location_id) arenaIds.add(str(s.location_id));
  }
  const orFilter = (ids: Set<string>) => {
    const parts: string[] = [];
    if (areaIds.size) parts.push(`area_id.in.(${[...areaIds].join(',')})`);
    if (ids.size) parts.push(`id.in.(${[...ids].join(',')})`);
    return parts.join(',');
  };
  const placeQuery = (table: 'schools' | 'arenas', ids: Set<string>) => {
    if (all) return rows(supabase.from(table).select('*').order('name').limit(300));
    const f = orFilter(ids);
    return f ? rows(supabase.from(table).select('*').or(f).order('name').limit(300)) : Promise.resolve([] as Row[]);
  };
  const [schools, arenas] = await Promise.all([placeQuery('schools', schoolIds), placeQuery('arenas', arenaIds)]);

  // Lagen på mina boenden, med rum och ledare. RLS ger bara de jag har ansvar för.
  const sIds = schools.map((s) => str(s.id));
  const [teams, rooms] = sIds.length
    ? await Promise.all([
        rows(supabase.from('team_assignments').select('*').in('school_id', sIds).order('team_name').limit(1000)),
        rows(supabase.from('classrooms').select('id,name').in('school_id', sIds).limit(2000))
      ])
    : [[], []];

  // Jourens namn och nummer: står de inte på passet tas de från profilen
  const needProfiles = [...new Set(onCall
    .filter((o) => o.user_id && (!str(o.contact_name) || !str(o.phone)))
    .map((o) => str(o.user_id)))];
  const people = needProfiles.length
    ? await rows(supabase.from('profiles').select('id,full_name,phone').in('id', needProfiles))
    : [];
  const person = new Map(people.map((p) => [str(p.id), p]));

  const areaName = new Map(areas.map((a) => [str(a.id), str(a.name)]));
  const roomName = new Map(rooms.map((r) => [str(r.id), str(r.name)]));

  const place = (type: 'school' | 'arena', p: Row): OfflinePlace => ({
    type,
    name: str(p.name),
    kind: type === 'arena' ? opts.placeLabel : (KIND_LABEL[str(p.kind)] ?? 'Boende'),
    area: areaName.get(str(p.area_id)) ?? '',
    address: str(p.address),
    lat: num(p.lat),
    lng: num(p.lng),
    contactName: str(p.contact_name),
    contactPhone: str(p.contact_phone),
    assembly: str(p.assembly_point),
    care: str(p.nearest_care),
    note: str(p.emergency_note),
    checkIn: str(p.check_in_from),
    teams: type === 'school'
      ? teams.filter((t) => str(t.school_id) === str(p.id)).map((t) => ({
          name: str(t.team_name),
          club: str(t.club_name),
          room: roomName.get(str(t.classroom_id)) ?? '',
          size: Number(t.group_size) || 0,
          leader: str(t.contact_name),
          phone: str(t.contact_phone),
          status: str(t.status)
        }))
      : []
  });

  const placeById = new Map<string, string>();
  schools.forEach((s) => placeById.set(`school:${str(s.id)}`, str(s.name)));
  arenas.forEach((a) => placeById.set(`arena:${str(a.id)}`, str(a.name)));

  const c = crisis[0];
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    userId: uid,
    lang: opts.lang,
    user: { name: str(profile[0]?.full_name) || str(sess.session?.user.email), role: opts.roleLabel },
    tenant: { name: opts.tenantName, logoText: opts.logoText, placeLabel: opts.placeLabel, colors: themeColors() },
    crisis: c ? { active: c.active === true, message: str(c.message) } : null,
    emergency: emergency
      .filter((e) => str(e.phone))
      .map((e) => ({ label: str(e.label), phone: str(e.phone), kind: str(e.kind), note: str(e.note) })),
    onCall: onCall.map((o) => {
      const p = person.get(str(o.user_id));
      return {
        fn: str(o.function),
        name: str(o.contact_name) || str(p?.full_name),
        phone: str(o.phone) || str(p?.phone),
        from: str(o.starts_at),
        to: str(o.ends_at),
        note: str(o.note)
      };
    }).filter((o) => o.name || o.phone),
    shifts: shifts.map((s) => ({
      from: str(s.starts_at),
      to: str(s.ends_at),
      place: placeById.get(`${str(s.location_type)}:${str(s.location_id)}`) ?? '',
      note: str(s.role_note),
      status: str(s.status)
    })),
    places: [...schools.map((s) => place('school', s)), ...arenas.map((a) => place('arena', a))],
    news: news
      .filter((n) => n.pinned === true || n.requires_ack === true)
      .slice(0, 5)
      .map((n) => ({ title: str(n.title), body: str(n.body).slice(0, 1500), at: str(n.created_at) }))
  };
}

export function saveSnapshot(s: OfflineSnapshot): boolean {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s));
    return true;
  } catch {
    // Fullt minne: försök utan lagen, som är den största delen
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...s, places: s.places.map((p) => ({ ...p, teams: [] })) }));
      return true;
    } catch {
      return false;
    }
  }
}

export function readSnapshot(): OfflineSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as OfflineSnapshot;
    return s && s.v === 1 ? s : null;
  } catch {
    return null;
  }
}

export function clearSnapshot() {
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignorera */ }
}
