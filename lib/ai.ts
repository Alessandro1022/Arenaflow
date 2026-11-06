// AI-kärnan för TournamentOps.
// Samlar en kompakt lägesbild ur databasen, räknar fram rutter för
// säkerhetsbilarna deterministiskt, och låter Gemini skriva rapporterna.
import type { SupabaseClient } from '@supabase/supabase-js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ---------- Gemini ----------
export async function callGemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY saknas i miljövariablerna');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
}

// ---------- Lägesbild ----------
export async function gatherContext(db: SupabaseClient, tenantId: string) {
  const now = new Date();
  const dayAgo = new Date(Date.now() - 24 * 36e5).toISOString();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  const [areas, schools, arenas, incidents, incidents24, tasksOpen, teams, rooms,
    issuesOpen, rounds24, matchesToday, shiftsNowAll, swapsPending, crowdLatest] = await Promise.all([
    db.from('areas').select('id,name').eq('tenant_id', tenantId),
    db.from('schools').select('id,name,capacity,area_id').eq('tenant_id', tenantId),
    db.from('arenas').select('id,name,area_id').eq('tenant_id', tenantId),
    db.from('incidents').select('id,title,severity,status,location_type,location_id,created_at').eq('tenant_id', tenantId).neq('status', 'resolved'),
    db.from('incidents').select('id,title,severity,status,location_type,location_id,created_at').eq('tenant_id', tenantId).gte('created_at', dayAgo),
    db.from('tasks').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).neq('status', 'done'),
    db.from('team_assignments').select('school_id,group_size,status,team_name').eq('tenant_id', tenantId),
    db.from('classrooms').select('id,school_id,capacity').eq('tenant_id', tenantId),
    db.from('room_issues').select('id,school_id,title,status,created_at').eq('tenant_id', tenantId).neq('status', 'resolved'),
    db.from('night_rounds').select('school_id,all_ok,notes,performed_at').eq('tenant_id', tenantId).gte('performed_at', dayAgo),
    db.from('arena_matches').select('id,arena_id,surface_label,home_team,away_team,category,starts_at,status,risk_level,risk_note').eq('tenant_id', tenantId)
      .gte('starts_at', todayStart.toISOString()).lte('starts_at', todayEnd.toISOString()).neq('status', 'cancelled'),
    db.from('shifts').select('id,status').eq('tenant_id', tenantId).lte('starts_at', now.toISOString()).gte('ends_at', now.toISOString()),
    db.from('shift_swaps').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'pending'),
    db.from('crowd_counts').select('arena_id,count,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(20)
  ]);

  const schoolList = (schools.data ?? []).map((s) => {
    const inHouse = (teams.data ?? []).filter((t) => t.school_id === s.id && t.status === 'checked_in')
      .reduce((a, t) => a + (t.group_size ?? 0), 0);
    const expected = (teams.data ?? []).filter((t) => t.school_id === s.id && t.status === 'expected').length;
    const openIssues = (issuesOpen.data ?? []).filter((i) => i.school_id === s.id);
    const round = (rounds24.data ?? []).filter((r) => r.school_id === s.id)
      .sort((a, b) => b.performed_at.localeCompare(a.performed_at))[0];
    const openInc = (incidents.data ?? []).filter((i) => i.location_type === 'school' && i.location_id === s.id);
    return {
      id: s.id, name: s.name, area_id: s.area_id, capacity: s.capacity,
      boende: inHouse, beläggning: s.capacity ? Math.round((inHouse / s.capacity) * 100) : 0,
      väntadeLag: expected,
      öppnaFel: openIssues.map((i) => i.title),
      öppnaIncidenter: openInc.map((i) => `${i.title} (${i.severity})`),
      nattrond: round ? (round.all_ok ? 'OK' : `ANMÄRKNING: ${round.notes ?? ''}`) : 'SAKNAS senaste 24h'
    };
  });

  const active = shiftsNowAll.data ?? [];
  const flagged = (matchesToday.data ?? []).filter((m) => m.risk_level !== 'green');

  return {
    tidpunkt: now.toLocaleString('sv-SE'),
    areas: areas.data ?? [],
    arenas: arenas.data ?? [],
    kpi: {
      öppnaIncidenter: (incidents.data ?? []).length,
      kritiska: (incidents.data ?? []).filter((i) => i.severity === 'critical').length,
      incidenterSenaste24h: (incidents24.data ?? []).length,
      öppnaUppgifter: tasksOpen.count ?? 0,
      passJustNu: active.length,
      passtäckning: active.length ? Math.round((active.filter((s) => s.status === 'checked_in').length / active.length) * 100) : null,
      väntandePassbyten: swapsPending.count ?? 0
    },
    incidenterSenaste24h: (incidents24.data ?? []).map((i) => `${i.title} [${i.severity}/${i.status}]`),
    skolor: schoolList,
    matcherIdag: (matchesToday.data ?? []).map((m) => ({
      arena: (arenas.data ?? []).find((a) => a.id === m.arena_id)?.name ?? '?',
      plan: m.surface_label, tid: new Date(m.starts_at).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }),
      match: `${m.home_team} – ${m.away_team}`, klass: m.category,
      risk: m.risk_level, riskNotering: m.risk_note, status: m.status
    })),
    flaggadeMatcher: flagged.length,
    senastePublik: (crowdLatest.data ?? []).slice(0, 6).map((c) => ({
      arena: (arenas.data ?? []).find((a) => a.id === c.arena_id)?.name ?? '?', antal: c.count
    }))
  };
}

