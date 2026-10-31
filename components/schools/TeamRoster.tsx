'use client';
// Deltagarlista för ett lag: spelare och ledare, incheckning per person,
// åldersklasskontroll och deltagarkort.
//
// Om personuppgifter: deltagarna är till stor del minderåriga. Här lagras
// bara det driften behöver — namn, roll, födelseår för åldersklassen och
// tröjnummer. Ingen hälsodata och inga anhöriguppgifter.
import { useCallback, useEffect, useState } from 'react';
import { QrCode, UserPlus, Trash2, Check, Undo2, AlertTriangle, FileDown } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { downloadJson, fileSafe } from '@/lib/download';

export type Participant = {
  id: string;
  full_name: string;
  role: 'spelare' | 'ledare';
  birth_year: number | null;
  jersey_number: number | null;
  card_code: string;
  checked_in_at: string | null;
};

type Props = {
  teamId: string;
  teamName: string;
  ageClass: string;
  groupSize: number;
  seasonYear: number | null;
  onClose: () => void;
};

// Samma regel som i databasen: talet i klassen är högsta ålder, och en
// ledare räknas aldrig mot den.
function tooOld(ageClass: string, birthYear: number | null, season: number) {
  if (!birthYear) return false;
  const max = parseInt((ageClass || '').replace(/\D/g, ''), 10);
  if (!Number.isFinite(max)) return false;
  return birthYear < season - max;
}

