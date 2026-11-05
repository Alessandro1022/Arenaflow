'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Phone } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useLang } from '@/components/LanguageProvider';
import { useTenant } from '@/components/TenantProvider';

// Databasen räknar, klienten ritar. En rad per område i stället för alla lag.
type AreaStat = {
  id: string; name: string; description: string | null;
  n_schools: number; n_arenas: number; teams_in: number;
  in_house: number; capacity: number; open_issues: number; open_incidents: number;
};
// Områdesansvariga (del 28): vem som har ansvar för området, med telefon
type Manager = { area_id: string; user_id: string; full_name: string; phone: string; role: string };
const tel = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;

export default function AreasClient({ canPickManagers = false }: { canPickManagers?: boolean }) {
  // Turneringens egna namn och etiketter, inte den statiska standarden
  const tenant = useTenant();
  const { tr } = useLang();
  const supabase = createClient();
  const [rows, setRows] = useState<AreaStat[]>([]);
  // null = del 28 inte körd än, då visas inget om ansvariga
  const [managers, setManagers] = useState<Record<string, Manager[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    // Statistiken och de områdesansvariga hämtas samtidigt
    const [s, m] = await Promise.all([
      supabase.from('area_stats').select('*').order('name'),
      supabase.from('area_managers').select('area_id,user_id,full_name,phone,role').order('full_name')
    ]);
    setRows((s.data ?? []) as AreaStat[]);
    if (m.error) setManagers(null);
    else {
      const by: Record<string, Manager[]> = {};
      for (const x of (m.data ?? []) as Manager[]) (by[x.area_id] ??= []).push(x);
      setManagers(by);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
    // Fördröjd omladdning: många ändringar i rad ger en enda uppdatering
    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 1500);
    };
    const ch = supabase.channel('areas-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_issues' }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_assignments' }, bump)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (loading) return <div className="page-sub">{tr('loading')}</div>;

  return (
    <>
      <h1 className="page-title">{tenant.labels.areas}</h1>
      <div className="page-sub">
        <span className="pulse" />{tr('live').toLowerCase()} · aggregerad status per {tenant.labels.area.toLowerCase()}
      </div>

      <div className="grid-cards">
        {rows.map((a) => {
          const pct = a.capacity > 0 ? Math.min(100, Math.round((a.in_house / a.capacity) * 100)) : 0;
          return (
            <div key={a.id} className="card link-card">
              <div className="li-head">
                <div className="li-title">{a.name}</div>
                {a.open_incidents > 0 && (
                  <span className="badge b-critical">{a.open_incidents} {tr('incidents').toLowerCase()}</span>
                )}
              </div>
              {a.description && <div className="li-meta">{a.description}</div>}
              {managers && (
                <div className="area-managers">
                  {(managers[a.id] ?? []).map((m) => (
                    <div key={m.user_id} className="area-manager">
                      <span><span className="li-meta" style={{ marginTop: 0 }}>Områdesansvarig</span> <b>{m.full_name || '—'}</b></span>
                      {m.phone && (
                        <a className="btn btn-sm" href={tel(m.phone)} aria-label={`Ring ${m.full_name}`}>
                          <Phone size={14} /> Ring
                        </a>
                      )}
                    </div>
                  ))}
                  {(managers[a.id] ?? []).length === 0 && (
                    <div className="li-meta" style={{ marginTop: 0 }}>Ingen områdesansvarig vald än{canPickManagers ? ' – välj under Personal.' : '.'}</div>
                  )}
                </div>
              )}

              <div className="stat-row"><span>{tenant.labels.schools}</span><b>{a.n_schools}</b></div>
              <div className="stat-row"><span>{tenant.labels.playingAreas}</span><b>{a.n_arenas}</b></div>
              <div className="stat-row"><span>{tr('teamsIn')}</span><b>{a.teams_in}</b></div>
              <div className="stat-row"><span>{tr('openIssues')}</span><b>{a.open_issues}</b></div>
              <div className="stat-row" style={{ marginBottom: 6 }}>
                <span>{tr('capacity')}</span><b>{a.in_house}/{a.capacity} · {pct}%</b>
              </div>
              <div className="prog"><div style={{ width: `${pct}%` }} /></div>

              <div className="li-actions">
                <Link href="/schools" className="btn btn-sm">{tenant.labels.schools}</Link>
                <Link href="/arenas" className="btn btn-sm">{tenant.labels.playingAreas}</Link>
              </div>
            </div>
          );
        })}
        {rows.length === 0 && <div className="page-sub">{tr('nothingHere')}</div>}
      </div>
    </>
  );
}
