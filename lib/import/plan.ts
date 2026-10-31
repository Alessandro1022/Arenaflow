// Från rader i en fil till en plan: vad blir nytt, vad ändras, vad är
// redan likadant och vad är fel. Inget sparas förrän planen körs.
//
// Regler som gäller alla typer:
//  - en tom cell skriver aldrig över ett befintligt värde
//  - samma sak två gånger i filen är ett fel på den andra raden
//  - en rad som inte går att spara stoppar inte de andra
import type { SupabaseClient } from '@supabase/supabase-js';
import { kindOf, norm, parseCell, stockholmIso, type KindKey } from './kinds';
import type { Cell } from './xlsx';
import { ROLE_LABELS, tierOf, type Role } from '@/lib/types';

export type RowStatus = 'ny' | 'ändras' | 'samma' | 'fel';

export type PlanRow = {
  line: number;
  label: string;
  status: RowStatus;
  errors: string[];
  changes: string[];
  note?: string;
  data: Record<string, unknown>;
  id?: string;
  // Hänvisningar som skapas först när planen körs
  areaName?: string;
  room?: { schoolId: string; name: string };
};

export type Plan = {
  kind: KindKey;
  rows: PlanRow[];
  newAreas: string[];
  newRooms: { schoolId: string; school: string; name: string }[];
  counts: Record<RowStatus, number>;
};

export type RunResult = { ok: number; skipped: number; failed: { line: number; label: string; error: string }[]; stopped?: string };

type Row = Record<string, unknown>;

async function fetchAll(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    const list = (Array.isArray(data) ? data : []) as Row[];
    out.push(...list);
    if (list.length < 1000) break;
  }
  return out;
}

const same = (a: unknown, b: unknown) => {
  if (a == null || a === '') return b == null || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(a)) || /^\d{4}-\d{2}-\d{2}T/.test(String(b))) return Date.parse(String(a)) === Date.parse(String(b));
  return String(a).trim() === String(b ?? '').trim();
};

// Roller: svenska namn, nycklar och vanliga ord
const ROLE_WORDS: Record<string, Role> = {
  vakt: 'security_staff', väktare: 'security_staff', säkerhet: 'security_staff', ordningsvakt: 'security_staff',
  säkerhetschef: 'security_lead', skolvärd: 'school_staff', värd: 'school_staff', boende: 'school_staff',
  planvärd: 'arena_staff', hallvärd: 'arena_staff', volontär: 'volunteer', funktionär: 'volunteer',
  chaufför: 'transport_staff', förare: 'transport_staff', kök: 'food_staff', mat: 'food_staff',
  lager: 'stock_staff', ekonomi: 'finance', tolk: 'interpreter', sjukvård: 'medic', sjuksköterska: 'medic'
};
function roleOf(s: string): Role | null {
  const n = norm(s);
  for (const [k, label] of Object.entries(ROLE_LABELS)) if (norm(label) === n || norm(k) === n) return k as Role;
  return ROLE_WORDS[n] ?? null;
}