// ---------- Rutter för säkerhetsbilarna ----------
// Deterministisk fördelning: poängsätt skolor efter läge, håll ihop områden,
// balansera mellan aktiva bilar. AI:n skriver briefingen ovanpå.
export type Stop = { school_id: string; name: string; score: number; reasons: string[] };

export async function buildRoutes(db: SupabaseClient, slot: string, tenantId: string) {
  const ctx = await gatherContext(db, tenantId);
  const today = ctx.matcherIdag;

  const stops: (Stop & { area_id: string | null })[] = ctx.skolor.map((s) => {
    const reasons: string[] = [];
    let score = 1; // alla skolor besöks
    if (s.öppnaIncidenter.length) { score += 3 * s.öppnaIncidenter.length; reasons.push(`${s.öppnaIncidenter.length} öppna incidenter`); }
    if (s.öppnaFel.length) { score += 2 * s.öppnaFel.length; reasons.push(`${s.öppnaFel.length} öppna fel`); }
    if (s.nattrond.startsWith('SAKNAS')) { score += 2; reasons.push('nattrond saknas'); }
    if (s.nattrond.startsWith('ANMÄRKNING')) { score += 3; reasons.push('anmärkning på nattrond'); }
    if (s.beläggning >= 90) { score += 1; reasons.push(`hög beläggning (${s.beläggning}%)`); }
    // Röd/gul match i samma område → prioritera skolorna där
    const areaArenas = ctx.arenas.filter((a) => a.area_id === s.area_id).map((a) => a.name);
    const risky = today.filter((m) => areaArenas.includes(m.arena) && m.risk !== 'green');
    if (risky.some((m) => m.risk === 'red')) { score += 3; reasons.push('röd match i området'); }
    else if (risky.length) { score += 1; reasons.push('gul match i området'); }
    return { school_id: s.id, name: s.name, score, reasons, area_id: s.area_id };
  });

  const { data: cars } = await db.from('security_cars').select('id,label').eq('tenant_id', tenantId).eq('active', true).order('label');
  const carList = cars ?? [];
  if (!carList.length) return { cars: [], ctx };

  // Gruppera per område, tyngst först, lägg gruppen på bilen med lägst last
  const byArea = new Map<string, typeof stops>();
  for (const st of stops) {
    const k = st.area_id ?? 'övrigt';
    byArea.set(k, [...(byArea.get(k) ?? []), st]);
  }
  const groups = [...byArea.values()].sort(
    (a, b) => b.reduce((x, s) => x + s.score, 0) - a.reduce((x, s) => x + s.score, 0)
  );
  const loads = carList.map(() => 0);
  const assigned: Stop[][] = carList.map(() => []);
  for (const g of groups) {
    const i = loads.indexOf(Math.min(...loads));
    assigned[i].push(...g.map(({ area_id: _a, ...rest }) => rest));
    loads[i] += g.reduce((x, s) => x + s.score, 0);
  }
  assigned.forEach((list) => list.sort((a, b) => b.score - a.score));

  // Spara
  for (let i = 0; i < carList.length; i++) {
    await db.from('car_routes').upsert(
      { car_id: carList[i].id, slot, stops: assigned[i], tenant_id: tenantId },
      { onConflict: 'car_id,route_date,slot' }
    );
  }
  return { cars: carList.map((c, i) => ({ ...c, stops: assigned[i] })), ctx };
}

