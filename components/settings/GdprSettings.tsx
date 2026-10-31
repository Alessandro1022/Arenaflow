'use client';
// Lagring och GDPR: turneringens sista dag, hur länge varje sorts uppgift
// sparas efter den, gallring och integritetstexten. Gallringen sker av sig
// själv varje morgon; knapparna här är för att se och göra det direkt.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Trash2, Eye } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useTenant } from '@/components/TenantProvider';
import { RETENTION, describeResult, type RetentionKey } from '@/lib/gdpr';

type Run = { ran_at: string; result: Record<string, unknown>; ran_by: string | null };

export default function GdprSettings() {
  const supabase = useMemo(() => createClient(), []);
  const tn = useTenant();
  const [endsOn, setEndsOn] = useState('');
  const [days, setDays] = useState<Record<string, string>>(() => Object.fromEntries(RETENTION.map((r) => [r.key, String(r.days)])));
  const [privacy, setPrivacy] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const id = tn.active?.id;
    if (!id) return;
    const { data, error } = await supabase.from('tenants').select('ends_on,retention,privacy_text').eq('id', id).maybeSingle();
    if (error) { setMissing(true); return; }
    const row = data as { ends_on: string | null; retention: Record<string, number> | null; privacy_text: string } | null;
    setEndsOn(row?.ends_on ?? '');
    setDays(Object.fromEntries(RETENTION.map((r) => [r.key, String(row?.retention?.[r.key] ?? r.days)])));
    setPrivacy(row?.privacy_text ?? '');
    const { data: rr } = await supabase.from('retention_runs').select('ran_at,result,ran_by').order('ran_at', { ascending: false }).limit(5);
    setRuns((rr ?? []) as Run[]);
  }, [supabase, tn.active?.id]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setErr(''); setMsg(''); setPreview('');
    const retention: Record<string, number> = {};
    for (const r of RETENTION) {
      const n = Number(days[r.key]);
      if (!Number.isInteger(n) || n < 1 || n > 3650) { setErr(`${r.label}: ange ett heltal mellan 1 och 3650 dagar.`); return; }
      if (n !== r.days) retention[r.key] = n;
    }
    setBusy('save');
    const { error } = await supabase.rpc('set_gdpr_settings', { p_ends_on: endsOn || null, p_retention: retention, p_privacy: privacy });
    setBusy('');
    if (error) { setErr(error.message); return; }
    setMsg('Sparat.');
    load();
  };

  const callPurge = async (dry: boolean) => {
    setErr(''); setMsg(''); setPreview('');
    if (!dry && !window.confirm('Gallra nu? Det som har passerat sin lagringstid raderas för gott.')) return;
    setBusy(dry ? 'dry' : 'purge');
    const res = await fetch('/api/gdpr/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry }) });
    const data = await res.json().catch(() => ({}));
    setBusy('');
    if (!res.ok) { setErr(data.error ?? 'Fel'); return; }
    if (dry) setPreview(describeResult(data.result));
    else { setMsg(`Gallrat: ${describeResult(data.result)}.`); load(); }
  };

  if (missing) {
    return (
      <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
        <div className="li-title"><ShieldCheck size={15} /> Lagring och GDPR</div>
        <div className="page-sub">Kör del 25 i Supabase för att slå på lagringstider och gallring.</div>
      </div>
    );
  }

  const dueText = (key: RetentionKey) => {
    if (!endsOn) return '';
    const d = new Date(`${endsOn}T12:00:00`);
    d.setDate(d.getDate() + (Number(days[key]) || 0));
    return d.toLocaleDateString('sv-SE');
  };

  return (
    <div className="card gdpr-card" style={{ maxWidth: 560, marginTop: 16 }}>
      <div className="li-title"><ShieldCheck size={15} /> Lagring och GDPR</div>
      <div className="page-sub" style={{ marginTop: 4 }}>
        Personuppgifter raderas automatiskt när lagringstiden efter turneringens sista dag har gått ut. Tiderna bestäms av arrangören.
      </div>

      <label className="label">Turneringens sista dag</label>
      <input className="input" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
      {!endsOn && <div className="li-meta" style={{ marginTop: 4 }}>Utan sista dag gallras ingenting.</div>}

      <div className="gdpr-list">
        {RETENTION.map((r) => (
          <div key={r.key} className="gdpr-row">
            <div style={{ minWidth: 0 }}>
              <div className="imp-field">{r.label}</div>
              <div className="li-meta">{r.what}{endsOn ? ` · raderas ${dueText(r.key)}` : ''}</div>
            </div>
            <div className="gdpr-days">
              <input className="input" inputMode="numeric" aria-label={`${r.label}, dagar`} value={days[r.key] ?? ''}
                onChange={(e) => setDays({ ...days, [r.key]: e.target.value.replace(/\D/g, '') })} />
              <span>dagar</span>
            </div>
          </div>
        ))}
      </div>

      <label className="label">Integritetsinformation</label>
      <textarea className="textarea" rows={5} value={privacy} onChange={(e) => setPrivacy(e.target.value)}
        placeholder="Tom = standardtexten, med lagringstiderna ovan. Skriv här om arrangören vill ha en egen text." />
      <div className="li-meta" style={{ marginTop: 4 }}>
        Visas för alla på <a href="/integritet" target="_blank" rel="noopener noreferrer">/integritet</a>, även utan inloggning.
        Standardtexten är en mall: låt arrangörens dataskyddsansvarige granska den före turneringen.
      </div>

      <div className="imp-actions" style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={save} disabled={!!busy}>Spara</button>
        <button className="btn" onClick={() => callPurge(true)} disabled={!!busy}><Eye size={15} /> Vad gallras idag?</button>
        <button className="btn" onClick={() => callPurge(false)} disabled={!!busy}><Trash2 size={15} /> Gallra nu</button>
      </div>
      {busy && <div className="page-sub">Arbetar…</div>}
      {preview && <div className="ok-msg gdpr-preview">Idag skulle detta gallras: {preview}.</div>}
      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="form-error">{err}</div>}

      {runs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="label" style={{ marginTop: 0 }}>Senaste gallringar</div>
          {runs.map((r, i) => (
            <div key={i} className="stat-row gdpr-run">
              <span>{new Date(r.ran_at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}{r.ran_by ? '' : ' · automatiskt'}</span>
              <b>{describeResult(r.result)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
