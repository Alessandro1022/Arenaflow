// Vad som går att importera, vilka kolumner som hör till vad, och hur ett
// cellvärde blir ett värde i databasen.
//
// Rubrikerna i Gothias filer är okända i förväg. Varje fält har därför en
// lista med vanliga rubriker på svenska och engelska; den som importerar kan
// alltid ändra kopplingen själv innan något sparas.
import type { Cell } from './xlsx';

export type KindKey = 'schools' | 'arenas' | 'teams' | 'participants' | 'matches' | 'staff';
export type FieldType = 'text' | 'int' | 'num' | 'date' | 'time' | 'datetime' | 'phone' | 'email' | 'enum';

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  synonyms: string[];
  options?: Record<string, string[]>;   // enum: värde → rubriker/ord som betyder det
  hint?: string;
};

export type Kind = {
  key: KindKey;
  label: string;
  desc: string;
  fields: Field[];
  example: Record<string, string>;
  // Minst en av grupperna måste vara kopplad (t.ex. namn ELLER för- och efternamn)
  needOneOf?: string[][];
};

const contactFields: Field[] = [
  { key: 'contact_name', label: 'Kontaktperson', type: 'text', synonyms: ['kontaktperson', 'kontakt', 'värd', 'skolvärd', 'contact', 'contact person'] },
  { key: 'contact_phone', label: 'Telefon', type: 'phone', synonyms: ['telefon', 'tel', 'mobil', 'mobilnummer', 'telefonnummer', 'kontakttelefon', 'phone', 'mobile'] }
];
const emergencyFields: Field[] = [
  { key: 'assembly_point', label: 'Återsamlingsplats', type: 'text', synonyms: ['återsamlingsplats', 'återsamling', 'samlingsplats', 'assembly point'] },
  { key: 'nearest_care', label: 'Närmaste vård', type: 'text', synonyms: ['närmaste vård', 'vård', 'sjukhus', 'vårdcentral', 'nearest care', 'hospital'] },
  { key: 'emergency_note', label: 'Nödinfo', type: 'text', synonyms: ['nödinfo', 'nödinformation', 'emergency', 'emergency info'] },
  { key: 'lat', label: 'Latitud', type: 'num', synonyms: ['lat', 'latitud', 'latitude'] },
  { key: 'lng', label: 'Longitud', type: 'num', synonyms: ['lng', 'lon', 'long', 'longitud', 'longitude'] }
];

