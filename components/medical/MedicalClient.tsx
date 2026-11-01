'use client';
// Sjukvård: larma, se närmaste hjälp, och (för sjukvården) ta hand om
// ärendena. Begäran syns bara för den som larmade, sjukvården,
// säkerhetsansvariga och ledningen.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Siren, Phone, MapPin, Navigation, HeartPulse, Plus, Trash2, LocateFixed } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { directionsHref, distanceM, isIOS } from '@/lib/map';
import { isOfflineError } from '@/lib/offline/outbox';
import { readSnapshot } from '@/lib/offline/snapshot';
import { netState } from '@/lib/offline/status';
import { flushPush } from '@/lib/pushClient';

type Urgency = 'akut' | 'snart' | 'ej_bradskande';
type Status = 'ny' | 'pa_vag' | 'klar' | 'avbruten';
type Req = {
  id: string; urgency: Urgency; location_type: 'school' | 'arena' | null; location_id: string | null;
  place_text: string; lat: number | null; lng: number | null; what: string; status: Status;
  requested_by: string | null; handled_by: string | null; created_at: string;
};
type Point = { id: string; kind: 'station' | 'forsta_hjalpen' | 'hjartstartare'; name: string; address: string; lat: number | null; lng: number | null; phone: string; hours: string; note: string };
type Place = { key: string; type: 'school' | 'arena'; id: string; name: string; lat: number | null; lng: number | null };

const URGENCY: Record<Urgency, string> = { akut: 'Akut', snart: 'Snart', ej_bradskande: 'Inte bråttom' };
const STATUS: Record<Status, string> = { ny: 'Ny', pa_vag: 'På väg', klar: 'Klar', avbruten: 'Avbruten' };
const KIND: Record<Point['kind'], string> = { station: 'Sjukvårdsstation', forsta_hjalpen: 'Första hjälpen', hjartstartare: 'Hjärtstartare' };
const tel = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'nyss' : m < 60 ? `${m} min sedan` : `${Math.round(m / 60)} tim sedan`;
};

