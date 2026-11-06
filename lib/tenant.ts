// White-label: ALLT märkes-/sportspecifikt läses härifrån.
// Byt event genom att ändra NEXT_PUBLIC_TENANT (GOTHIA | PARTILLE).
// Eventnamn + primärfärg kan överstyras i runtime via event_settings (Inställningar).

export type Sport = 'fotboll' | 'handboll';
export type TenantKey = 'GOTHIA' | 'PARTILLE';

export type TenantConfig = {
  key: TenantKey;
  event: { name: string; shortName: string; sport: Sport; city: string; logoText: string };
  theme: {
    bg: string;           // ljus appbakgrund
    panel: string;        // vita kort
    panel2: string;       // sidomeny/topbar (mörk brandfärg)
    line: string;         // kantlinjer
    ink: string;          // primär text
    muted: string;        // sekundär text
    sidebarInk: string;   // text i sidomenyn
    sidebarMuted: string;
    primary: string;      // knappar/aktiva element
    primaryDark: string;
    accent: string;       // gul/brand-accent
    danger: string;
    ok: string;
  };
  labels: {
    playingArea: string; playingAreas: string;
    matchStart: string;
    match: string; school: string; schools: string; area: string; areas: string;
  };
};

export const GOTHIA: TenantConfig = {
  key: 'GOTHIA',
  event: { name: 'ArenaFlow', shortName: 'ArenaFlow', sport: 'fotboll', city: 'Göteborg', logoText: 'AF' },
  theme: {
    bg: '#F2F5F9', panel: '#FFFFFF', panel2: '#25618F', line: '#E2E8F1',
    ink: '#16283C', muted: '#5D7186',
    sidebarInk: '#FFFFFF', sidebarMuted: 'rgba(255,255,255,0.72)',
    primary: '#1D6FA8', primaryDark: '#155A8C',
    accent: '#FFC845', danger: '#D64545', ok: '#1E9E5A'
  },
  labels: {
    playingArea: 'Plan', playingAreas: 'Planer', matchStart: 'Avspark',
    match: 'Match', school: 'Boende', schools: 'Boenden', area: 'Område', areas: 'Områden'
  }
};

export const PARTILLE: TenantConfig = {
  key: 'PARTILLE',
  event: { name: 'Partille Cup', shortName: 'Partille', sport: 'handboll', city: 'Partille', logoText: 'PC' },
  theme: {
    bg: '#F3F7F4', panel: '#FFFFFF', panel2: '#1E6B45', line: '#E1EAE3',
    ink: '#152A20', muted: '#5B7264',
    sidebarInk: '#FFFFFF', sidebarMuted: 'rgba(255,255,255,0.72)',
    primary: '#1E9E5A', primaryDark: '#177C46',
    accent: '#FFD24C', danger: '#D64545', ok: '#1E9E5A'
  },
  labels: {
    playingArea: 'Hall', playingAreas: 'Hallar', matchStart: 'Nedkast',
    match: 'Match', school: 'Boende', schools: 'Boenden', area: 'Område', areas: 'Områden'
  }
};

const ACTIVE = (process.env.NEXT_PUBLIC_TENANT ?? 'GOTHIA') as TenantKey;
export const tenant: TenantConfig = ACTIVE === 'PARTILLE' ? PARTILLE : GOTHIA;
