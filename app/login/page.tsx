'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { assertSupabaseEnv } from '@/lib/supabase/env';
import { tenant } from '@/lib/tenant';
import { useLang } from '@/components/LanguageProvider';
import { clearSnapshot } from '@/lib/offline/snapshot';

export default function LoginPage() {
  const { tr } = useLang();
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Ett offlinepaket från förra inloggningen ska inte ligga kvar för nästa
  // person. Det byggs upp igen direkt efter inloggning.
  useEffect(() => { clearSnapshot(); }, []);
  // Fel i miljövariablerna ger annars bara "Load failed" utan förklaring
  const envError = assertSupabaseEnv();

  // "Load failed" är Safaris text för ett anrop som aldrig nådde fram.
  // Nästan alltid fel adress till Supabase, inte fel lösenord.
  const readable = (m: string) =>
    /load failed|failed to fetch|networkerror/i.test(m)
      ? 'Ingen kontakt med servern. Kontrollera nätverket – kvarstår det är adressen till databasen felaktig.'
      : m;

  const signIn = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) { setError(readable(error.message)); return; }
      router.push('/dashboard');
      router.refresh();
    } catch (e) {
      setBusy(false);
      setError(readable(e instanceof Error ? e.message : 'Okänt fel'));
    }
  };

  const magic = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${location.origin}/auth/callback` }
      });
      setBusy(false);
      if (error) { setError(readable(error.message)); return; }
      setMsg(tr('magicSent'));
    } catch (e) {
      setBusy(false);
      setError(readable(e instanceof Error ? e.message : 'Okänt fel'));
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-eyebrow"><span className="pulse" />TOURNAMENTOPS · {tenant.event.city.toUpperCase()}</div>
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <div className="brand-badge">{tenant.event.logoText}</div>
          <div>
            <div className="brand-name" style={{ fontSize: 19 }}>{tenant.event.name}</div>
            <div className="brand-sub">{tenant.event.sport} · fältdrift</div>
          </div>
        </div>

        <label className="label">{tr('email')}</label>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />

        <label className="label">{tr('password')}</label>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />

        <div style={{ display: 'grid', gap: 10, marginTop: 20 }}>
          <button className="btn btn-primary" disabled={busy || !email} onClick={signIn}>{tr('signIn')}</button>
          <button className="btn" disabled={busy || !email} onClick={magic}>{tr('magicLink')}</button>
        </div>

        {envError && <div className="form-error">Konfigurationsfel: {envError}</div>}
        {error && <div className="form-error">{error}</div>}
        {msg && <div className="ok-msg">{msg}</div>}
        <div className="li-meta" style={{ marginTop: 16, textAlign: 'center' }}>
          <a href="/integritet">Integritetsinformation</a>
        </div>
      </div>
    </div>
  );
}
