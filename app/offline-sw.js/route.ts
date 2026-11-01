// Service workern för offlineläget. Serveras härifrån i stället för som fil
// i public/ av två skäl:
//  - versionen byts vid varje driftsättning, så telefonerna hämtar en ny
//    worker och en färsk offlinesida av sig själva
//  - OFFLINE_SW=off i Vercel stänger av allt utan kodändring: då serveras en
//    worker som tar bort sig själv. Kräver ny driftsättning (Redeploy).
import { offlineSwKillSource, offlineSwSource } from '@/lib/offline/swSource';
import { supabaseUrl } from '@/lib/supabase/env';

export const dynamic = 'force-dynamic';

const DEFAULT_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Supabase-adressens ursprung. Saknas den sparas ingen data, men sidorna gör det.
function supabaseOrigin(): string {
  try { return new URL(supabaseUrl()).origin; } catch { return ''; }
}

// Kartbildernas värd. {s} i adressen betyder flera underdomäner (a, b, c).
function tileHosts(): string[] {
  const tpl = (process.env.NEXT_PUBLIC_MAP_TILE_URL || DEFAULT_TILES).trim();
  try {
    const host = new URL(tpl.replace(/\{[a-z]\}/gi, 'x')).host;
    return [/^https?:\/\/\{s\}\./i.test(tpl) ? '*.' + host.split('.').slice(1).join('.') : host];
  } catch {
    return [];
  }
}

export function GET() {
  const off = process.env.OFFLINE_SW === 'off';
  const version = process.env.SW_BUILD || process.env.TOPS_BUILD || 'dev';
  const body = off ? offlineSwKillSource() : offlineSwSource(version, { supabase: supabaseOrigin(), tiles: tileHosts() });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      // Webbläsaren ska alltid fråga servern, aldrig använda en sparad kopia
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Service-Worker-Allowed': '/'
    }
  });
}
