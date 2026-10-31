'use client';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLang } from '@/components/LanguageProvider';
import { useTenant } from '@/components/TenantProvider';
import { tierOf, type Role, ROLE_LABELS, ROLE_GROUPS } from '@/lib/types';
import { downloadJson, fileSafe } from '@/lib/download';

// 16 roller i en platt lista blir svart att overblicka, sa de grupperas
// som organisationen faktiskt ser ut.
// Roller över ens egen nivå går inte att dela ut (spärras även i databasen)
const RoleOptions = ({ max = 6 }: { max?: number }) => (
  <>
    {ROLE_GROUPS.map((g) => (
      <optgroup key={g.label} label={g.label}>
        {g.roles.map((r) => <option key={r} value={r} disabled={tierOf(r) > max}>{ROLE_LABELS[r]}</option>)}
      </optgroup>
    ))}
  </>
);

type Profile = { id: string; full_name: string; email: string; role: Role; phone: string | null };
type Scope = { id: string; user_id: string; area_id: string | null; location_type: 'school' | 'arena' | null; location_id: string | null };
type Named = { id: string; name: string };

export default function StaffClient({ viewerRole }: { viewerRole: Role }) {
  // Turneringens egna namn och etiketter, inte den statiska standarden
  const tenant = useTenant();
  const { tr } = useLang();
  const supabase = createClient();
  const canEdit = tierOf(viewerRole) >= 5; // roll + scope skrivs endast av admin+ (skyddat av RLS/trigger)
  const [people, setPeople] = useState<Profile[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [areas, setAreas] = useState<Named[]>([]);
  const [schools, setSchools] = useState<Named[]>([]);
  const [arenas, setArenas] = useState<Named[]>([]);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [pick, setPick] = useState(''); // 'area:ID' | 'school:ID' | 'arena:ID'
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [myId, setMyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [invOpen, setInvOpen] = useState(false);
  const [invEmail, setInvEmail] = useState('');
  const [invRole, setInvRole] = useState<Role>('volunteer');
  const [invPick, setInvPick] = useState('');
  const [invMsg, setInvMsg] = useState(''); const [invErr, setInvErr] = useState('');
  const [invBusy, setInvBusy] = useState(false);

  const sendInvite = async () => {
    setInvBusy(true); setInvErr(''); setInvMsg('');
    const [k, id] = invPick ? invPick.split(':') : ['', ''];
    const res = await fetch('/api/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: invEmail.trim(), role: invRole,
        areaId: k === 'area' ? id : null,
        locationType: k === 'school' || k === 'arena' ? k : null,
        locationId: k === 'school' || k === 'arena' ? id : null
      })
    });
    const data = await res.json();
    if (!res.ok) setInvErr(data.error ?? 'Fel');
    else { setInvMsg(tr('inviteSent')); setInvEmail(''); setInvPick(''); }
    setInvBusy(false);
  };

  const load = useCallback(async () => {
    const [p, sc, a, s, ar] = await Promise.all([
      supabase.from('profiles').select('id,full_name,email,role,phone').order('full_name'),
      supabase.from('staff_scope').select('id,user_id,area_id,location_type,location_id'),
      supabase.from('areas').select('id,name').order('name'),
      supabase.from('schools').select('id,name').order('name'),
      supabase.from('arenas').select('id,name').order('name')
    ]);
    const { data: sess } = await supabase.auth.getSession();
    setMyId(sess.session?.user.id ?? '');
    setPeople((p.data ?? []) as Profile[]);
    setScopes((sc.data ?? []) as Scope[]);
    setAreas((a.data ?? []) as Named[]);
    setSchools((s.data ?? []) as Named[]);
    setArenas((ar.data ?? []) as Named[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const changeRole = async (id: string, role: string) => {
    setErr('');
    const { error } = await supabase.from('profiles').update({ role }).eq('id', id);
    if (error) setErr(error.message);
    load();
  };

  const addScope = async (userId: string) => {
    if (!pick) return;
    setErr('');
    const [kind, id] = pick.split(':');
    const row: { user_id: string; area_id: string | null; location_type: string | null; location_id: string | null } =
      kind === 'area'
        ? { user_id: userId, area_id: id, location_type: null, location_id: null }
        : { user_id: userId, area_id: null, location_type: kind, location_id: id };
    const { error } = await supabase.from('staff_scope').insert(row);
    if (error) setErr(error.message);
    setPick(''); load();
  };

  // Tappad telefon: tar bort personens kodapp, så får hen slå på tvåfaktor igen
  const resetMfa = async (p: Profile) => {
    if (!window.confirm(`Nollställa tvåfaktor för ${p.full_name || p.email}? Personen får lägga till kodappen igen vid nästa inloggning.`)) return;
    setErr(''); setMsg('');
    const res = await fetch('/api/mfa-reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: p.id })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setErr(data.error ?? 'Fel');
    else setMsg(data.removed ? `Tvåfaktor nollställd för ${p.full_name || p.email}.` : `${p.full_name || p.email} hade ingen kodapp.`);
  };

  // Registerutdrag: allt systemet har om personen, som en fil
  const exportPerson = async (p: Profile) => {
    setErr(''); setMsg('');
    const { data, error } = await supabase.rpc('person_export', { p: p.id });
    if (error) { setErr(/function|schema cache/i.test(error.message) ? 'Kör del 25 i Supabase först.' : error.message); return; }
    downloadJson(`registerutdrag-${fileSafe(p.full_name || p.email)}-${new Date().toISOString().slice(0, 10)}.json`, data);
  };

  // Radering: personen görs anonym och inloggningen spärras
  const erasePerson = async (p: Profile) => {
    if (!window.confirm(`Radera ${p.full_name || p.email}? Namn, e-post och telefon tas bort och inloggningen spärras. Det går inte att ångra.`)) return;
    setErr(''); setMsg('');
    const res = await fetch('/api/gdpr/erase-person', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: p.id })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setErr(data.error ?? 'Fel');
    else setMsg(`${p.full_name || p.email} är raderad.`);
    load();
  };

  const removeScope = async (scopeId: string) => {
    setErr('');
    const { error } = await supabase.from('staff_scope').delete().eq('id', scopeId);
    if (error) setErr(error.message);
    load();
  };

  const scopeLabel = (s: Scope) => {
    if (s.area_id) return `${tenant.labels.area}: ${areas.find((a) => a.id === s.area_id)?.name ?? '?'}`;
    const list = s.location_type === 'school' ? schools : arenas;
    return `${list.find((l) => l.id === s.location_id)?.name ?? '?'}`;
  };

  if (loading) return <div className="page-sub">{tr('loading')}</div>;

  const visible = people.filter((p) =>
    !q || p.full_name?.toLowerCase().includes(q.toLowerCase()) || p.email?.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">{tr('staff')}</h1>
          <div className="page-sub" style={{ marginBottom: 0 }}>{people.length} · {tr('roleLbl').toLowerCase()} + {tr('scope').toLowerCase()}</div>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={() => setInvOpen(true)}>{tr('invite')}</button>}
      </div>


      <input className="input" placeholder="Sök namn eller e-post…" value={q}
        onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340, marginBottom: 16 }} />
      {err && <div className="form-error" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="ok-msg" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="list">
        {visible.map((p) => {
          const myScopes = scopes.filter((s) => s.user_id === p.id);
          const open = openId === p.id;
          return (
            <div key={p.id} className="list-item">
              <div className="li-head">
                <div>
                  <div className="li-title">{p.full_name || '—'}</div>
                  <div className="li-meta">{p.email}{p.phone ? ` · ${p.phone}` : ''}</div>
                </div>
                {canEdit ? (
                  <select className="select" style={{ width: 'auto', padding: '6px 9px', fontSize: 12.5 }}
                    value={p.role} onChange={(e) => changeRole(p.id, e.target.value)}>
                    <RoleOptions max={tierOf(viewerRole)} />
                  </select>
                ) : (
                  <span className="badge b-low">{ROLE_LABELS[p.role]}</span>
                )}
              </div>

              <div className="li-actions">
                {myScopes.length === 0 && <span className="li-meta">{tr('noScope')}</span>}
                {myScopes.map((s) => (
                  <span key={s.id} className="badge b-resolved">
                    {scopeLabel(s)}
                    {canEdit && (
                      <button className="btn-ghost" style={{ marginLeft: 6, fontSize: 11 }}
                        onClick={() => removeScope(s.id)} title={tr('remove')}>✕</button>
                    )}
                  </span>
                ))}
                {canEdit && (
                  <button className="btn btn-sm" onClick={() => { setOpenId(open ? null : p.id); setPick(''); }}>
                    {open ? tr('cancel') : tr('assign')}
                  </button>
                )}
                {canEdit && tierOf(p.role) <= tierOf(viewerRole) && (
                  <button className="btn btn-sm" onClick={() => resetMfa(p)}>Nollställ tvåfaktor</button>
                )}
                {canEdit && (
                  <button className="btn btn-sm" onClick={() => exportPerson(p)}>Registerutdrag</button>
                )}
                {canEdit && p.id !== myId && tierOf(p.role) <= tierOf(viewerRole) && p.full_name !== 'Raderad person' && (
                  <button className="btn btn-sm btn-danger" onClick={() => erasePerson(p)}>Radera</button>
                )}
              </div>

              {open && canEdit && (
                <div className="inline-form cols" style={{ marginTop: 12, marginBottom: 0 }}>
                  <div>
                    <label className="label">{tr('wholeArea')} / {tr('singlePlace')}</label>
                    <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
                      <option value="">—</option>
                      <optgroup label={tenant.labels.areas}>
                        {areas.map((a) => <option key={a.id} value={`area:${a.id}`}>{a.name}</option>)}
                      </optgroup>
                      <optgroup label={tenant.labels.schools}>
                        {schools.map((s) => <option key={s.id} value={`school:${s.id}`}>{s.name}</option>)}
                      </optgroup>
                      <optgroup label={tenant.labels.playingAreas}>
                        {arenas.map((a) => <option key={a.id} value={`arena:${a.id}`}>{a.name}</option>)}
                      </optgroup>
                    </select>
                  </div>
                  <button className="btn btn-primary" disabled={!pick} onClick={() => addScope(p.id)}>{tr('assign')}</button>
                </div>
              )}
            </div>
          );
        })}
        {visible.length === 0 && <div className="page-sub">{tr('nothingHere')}</div>}
      </div>
      {invOpen && (
        <div className="modal-overlay" onClick={() => setInvOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{tr('invite')}</h3>
            <div className="page-sub">Personen får ett mejl, sätter lösenord och landar med rätt roll + behörighet.</div>
            <label className="label">{tr('email')}</label>
            <input className="input" type="email" value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="namn@gothiacup.se" />
            <label className="label">{tr('roleLbl')}</label>
            <select className="select" value={invRole} onChange={(e) => setInvRole(e.target.value as Role)}>
              <RoleOptions max={tierOf(viewerRole)} />
            </select>
            <label className="label">{tr('scope')}</label>
            <select className="select" value={invPick} onChange={(e) => setInvPick(e.target.value)}>
              <option value="">{tr('none')}</option>
              <optgroup label={tr('wholeArea')}>
                {areas.map((a) => <option key={a.id} value={`area:${a.id}`}>{a.name}</option>)}
              </optgroup>
              <optgroup label={tenant.labels.schools}>
                {schools.map((sc) => <option key={sc.id} value={`school:${sc.id}`}>{sc.name}</option>)}
              </optgroup>
              <optgroup label={tenant.labels.playingAreas}>
                {arenas.map((a) => <option key={a.id} value={`arena:${a.id}`}>{a.name}</option>)}
              </optgroup>
            </select>
            {invErr && <div className="form-error">{invErr}</div>}
            {invMsg && <div className="ok-msg">{invMsg}</div>}
            <div className="modal-actions">
              <button className="btn" onClick={() => setInvOpen(false)}>{tr('cancel')}</button>
              <button className="btn btn-primary" onClick={sendInvite} disabled={invBusy || !invEmail}>
                {invBusy ? '…' : tr('sendInvite')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