export const KINDS: Kind[] = [
  {
    key: 'schools',
    label: 'Boenden',
    desc: 'Skolor, hotell, vandrarhem och camping. Saknade områden skapas.',
    fields: [
      { key: 'name', label: 'Namn', type: 'text', required: true, synonyms: ['namn', 'boende', 'skola', 'hotell', 'förläggning', 'name', 'accommodation', 'school'] },
      {
        key: 'kind', label: 'Typ', type: 'enum', synonyms: ['typ', 'boendetyp', 'type'],
        options: { skola: ['skola', 'school', 'skolboende'], hotell: ['hotell', 'hotel'], vandrarhem: ['vandrarhem', 'hostel'], camping: ['camping', 'camp'] }
      },
      { key: 'address', label: 'Adress', type: 'text', synonyms: ['adress', 'gatuadress', 'besöksadress', 'address'] },
      { key: 'area', label: 'Område', type: 'text', synonyms: ['område', 'stadsdel', 'distrikt', 'area', 'district', 'zon'] },
      { key: 'capacity', label: 'Kapacitet', type: 'int', synonyms: ['kapacitet', 'platser', 'bäddar', 'antal platser', 'capacity', 'beds'] },
      ...contactFields,
      { key: 'contact_email', label: 'E-post', type: 'email', synonyms: ['e-post', 'epost', 'mejl', 'mail', 'email'] },
      { key: 'rooms', label: 'Antal rum', type: 'int', synonyms: ['antal rum', 'rum', 'rooms'] },
      { key: 'check_in_from', label: 'Incheckning', type: 'text', synonyms: ['incheckning', 'incheckning från', 'check-in', 'check in'] },
      ...emergencyFields
    ],
    example: { name: 'Hvitfeldtska gymnasiet', kind: 'Skola', address: 'Rektorsgatan 2, Göteborg', area: 'Centrum', capacity: '400', contact_name: 'Kim Andersson', contact_phone: '070-123 45 67' }
  },
  {
    key: 'arenas',
    label: 'Spelplatser',
    desc: 'Hallar och planer. Saknade områden skapas.',
    fields: [
      { key: 'name', label: 'Namn', type: 'text', required: true, synonyms: ['namn', 'spelplats', 'hall', 'idrottshall', 'arena', 'anläggning', 'venue', 'name'] },
      { key: 'address', label: 'Adress', type: 'text', synonyms: ['adress', 'gatuadress', 'address'] },
      { key: 'area', label: 'Område', type: 'text', synonyms: ['område', 'stadsdel', 'distrikt', 'area', 'district', 'zon'] },
      { key: 'surface_count', label: 'Antal planer', type: 'int', synonyms: ['antal planer', 'planer', 'banor', 'antal banor', 'ytor', 'courts', 'pitches'] },
      { key: 'club', label: 'Värdklubb', type: 'text', synonyms: ['värdklubb', 'klubb', 'förening', 'club', 'host club'] },
      ...contactFields,
      ...emergencyFields
    ],
    example: { name: 'Lisebergshallen', address: 'Örgrytevägen 7, Göteborg', area: 'Centrum', surface_count: '2', contact_name: 'Sam Berg', contact_phone: '070-765 43 21' }
  },
  {
    key: 'teams',
    label: 'Lag',
    desc: 'Lagen och var de bor. Boendet måste finnas; saknade rum skapas.',
    fields: [
      { key: 'team_name', label: 'Lag', type: 'text', required: true, synonyms: ['lag', 'lagnamn', 'team', 'team name', 'teamname'] },
      { key: 'club_name', label: 'Förening', type: 'text', synonyms: ['förening', 'klubb', 'club', 'club name'] },
      { key: 'country', label: 'Land', type: 'text', synonyms: ['land', 'nation', 'country'] },
      { key: 'age_class', label: 'Åldersklass', type: 'text', synonyms: ['åldersklass', 'klass', 'ålder', 'kategori', 'age class', 'class', 'category', 'age'] },
      { key: 'group_size', label: 'Antal personer', type: 'int', synonyms: ['antal personer', 'antal', 'personer', 'deltagare', 'storlek', 'size', 'persons', 'people'] },
      { key: 'contact_name', label: 'Lagledare', type: 'text', synonyms: ['lagledare', 'ledare', 'kontaktperson', 'kontakt', 'leader', 'team leader', 'contact'] },
      { key: 'contact_phone', label: 'Telefon', type: 'phone', synonyms: ['telefon', 'tel', 'mobil', 'mobilnummer', 'phone', 'mobile'] },
      { key: 'school', label: 'Boende', type: 'text', required: true, synonyms: ['boende', 'skola', 'förläggning', 'hotell', 'accommodation', 'school', 'lodging'] },
      { key: 'classroom', label: 'Rum', type: 'text', synonyms: ['rum', 'klassrum', 'sal', 'room', 'classroom'] },
      { key: 'arrival_date', label: 'Ankomst', type: 'date', synonyms: ['ankomst', 'ankomstdatum', 'ankommer', 'arrival', 'arrival date'] },
      { key: 'departure_date', label: 'Avresa', type: 'date', synonyms: ['avresa', 'avresedatum', 'avreser', 'departure', 'departure date'] }
    ],
    example: { team_name: 'IBK Exempel P15', club_name: 'IBK Exempel', country: 'Sverige', age_class: 'P15', group_size: '16', contact_name: 'Lena Ledare', contact_phone: '070-333 44 55', school: 'Hvitfeldtska gymnasiet', classroom: 'B12', arrival_date: '2027-01-02', departure_date: '2027-01-05' }
  },
  {
    key: 'participants',
    label: 'Deltagare',
    desc: 'Spelare och ledare i lagen. Lagen måste finnas. Bara födelseåret sparas.',
    needOneOf: [['full_name'], ['first_name', 'last_name']],
    fields: [
      { key: 'full_name', label: 'Namn', type: 'text', synonyms: ['namn', 'fullständigt namn', 'deltagare', 'name', 'full name'] },
      { key: 'first_name', label: 'Förnamn', type: 'text', synonyms: ['förnamn', 'first name', 'firstname', 'given name'] },
      { key: 'last_name', label: 'Efternamn', type: 'text', synonyms: ['efternamn', 'last name', 'lastname', 'surname', 'family name'] },
      { key: 'team', label: 'Lag', type: 'text', required: true, synonyms: ['lag', 'lagnamn', 'team', 'team name'] },
      { key: 'club', label: 'Förening', type: 'text', synonyms: ['förening', 'klubb', 'club'], hint: 'Behövs bara om två lag har samma namn' },
      {
        key: 'role', label: 'Roll', type: 'enum', synonyms: ['roll', 'typ', 'funktion', 'role', 'type'],
        options: { spelare: ['spelare', 'player', 'aktiv', 'deltagare'], ledare: ['ledare', 'lagledare', 'tränare', 'coach', 'leader', 'staff', 'official'] }
      },
      { key: 'birth_year', label: 'Födelseår', type: 'int', synonyms: ['födelseår', 'född', 'födelsedatum', 'födelsedag', 'birth year', 'year of birth', 'birthdate', 'date of birth', 'dob'], hint: 'Datum eller personnummer går bra – bara året sparas' },
      { key: 'jersey_number', label: 'Tröjnummer', type: 'int', synonyms: ['tröjnummer', 'nummer', 'nr', 'number', 'jersey', 'shirt number'] }
    ],
    example: { full_name: 'Alva Exempel', team: 'IBK Exempel P15', role: 'Spelare', birth_year: '2011', jersey_number: '7' }
  },
  {
    key: 'matches',
    label: 'Matcher',
    desc: 'Spelschemat. Spelplatserna måste finnas. Tider i svensk tid.',
    needOneOf: [['starts_at'], ['date', 'time']],
    fields: [
      { key: 'arena', label: 'Spelplats', type: 'text', required: true, synonyms: ['spelplats', 'hall', 'idrottshall', 'arena', 'anläggning', 'venue'] },
      { key: 'surface_label', label: 'Bana', type: 'text', synonyms: ['bana', 'plan nr', 'yta', 'court', 'pitch', 'field'] },
      { key: 'date', label: 'Datum', type: 'date', synonyms: ['datum', 'dag', 'matchdag', 'date', 'day'] },
      { key: 'time', label: 'Tid', type: 'time', synonyms: ['tid', 'starttid', 'avslag', 'nedsläpp', 'klockslag', 'time', 'start time', 'kick-off'] },
      { key: 'starts_at', label: 'Start (datum och tid)', type: 'datetime', synonyms: ['start', 'matchstart', 'datum och tid', 'datum tid', 'start datetime', 'datetime'] },
      { key: 'home_team', label: 'Hemmalag', type: 'text', required: true, synonyms: ['hemmalag', 'hemma', 'lag 1', 'lag a', 'home', 'home team', 'team 1'] },
      { key: 'away_team', label: 'Bortalag', type: 'text', required: true, synonyms: ['bortalag', 'borta', 'lag 2', 'lag b', 'away', 'away team', 'team 2'] },
      { key: 'category', label: 'Klass', type: 'text', synonyms: ['klass', 'åldersklass', 'kategori', 'class', 'category', 'age class'] },
      { key: 'group_name', label: 'Grupp', type: 'text', synonyms: ['grupp', 'pool', 'group'] },
      { key: 'stage', label: 'Omgång', type: 'text', synonyms: ['omgång', 'fas', 'skede', 'stage', 'round'] }
    ],
    example: { arena: 'Lisebergshallen', surface_label: '1', date: '2027-01-03', time: '09:00', home_team: 'IBK Exempel P15', away_team: 'FBC Test P15', category: 'P15', group_name: 'Grupp A' }
  },
  {
    key: 'staff',
    label: 'Personal',
    desc: 'Bjuder in personal med roll och område. Var och en får ett mejl.',
    fields: [
      { key: 'email', label: 'E-post', type: 'email', required: true, synonyms: ['e-post', 'epost', 'mejl', 'mail', 'email', 'e-mail'] },
      { key: 'full_name', label: 'Namn', type: 'text', synonyms: ['namn', 'fullständigt namn', 'name', 'full name'] },
      { key: 'role', label: 'Roll', type: 'text', required: true, synonyms: ['roll', 'befattning', 'funktion', 'role', 'position'] },
      { key: 'area', label: 'Område', type: 'text', synonyms: ['område', 'stadsdel', 'distrikt', 'area', 'district'] },
      { key: 'place', label: 'Plats', type: 'text', synonyms: ['plats', 'boende', 'skola', 'spelplats', 'hall', 'location', 'place'], hint: 'Ett boende eller en spelplats. Används om område saknas.' }
    ],
    example: { email: 'kim@example.se', full_name: 'Kim Andersson', role: 'Säkerhetspersonal', area: 'Centrum', place: '' }
  }
];

