'use client';
// Chatt med riktiga kanaler. Tidigare var kanalen en fri sträng, vilket
// fungerar så länge allt är öppet men inte går att svara på frågan "vem får
// läsa den här?" så fort det finns privata samtal. Nu styr medlemskapet.
//
// Direktmeddelanden är aldrig öppna, oavsett behörighet: ledningen ska inte
// kunna läsa personalens privata samtal för att de står högre i organisationen.
// Platskanaler läses av den som har ansvar för platsen (del 22).
// Grupper kan följa roller, även på en viss plats, och en kanal kan vara
// sådan att bara ledningen skriver (del 28).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Plus, AlertTriangle, ListPlus, Languages, X, Users, Paperclip, Megaphone, Sparkles } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  addToOutbox, dropFromOutbox, isOfflineError, newId, readOutbox, retryOutboxItem, OUTBOX_EVENT, type OutboxItem
} from '@/lib/offline/outbox';
import { netState } from '@/lib/offline/status';
import { flushPush } from '@/lib/pushClient';
import { useLang } from '@/components/LanguageProvider';
import { tierOf, ROLE_LABELS, ROLE_GROUPS, type Role } from '@/lib/types';
import { useTenant } from '@/components/TenantProvider';
import {
  AttachmentList, signAttachments, uploadAttachment, type Att
} from '@/components/attachments/Attachments';

type Msg = {
  id: string; channel_id: string | null; body: string; sender: string;
  created_at: string; priority: boolean; task_id: string | null;
  translated_body: string; translated_to: string;
};
type Channel = {
  id: string; kind: string; name: string; is_open: boolean; min_tier: number;
  location_type: string | null; location_id: string | null;
  // Från del 28. Saknas kolumnerna gäller det gamla: alla som läser får skriva.
  roles?: string[]; post_min_tier?: number; created_by?: string | null;
};
type Person = { id: string; full_name: string; role: Role };
type Place = { key: string; type: 'school' | 'arena'; id: string; name: string };

const KIND_LABEL: Record<string, string> = {
  global: 'Alla', grupp: 'Grupp', plats: 'Plats', direkt: 'Direkt', lagledare: 'Lagledare'
};
const TIER_OPTIONS = [
  { tier: 1, label: 'Alla i turneringen' },
  { tier: 2, label: 'Fältpersonal och uppåt' },
  { tier: 3, label: 'Områdesansvariga och uppåt' },
  { tier: 4, label: 'Ledningen' }
];
const MSG_FIELDS = 'id,channel_id,body,sender,created_at,priority,task_id,translated_body,translated_to';
const CH_FIELDS = 'id,kind,name,is_open,min_tier,location_type,location_id';
const CH_FIELDS_28 = `${CH_FIELDS},roles,post_min_tier,created_by`;
const LEADERS_WRITE = 4;

// Vilka som är med, i klartext under kanalens namn
function audience(c: Channel): string {
  const roles = c.roles ?? [];
  let who: string;
  if (c.kind === 'direkt') who = 'Bara ni två';
  else if (roles.length) {
    who = roles.map((r) => ROLE_LABELS[r as Role] ?? r).join(', ') + (c.location_id ? ' med ansvar för platsen' : '');
  } else if (c.kind === 'plats') who = 'Alla med ansvar för platsen';
  else if (c.is_open) who = TIER_OPTIONS.find((o) => o.tier === c.min_tier)?.label ?? 'Alla i turneringen';
  else who = 'Utvalda personer';
  return (c.post_min_tier ?? 1) >= LEADERS_WRITE ? `${who} läser · bara ledningen skriver` : who;
}

// Ordningen i listan: info från ledningen först, sedan alla, grupper, platser och direkt
function rank(c: Channel): number {
  if ((c.post_min_tier ?? 1) >= LEADERS_WRITE && c.is_open) return 0;
  if (c.kind === 'global') return 1;
  if (c.kind === 'direkt') return 5;
  if (c.kind === 'plats') return 4;
  if ((c.roles ?? []).length) return 2;
  return 3;
}
const PLACEHOLDER = /^(Bild|\d+ bilagor)$/;

