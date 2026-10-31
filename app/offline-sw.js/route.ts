// Service workern för offlineläget. Serveras härifrån i stället för som fil
// i public/ av två skäl:
//  - versionen byts vid varje driftsättning, så telefonerna hämtar en ny
//    worker och en färsk offlinesida av sig själva
//  - OFFLINE_SW=off i Vercel stänger av allt utan kodändring: då serveras en
//    worker som tar bort sig själv. Kräver ny driftsättning (Redeploy).
import { offlineSwKillSource, offlineSwSource } from '@/lib/offline/swSource';

export const dynamic = 'force-dynamic';

export function GET() {
  const off = process.env.OFFLINE_SW === 'off';
  const version = process.env.SW_BUILD || process.env.TOPS_BUILD || 'dev';
  return new Response(off ? offlineSwKillSource() : offlineSwSource(version), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      // Webbläsaren ska alltid fråga servern, aldrig använda en sparad kopia
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Service-Worker-Allowed': '/'
    }
  });
}
