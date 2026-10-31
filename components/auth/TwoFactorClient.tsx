'use client';
// Tvåfaktor: slå på med en kodapp, eller ange koden vid inloggning.
//
// På iPhone öppnar knappen "Lägg till i kodappen" telefonens inbyggda
// kodhanterare (Lösenord), så det går att göra helt i telefonen. QR-koden är
// till för den som har appen på en annan enhet än den här.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, Copy, LogOut, KeyRound } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

type Mode = 'loading' | 'off' | 'enroll' | 'verify' | 'done';

export default function TwoFactorClient({ required, enrolled, verified, email, issuer }: {
  required: boolean; enrolled: boolean; verified: boolean; email: string; issuer: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [mode, setMode] = useState<Mode>('loading');
  const [factorId, setFactorId] = useState('');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const startEnroll = async () => {
    setErr(''); setBusy(true);
    try {
      // Påbörjade men aldrig slutförda försök tas bort först, annars vägrar
      // Supabase ett nytt med samma namn
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of list?.all ?? []) {
        if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const stamp = new Date().toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Telefon ${stamp}`, issuer });
      if (error || !data) throw new Error(error?.message ?? 'Kunde inte starta');
      setFactorId(data.id);
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
      setUri(data.totp.uri);
      setMode('enroll');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Något gick fel. Försök igen.');
    }
    setBusy(false);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      if (verified) { setMode('done'); return; }
      const { data } = await supabase.auth.mfa.listFactors();
      const ok = data?.totp?.[0];
      if (ok) { setFactorId(ok.id); setMode('verify'); return; }
      if (required) { await startEnroll(); return; }
      setMode('off');
    })().catch(() => setMode(enrolled ? 'verify' : 'off'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (value = code) => {
    if (busy || value.length !== 6 || !factorId) return;
    setErr(''); setBusy(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: value });
    if (error) {
      setBusy(false);
      setCode('');
      setErr(/invalid|incorrect|verification/i.test(error.message)
        ? 'Fel kod. Koden byts var 30:e sekund – skriv den som visas nu.'
        : error.message);
      return;
    }
    // Hel omladdning, så att servern ser den uppgraderade inloggningen
    window.location.href = '/dashboard';
  };

  const onCode = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 6);
    setCode(d);
    if (d.length === 6) submit(d);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignorera */ }
  };

  const codeInput = (
    <>
      <label className="label">Sexsiffrig kod</label>
      <input className="input mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*"
        maxLength={6} value={code} onChange={(e) => onCode(e.target.value)} placeholder="123456" autoFocus disabled={busy} />
    </>
  );

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-eyebrow"><ShieldCheck size={14} /> TVÅFAKTOR</div>
        <h2 style={{ margin: '4px 0 6px' }}>
          {mode === 'loading' ? 'Tvåfaktor' : mode === 'verify' ? 'Ange koden' : mode === 'done' ? 'Tvåfaktor är på' : 'Slå på tvåfaktor'}
        </h2>
        <div className="page-sub" style={{ marginTop: 0 }}>{email}</div>

        {mode === 'loading' && <div className="page-sub">Laddar…</div>}

        {mode === 'off' && (
          <>
            <p className="mfa-text">Med tvåfaktor krävs en sexsiffrig kod från telefonen vid varje inloggning, utöver lösenordet. Din roll kräver det inte, men du kan slå på det ändå.</p>
            <button className="btn btn-primary" onClick={startEnroll} disabled={busy}>Slå på tvåfaktor</button>
            <a className="btn" href="/dashboard">Inte nu</a>
          </>
        )}

        {mode === 'enroll' && (
          <>
            <p className="mfa-text">
              {required ? 'Din roll kräver tvåfaktor. ' : ''}Varje inloggning kräver då en sexsiffrig kod från telefonen, utöver lösenordet.
            </p>
            <div className="mfa-step"><b>1.</b> Lägg till kontot i en kodapp</div>
            {uri && <a className="btn btn-primary" href={uri}><KeyRound size={15} /> Lägg till i kodappen</a>}
            <div className="mfa-hint">På iPhone öppnas den inbyggda kodhanteraren. Fungerar också med Google Authenticator och Microsoft Authenticator.</div>
            {qr && (
              <details className="mfa-more">
                <summary>Har du kodappen på en annan enhet? Skanna QR-koden</summary>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="mfa-qr" src={qr} alt="QR-kod för kodappen" />
              </details>
            )}
            {secret && (
              <details className="mfa-more">
                <summary>Eller skriv in nyckeln för hand</summary>
                <div className="mfa-secret">{secret.match(/.{1,4}/g)?.join(' ')}</div>
                <button className="btn btn-sm" onClick={copy}><Copy size={13} /> {copied ? 'Kopierad' : 'Kopiera'}</button>
              </details>
            )}
            <div className="mfa-step"><b>2.</b> Skriv koden som visas i appen</div>
            {codeInput}
          </>
        )}

        {mode === 'verify' && (
          <>
            <p className="mfa-text">Öppna kodappen och skriv koden för {issuer}.</p>
            {codeInput}
            <div className="mfa-hint">Tappat telefonen? En admin kan nollställa tvåfaktor åt dig under Personal.</div>
          </>
        )}

        {mode === 'done' && (
          <>
            <p className="mfa-text">Inloggningen är bekräftad med kod.</p>
            <a className="btn btn-primary" href="/dashboard">Till appen</a>
          </>
        )}

        {busy && mode !== 'loading' && <div className="page-sub">Kontrollerar…</div>}
        {err && <div className="form-error">{err}</div>}

        <form action="/auth/signout" method="post" style={{ marginTop: 14 }}>
          <button className="btn" type="submit"><LogOut size={15} /> Logga ut</button>
        </form>
      </div>
    </div>
  );
}