export default function TeamRoster({
  teamId, teamName, ageClass, groupSize, seasonYear, onClose
}: Props) {
  const supabase = createClient();
  const [rows, setRows] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [card, setCard] = useState<Participant | null>(null);

  const [name, setName] = useState('');
  const [role, setRole] = useState<'spelare' | 'ledare'>('spelare');
  const [year, setYear] = useState('');
  const [jersey, setJersey] = useState('');

  const season = seasonYear ?? new Date().getFullYear();

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('participants')
      .select('id,full_name,role,birth_year,jersey_number,card_code,checked_in_at')
      .eq('team_assignment_id', teamId)
      .order('role')
      .order('jersey_number', { nullsFirst: false })
      .order('full_name');
    if (error) setErr(error.message);
    setRows((data ?? []) as Participant[]);
    setLoading(false);
  }, [supabase, teamId]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setErr('');
    const { error } = await supabase.from('participants').insert({
      team_assignment_id: teamId,
      full_name: n,
      role,
      birth_year: year.trim() === '' ? null : Number(year),
      jersey_number: jersey.trim() === '' ? null : Number(jersey)
    });
    if (error) { setErr(error.message); return; }
    setName(''); setYear(''); setJersey('');
    load();
  };

  const toggleCheckIn = async (p: Participant) => {
    await supabase.from('participants')
      .update({ checked_in_at: p.checked_in_at ? null : new Date().toISOString() })
      .eq('id', p.id);
    load();
  };

  // Registerutdrag åt en förälder eller deltagare (admin)
  const exportOne = async (p: Participant) => {
    setErr('');
    const { data, error } = await supabase.rpc('participant_export', { p: p.id });
    if (error) {
      setErr(/behörighet/i.test(error.message) ? 'Endast admin kan ta ut registerutdrag.' : /function|schema cache/i.test(error.message) ? 'Kör del 25 i Supabase först.' : error.message);
      return;
    }
    downloadJson(`registerutdrag-${fileSafe(p.full_name)}-${new Date().toISOString().slice(0, 10)}.json`, data);
  };

  // Att ta bort deltagaren raderar också hens måltidsregistreringar
  const remove = async (p: Participant) => {
    if (!confirm(`Ta bort ${p.full_name}? Uppgifterna raderas för gott.`)) return;
    await supabase.from('participants').delete().eq('id', p.id);
    load();
  };

  const players = rows.filter((r) => r.role === 'spelare').length;
  const leaders = rows.filter((r) => r.role === 'ledare').length;
  const checkedIn = rows.filter((r) => r.checked_in_at).length;
  const flagged = rows.filter((r) => r.role === 'spelare' && tooOld(ageClass, r.birth_year, season)).length;
  const diff = rows.length - groupSize;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <h3>{teamName}</h3>
        <div className="page-sub" style={{ marginBottom: 12 }}>
          {rows.length} registrerade av {groupSize} anmälda · {players} spelare · {leaders} ledare · {checkedIn} incheckade
          {ageClass ? ` · ${ageClass}` : ''}
        </div>

        {/* Skillnad mot anmält antal är det vanligaste felet vid ankomst */}
        {diff !== 0 && !loading && (
          <div className={diff > 0 ? 'form-error' : 'page-sub'} style={{ marginBottom: 10 }}>
            {diff > 0
              ? `${diff} fler registrerade än anmälda. Kontrollera gruppstorleken.`
              : `${-diff} kvar att registrera.`}
          </div>
        )}

        {flagged > 0 && (
          <div className="form-error" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
            <AlertTriangle size={15} />
            {flagged} spelare är för gamla för {ageClass} säsongen {season}.
          </div>
        )}

        <div className="inline-form cols">
          <div style={{ flex: 2 }}>
            <label className="label">Namn</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          </div>
          <div>
            <label className="label">Roll</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as 'spelare' | 'ledare')}>
              <option value="spelare">Spelare</option>
              <option value="ledare">Ledare</option>
            </select>
          </div>
          <div>
            <label className="label">Födelseår</label>
            <input className="input" inputMode="numeric" value={year} maxLength={4}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} placeholder="2011" />
          </div>
          <div>
            <label className="label">Nr</label>
            <input className="input" inputMode="numeric" value={jersey} maxLength={3}
              onChange={(e) => setJersey(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button className="btn btn-primary" onClick={add} disabled={!name.trim()}>
            <UserPlus size={15} /> Lägg till
          </button>
        </div>

        {err && <div className="form-error">{err}</div>}
        {loading && <div className="page-sub">Laddar…</div>}

        <div className="list" style={{ maxHeight: 340, overflowY: 'auto' }}>
          {rows.map((p) => {
            const old = p.role === 'spelare' && tooOld(ageClass, p.birth_year, season);
            return (
              <div key={p.id} className="list-item">
                <div className="li-head">
                  <div>
                    <div className="li-title">
                      {p.jersey_number !== null ? `${p.jersey_number}. ` : ''}{p.full_name}
                    </div>
                    <div className="li-meta">
                      {p.role === 'ledare' ? 'Ledare' : 'Spelare'}
                      {p.birth_year ? ` · ${p.birth_year}` : ''}
                      {p.checked_in_at ? ' · incheckad' : ''}
                    </div>
                  </div>
                  {old && <span className="badge b-critical">för gammal</span>}
                </div>
                <div className="li-actions">
                  <button className="btn btn-sm" onClick={() => toggleCheckIn(p)}>
                    {p.checked_in_at ? <><Undo2 size={13} /> Ångra</> : <><Check size={13} /> Checka in</>}
                  </button>
                  <button className="btn btn-sm" onClick={() => setCard(p)}>
                    <QrCode size={13} /> Kort
                  </button>
                  <button className="btn btn-sm" onClick={() => exportOne(p)} aria-label={`Registerutdrag för ${p.full_name}`}>
                    <FileDown size={13} /> Utdrag
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(p)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
          {!loading && rows.length === 0 && (
            <div className="page-sub">Inga deltagare registrerade än.</div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Stäng</button>
        </div>

        {card && (
          <div className="modal-overlay" onClick={() => setCard(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
              <h3>{card.full_name}</h3>
              <div className="page-sub">{teamName}{ageClass ? ` · ${ageClass}` : ''}</div>
              <div style={{
                background: 'var(--bg)', borderRadius: 12, padding: 18,
                textAlign: 'center', margin: '12px 0'
              }}>
                <div className="li-meta" style={{ marginBottom: 6 }}>Kortkod</div>
                <div className="mono" style={{ fontSize: 20, letterSpacing: 2, fontWeight: 700 }}>
                  {card.card_code}
                </div>
              </div>
              <div className="page-sub" style={{ fontSize: 12.5 }}>
                Koden slås upp av personal på <span className="mono">/kort/{card.card_code}</span>.
                Den kräver inloggning.
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setCard(null)}>Stäng</button>
                <a className="btn btn-primary" href={`/kort/${card.card_code}`} target="_blank" rel="noreferrer">
                  Öppna kortet
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
