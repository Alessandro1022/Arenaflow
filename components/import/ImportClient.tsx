'use client';
// Import från Excel eller CSV: boenden, spelplatser, lag, deltagare,
// matcher och personal. Fyra steg på samma sida: välj vad, välj fil,
// koppla kolumnerna, granska. Inget sparas förrän man trycker Importera.
import { useMemo, useState } from 'react';
import { Upload, FileDown, ClipboardPaste, Check, AlertTriangle, RotateCcw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useTenant } from '@/components/TenantProvider';
import { KINDS, kindOf, guessMapping, cellText, type KindKey } from '@/lib/import/kinds';
import { openXlsx, type Cell, type Workbook } from '@/lib/import/xlsx';
import { decodeText, parseDelimited, toCsv } from '@/lib/import/csv';
import { planImport, runImport, type Plan, type RowStatus, type RunResult } from '@/lib/import/plan';

const STATUS_LABEL: Record<RowStatus, string> = { ny: 'Ny', ändras: 'Ändras', samma: 'Oförändrad', fel: 'Fel' };
const STATUS_BADGE: Record<RowStatus, string> = { ny: 'b-resolved', ändras: 'b-medium', samma: 'b-low', fel: 'b-high' };
const MAX_ROWS = 20000;

export default function ImportClient({ tier }: { tier: number }) {
  const supabase = useMemo(() => createClient(), []);
  const tn = useTenant();
  const [kindKey, setKindKey] = useState<KindKey | null>(null);
  const [fileName, setFileName] = useState('');
  const [wb, setWb] = useState<Workbook | null>(null);
  const [sheet, setSheet] = useState(0);
  const [raw, setRaw] = useState<Cell[][] | null>(null);
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [filter, setFilter] = useState<RowStatus | 'alla'>('alla');
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [err, setErr] = useState('');

  const kind = kindKey ? kindOf(kindKey) : null;

  // Turneringens egna ord räknas också som rubriker, t.ex. "Plan" för spelplats
  const extraSynonyms = useMemo<Record<string, string[]>>(() => ({
    name: kindKey === 'arenas' ? [tn.labels.playingArea, tn.labels.playingAreas]
      : kindKey === 'schools' ? [tn.labels.school, tn.labels.schools] : [],
    arena: [tn.labels.playingArea, tn.labels.playingAreas],
    school: [tn.labels.school],
    area: [tn.labels.area]
  }), [kindKey, tn.labels]);

  // Rubrikraden: första raden med minst två ifyllda celler
  const headerIdx = useMemo(() => {
    if (!raw) return -1;
    const i = raw.slice(0, 15).findIndex((r) => r.filter((c) => cellText(c)).length >= 2);
    return i < 0 ? 0 : i;
  }, [raw]);
  const headers = useMemo(() => (raw && headerIdx >= 0 ? (raw[headerIdx] ?? []).map((c) => cellText(c)) : []), [raw, headerIdx]);
  const dataRows = useMemo(() => (raw ? raw.slice(headerIdx + 1) : []), [raw, headerIdx]);
  const filled = useMemo(() => dataRows.filter((r) => r.some((c) => cellText(c))).length, [dataRows]);
  const sample = (idx: number) => {
    for (const r of dataRows) { const t = cellText(r[idx] ?? null); if (t) return t; }
    return '';
  };

  const resetAfterKind = () => {
    setFileName(''); setWb(null); setRaw(null); setPaste(''); setShowPaste(false);
    setMapping({}); setPlan(null); setResult(null); setProgress(null); setErr(''); setFilter('alla'); setLimit(100);
  };

  const takeRows = (rows: Cell[][], name: string) => {
    if (rows.length > MAX_ROWS) { setErr(`Filen har ${rows.length} rader. Dela upp den i delar om högst ${MAX_ROWS}.`); return; }
    setRaw(rows); setFileName(name); setPlan(null); setResult(null);
    const hIdx = Math.max(0, rows.slice(0, 15).findIndex((r) => r.filter((c) => cellText(c)).length >= 2));
    if (kind) setMapping(guessMapping(kind, (rows[hIdx] ?? []).map((c) => cellText(c)), extraSynonyms));
  };

  const onFile = async (f: File | null) => {
    if (!f || !kind) return;
    setErr(''); setBusy('Läser filen…');
    try {
      const buf = await f.arrayBuffer();
      if (/\.xlsx$/i.test(f.name) || f.type.includes('spreadsheetml')) {
        const book = await openXlsx(buf);
        setWb(book); setSheet(0);
        takeRows(await book.read(0), f.name);
      } else if (/\.xls$/i.test(f.name)) {
        setErr('Gamla .xls-filer går inte att läsa. Spara om filen som .xlsx eller CSV i Excel.');
      } else {
        setWb(null);
        takeRows(parseDelimited(decodeText(buf)), f.name);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Filen gick inte att läsa.');
    }
    setBusy('');
  };

  const onSheet = async (i: number) => {
    if (!wb) return;
    setSheet(i); setBusy('Läser bladet…');
    try { takeRows(await wb.read(i), fileName); } catch (e) { setErr(e instanceof Error ? e.message : 'Bladet gick inte att läsa.'); }
    setBusy('');
  };

  const onPaste = () => {
    if (!paste.trim()) return;
    setWb(null);
    takeRows(parseDelimited(paste), 'Inklistrat');
    setShowPaste(false);
  };

  const template = () => {
    if (!kind) return;
    const fields = kind.fields.filter((f) => !(kind.needOneOf && kind.needOneOf.slice(1).flat().includes(f.key)));
    const csv = toCsv([fields.map((f) => f.label), fields.map((f) => kind.example[f.key] ?? '')]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `mall-${kind.label.toLowerCase()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  // Det som måste vara kopplat innan granskningen kan göras
  const missing = useMemo(() => {
    if (!kind) return [];
    const out = kind.fields.filter((f) => f.required && mapping[f.key] === undefined).map((f) => f.label);
    if (kind.needOneOf && !kind.needOneOf.some((g) => g.every((k) => mapping[k] !== undefined))) {
      out.push(kind.needOneOf.map((g) => g.map((k) => kind.fields.find((f) => f.key === k)?.label).join(' + ')).join(' eller '));
    }
    return out;
  }, [kind, mapping]);

  const makePlan = async () => {
    if (!kindKey) return;
    setErr(''); setResult(null); setPlan(null); setBusy('Jämför med det som redan finns…');
    try {
      setPlan(await planImport(supabase, kindKey, dataRows, mapping, { tier, firstLine: headerIdx + 2 }));
      setFilter('alla'); setLimit(100);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Granskningen misslyckades.');
    }
    setBusy('');
  };

  const run = async () => {
    if (!plan) return;
    const n = plan.counts.ny + plan.counts.ändras;
    if (plan.kind === 'staff' && !window.confirm(`Skicka ${n} inbjudningar? Var och en får ett mejl.`)) return;
    setErr(''); setBusy('Sparar…');
    try {
      setResult(await runImport(supabase, plan, (d, t) => setProgress([d, t])));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Importen avbröts.');
    }
    setBusy(''); setProgress(null);
  };

  const shown = plan ? plan.rows.filter((r) => filter === 'alla' || r.status === filter) : [];
  const todo = plan ? plan.counts.ny + plan.counts.ändras : 0;

  return (
    <>
      <h1 className="page-title">Import</h1>
      <div className="page-sub">Från Excel (.xlsx) eller CSV. Inget sparas förrän du har granskat och tryckt Importera.</div>

      {/* 1. Vad */}
      <div className="card imp-step">
        <div className="imp-h"><span className="imp-n">1</span> Vad ska importeras?</div>
        <div className="chips">
          {KINDS.map((k) => (
            <button key={k.key} className={`chip ${kindKey === k.key ? 'active' : ''}`}
              onClick={() => { setKindKey(k.key); resetAfterKind(); }}>{k.label}</button>
          ))}
        </div>
        {kind && <div className="page-sub" style={{ margin: '10px 0 0' }}>{kind.desc}</div>}
        {!kind && <div className="page-sub" style={{ margin: '10px 0 0' }}>Ordning första gången: boenden, spelplatser, lag, deltagare, matcher, personal.</div>}
      </div>

      {/* 2. Fil */}
      {kind && (
        <div className="card imp-step">
          <div className="imp-h"><span className="imp-n">2</span> Fil</div>
          <div className="imp-actions">
            <label className="btn btn-primary imp-file">
              <Upload size={15} /> Välj fil
              <input type="file" accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} hidden />
            </label>
            <button className="btn" onClick={() => setShowPaste(!showPaste)}><ClipboardPaste size={15} /> Klistra in</button>
            <button className="btn" onClick={template}><FileDown size={15} /> Mall</button>
          </div>
          {showPaste && (
            <div style={{ marginTop: 10 }}>
              <textarea className="textarea" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)}
                placeholder="Markera cellerna i Excel, kopiera och klistra in här – med rubrikraden överst." />
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={onPaste} disabled={!paste.trim()}>Använd</button>
            </div>
          )}
          {fileName && raw && (
            <div className="page-sub" style={{ margin: '10px 0 0' }}>
              <b>{fileName}</b> · {filled} rader · rubriker på rad {headerIdx + 1}
            </div>
          )}
          {wb && wb.sheets.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <label className="label">Blad</label>
              <select className="select" value={sheet} onChange={(e) => onSheet(Number(e.target.value))}>
                {wb.sheets.map((s, i) => <option key={i} value={i}>{s}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {/* 3. Kolumner */}
      {kind && raw && (
        <div className="card imp-step">
          <div className="imp-h"><span className="imp-n">3</span> Koppla kolumnerna</div>
          <div className="page-sub" style={{ marginTop: 0 }}>Gissat från rubrikerna. Ändra där det blev fel. * måste finnas.</div>
          <div className="imp-map">
            {kind.fields.map((f) => {
              const idx = mapping[f.key];
              return (
                <div key={f.key} className="imp-map-row">
                  <div>
                    <div className="imp-field">{f.label}{f.required ? ' *' : ''}</div>
                    {idx !== undefined && sample(idx) && <div className="li-meta">t.ex. {sample(idx).slice(0, 40)}</div>}
                    {f.hint && idx === undefined && <div className="li-meta">{f.hint}</div>}
                  </div>
                  <select className="select" value={idx ?? ''} aria-label={f.label}
                    onChange={(e) => {
                      const m = { ...mapping };
                      if (e.target.value === '') delete m[f.key]; else m[f.key] = Number(e.target.value);
                      setMapping(m); setPlan(null); setResult(null);
                    }}>
                    <option value="">– inte med –</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Kolumn ${i + 1}`}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          {missing.length > 0 && <div className="form-error" style={{ marginTop: 10 }}>Koppla: {missing.join(', ')}</div>}
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={missing.length > 0 || !!busy} onClick={makePlan}>
            Granska
          </button>
        </div>
      )}

      {busy && <div className="page-sub">{busy}{progress ? ` ${progress[0]} av ${progress[1]}` : ''}</div>}
      {progress && progress[1] > 0 && (
        <div className="imp-bar"><div style={{ width: `${Math.round((progress[0] / progress[1]) * 100)}%` }} /></div>
      )}
      {err && <div className="form-error" style={{ marginBottom: 12 }}>{err}</div>}

      {/* 4. Granska */}
      {plan && kind && !result && (
        <div className="card imp-step">
          <div className="imp-h"><span className="imp-n">4</span> Granska</div>
          <div className="chips">
            {(['alla', 'ny', 'ändras', 'samma', 'fel'] as const).map((s) => (
              <button key={s} className={`chip ${filter === s ? 'active' : ''}`} onClick={() => { setFilter(s); setLimit(100); }}>
                {s === 'alla' ? `Alla ${plan.rows.length}` : `${STATUS_LABEL[s]} ${plan.counts[s]}`}
              </button>
            ))}
          </div>
          {plan.newAreas.length > 0 && <div className="page-sub" style={{ margin: '10px 0 0' }}>Nya områden skapas: {plan.newAreas.join(', ')}</div>}
          {plan.newRooms.length > 0 && (
            <div className="page-sub" style={{ margin: '10px 0 0' }}>
              Nya rum skapas: {plan.newRooms.slice(0, 12).map((r) => `${r.school} ${r.name}`).join(', ')}{plan.newRooms.length > 12 ? ` och ${plan.newRooms.length - 12} till` : ''}
            </div>
          )}
          <div className="list" style={{ marginTop: 10 }}>
            {shown.slice(0, limit).map((r) => (
              <div key={r.line} className="list-item imp-row">
                <div className="li-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="li-title">{r.label || '–'}</div>
                    <div className="li-meta">
                      Rad {r.line}
                      {r.note ? ` · ${r.note}` : ''}
                      {r.status === 'ändras' && r.changes.length ? ` · ${r.changes.join(', ')}` : ''}
                    </div>
                    {r.errors.map((e, i) => <div key={i} className="imp-err"><AlertTriangle size={12} /> {e}</div>)}
                  </div>
                  <span className={`badge ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                </div>
              </div>
            ))}
            {shown.length > limit && <button className="btn" onClick={() => setLimit(limit + 200)}>Visa fler ({shown.length - limit} kvar)</button>}
            {shown.length === 0 && <div className="page-sub">Inget här.</div>}
          </div>
          <div className="imp-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" disabled={todo === 0 || !!busy} onClick={run}>
              <Check size={15} /> {kindKey === 'staff' ? `Skicka ${todo} inbjudningar` : `Importera ${todo} rader`}
            </button>
            {plan.counts.fel > 0 && <span className="li-meta">Rader med fel hoppas över.</span>}
          </div>
        </div>
      )}

      {/* Resultat */}
      {result && (
        <div className="card imp-step">
          <div className="imp-h"><Check size={16} /> Klart</div>
          <div className="stat-row"><span>Sparade</span><b>{result.ok}</b></div>
          <div className="stat-row"><span>Hoppades över (oförändrade eller fel)</span><b>{result.skipped}</b></div>
          <div className="stat-row"><span>Gick inte att spara</span><b>{result.failed.length}</b></div>
          {result.stopped && <div className="form-error" style={{ marginTop: 10 }}>{result.stopped}</div>}
          {result.failed.length > 0 && (
            <div className="list" style={{ marginTop: 10 }}>
              {result.failed.slice(0, 200).map((f) => (
                <div key={f.line} className="list-item">
                  <div className="li-title">{f.label || '–'}</div>
                  <div className="li-meta">Rad {f.line} · {f.error}</div>
                </div>
              ))}
            </div>
          )}
          <div className="imp-actions" style={{ marginTop: 12 }}>
            <button className="btn" onClick={makePlan}><RotateCcw size={15} /> Granska igen</button>
            <button className="btn" onClick={() => { setKindKey(null); resetAfterKind(); }}>Ny import</button>
          </div>
        </div>
      )}
    </>
  );
}
