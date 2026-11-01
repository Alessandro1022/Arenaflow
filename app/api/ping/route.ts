// Täckningskoll för appen (components/OfflineBar.tsx): svarar direkt, utan
// databas och utan inloggning. Går aldrig via service workern.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