export async function planImport(
  supabase: SupabaseClient,
  kindKey: KindKey,
  rows: Cell[][],
  mapping: Record<string, number>,
  ctx: { tier: number; firstLine: number }
): Promise<Plan> {
  const kind = kindOf(kindKey);
  const plan: Plan = { kind: kindKey, rows: [], newAreas: [], newRooms: [], counts: { ny: 0, ändras: 0, samma: 0, fel: 0 } };

  // ---- Referensdata ----
  const needAreas = kindKey === 'schools' || kindKey === 'arenas' || kindKey === 'staff';
  const areas = needAreas ? await fetchAll((a, b) => supabase.from('areas').select('id,name').range(a, b)) : [];
  const areaByName = new Map(areas.map((a) => [norm(a.name), String(a.id)]));
  const schools = ['schools', 'teams', 'staff'].includes(kindKey)
    ? await fetchAll((a, b) => supabase.from('schools').select('*').range(a, b)) : [];
  const schoolByName = new Map(schools.map((s) => [norm(s.name), s]));
  const arenas = ['arenas', 'matches', 'staff'].includes(kindKey)
    ? await fetchAll((a, b) => supabase.from('arenas').select('*').range(a, b)) : [];
  const arenaByName = new Map(arenas.map((s) => [norm(s.name), s]));

  let existing: Row[] = [];
  let rooms: Row[] = [];
  let teams: Row[] = [];
  let emails = new Set<string>(), pending = new Set<string>();
  if (kindKey === 'teams') {
    existing = await fetchAll((a, b) => supabase.from('team_assignments').select('*').range(a, b));
    rooms = await fetchAll((a, b) => supabase.from('classrooms').select('id,name,school_id').range(a, b));
  } else if (kindKey === 'participants') {
    teams = await fetchAll((a, b) => supabase.from('team_assignments').select('id,team_name,club_name').range(a, b));
    existing = await fetchAll((a, b) => supabase.from('participants')
      .select('id,team_assignment_id,full_name,role,birth_year,jersey_number').range(a, b));
  } else if (kindKey === 'matches') {
    existing = await fetchAll((a, b) => supabase.from('arena_matches')
      .select('id,arena_id,starts_at,home_team,away_team,surface_label,category,group_name,stage').range(a, b));
  } else if (kindKey === 'staff') {
    const profiles = await fetchAll((a, b) => supabase.from('profiles').select('email').range(a, b));
    emails = new Set(profiles.map((p) => norm(p.email)));
    const inv = await fetchAll((a, b) => supabase.from('invites').select('email,accepted_at').range(a, b));
    pending = new Set(inv.filter((i) => !i.accepted_at).map((i) => norm(i.email)));
  }
  const roomByKey = new Map(rooms.map((r) => [`${r.school_id}|${norm(r.name)}`, String(r.id)]));
  const teamsByName = new Map<string, Row[]>();
  for (const t of teams) {
    const k = norm(t.team_name);
    teamsByName.set(k, [...(teamsByName.get(k) ?? []), t]);
  }

  // Befintliga rader, nycklade som filens rader nycklas
  const keyOf = (r: Row): string => {
    switch (kindKey) {
      case 'schools': case 'arenas': return norm(r.name);
      case 'teams': return `${norm(r.team_name)}|${norm(r.club_name)}`;
      case 'participants': return `${r.team_assignment_id}|${norm(r.full_name)}`;
      case 'matches': return `${r.arena_id}|${Date.parse(String(r.starts_at))}|${norm(r.home_team)}|${norm(r.away_team)}`;
      default: return '';
    }
  };
  const existingByKey = new Map<string, Row>();
  const pool = kindKey === 'schools' ? schools : kindKey === 'arenas' ? arenas : existing;
  for (const r of pool) existingByKey.set(keyOf(r), r);
  // Lag utan förening i filen: matcha på lagnamnet om det bara finns ett
  const teamOnlyName = new Map<string, Row[]>();
  if (kindKey === 'teams') for (const r of existing) {
    const k = norm(r.team_name);
    teamOnlyName.set(k, [...(teamOnlyName.get(k) ?? []), r]);
  }

  const seen = new Map<string, number>();
  const newAreas = new Map<string, string>();
  const newRooms = new Map<string, { schoolId: string; school: string; name: string }>();
  const labelOf = (key: string) => kind.fields.find((f) => f.key === key)?.label ?? key;

  rows.forEach((cells, i) => {
    const line = ctx.firstLine + i;
    // Helt tomma rader hoppas över utan att räknas
    const mappedCells = Object.values(mapping).map((idx) => cells[idx]);
    if (mappedCells.every((c) => c == null || String(c).trim() === '')) return;

    const v: Record<string, string | number | null> = {};
    const errors: string[] = [];
    for (const f of kind.fields) {
      const idx = mapping[f.key];
      if (idx === undefined) continue;
      const p = parseCell(f, cells[idx] ?? null);
      if (p.ok) v[f.key] = p.value;
      else errors.push(`${f.label}: ${p.error}`);
    }
    for (const f of kind.fields) {
      if (f.required && mapping[f.key] !== undefined && (v[f.key] == null || v[f.key] === '') && !errors.some((e) => e.startsWith(f.label))) {
        errors.push(`${f.label} saknas`);
      }
    }

    const row: PlanRow = { line, label: '', status: 'ny', errors, changes: [], data: {} };
    const put = (key: string, val: unknown) => { if (val != null && val !== '') row.data[key] = val; };
    let key = '';
    let match: Row | undefined;

    switch (kindKey) {
      case 'schools':
      case 'arenas': {
        row.label = String(v.name ?? '');
        const cols = kindKey === 'schools'
          ? ['name', 'kind', 'address', 'capacity', 'contact_name', 'contact_phone', 'contact_email', 'rooms', 'check_in_from', 'assembly_point', 'nearest_care', 'emergency_note', 'lat', 'lng']
          : ['name', 'address', 'surface_count', 'club', 'contact_name', 'contact_phone', 'assembly_point', 'nearest_care', 'emergency_note', 'lat', 'lng'];
        for (const c of cols) put(c, v[c]);
        if (v.area) {
          const id = areaByName.get(norm(v.area));
          if (id) row.data.area_id = id;
          else { row.areaName = String(v.area).trim(); newAreas.set(norm(v.area), row.areaName); }
        }
        key = norm(v.name);
        match = existingByKey.get(key);
        break;
      }
      case 'teams': {
        row.label = [v.team_name, v.club_name && v.club_name !== v.team_name ? v.club_name : ''].filter(Boolean).join(' · ');
        for (const c of ['team_name', 'club_name', 'country', 'age_class', 'group_size', 'contact_name', 'contact_phone', 'arrival_date', 'departure_date']) put(c, v[c]);
        const school = v.school ? schoolByName.get(norm(v.school)) : undefined;
        if (v.school && !school) errors.push(`Okänt boende: ${v.school}`);
        if (school) {
          row.data.school_id = school.id;
          if (v.classroom) {
            const rk = `${school.id}|${norm(v.classroom)}`;
            const roomId = roomByKey.get(rk);
            if (roomId) row.data.classroom_id = roomId;
            else {
              row.room = { schoolId: String(school.id), name: String(v.classroom).trim() };
              newRooms.set(rk, { schoolId: String(school.id), school: String(school.name), name: row.room.name });
            }
          }
        }
        key = `${norm(v.team_name)}|${norm(v.club_name)}`;
        match = existingByKey.get(key);
        if (!match && mapping.club_name === undefined) {
          const byName = teamOnlyName.get(norm(v.team_name)) ?? [];
          if (byName.length === 1) match = byName[0];
        }
        break;
      }
      case 'participants': {
        const name = (v.full_name ? String(v.full_name) : [v.first_name, v.last_name].filter(Boolean).join(' ')).trim();
        if (!name) errors.push('Namn saknas');
        let team: Row | undefined;
        if (v.team) {
          let cands = teamsByName.get(norm(v.team)) ?? [];
          if (cands.length > 1 && v.club) cands = cands.filter((t) => norm(t.club_name) === norm(v.club));
          if (cands.length === 1) team = cands[0];
          else if (cands.length === 0) errors.push(`Okänt lag: ${v.team}${v.club ? ` (${v.club})` : ''}`);
          else errors.push(`Flera lag heter ${v.team} – koppla kolumnen Förening`);
        }
        row.label = [name, v.team].filter(Boolean).join(' · ');
        put('full_name', name);
        if (team) row.data.team_assignment_id = team.id;
        for (const c of ['role', 'birth_year', 'jersey_number']) put(c, v[c]);
        key = team ? `${team.id}|${norm(name)}` : '';
        match = key ? existingByKey.get(key) : undefined;
        break;
      }
      case 'matches': {
        const arena = v.arena ? arenaByName.get(norm(v.arena)) : undefined;
        if (v.arena && !arena) errors.push(`Okänd spelplats: ${v.arena}`);
        let starts = v.starts_at ? String(v.starts_at) : null;
        if (!starts && v.date && v.time) starts = stockholmIso(String(v.date), String(v.time));
        if (!starts && !errors.some((e) => /^(Datum|Tid|Start)/.test(e))) {
          errors.push(mapping.date === undefined ? 'Start saknas' : !v.date ? 'Datum saknas' : 'Tid saknas');
        }
        row.label = `${v.home_team ?? '?'} – ${v.away_team ?? '?'}`;
        if (starts) {
          const d = new Date(starts);
          row.label += ` · ${d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })} ${d.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' })}`;
        }
        if (arena) { row.data.arena_id = arena.id; row.label += ` · ${arena.name}`; }
        put('starts_at', starts);
        for (const c of ['home_team', 'away_team', 'surface_label', 'category', 'group_name', 'stage']) put(c, v[c]);
        key = arena && starts ? `${arena.id}|${Date.parse(starts)}|${norm(v.home_team)}|${norm(v.away_team)}` : '';
        match = key ? existingByKey.get(key) : undefined;
        if (!match && row.data.surface_label == null) row.data.surface_label = '1';
        break;
      }
      case 'staff': {
        const email = v.email ? String(v.email) : '';
        row.label = [email, v.full_name].filter(Boolean).join(' · ');
        const role = v.role ? roleOf(String(v.role)) : null;
        if (v.role && !role) errors.push(`Okänd roll: ${v.role}`);
        if (role && tierOf(role) > ctx.tier) errors.push(`${ROLE_LABELS[role]}: högre roll än din egen`);
        put('email', email);
        put('fullName', v.full_name);
        if (role) row.data.role = role;
        if (v.area) {
          const id = areaByName.get(norm(v.area));
          if (id) row.data.areaId = id;
          else errors.push(`Okänt område: ${v.area}`);
        } else if (v.place) {
          const s = schoolByName.get(norm(v.place)), a = arenaByName.get(norm(v.place));
          if (s) { row.data.locationType = 'school'; row.data.locationId = s.id; }
          else if (a) { row.data.locationType = 'arena'; row.data.locationId = a.id; }
          else errors.push(`Okänd plats: ${v.place}`);
        }
        key = norm(email);
        if (emails.has(key)) { row.status = 'samma'; row.note = 'Har redan konto'; }
        else if (pending.has(key)) { row.status = 'samma'; row.note = 'Redan inbjuden'; }
        break;
      }
    }

    if (key) {
      const prev = seen.get(key);
      if (prev !== undefined) errors.push(`Samma som rad ${prev}`);
      else seen.set(key, line);
    }

    if (errors.length) row.status = 'fel';
    else if (match) {
      row.id = String(match.id);
      for (const [k, val] of Object.entries(row.data)) {
        if (!same(val, match[k])) row.changes.push(labelOf(k === 'school_id' ? 'school' : k === 'classroom_id' ? 'classroom' : k === 'area_id' ? 'area' : k === 'arena_id' ? 'arena' : k === 'team_assignment_id' ? 'team' : k));
      }
      if (row.areaName || row.room) row.changes.push(row.areaName ? 'Område' : 'Rum');
      row.status = row.changes.length ? 'ändras' : 'samma';
    }
    plan.rows.push(row);
    plan.counts[row.status]++;
  });

  plan.newAreas = [...newAreas.values()];
  plan.newRooms = [...newRooms.values()];
  return plan;
}

