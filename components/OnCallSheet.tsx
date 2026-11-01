'use client';
// Jour och nödnummer, nåbara från topbaren på varje sida.
//
// Ligger medvetet INTE under en meny: när man behöver den här panelen har
// man inte tid att leta. Numren är tel:-länkar så att ett tryck ringer.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Phone, Siren, X, ShieldAlert, CalendarClock } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { readSnapshot } from '@/lib/offline/snapshot';
import { netState } from '@/lib/offline/status';

type OnCall = {
  function: string; contact_name: string | null; phone: string | null;
  starts_at: string; ends_at: string; note: string;
};
type Emergency = { id: string; label: string; phone: string; kind: string; note: string };

const FUNC_LABEL: Record<string, string> = {
  ledning: 'Ledning', sakerhet: 'Säkerhet', boende: 'Boende', planer: 'Planer',
  transport: 'Transport', maltider: 'Måltider', sjukvard: 'Sjukvård'
};

export default function OnCallSheet({ onClose, canEdit = false, showSchedule = true }: {
  onClose: () => void; canEdit?: boolean; showSchedule?: boolean;
}) {
  const supabase = createClient();
  const [onCall, setOnCall] = useState<OnCall[]>([]);
  const [emergency, setEmergency] = useState<Emergency[]>([]);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [o, e] = await Promise.all([
      supabase.from('on_call_now').select('*'),
      supabase.from('emergency_contacts').select('*').order('sort_order')
    ]);
    // Utan täckning räknas jouren fram ur offlinepaketet, som har passens
    // tider. Ett sparat "jour just nu" kan ha hunnit bli fel.
    const snap = readSnapshot();
    if (snap && (netState().offline || o.error)) {
      const now = Date.now();
      const cur = new Map<string, OnCall>();
      [...snap.onCall]
        .filter((x) => Date.parse(x.from) <= now && now < Date.parse(x.to))
        .sort((a, b) => Date.parse(b.from) - Date.parse(a.from))
        .forEach((x) => {
          if (!cur.has(x.fn)) {
            cur.set(x.fn, { function: x.fn, contact_name: x.name, phone: x.phone, starts_at: x.from, ends_at: x.to, note: x.note });
          }
        });
      setOnCall([...cur.values()]);
      setSavedAt(snap.savedAt);
    } else {
      setOnCall((o.data ?? []) as OnCall[]);
      setSavedAt(null);
    }
    if (snap && (e.error || (netState().offline && !(e.data ?? []).length))) {
      setEmergency(snap.emergency.map((x, i) => ({ id: `s${i}`, label: x.label, phone: x.phone, kind: x.kind, note: x.note })));
    } else {
      setEmergency((e.data ?? []) as Emergency[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const until = (d: string) =>
    new Date(d).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldAlert size={19} /> Jour
          </h3>
          <button className="btn btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        {loading && <div className="page-sub">Laddar…</div>}
        {savedAt && (
          <div className="li-meta" style={{ margin: '0 0 8px' }}>
            Ingen täckning · enligt jourschemat som sparades {new Date(savedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}

        {!loading && onCall.length === 0 && (
          <div className="page-sub">
            Ingen jour är schemalagd just nu.
            {canEdit && showSchedule && ' Lägg upp jourpass under Bemanning → Jour.'}
          </div>
        )}

        {onCall.map((o) => (
          <a key={o.function} href={o.phone ? `tel:${o.phone.replace(/\s/g, '')}` : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none',
              padding: '12px 14px', borderRadius: 11, marginBottom: 8,
              background: 'var(--bg)', color: 'inherit'
            }}>
            <Phone size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                {FUNC_LABEL[o.function] ?? o.function}
              </div>
              <div className="li-meta" style={{ marginTop: 1 }}>
                {o.contact_name || 'Namn saknas'} · till {until(o.ends_at)}
                {o.note ? ` · ${o.note}` : ''}
              </div>
            </div>
            <div className="mono" style={{ fontSize: 13.5, fontWeight: 600, flexShrink: 0 }}>
              {o.phone || '—'}
            </div>
          </a>
        ))}

        {emergency.length > 0 && (
          <>
            <div className="label" style={{ marginTop: 14 }}>Nödnummer</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {emergency.map((e) => (
                <a key={e.id} href={`tel:${e.phone.replace(/\s/g, '')}`} className="chip"
                  style={{
                    textDecoration: 'none',
                    borderColor: e.kind === 'nod' ? 'var(--danger)' : undefined,
                    color: e.kind === 'nod' ? 'var(--danger)' : undefined,
                    fontWeight: e.kind === 'nod' ? 700 : undefined
                  }}>
                  {e.kind === 'nod' && <Siren size={13} />}
                  {e.label} · {e.phone}
                </a>
              ))}
            </div>
          </>
        )}

        {showSchedule && (
          <Link href="/staffing?tab=jour" className="btn btn-sm" onClick={onClose}
            style={{ marginTop: 16, width: '100%' }}>
            <CalendarClock size={15} /> {canEdit ? 'Jourschema och nödnummer' : 'Hela jourschemat'}
          </Link>
        )}
      </div>
    </div>
  );
}
