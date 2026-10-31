'use client';
// Säkerhetskopior: lista, ta en nu, ladda ner, och lägg tillbaka det som
// saknas. Återställningen skriver aldrig över något som finns.
import { useCallback, useEffect, useState } from 'react';
import { DatabaseBackup, Download, RotateCcw } from 'lucide-react';
import { describeRestore } from '@/lib/backupLabels';

type File = { name: string; size: number; created_at: string };

export default function BackupSettings() {
  const [files, setFiles] = useState<File[] | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<{ file: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/backup');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(data.error ?? 'Säkerhetskopiorna gick inte att läsa.'); setFiles([]); return; }
    setFiles(data.files ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Fel');
    return data;
  };

  const create = async () => {
    setErr(''); setMsg(''); setPending(null); setBusy('create');
    try { const d = await post({ action: 'create' }); setMsg(d.file?.name ? `Säkerhetskopia tagen (${d.file.rows} rader).` : 'Inget att kopiera än.'); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Fel'); }
    setBusy('');
  };

  const check = async (file: string) => {
    setErr(''); setMsg(''); setPending(null); setBusy(file);
    try {
      const d = await post({ action: 'restore', file, dry: true });
      const text = describeRestore(d.result ?? {});
      if (text === 'Inget saknas') setMsg(`Inget i kopian från ${label(file)} saknas idag.`);
      else setPending({ file, text });
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fel'); }
    setBusy('');
  };

  const restore = async () => {
    if (!pending) return;
    setErr(''); setMsg(''); setBusy('restore');
    try {
      const d = await post({ action: 'restore', file: pending.file, dry: false });
      const failed = Object.entries(d.failed ?? {}).map(([t, m]) => `${t}: ${m}`);
      setMsg(`Tillbakalagt: ${describeRestore(d.result ?? {})}.`);
      if (failed.length) setErr(`Gick inte: ${failed.join('; ')}`);
      setPending(null);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Fel'); }
    setBusy('');
  };

  const label = (name: string) => name.replace(/\.json\.gz$/, '');

  return (
    <div className="card backup-card" style={{ maxWidth: 560, marginTop: 16 }}>
      <div className="li-title"><DatabaseBackup size={15} /> Säkerhetskopior</div>
      <div className="page-sub" style={{ marginTop: 4 }}>
        En kopia tas automatiskt varje morgon och de 14 senaste sparas. Återställning lägger bara tillbaka sådant som saknas, till exempel ett boende som tagits bort av misstag. Inget som finns skrivs över. Bilder ingår inte.
      </div>
      <button className="btn btn-primary" onClick={create} disabled={!!busy}>Ta säkerhetskopia nu</button>

      {files === null && <div className="page-sub">Laddar…</div>}
      {files && files.length === 0 && !err && <div className="page-sub">Inga säkerhetskopior än.</div>}
      {files && files.length > 0 && (
        <div className="backup-list">
          {files.map((f) => (
            <div key={f.name} className="backup-row">
              <div>
                <div className="imp-field">{label(f.name)}</div>
                <div className="li-meta">{f.size ? `${Math.max(1, Math.round(f.size / 1024))} kB` : ''}</div>
              </div>
              <div className="imp-actions">
                <a className="btn btn-sm" href={`/api/backup?file=${encodeURIComponent(f.name)}`}><Download size={13} /> Ladda ner</a>
                <button className="btn btn-sm" onClick={() => check(f.name)} disabled={!!busy}><RotateCcw size={13} /> Återställ saknat</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {busy && <div className="page-sub">Arbetar…</div>}
      {pending && (
        <div className="backup-confirm">
          <div>I kopian från {label(pending.file)} finns detta som saknas idag: <b>{pending.text}</b>.</div>
          <div className="imp-actions" style={{ marginTop: 8 }}>
            <button className="btn btn-primary" onClick={restore} disabled={!!busy}>Lägg tillbaka</button>
            <button className="btn" onClick={() => setPending(null)}>Avbryt</button>
          </div>
        </div>
      )}
      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}
