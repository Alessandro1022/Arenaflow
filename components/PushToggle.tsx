'use client';
// Slå på pushnotiser för den här telefonen. Visas bara när appen har
// VAPID-nycklar. På iPhone måste appen först läggas till på hemskärmen.
import { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { VAPID_PUBLIC, currentSubscription, disablePush, enablePush, isIOS, isStandalone, pushSupported } from '@/lib/pushClient';

type State = 'hidden' | 'ios-home' | 'denied' | 'off' | 'on';

export default function PushToggle() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>('hidden');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      if (!VAPID_PUBLIC) return setState('hidden');
      if (isIOS() && !isStandalone()) return setState('ios-home');
      if (!pushSupported()) return setState('hidden');
      if (Notification.permission === 'denied') return setState('denied');
      setState((await currentSubscription()) ? 'on' : 'off');
    })().catch(() => setState('hidden'));
  }, []);

  if (state === 'hidden') return null;
  if (state === 'ios-home') {
    return <div className="push-hint"><Bell size={14} /> Notiser: lägg först till appen på hemskärmen (Dela → Lägg till på hemskärmen).</div>;
  }
  if (state === 'denied') {
    return <div className="push-hint"><BellOff size={14} /> Notiser är avstängda i telefonens inställningar.</div>;
  }

  const toggle = async () => {
    setErr(''); setBusy(true);
    try {
      if (state === 'on') { await disablePush(supabase); setState('off'); }
      else { await enablePush(supabase); setState('on'); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Det gick inte.');
    }
    setBusy(false);
  };

  return (
    <>
      <button className="nav-link push-toggle" onClick={toggle} disabled={busy}
        style={{ width: '100%', border: 'none', background: 'none' }}>
        {state === 'on' ? <Bell size={17} /> : <BellOff size={17} />}
        {state === 'on' ? 'Notiser på' : 'Slå på notiser'}
      </button>
      {err && <div className="push-hint">{err}</div>}
    </>
  );
}