// ---- Körning ----
export async function runImport(
  supabase: SupabaseClient,
  plan: Plan,
  onProgress: (done: number, total: number) => void
): Promise<RunResult> {
  const res: RunResult = { ok: 0, skipped: 0, failed: [] };
  const todo = plan.rows.filter((r) => r.status === 'ny' || r.status === 'ändras');
  res.skipped = plan.rows.length - todo.length;
  const total = todo.length;
  let done = 0;
  const tick = (n = 1) => { done += n; onProgress(done, total); };
  onProgress(0, total);

  // Personal: en inbjudan i taget, via servern som skickar mejlet
  if (plan.kind === 'staff') {
    for (let i = 0; i < todo.length; i++) {
      const r = todo[i];
      try {
        const resp = await fetch('/api/invite', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.data)
        });
        const j = await resp.json().catch(() => ({}));
        if (resp.ok) res.ok++;
        else {
          const msg = String(j.error ?? `Fel ${resp.status}`);
          res.failed.push({ line: r.line, label: r.label, error: msg });
          if (resp.status === 429 || /rate limit|too many/i.test(msg)) {
            res.stopped = 'Mejlgränsen i Supabase är nådd. Kör samma fil igen om en stund – de som redan fått inbjudan hoppas över.';
            for (const rest of todo.slice(i + 1)) res.failed.push({ line: rest.line, label: rest.label, error: 'Inte skickad än' });
            tick(todo.length - i);
            return res;
          }
        }
      } catch (e) {
        res.failed.push({ line: r.line, label: r.label, error: e instanceof Error ? e.message : 'Nätverksfel' });
      }
      tick();
    }
    return res;
  }

  const table = { schools: 'schools', arenas: 'arenas', teams: 'team_assignments', participants: 'participants', matches: 'arena_matches' }[plan.kind];

  // Först det som raderna hänvisar till: nya områden och rum
  const areaIds = new Map<string, string>();
  if (plan.newAreas.length) {
    const { data, error } = await supabase.from('areas').insert(plan.newAreas.map((name) => ({ name }))).select('id,name');
    if (error) return { ...res, failed: todo.map((r) => ({ line: r.line, label: r.label, error: `Områdena gick inte att skapa: ${error.message}` })) };
    for (const a of (data ?? []) as Row[]) areaIds.set(norm(a.name), String(a.id));
  }
  const roomIds = new Map<string, string>();
  if (plan.newRooms.length) {
    const { data, error } = await supabase.from('classrooms')
      .insert(plan.newRooms.map((r) => ({ school_id: r.schoolId, name: r.name, capacity: 0 }))).select('id,name,school_id');
    if (error) return { ...res, failed: todo.map((r) => ({ line: r.line, label: r.label, error: `Rummen gick inte att skapa: ${error.message}` })) };
    for (const r of (data ?? []) as Row[]) roomIds.set(`${r.school_id}|${norm(r.name)}`, String(r.id));
  }
  const resolved = (r: PlanRow) => {
    const d = { ...r.data };
    if (r.areaName) d.area_id = areaIds.get(norm(r.areaName));
    if (r.room) d.classroom_id = roomIds.get(`${r.room.schoolId}|${norm(r.room.name)}`);
    return d;
  };

  // Nya rader i omgångar om 200. Går en omgång inte igenom tas raderna en
  // och en, så att bara de felaktiga blir kvar. defaultToNull: false gör att
  // en kolumn som saknas på en rad får sitt standardvärde i stället för null
  // – annars fäller en enda tom grupp eller förening hela omgången.
  const inserts = todo.filter((r) => r.status === 'ny');
  for (let i = 0; i < inserts.length; i += 200) {
    const chunk = inserts.slice(i, i + 200);
    const { error } = await supabase.from(table).insert(chunk.map(resolved), { defaultToNull: false });
    if (!error) { res.ok += chunk.length; tick(chunk.length); continue; }
    for (const r of chunk) {
      const { error: e1 } = await supabase.from(table).insert(resolved(r));
      if (e1) res.failed.push({ line: r.line, label: r.label, error: e1.message });
      else res.ok++;
      tick();
    }
  }

  // Ändringar en och en, sex åt gången
  const updates = todo.filter((r) => r.status === 'ändras');
  for (let i = 0; i < updates.length; i += 6) {
    await Promise.all(updates.slice(i, i + 6).map(async (r) => {
      const { data, error } = await supabase.from(table).update(resolved(r)).eq('id', r.id!).select('id');
      if (error) res.failed.push({ line: r.line, label: r.label, error: error.message });
      else if (!data || !(data as Row[]).length) res.failed.push({ line: r.line, label: r.label, error: 'Saknar behörighet att ändra raden' });
      else res.ok++;
      tick();
    }));
  }
  return res;
}
