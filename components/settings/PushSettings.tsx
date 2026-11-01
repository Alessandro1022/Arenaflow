'use client';
// Pushnotiser: skapa VAPID-nycklarna här i telefonen, lägg in dem i Vercel,
// och skicka en testnotis. Den privata nyckeln skapas och visas bara i den
// här webbläsaren – den skickas inte till servern och sparas ingenstans.
import { useState } from 'react';
import { Bell, Copy, KeyRound, Send } from 'lucide-react';
import { VAPID_PUBLIC } from '@/lib/pushClient';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export default function PushSettings() {
  const [keys, setKeys] = useState<{ pub: string; priv: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const generate = async () => {
    setErr('');
    try {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      setKeys({ pub: b64url(pub), priv: String(jwk.d) });
    } catch {
      setErr('Webbläsaren kunde inte skapa nycklar.');
    }
  };

  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(''), 2000); } catch { /* ignorera */ }
  };

  const test = async () => {
    setErr(''); setMsg('');
    const res = await fetch('/api/push/test', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setErr(data.error ?? 'Fel');
    else setMsg(data.sent ? 'Testnotisen är skickad.' : 'Ingen notis skickades. Slå på notiser i menyn först.');
  };

  const row = (label: string, name: string, value: string) => (
    <div className="push-key">
      <div className="label" style={{ marginTop: 10 }}>{label}</div>
      <div className="mono push-name">{name}</div>
      <div className="push-value mono">{value}</div>
      <button className="btn btn-sm" onClick={() => copy(name, value)}><Copy size={13} /> {copied === name ? 'Kopierad' : 'Kopiera'}</button>
    </div>
  );

  return (
    <div className="card push-card" style={{ maxWidth: 560, marginTop: 16 }}>
      <div className="li-title"><Bell size={15} /> Pushnotiser</div>
      {VAPID_PUBLIC ? (
        <>
          <div className="page-sub" style={{ marginTop: 4 }}>
            Påslaget. Var och en slår på notiser för sin telefon i menyn. Notiser skickas vid begäran om sjukvård, krisläge, driftmeddelanden, kritiska incidenter och ändrade pass och matcher.
          </div>
          <button className="btn" onClick={test}><Send size={15} /> Skicka testnotis till mig</button>
        </>
      ) : (
        <>
          <div className="page-sub" style={{ marginTop: 4 }}>
            Inte påslaget än. Det behövs två nycklar i Vercel, som du skapar här:
          </div>
          <ol className="push-steps">
            <li>Tryck på Skapa nycklar.</li>
            <li>I Vercel: Settings → Environment Variables. Lägg till båda raderna nedan, med namnet till vänster och värdet till höger.</li>
            <li>Gör Redeploy. Sedan är notiserna på.</li>
          </ol>
          <button className="btn btn-primary" onClick={generate}><KeyRound size={15} /> Skapa nycklar</button>
          {keys && (
            <>
              {row('Offentlig nyckel', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', keys.pub)}
              {row('Hemlig nyckel – visa aldrig för någon', 'VAPID_PRIVATE_KEY', keys.priv)}
              <div className="li-meta" style={{ marginTop: 8 }}>
                Nycklarna skapades här i telefonen och har inte skickats någonstans. Stänger du sidan försvinner de – då skapar du bara nya.
              </div>
            </>
          )}
        </>
      )}
      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}