export const kindOf = (k: KindKey) => KINDS.find((x) => x.key === k)!;

// ---- Rubriker ----
const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9åäöéü]+/g, ' ').trim();

// Gissar vilken kolumn som hör till vilket fält. Exakt träff först, sedan
// rubriker som börjar med ordet. En kolumn används bara en gång.
export function guessMapping(kind: Kind, headers: string[], extraSynonyms: Record<string, string[]> = {}): Record<string, number> {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const out: Record<string, number> = {};
  const syn = (f: Field) => [...f.synonyms, ...(extraSynonyms[f.key] ?? [])].map(headerKey);
  for (const pass of ['exact', 'prefix'] as const) {
    for (const f of kind.fields) {
      if (out[f.key] !== undefined) continue;
      const list = syn(f);
      const idx = keys.findIndex((k, i) => !used.has(i) && k && list.some((s) =>
        pass === 'exact' ? k === s : k.startsWith(s + ' ') || k.endsWith(' ' + s)));
      if (idx >= 0) { out[f.key] = idx; used.add(idx); }
    }
  }
  return out;
}

// ---- Värden ----
export const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const pad = (n: number) => String(n).padStart(2, '0');

export function cellText(c: Cell): string {
  if (c == null) return '';
  if (c instanceof Date) {
    const hasTime = c.getUTCHours() || c.getUTCMinutes();
    const d = `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}`;
    return hasTime ? `${d} ${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}` : d;
  }
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(Math.round(c * 1e6) / 1e6);
  return String(c).trim();
}

