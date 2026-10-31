'use client';
// Den inloggade laddar ner allt systemet har om hen (registerutdrag)
import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { downloadJson } from '@/lib/download';

export default function MyDataButton({ userId }: { userId: string }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(''); setBusy(true);
    const { data, error } = await createClient().rpc('person_export', { p: userId });
    setBusy(false);
    if (error) { setErr('Utdraget gick inte att skapa just nu.'); return; }
    downloadJson(`mina-uppgifter-${new Date().toISOString().slice(0, 10)}.json`, data);
  };
  return (
    <>
      <button className="btn btn-primary" onClick={run} disabled={busy}><FileDown size={15} /> Ladda ner mina uppgifter</button>
      {err && <div className="form-error">{err}</div>}
    </>
  );
}