export default function MedicalClient({ userId, canHandle, canManage }: { userId: string; canHandle: boolean; canManage: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [points, setPoints] = useState<Point[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [jour, setJour] = useState<{ contact_name: string | null; phone: string | null } | null>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [missing, setMissing] = useState(false);
  // Ärendena sparas aldrig i telefonen, så utan täckning syns de inte
  const [reqsOffline, setReqsOffline] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [ios, setIos] = useState(false);

  // Larmformuläret
  const [open, setOpen] = useState(false);
  const [urgency, setUrgency] = useState<Urgency>('akut');
  const [place, setPlace] = useState('');
  const [placeText, setPlaceText] = useState('');
  const [what, setWhat] = useState('');
  const [usePos, setUsePos] = useState(false);

  // Ny sjukvårdsplats
  const [pOpen, setPOpen] = useState(false);
  const [pKind, setPKind] = useState<Point['kind']>('hjartstartare');
  const [pName, setPName] = useState('');
  const [pAddr, setPAddr] = useState('');
  const [pPhone, setPPhone] = useState('');
  const [pHours, setPHours] = useState('');
  const [pPos, setPPos] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => { setIos(isIOS()); }, []);

  const load = useCallback(async () => {
    const [r, p, s, a, j] = await Promise.all([
      supabase.from('medical_requests').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('medical_points').select('*').order('name'),
      supabase.from('schools').select('id,name,lat,lng').order('name'),
      supabase.from('arenas').select('id,name,lat,lng').order('name'),
      supabase.from('on_call_now').select('contact_name,phone,function').eq('function', 'sjukvard').maybeSingle()
    ]);
    if (r.error && /does not exist|schema cache|Could not find/i.test(r.error.message)) { setMissing(true); return; }
    const offline = isOfflineError(r.error);
    setReqsOffline(offline);
    const list = (r.data ?? []) as Req[];
    if (!offline) setReqs(list);
    setPoints((p.data ?? []) as Point[]);
    setPlaces([
      ...((s.data ?? []) as Place[]).map((x) => ({ ...x, type: 'school' as const, key: `school:${x.id}` })),
      ...((a.data ?? []) as Place[]).map((x) => ({ ...x, type: 'arena' as const, key: `arena:${x.id}` }))
    ]);
    // Utan täckning: jouren ur offlinepaketet, som har passens tider
    const snap = readSnapshot();
    if (snap && (netState().offline || j.error)) {
      const now = Date.now();
      const cur = snap.onCall
        .filter((x) => x.fn === 'sjukvard' && Date.parse(x.from) <= now && now < Date.parse(x.to))
        .sort((a, b) => Date.parse(b.from) - Date.parse(a.from))[0];
      setJour(cur ? { contact_name: cur.name, phone: cur.phone } : null);
    } else {
      setJour((j.data as { contact_name: string | null; phone: string | null } | null) ?? null);
    }
    const ids = [...new Set(list.flatMap((x) => [x.requested_by, x.handled_by]).filter(Boolean))] as string[];
    if (ids.length) {
      const { data } = await supabase.from('profiles').select('id,full_name').in('id', ids);
      setNames(Object.fromEntries(((data ?? []) as { id: string; full_name: string }[]).map((x) => [x.id, x.full_name])));
    }
  }, [supabase]);

  // Realtid när det finns, annars en koll var 15:e sekund
  useEffect(() => {
    load();
    const ch = supabase.channel('medical').on('postgres_changes', { event: '*', schema: 'public', table: 'medical_requests' }, () => load()).subscribe();
    const t = setInterval(load, 15000);
    return () => { clearInterval(t); supabase.removeChannel(ch); };
  }, [supabase, load]);

  const locate = (then?: (p: { lat: number; lng: number }) => void) => {
    if (!navigator.geolocation) { setErr('Telefonen kan inte ge någon position.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }; setMe(p); then?.(p); },
      () => setErr('Kunde inte hämta din position. Skriv var du är i stället.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  };

  const send = async () => {
    setErr(''); setMsg('');
    if (!place && !placeText.trim() && !usePos) { setErr('Ange var hjälpen behövs.'); return; }
    setBusy(true);
    const [lt, lid] = place ? place.split(':') : [null, null];
    const { error } = await supabase.from('medical_requests').insert({
      urgency, location_type: lt, location_id: lid, place_text: placeText.trim(),
      lat: usePos && me ? me.lat : null, lng: usePos && me ? me.lng : null,
      what: what.trim().slice(0, 300), requested_by: userId
    });
    setBusy(false);
    if (error) {
      // Utan täckning går det inte att larma via appen – och det får inte
      // ligga och vänta i telefonen. Ring i stället.
      setErr(isOfflineError(error)
        ? 'Ingen täckning – begäran kunde inte skickas. Ring sjukvårdsjouren eller 112 med knapparna ovan.'
        : error.message);
      return;
    }
    flushPush();
    setMsg('Skickat. Sjukvården ser din begäran nu. Ring 112 om det är livshotande.');
    setOpen(false); setWhat(''); setPlaceText(''); setPlace(''); setUsePos(false); setUrgency('akut');
    load();
  };

  const setStatus = async (r: Req, status: Status) => {
    setErr('');
    const { error } = await supabase.from('medical_requests').update({ status }).eq('id', r.id);
    if (error) setErr(error.message);
    load();
  };

  const addPoint = async () => {
    setErr('');
    if (!pName.trim()) { setErr('Ange ett namn.'); return; }
    let pos = pPos;
    if (!pos && pAddr.trim()) {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(pAddr.trim())}`);
      const d = await res.json().catch(() => ({}));
      if (d.hit) pos = { lat: d.hit.lat, lng: d.hit.lng };
    }
    const { error } = await supabase.from('medical_points').insert({
      kind: pKind, name: pName.trim(), address: pAddr.trim(), phone: pPhone.trim(), hours: pHours.trim(),
      lat: pos?.lat ?? null, lng: pos?.lng ?? null
    });
    if (error) { setErr(error.message); return; }
    setPOpen(false); setPName(''); setPAddr(''); setPPhone(''); setPHours(''); setPPos(null);
    load();
  };

  const removePoint = async (p: Point) => {
    if (!window.confirm(`Ta bort ${p.name}?`)) return;
    const { error } = await supabase.from('medical_points').delete().eq('id', p.id);
    if (error) setErr(error.message);
    load();
  };

  if (missing) return (<><h1 className="page-title">Sjukvård</h1><div className="page-sub">Kör del 26 i Supabase för att slå på sjukvården.</div></>);

  const placeName = (r: Req) => {
    const p = places.find((x) => x.type === r.location_type && x.id === r.location_id);
    return [p?.name, r.place_text].filter(Boolean).join(' · ') || (r.lat ? 'Position från telefonen' : 'Plats saknas');
  };
  const reqPos = (r: Req) => {
    if (r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng };
    const p = places.find((x) => x.type === r.location_type && x.id === r.location_id);
    return p && p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
  };
  const mine = reqs.filter((r) => r.requested_by === userId && (r.status === 'ny' || r.status === 'pa_vag'));
  const active = reqs.filter((r) => r.status === 'ny' || r.status === 'pa_vag');
  const sortedPoints = me
    ? [...points].sort((a, b) => (a.lat == null ? 1e12 : distanceM([me.lat, me.lng], [a.lat, a.lng as number])) - (b.lat == null ? 1e12 : distanceM([me.lat, me.lng], [b.lat, b.lng as number])))
    : points;
  const dist = (p: Point) => {
    if (!me || p.lat == null || p.lng == null) return '';
    const m = distanceM([me.lat, me.lng], [p.lat, p.lng]);
    return m < 1000 ? ` · ${Math.round(m / 10) * 10} m` : ` · ${(m / 1000).toFixed(1)} km`;
  };

  return (
    <>
      <h1 className="page-title">Sjukvård</h1>
      <div className="page-sub">Livshotande: ring 112 först.</div>

      <div className="med-top">
        <a className="btn btn-alarm med-112" href="tel:112"><Phone size={16} /> 112</a>
        {jour?.phone && (
          <a className="btn med-jour" href={tel(jour.phone)}><HeartPulse size={16} /> Sjukvårdsjour{jour.contact_name ? `: ${jour.contact_name}` : ''}</a>
        )}
      </div>

      {!open && <button className="btn btn-alarm med-alarm" onClick={() => setOpen(true)}><Siren size={18} /> Begär sjukvård</button>}
      {open && (
        <div className="card med-form">
          <div className="li-title"><Siren size={15} /> Begär sjukvård</div>
          <label className="label">Hur bråttom?</label>
          <div className="chips">
            {(Object.keys(URGENCY) as Urgency[]).map((u) => (
              <button key={u} className={`chip ${urgency === u ? 'active' : ''}`} onClick={() => setUrgency(u)}>{URGENCY[u]}</button>
            ))}
          </div>
          <label className="label">Var?</label>
          <select className="select" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">– välj plats –</option>
            {places.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
          <input className="input" style={{ marginTop: 8 }} value={placeText} onChange={(e) => setPlaceText(e.target.value)} placeholder="Var exakt? T.ex. läktaren vid bana 2" />
          <button className={`btn btn-sm ${usePos ? 'btn-primary' : ''}`} style={{ marginTop: 8 }}
            onClick={() => { if (usePos) setUsePos(false); else locate(() => setUsePos(true)); }}>
            <LocateFixed size={13} /> {usePos ? 'Min position skickas med' : 'Skicka med min position'}
          </button>
          <label className="label">Vad har hänt?</label>
          <input className="input" maxLength={300} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Kort, t.ex. fotled, kan inte gå" />
          <div className="li-meta" style={{ marginTop: 4 }}>Skriv inga personnummer eller journaluppgifter.</div>
          <div className="imp-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-alarm" onClick={send} disabled={busy}><Siren size={15} /> Skicka</button>
            <button className="btn" onClick={() => setOpen(false)}>Avbryt</button>
          </div>
        </div>
      )}
      {msg && <div className="ok-msg" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div className="form-error" style={{ marginBottom: 12 }}>{err}</div>}

      {mine.length > 0 && !canHandle && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="li-title">Din begäran</div>
          {mine.map((r) => (
            <div key={r.id} className="stat-row med-mine">
              <span>{URGENCY[r.urgency]} · {placeName(r)} · {ago(r.created_at)}</span>
              <b className={`badge ${r.status === 'pa_vag' ? 'b-resolved' : 'b-high'}`}>{STATUS[r.status]}{r.status === 'pa_vag' && r.handled_by && names[r.handled_by] ? `: ${names[r.handled_by]}` : ''}</b>
              <button className="btn btn-sm" onClick={() => setStatus(r, 'avbruten')}>Avbryt</button>
            </div>
          ))}
        </div>
      )}

      {canHandle && (
        <>
          <h2 className="med-h">Pågående{reqsOffline ? '' : ` (${active.length})`}</h2>
          <div className="list">
            {reqsOffline && (
              <div className="page-sub">
                {active.length
                  ? 'Ingen täckning. Listan är som när täckningen försvann och uppdateras när den är tillbaka.'
                  : 'Ingen täckning. Ärendena sparas inte i telefonen och visas när täckningen är tillbaka.'}
              </div>
            )}
            {!reqsOffline && active.length === 0 && <div className="page-sub">Inga öppna ärenden.</div>}
            {active.map((r) => {
              const pos = reqPos(r);
              return (
                <div key={r.id} className={`list-item med-req ${r.urgency}`}>
                  <div className="li-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="li-title">{placeName(r)}</div>
                      <div className="li-meta">{ago(r.created_at)}{r.requested_by && names[r.requested_by] ? ` · ${names[r.requested_by]}` : ''}{r.status === 'pa_vag' && r.handled_by && names[r.handled_by] ? ` · ${names[r.handled_by]} på väg` : ''}</div>
                      {r.what && <div className="med-what">{r.what}</div>}
                    </div>
                    <span className={`badge ${r.urgency === 'akut' ? 'b-critical' : r.urgency === 'snart' ? 'b-high' : 'b-medium'}`}>{URGENCY[r.urgency]}</span>
                  </div>
                  <div className="li-actions">
                    {r.status === 'ny' && <button className="btn btn-sm btn-primary" onClick={() => setStatus(r, 'pa_vag')}>Jag åker</button>}
                    <button className="btn btn-sm" onClick={() => setStatus(r, 'klar')}>Klar</button>
                    {pos && <a className="btn btn-sm" href={directionsHref(pos.lat, pos.lng, ios)} target="_blank" rel="noopener noreferrer"><Navigation size={13} /> Vägbeskrivning</a>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="row-between" style={{ marginTop: 18 }}>
        <h2 className="med-h" style={{ margin: 0 }}>Sjukvård och hjärtstartare</h2>
        <button className="btn btn-sm" onClick={() => locate()}><LocateFixed size={13} /> Närmast mig</button>
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {sortedPoints.length === 0 && <div className="page-sub">Inga sjukvårdsplatser inlagda än.</div>}
        {sortedPoints.map((p) => (
          <div key={p.id} className="list-item">
            <div className="li-head">
              <div style={{ minWidth: 0 }}>
                <div className="li-title">{p.name}</div>
                <div className="li-meta">{KIND[p.kind]}{dist(p)}{p.hours ? ` · ${p.hours}` : ''}</div>
                {p.address && <div className="li-meta"><MapPin size={11} /> {p.address}</div>}
              </div>
              <span className={`med-kind ${p.kind}`}>{p.kind === 'hjartstartare' ? '♥' : '+'}</span>
            </div>
            <div className="li-actions">
              {p.phone && <a className="btn btn-sm btn-primary" href={tel(p.phone)}><Phone size={13} /> {p.phone}</a>}
              {p.lat != null && p.lng != null && <a className="btn btn-sm" href={directionsHref(p.lat, p.lng, ios)} target="_blank" rel="noopener noreferrer"><Navigation size={13} /> Vägbeskrivning</a>}
              {canManage && <button className="btn btn-sm btn-danger" onClick={() => removePoint(p)} aria-label={`Ta bort ${p.name}`}><Trash2 size={13} /></button>}
            </div>
          </div>
        ))}
      </div>

      {canManage && !pOpen && <button className="btn" style={{ marginTop: 10 }} onClick={() => setPOpen(true)}><Plus size={15} /> Lägg till</button>}
      {canManage && pOpen && (
        <div className="card med-form" style={{ marginTop: 10 }}>
          <label className="label">Vad</label>
          <select className="select" value={pKind} onChange={(e) => setPKind(e.target.value as Point['kind'])}>
            {(Object.keys(KIND) as Point['kind'][]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
          </select>
          <label className="label">Namn</label>
          <input className="input" value={pName} onChange={(e) => setPName(e.target.value)} placeholder="T.ex. Hjärtstartare entré Lisebergshallen" />
          <label className="label">Adress</label>
          <input className="input" value={pAddr} onChange={(e) => setPAddr(e.target.value)} />
          <label className="label">Telefon</label>
          <input className="input" value={pPhone} onChange={(e) => setPPhone(e.target.value)} />
          <label className="label">Öppettider</label>
          <input className="input" value={pHours} onChange={(e) => setPHours(e.target.value)} placeholder="T.ex. 08–22" />
          <button className={`btn btn-sm ${pPos ? 'btn-primary' : ''}`} style={{ marginTop: 8 }} onClick={() => locate((p) => setPPos(p))}>
            <LocateFixed size={13} /> {pPos ? 'Min position används' : 'Använd min position'}
          </button>
          <div className="li-meta" style={{ marginTop: 4 }}>Utan position hämtas den från adressen.</div>
          <div className="imp-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={addPoint}>Spara</button>
            <button className="btn" onClick={() => setPOpen(false)}>Avbryt</button>
          </div>
        </div>
      )}
    </>
  );
}