type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string };

function parseDate(c: Cell): Parsed<string> {
  if (c == null || c === '') return { ok: true, value: null };
  if (c instanceof Date) return { ok: true, value: `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}` };
  if (typeof c === 'number' && c > 20000 && c < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(c) * 86400000);
    return { ok: true, value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` };
  }
  const s = String(c).trim().split(/[ T]/)[0];
  let y = 0, m = 0, d = 0, mm: RegExpMatchArray | null;
  if ((mm = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +mm[1]; m = +mm[2]; y = +mm[3]; }
  else if ((mm = s.match(/^(\d{4})(\d{2})(\d{2})$/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else return { ok: false, error: `"${s}" är inget datum` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok: false, error: `"${s}" är inget giltigt datum` };
  return { ok: true, value: `${y}-${pad(m)}-${pad(d)}` };
}

function parseTime(c: Cell): Parsed<string> {
  if (c == null || c === '') return { ok: true, value: null };
  if (c instanceof Date) return { ok: true, value: `${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}` };
  if (typeof c === 'number' && c >= 0 && c < 1) {
    const mins = Math.round(c * 1440);
    return { ok: true, value: `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}` };
  }
  const s = String(c).trim();
  const mm = s.match(/(?:^|\s)(\d{1,2})[:.](\d{2})(?::\d{2})?$/) ?? s.match(/^(\d{2})(\d{2})$/);
  if (!mm || +mm[1] > 23 || +mm[2] > 59) return { ok: false, error: `"${s}" är ingen tid` };
  return { ok: true, value: `${pad(+mm[1])}:${mm[2]}` };
}

function parseInt0(c: Cell, field: Field): Parsed<number> {
  if (c == null || c === '') return { ok: true, value: null };
  if (field.key === 'birth_year') {
    // Datum, personnummer eller år: bara året sparas, aldrig resten
    if (c instanceof Date) return { ok: true, value: c.getUTCFullYear() };
    const s = String(c).trim();
    const y4 = s.match(/^(19|20)\d{2}/);
    if (y4) return { ok: true, value: Number(y4[0]) };
    const dmy = s.match(/^\d{1,2}[-/.]\d{1,2}[-/.]((?:19|20)\d{2})/);
    if (dmy) return { ok: true, value: Number(dmy[1]) };
    return { ok: false, error: `"${s}" går inte att läsa som födelseår` };
  }
  const n = typeof c === 'number' ? c : Number(String(c).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return { ok: false, error: `"${cellText(c)}" är inget tal` };
  return { ok: true, value: Math.round(n) };
}

export function stockholmIso(date: string, time: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let utc = want - 3600e3;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  // Två varv räcker även vid omställning till och från sommartid
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    utc += want - local;
  }
  return new Date(utc).toISOString();
}

export function parseCell(field: Field, c: Cell): Parsed<string | number> {
  switch (field.type) {
    case 'int': return parseInt0(c, field);
    case 'num': {
      if (c == null || c === '') return { ok: true, value: null };
      const n = typeof c === 'number' ? c : Number(String(c).replace(',', '.'));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `"${cellText(c)}" är inget tal` };
    }
    case 'date': return parseDate(c);
    case 'time': return parseTime(c);
    case 'datetime': {
      if (c == null || c === '') return { ok: true, value: null };
      const d = parseDate(c);
      if (!d.ok || !d.value) return d.ok ? { ok: false, error: 'Datum saknas' } : d;
      const t = c instanceof Date ? parseTime(c) : parseTime(String(c).trim().split(/[ T]/).slice(1).join(' '));
      if (!t.ok || !t.value) return { ok: false, error: `"${cellText(c)}" saknar klockslag` };
      return { ok: true, value: stockholmIso(d.value, t.value) };
    }
    case 'phone': {
      if (c == null || c === '') return { ok: true, value: null };
      // Ett nummer som Excel sparat som tal har tappat sin nolla
      if (typeof c === 'number') {
        const s = String(Math.round(c));
        return { ok: true, value: s.length === 9 ? `0${s}` : s };
      }
      return { ok: true, value: String(c).trim() };
    }
    case 'email': {
      const s = cellText(c).toLowerCase();
      if (!s) return { ok: true, value: null };
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? { ok: true, value: s } : { ok: false, error: `"${s}" är ingen e-postadress` };
    }
    case 'enum': {
      const s = norm(cellText(c));
      if (!s) return { ok: true, value: null };
      for (const [val, words] of Object.entries(field.options ?? {})) {
        if (words.some((w) => norm(w) === s)) return { ok: true, value: val };
      }
      return { ok: false, error: `"${cellText(c)}" är ingen giltig ${field.label.toLowerCase()}` };
    }
    default: {
      const s = cellText(c);
      return { ok: true, value: s || null };
    }
  }
}
