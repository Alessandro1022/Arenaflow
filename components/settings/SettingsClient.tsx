'use client';
// Inställningar för DEN EGNA turneringen. event_settings är borttagen –
// namn och färg låg både där och i tenants, vilket gav två sanningskällor
// för samma sak. tenants är nu enda källan.
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLang } from '@/components/LanguageProvider';
import { useTenant } from '@/components/TenantProvider';
import { tenant as fallback } from '@/lib/tenant';
import GdprSettings from '@/components/settings/GdprSettings';
import BackupSettings from '@/components/settings/BackupSettings';

export default function SettingsClient() {
  const { tr } = useLang();
  const tn = useTenant();
  const supabase = createClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Fyll fälten när turneringen laddats
  useEffect(() => {
    setName(tn.active?.name ?? '');
    setColor(tn.active?.colors?.primary ?? '');
  }, [tn.active?.id, tn.active?.name, tn.active?.colors?.primary]);

  const save = async (reset = false) => {
    setError('');
    const id = tn.active?.id;
    if (!id) { setError('Ingen turnering vald.'); return; }

    const nextColor = reset ? '' : color.trim();
    const validColor = /^#[0-9a-fA-F]{6}$/.test(nextColor);
    if (nextColor && !validColor) {
      setError('Färgen måste vara en hex-kod, t.ex. #1D6FA8.');
      return;
    }

    const colors = { ...(tn.active?.colors ?? {}) };
    if (reset) {
      delete colors.primary;
      delete colors.primaryDark;
    } else if (validColor) {
      colors.primary = nextColor;
      colors.primaryDark = nextColor;
    }

    const { error: err } = await supabase.from('tenants').update({
      name: reset ? fallback.event.name : (name.trim() || tn.active!.name),
      colors
    }).eq('id', id);

    if (err) { setError(err.message); return; }

    if (reset) { setName(fallback.event.name); setColor(''); }
    tn.reload();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <>
      <h1 className="page-title">{tr('settings')}</h1>
      <div className="page-sub">Gäller {tn.name}</div>

      <div className="card" style={{ maxWidth: 560 }}>
        <label className="label">{tr('eventName')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={fallback.event.name} />

        <label className="label">{tr('primaryColor')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" value={color} onChange={(e) => setColor(e.target.value)}
            placeholder={fallback.theme.primary} style={{ flex: 1 }} />
          <input type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback.theme.primary}
            onChange={(e) => setColor(e.target.value)}
            style={{ width: 46, height: 42, border: '1px solid var(--line)', borderRadius: 10, background: '#fff', padding: 3 }} />
        </div>

        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn btn-primary" onClick={() => save(false)}>{tr('saveSettings')}</button>
          <button className="btn" onClick={() => save(true)}>{tr('resetLbl')}</button>
        </div>

        {error && <div className="form-error">{error}</div>}
        {saved && <div className="ok-msg">{tr('settingsSaved')}</div>}
      </div>

      <GdprSettings />
      <BackupSettings />
    </>
  );
}
