'use client';
import { useCallback, useEffect, useState } from 'react';
import { Siren } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { flushPush } from '@/lib/pushClient';
import { useLang } from '@/components/LanguageProvider';
import { useTenant } from '@/components/TenantProvider';

export default function CrisisClient({ userId }: { userId: string }) {
  const { tr } = useLang();
  const tn = useTenant();
  const supabase = createClient();
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // En krisrad per turnering; RLS ger bara den egna.
    const { data } = await supabase.from('crisis_state').select('active,message').maybeSingle();
    if (data) { setActive(data.active); setMessage(data.message ?? ''); }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    const tenantId = tn.active?.id;
    if (!tenantId) return;
    await supabase.from('crisis_state').update({
      active: !active,
      message: message || null,
      activated_by: userId,
      activated_at: !active ? new Date().toISOString() : null
    }).eq('tenant_id', tenantId);
    if (!active) flushPush();
    load();
  };

  if (loading) return <div className="page-sub">{tr('loading')}</div>;

  return (
    <>
      <h1 className="page-title">{tr('crisis')}</h1>
      <div className="page-sub">{active ? tr('crisisActive') : tr('crisisInactive')}</div>

      <div className="card" style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Siren size={20} style={{ color: active ? 'var(--danger)' : 'var(--muted)' }} />
          <span className={`badge ${active ? 'b-critical' : 'b-low'}`}>{active ? tr('crisisActive') : tr('crisisInactive')}</span>
        </div>
        <label className="label">{tr('crisisMsg')}</label>
        <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)}
          placeholder="Ex: Samling vid huvudentrén. Följ områdesansvarigs instruktioner." />
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className={`btn ${active ? '' : 'btn-primary'}`} style={active ? undefined : { background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={toggle}>
            {active ? tr('deactivateCrisis') : tr('activateCrisis')}
          </button>
        </div>
        <div className="page-sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Bannern visas direkt för all inloggad personal, på alla sidor.
        </div>
      </div>
    </>
  );
}