export default function ChatClient({ userId, role }: { userId: string; role: Role }) {
  const { tr } = useLang();
  const supabase = useMemo(() => createClient(), []);
  const tn = useTenant();
  const tier = tierOf(role);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [atts, setAtts] = useState<Record<string, Att[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [dmOther, setDmOther] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [text, setText] = useState('');
  const [priority, setPriority] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [newDm, setNewDm] = useState(false);
  const [newCh, setNewCh] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Skrivet utan täckning: skickas av sig självt när täckningen kommer tillbaka
  const [pending, setPending] = useState<OutboxItem[]>([]);

  // Ny kanal
  const [cName, setCName] = useState('');
  const [cKind, setCKind] = useState<'roller' | 'plats' | 'grupp' | 'oppen'>('roller');
  const [cMembers, setCMembers] = useState<string[]>([]);
  const [cTier, setCTier] = useState(1);
  const [cPlace, setCPlace] = useState('');
  const [cSearch, setCSearch] = useState('');
  const [cRoles, setCRoles] = useState<Role[]>([]);
  const [cLeadersWrite, setCLeadersWrite] = useState(false);
  // Finns del 28? Annars döljs det som kräver den.
  const [has28, setHas28] = useState(true);
  const [info, setInfo] = useState('');

  const loadUnread = useCallback(async () => {
    const { data } = await supabase.from('channel_unread').select('channel_id,unread').eq('user_id', userId);
    setUnread(Object.fromEntries(((data ?? []) as { channel_id: string; unread: number }[])
      .map((x) => [x.channel_id, Number(x.unread) || 0])));
  }, [supabase, userId]);

  const loadChannels = useCallback(async () => {
    const [c0, p] = await Promise.all([
      supabase.from('channels').select(CH_FIELDS_28).order('kind'),
      supabase.from('profiles').select('id,full_name,role').order('full_name')
    ]);
    let c: { data: unknown; error: { message: string } | null } = c0;
    // Del 28 inte körd än: läs som förut
    if (c.error && /roles|post_min_tier|created_by|column/i.test(c.error.message)) {
      setHas28(false);
      c = await supabase.from('channels').select(CH_FIELDS).order('kind');
    }
    const list = ((c.data ?? []) as Channel[])
      .slice().sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || '', 'sv'));
    setChannels(list);
    const ppl = (p.data ?? []) as Person[];
    setPeople(ppl.filter((x) => x.id !== userId));
    setNames(Object.fromEntries(ppl.map((x) => [x.id, x.full_name])));
    setActive((cur) => cur ?? list[0]?.id ?? null);
    loadUnread();

    // Ett direktmeddelande heter som den andra personen, inte som en själv
    const dms = list.filter((x) => x.kind === 'direkt').map((x) => x.id);
    if (dms.length) {
      const { data } = await supabase.from('channel_members').select('channel_id,user_id').in('channel_id', dms);
      const other: Record<string, string> = {};
      for (const r of (data ?? []) as { channel_id: string; user_id: string }[]) {
        if (r.user_id !== userId) other[r.channel_id] = r.user_id;
      }
      setDmOther(other);
    }
  }, [supabase, userId, loadUnread]);

  // Markera kanalen som läst. Läst-markeringen ligger i en egen tabell
  // (del 22). Finns den inte än uppdateras medlemskapet som förut.
  const markRead = useCallback(async (ch: string) => {
    const now = new Date().toISOString();
    const { error } = await supabase.from('channel_reads')
      .upsert({ channel_id: ch, user_id: userId, last_read_at: now }, { onConflict: 'channel_id,user_id' });
    if (error) {
      await supabase.from('channel_members').update({ last_read_at: now })
        .eq('channel_id', ch).eq('user_id', userId);
    }
    setUnread((u) => ({ ...u, [ch]: 0 }));
    window.dispatchEvent(new Event('tops:chat-read'));
  }, [supabase, userId]);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  // Platserna behövs bara när ledningen skapar en platskanal
  useEffect(() => {
    if (!newCh || places.length) return;
    Promise.all([
      supabase.from('schools').select('id,name').order('name'),
      supabase.from('arenas').select('id,name').order('name')
    ]).then(([s, a]) => setPlaces([
      ...((s.data ?? []) as { id: string; name: string }[]).map((x) => ({ key: `school:${x.id}`, type: 'school' as const, id: x.id, name: x.name })),
      ...((a.data ?? []) as { id: string; name: string }[]).map((x) => ({ key: `arena:${x.id}`, type: 'arena' as const, id: x.id, name: x.name }))
    ]));
  }, [newCh, places.length, supabase]);

  const loadAtts = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const { data, error } = await supabase.from('attachments').select('*')
      .eq('parent_type', 'message').in('parent_id', ids).order('created_at');
    if (error || !data?.length) return;
    const signed = await signAttachments(supabase, data as Att[]);
    setAtts((cur) => {
      const next = { ...cur };
      for (const id of ids) next[id] = signed.filter((a) => a.parent_id === id);
      return next;
    });
  }, [supabase]);

  const load = useCallback(async () => {
    if (!active) { setMsgs([]); return; }
    const { data, error } = await supabase.from('messages')
      .select(MSG_FIELDS).eq('channel_id', active).order('created_at').limit(200);
    if (error) setErr(error.message);
    const list = (data ?? []) as Msg[];
    setMsgs(list);
    loadAtts(list.map((m) => m.id));
  }, [supabase, active, loadAtts]);

  useEffect(() => {
    load();
    if (!active) return;
    markRead(active);
    let readTimer: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase.channel(`chat-${active}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new as Msg;
        if (m.channel_id !== active) {
          // Annan kanal: räkna upp olästa
          if (m.channel_id && m.sender !== userId) {
            setUnread((u) => ({ ...u, [m.channel_id as string]: (u[m.channel_id as string] ?? 0) + 1 }));
          }
          return;
        }
        setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        // Bilden laddas upp strax efter meddelandet
        setTimeout(() => loadAtts([m.id]), 2000);
        // Meddelandet syns på skärmen, alltså är det läst
        if (readTimer) clearTimeout(readTimer);
        readTimer = setTimeout(() => markRead(active), 1000);
      })
      .subscribe();
    return () => {
      if (readTimer) clearTimeout(readTimer);
      supabase.removeChannel(ch);
      // Det som kom medan kanalen var öppen är läst
      markRead(active);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, load]);

  // Det som väntar i telefonen, och nya meddelanden när kön skickats
  useEffect(() => {
    const read = () => setPending(readOutbox(userId).filter((i) => i.table === 'messages'));
    const sent = () => { read(); load(); };
    read();
    window.addEventListener(OUTBOX_EVENT, read);
    window.addEventListener('tops:outbox-sent', sent);
    return () => {
      window.removeEventListener(OUTBOX_EVENT, read);
      window.removeEventListener('tops:outbox-sent', sent);
    };
  }, [userId, load]);
  const pendingHere = pending.filter((i) => i.row.channel_id === active);

  // Till senaste meddelandet, även när en bild laddats klart och tagit plats
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, atts, pendingHere.length]);

  // Utan täckning läggs meddelandet i kön och skickas senare. Bilder och filer
  // kan inte vänta i telefonen, så de kräver täckning direkt.
  const insertMessage = async (body: string, canWait = true): Promise<Msg | 'queued' | null> => {
    const row = { channel: 'kanal', channel_id: active, body, sender: userId, priority };
    const { data, error } = await supabase.from('messages').insert(row).select(MSG_FIELDS).single();
    if (error && isOfflineError(error) && canWait) {
      if (addToOutbox({ id: newId(), table: 'messages', row, userId })) return 'queued';
    }
    if (error) { setErr(error.message); return null; }
    setMsgs((prev) => (prev.some((x) => x.id === data.id) ? prev : [...prev, data as Msg]));
    if (priority) flushPush();
    return data as Msg;
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !active) return;
    setSending(true); setErr('');
    const m = await insertMessage(body);
    if (m) { setText(''); setPriority(false); }
    setSending(false);
  };

  // Bild eller fil i chatten: meddelandet först, sedan bilagan på det
  const sendFiles = async (list: FileList | null) => {
    if (!list || !list.length || !active || sending) return;
    if (netState().offline) {
      setErr('Bilder och filer kan inte skickas utan täckning. Försök igen när du har täckning.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setSending(true); setErr('');
    const m = await insertMessage(text.trim() || (list.length > 1 ? `${list.length} bilagor` : 'Bild'), false);
    if (m && m !== 'queued') {
      for (const file of Array.from(list)) {
        const e = await uploadAttachment(supabase, {
          tenantId: tn.active?.id ?? 'okand', parentType: 'message', parentId: m.id, userId, file
        });
        if (e) { setErr(e); break; }
      }
      setText(''); setPriority(false);
      await loadAtts([m.id]);
    }
    if (fileRef.current) fileRef.current.value = '';
    setSending(false);
  };

  // Ett meddelande som kräver åtgärd ska bli ett ärende, inte skrollas bort
  const toTask = async (m: Msg) => {
    setErr('');
    const { data, error } = await supabase.from('tasks')
      .insert({ title: m.body.slice(0, 120), description: m.body, created_by: userId })
      .select('id').single();
    if (error) { setErr(error.message); return; }
    await supabase.from('messages').update({ task_id: data.id }).eq('id', m.id);
    load();
  };

  const translate = async (m: Msg) => {
    setErr('');
    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'ask',
          question: `Översätt till svenska, svara med enbart översättningen: "${m.body}"`
        })
      });
      const body = await res.json();
      if (!res.ok) { setErr(body.error || 'Översättning misslyckades'); return; }
      await supabase.from('messages')
        .update({ translated_body: body.body ?? '', translated_to: 'sv' })
        .eq('id', m.id);
      load();
    } catch {
      setErr('Översättning misslyckades');
    }
  };

  const startDm = async (other: Person) => {
    setErr('');
    // Finns redan ett samtal med personen? Öppna det i stället för att skapa ett till.
    const existing = channels.filter((c) => c.kind === 'direkt');
    if (existing.length) {
      const { data } = await supabase.from('channel_members').select('channel_id')
        .eq('user_id', other.id).in('channel_id', existing.map((c) => c.id));
      const hit = (data ?? [])[0] as { channel_id: string } | undefined;
      if (hit) { setNewDm(false); setActive(hit.channel_id); return; }
    }
    const { data, error } = await supabase.from('channels').insert({
      kind: 'direkt', name: other.full_name || 'Direkt', is_open: false, created_by: userId
    }).select('id').single();
    if (error) { setErr(error.message); return; }
    const { error: e2 } = await supabase.from('channel_members').insert([
      { channel_id: data.id, user_id: userId },
      { channel_id: data.id, user_id: other.id }
    ]);
    if (e2) { setErr(e2.message); return; }
    setNewDm(false);
    await loadChannels();
    setActive(data.id);
  };

  const resetNewChannel = () => {
    setNewCh(false); setCName(''); setCKind(has28 ? 'roller' : 'grupp'); setCMembers([]); setCTier(1); setCPlace(''); setCSearch('');
    setCRoles([]); setCLeadersWrite(false);
  };

  const createChannel = async () => {
    setErr(''); setInfo('');
    // Platsen gäller bara platskanaler, även om en plats valts innan man bytte typ
    const place = cKind === 'plats' ? places.find((p) => p.key === cPlace) : undefined;
    const roleNames = cRoles.map((r) => ROLE_LABELS[r]).join(' och ');
    const name = cName.trim() || (place ? (cRoles.length ? `${place.name} · ${roleNames.toLowerCase()}` : place.name) : roleNames);
    if (cKind === 'roller' && cRoles.length === 0) { setErr('Välj minst en roll.'); return; }
    if (!name) { setErr('Ge kanalen ett namn.'); return; }
    if (cKind === 'grupp' && cMembers.length === 0) { setErr('Välj minst en person.'); return; }
    if (cKind === 'plats' && !place) { setErr('Välj en plats.'); return; }

    const row: Record<string, unknown> = {
      name,
      kind: cKind === 'plats' ? 'plats' : 'grupp',
      is_open: cKind === 'oppen',
      min_tier: cKind === 'oppen' ? cTier : 1,
      location_type: place?.type ?? null,
      location_id: place?.id ?? null,
      created_by: userId
    };
    if (has28) {
      row.roles = cKind === 'roller' || cKind === 'plats' ? cRoles : [];
      row.post_min_tier = cLeadersWrite ? LEADERS_WRITE : 1;
    }
    const { data, error } = await supabase.from('channels').insert(row).select('id').single();
    if (error) { setErr(error.message); return; }

    // Gruppkanal: utvalda medlemmar. Den som skapar är alltid med.
    const members = cKind === 'grupp' ? [userId, ...cMembers] : [userId];
    const { error: e2 } = await supabase.from('channel_members')
      .insert(members.map((u) => ({ channel_id: data.id, user_id: u })));
    if (e2) { setErr(e2.message); return; }
    resetNewChannel();
    await loadChannels();
    setActive(data.id);
  };

  // Standardgrupperna med en knapp: Info från ledningen, Säkerhet, Boende, Kök …
  const createStandard = async () => {
    setErr(''); setInfo('');
    const { data, error } = await supabase.rpc('create_standard_channels');
    if (error) { setErr(error.message); return; }
    const n = Number(data) || 0;
    setInfo(n ? `${n} nya grupper lades upp. Alla med rätt roll är med automatiskt.` : 'Standardgrupperna finns redan.');
    await loadChannels();
  };

  const fmt = (d: string) => new Date(d).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const current = channels.find((c) => c.id === active);
  const needle = cSearch.trim().toLowerCase();
  // Bara ledningen skriver i vissa kanaler; den som skapat kanalen får alltid
  const canPost = !current || current.created_by === userId || tier >= (current.post_min_tier ?? 1);
  const toggleRole = (r: Role) => setCRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">{tr('chat')}</h1>
          <div className="page-sub" style={{ marginBottom: 0 }}>{tn.name}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {tier >= 4 && has28 && (
            <button className="btn btn-sm" onClick={createStandard} title="Info från ledningen, Ledning, Säkerhet, Boende, Kök och måltider, Planer, Sjukvård, Transport och lager">
              <Sparkles size={14} /> Standardgrupper
            </button>
          )}
          {tier >= 4 && (
            <button className="btn btn-sm" onClick={() => { setCKind(has28 ? 'roller' : 'grupp'); setNewCh(true); }}>
              <Users size={14} /> Ny kanal
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setNewDm(true)}>
            <Plus size={14} /> Direkt
          </button>
        </div>
      </div>

      <div className="chips" style={{ marginTop: 12 }}>
        {channels.map((c) => (
          <button key={c.id} className={`chip ${active === c.id ? 'active' : ''}`}
            onClick={() => setActive(c.id)}>
            {(c.kind === 'direkt' && names[dmOther[c.id]]) || c.name || KIND_LABEL[c.kind]}
            {c.kind === 'direkt' && <span className="li-meta" style={{ marginTop: 0 }}>&nbsp;· direkt</span>}
            {c.kind === 'plats' && <span className="li-meta" style={{ marginTop: 0 }}>&nbsp;· plats</span>}
            {(c.post_min_tier ?? 1) >= LEADERS_WRITE && <Megaphone size={12} style={{ marginLeft: 4 }} aria-label="bara ledningen skriver" />}
            {active !== c.id && (unread[c.id] ?? 0) > 0 && <span className="unread">{unread[c.id]}</span>}
          </button>
        ))}
        {channels.length === 0 && <div className="page-sub">Inga kanaler än.</div>}
      </div>
      {current && <div className="chat-audience">{audience(current)}</div>}

      {err && <div className="form-error" style={{ marginBottom: 10 }}>{err}</div>}
      {info && <div className="ok-msg" style={{ marginBottom: 10 }}>{info}</div>}

      <div className="chat-box">
        <div className="chat-msgs">
          {msgs.map((m) => (
            <div key={m.id} className={`chat-msg ${m.sender === userId ? 'mine' : ''}`}>
              <div className="chat-bubble" style={m.priority ? {
                borderLeft: '3px solid var(--danger)', fontWeight: 600
              } : undefined}>
                {m.priority && <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 5 }} />}
                {/* "Bild" är bara en platshållare när bilden själv syns */}
                {!(PLACEHOLDER.test(m.body) && (atts[m.id]?.length ?? 0) > 0) && m.body}
                {m.translated_body && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--line)', fontWeight: 400 }}>
                    {m.translated_body}
                  </div>
                )}
                {(atts[m.id]?.length ?? 0) > 0 && <AttachmentList items={atts[m.id]} />}
              </div>
              <div className="chat-meta">
                {m.sender === userId ? '' : `${names[m.sender] ?? '—'} · `}{fmt(m.created_at)}
                {m.task_id && ' · ärende skapat'}
                {' '}
                {!m.task_id && tier >= 2 && (
                  <button className="btn btn-sm" style={{ padding: '1px 6px', fontSize: 11 }}
                    onClick={() => toTask(m)}>
                    <ListPlus size={11} /> ärende
                  </button>
                )}
                {' '}
                {!m.translated_body && (
                  <button className="btn btn-sm" style={{ padding: '1px 6px', fontSize: 11 }}
                    onClick={() => translate(m)}>
                    <Languages size={11} /> översätt
                  </button>
                )}
              </div>
            </div>
          ))}
          {pendingHere.map((p) => (
            <div key={p.id} className="chat-msg mine pending">
              <div className="chat-bubble" style={p.row.priority ? { borderLeft: '3px solid var(--danger)', fontWeight: 600 } : undefined}>
                {String(p.row.body ?? '')}
              </div>
              <div className="chat-meta">
                {p.error ? (
                  <>
                    <span className="pending-err">Kunde inte skickas: {p.error}</span>{' '}
                    <button className="btn btn-sm" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => retryOutboxItem(p.id)}>Försök igen</button>{' '}
                  </>
                ) : (
                  <span className="pending-wait">Väntar på täckning · skickas av sig självt</span>
                )}{' '}
                <button className="btn btn-sm" style={{ padding: '1px 6px', fontSize: 11 }} onClick={() => dropFromOutbox(p.id)}>Ta bort</button>
              </div>
            </div>
          ))}
          {msgs.length === 0 && pendingHere.length === 0 && <div className="page-sub" style={{ marginBottom: 0 }}>{tr('nothingHere')}</div>}
          <div ref={endRef} />
        </div>

        {tier >= 4 && current && canPost && (
          <label className="check-row" style={{ margin: '0 0 6px' }}>
            <input type="checkbox" checked={priority} onChange={() => setPriority(!priority)} />
            Prioriterat driftmeddelande
          </label>
        )}

        {!canPost && (
          <div className="chat-readonly"><Megaphone size={15} /> Här skriver bara ledningen – du ser allt som skrivs här.</div>
        )}
        {canPost && <div className="chat-input">
          <label className={`btn chat-attach ${sending || !active ? 'busy' : ''}`} aria-label="Bifoga bild eller fil">
            <Paperclip size={17} />
            <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden
              disabled={sending || !active} onChange={(e) => sendFiles(e.target.files)} />
          </label>
          <input
            className="input"
            style={{ minWidth: 0, flex: 1 }}
            placeholder={tr('writeMsg')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            enterKeyHint="send"
          />
          <button className="btn btn-primary" onClick={send} disabled={sending || !text.trim() || !active}>
            <Send size={16} /> <span className="send-label">{tr('send')}</span>
          </button>
        </div>}
      </div>

      {newDm && (
        <div className="modal-overlay" onClick={() => setNewDm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Nytt direktmeddelande</h3>
              <button className="btn btn-sm" onClick={() => setNewDm(false)} aria-label="Stäng"><X size={14} /></button>
            </div>
            <div className="page-sub">
              Bara ni två kan läsa samtalet, oavsett vilken roll någon har.
            </div>
            <div className="list" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {people.map((p) => (
                <button key={p.id} className="list-item" style={{
                  width: '100%', textAlign: 'left', background: 'none', border: 'none',
                  cursor: 'pointer', padding: '10px 0'
                }} onClick={() => startDm(p)}>
                  {p.full_name || '—'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {newCh && (
        <div className="modal-overlay" onClick={resetNewChannel}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Ny kanal</h3>
              <button className="btn btn-sm" onClick={resetNewChannel} aria-label="Stäng"><X size={14} /></button>
            </div>

            <label className="label">Vilka är med?</label>
            <div className="chips" style={{ margin: '0 0 6px', padding: 0, flexWrap: 'wrap' }}>
              {has28 && <button className={`chip ${cKind === 'roller' ? 'active' : ''}`} onClick={() => setCKind('roller')}>Roller</button>}
              <button className={`chip ${cKind === 'plats' ? 'active' : ''}`} onClick={() => setCKind('plats')}>Plats</button>
              <button className={`chip ${cKind === 'grupp' ? 'active' : ''}`} onClick={() => setCKind('grupp')}>Utvalda personer</button>
              <button className={`chip ${cKind === 'oppen' ? 'active' : ''}`} onClick={() => setCKind('oppen')}>Alla från en nivå</button>
            </div>
            <div className="li-meta" style={{ marginTop: 0 }}>
              {cKind === 'roller' && 'Alla med rollerna du väljer, även de som läggs till senare. T.ex. Boendevärd för boendegruppen.'}
              {cKind === 'grupp' && 'Bara de du väljer kan läsa och skriva.'}
              {cKind === 'oppen' && 'Alla från vald nivå kan läsa och skriva.'}
              {cKind === 'plats' && 'Alla som har ansvar för platsen eller dess område, även de som tillkommer senare. Välj roller om bara vissa ska vara med, t.ex. Boendevärd och Måltider där maten serveras på plats.'}
            </div>

            {cKind === 'plats' && (
              <>
                <label className="label">Plats</label>
                <select className="select" value={cPlace} onChange={(e) => setCPlace(e.target.value)}>
                  <option value="">Välj plats</option>
                  <optgroup label={tn.labels.schools}>
                    {places.filter((p) => p.type === 'school').map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </optgroup>
                  <optgroup label={tn.labels.playingAreas}>
                    {places.filter((p) => p.type === 'arena').map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </optgroup>
                </select>
              </>
            )}

            {has28 && (cKind === 'roller' || cKind === 'plats') && (
              <>
                <label className="label">{cKind === 'plats' ? 'Bara de här rollerna (valfritt)' : 'Roller'}</label>
                <div className="role-pick">
                  {ROLE_GROUPS.map((g) => (
                    <div key={g.label} className="role-pick-group">
                      <div className="li-meta" style={{ marginTop: 0 }}>{g.label}</div>
                      <div className="chips" style={{ margin: 0, padding: 0, flexWrap: 'wrap' }}>
                        {g.roles.map((r) => (
                          <button key={r} type="button" className={`chip ${cRoles.includes(r) ? 'active' : ''}`} onClick={() => toggleRole(r)}>
                            {ROLE_LABELS[r]}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <label className="label">Namn</label>
            <input className="input" value={cName} onChange={(e) => setCName(e.target.value)}
              placeholder={cKind === 'plats' ? 'Platsens namn om du lämnar tomt' : cKind === 'roller' ? 'Rollernas namn om du lämnar tomt' : 't.ex. Säkerhetsgruppen'} />

            {cKind === 'oppen' && (
              <>
                <label className="label">Vilka kan läsa</label>
                <select className="select" value={cTier} onChange={(e) => setCTier(Number(e.target.value))}>
                  {TIER_OPTIONS.map((o) => <option key={o.tier} value={o.tier}>{o.label}</option>)}
                </select>
              </>
            )}

            {cKind === 'grupp' && (
              <>
                <label className="label">Medlemmar · {cMembers.length} valda</label>
                <input className="input" placeholder="Sök person" value={cSearch} onChange={(e) => setCSearch(e.target.value)} />
                <div className="member-pick">
                  {people.filter((p) => !needle || (p.full_name || '').toLowerCase().includes(needle)).map((p) => (
                    <label key={p.id} className="member-row">
                      <input type="checkbox" checked={cMembers.includes(p.id)}
                        onChange={() => setCMembers((cur) => cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id])} />
                      <span>{p.full_name || '—'}</span>
                      <span className="li-meta" style={{ marginTop: 0 }}>{ROLE_LABELS[p.role] ?? p.role}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {has28 && (
              <label className="check-row" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={cLeadersWrite} onChange={() => setCLeadersWrite(!cLeadersWrite)} />
                Bara ledningen skriver (alla andra läser)
              </label>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={resetNewChannel}>Avbryt</button>
              <button className="btn btn-primary" onClick={createChannel}>Skapa kanal</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