// ---------- Rapporter ----------
// Vilken turnering rapporten gäller. Promptet får ALDRIG hårdkoda en turnerings
// namn eller beskrivning: varje turnering ska beskrivas utifrån sina egna uppgifter.
export type TenantInfo = {
  id: string;
  name: string;
  sport?: string;
  city?: string;
  playingAreas?: string;
};

function baseFor(t: TenantInfo) {
  const sport = t.sport || 'fotboll';
  const city = t.city ? ` i ${t.city}` : '';
  const planer = t.playingAreas || 'planer';
  const intro = `Du är AI-driftassistenten för ${t.name} – en ungdomsturnering i ${sport}${city}, med lag, deltagare och matcher fördelade över flera ${planer}`;

  return `${intro} och ett helt driftteam (ledning, områdesansvariga, skolvärdar, planvärdar, matchdelegater och säkerhetsgrupp) som håller ihop allt.
Skriv på svenska. Var konkret, kort och handlingsorienterad – punktlistor framför prosa. Hitta ALDRIG på data; använd endast lägesbilden nedan. Riskflaggor: grön = planvärd + domare räcker, gul = matchdelegat kopplas in, röd = säkerhetsgruppen kopplas in.`;
}

export function reportPrompt(
  kind: string,
  slot: string,
  ctx: unknown,
  routes?: unknown,
  tenant?: TenantInfo
) {
  const BASE = baseFor(tenant ?? { id: '', name: 'ArenaFlow' });
  const slotTxt = slot === 'morning' ? 'MORGONRAPPORT (inför dagen)' : slot === 'evening' ? 'KVÄLLSRAPPORT (summering av dagen och läget inför natten)' : 'LÄGESRAPPORT';
  const data = `\n\nLÄGESBILD (JSON):\n${JSON.stringify(ctx, null, 1)}`;
  if (kind === 'overview') {
    return `${BASE}\n\nSkriv en ${slotTxt} för LEDNINGEN. Struktur: 1) Läget i korthet (3–5 punkter), 2) Det ledningen måste agera på nu, 3) Flaggade matcher idag (gul/röd med tid, arena, åtgärd), 4) Incidenter senaste dygnet, 5) Bemanning & passbyten, 6) Prognos/risker inför ${slot === 'morning' ? 'dagen' : 'natten och morgondagen'}.${data}`;
  }
  if (kind === 'schools') {
    return `${BASE}\n\nSkriv en ${slotTxt} för SKOLVÄRDAR OCH BOENDEANSVARIGA. Struktur: 1) Skolor som behöver uppmärksamhet först (varför), 2) Beläggning & incheckningar (väntade lag), 3) Öppna fel per skola, 4) Nattronder (saknade/anmärkningar), 5) Konkret att-göra-lista för värdarna ${slot === 'morning' ? 'idag' : 'inför natten'}.${data}`;
  }
  if (kind === 'matches') {
    return `${BASE}\n\nSkriv en RAPPORT OM FLAGGADE MATCHER (gul/röd) idag. För varje flaggad match: tid, arena/plan, lag, klass, risknivå, notering, samt exakt vilken funktion som ska kopplas in och när de bör vara på plats. Avsluta med en samlad bedömning för säkerhetsgruppen. Om inga flaggade matcher finns: skriv kort att alla dagens matcher är gröna.${data}`;
  }
  // security
  return `${BASE}\n\nSkriv en KÖRORDER/BRIEFING för säkerhetsbilarna som ronderar mellan skolorna (${slotTxt.toLowerCase()}). Rutterna är redan beräknade nedan – för varje bil: sammanfatta rutten i stoppordning med skälen per stopp, vad föraren särskilt ska kontrollera, och när avvikelser ska eskaleras till säkerhetsgruppen. Kort och körbart.\n\nRUTTER (JSON):\n${JSON.stringify(routes, null, 1)}${data}`;
}

export async function generateReport(
  db: SupabaseClient,
  kind: string,
  slot: string,
  tenant: TenantInfo
) {
  let routes: unknown;
  let ctx: unknown;
  if (kind === 'security') {
    const r = await buildRoutes(db, slot, tenant.id);
    routes = r.cars; ctx = r.ctx;
  } else {
    ctx = await gatherContext(db, tenant.id);
  }
  const body = await callGemini(reportPrompt(kind, slot, ctx, routes, tenant));
  await db.from('ai_reports').upsert(
    { kind, slot, body, tenant_id: tenant.id },
    { onConflict: 'tenant_id,kind,slot,report_date' }
  );
  return body;
}
