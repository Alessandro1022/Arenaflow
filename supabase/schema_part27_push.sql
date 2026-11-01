-- TournamentOps · Del 27 · Pushnotiser
-- ============================================================================
-- Notiserna som redan skapas i databasen (ändrade pass och matcher, begäran
-- om sjukvård) skickas nu också som pushnotiser till telefonen. Tre nya
-- tillfällen får notiser:
--   - krisläge slås på            → alla i turneringen
--   - driftmeddelande i chatten   → alla som kan läsa kanalen, utom avsändaren
--   - kritisk incident            → säkerhetsansvariga, koordinatorer och ledningen
--
-- Själva utskicket görs av servern med VAPID-nycklarna i Vercel. Utan dem
-- händer ingenting – notiserna ligger kvar i databasen som förut.
--
-- Kör efter schema_part26_sjukvard.sql. Går att köra flera gånger.
-- ============================================================================

-- ============ 0. FÖRKONTROLL ============
do $$
begin
  if to_regclass('public.push_subscriptions') is null or to_regclass('public.medical_requests') is null then
    raise exception 'Del 21 och del 26 saknas. Kör dem först (se diagnos.sql).';
  end if;
end $$;

-- ============ 1. NOTISERNA ============
alter table public.notifications
  add column if not exists pushed_at timestamptz,
  add column if not exists url text not null default '';
create index if not exists idx_notifications_unpushed on public.notifications (created_at) where pushed_at is null;

-- Servern hämtar och markerar ej skickade notiser i ett svep. "skip locked"
-- gör att två samtidiga utskick aldrig skickar samma notis två gånger.
-- Notiser äldre än en timme skickas inte: då är de inte längre aktuella.
create or replace function public.claim_pushes(n int default 200)
returns setof public.notifications
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Behörighet saknas';
  end if;
  return query
    update public.notifications x set pushed_at = now()
     where x.id in (
       select id from public.notifications
        where pushed_at is null and created_at > now() - interval '1 hour'
        order by created_at
        limit greatest(1, least(n, 500))
        for update skip locked)
    returning x.*;
end $$;

-- ============ 2. PRENUMERATIONER ============
-- En telefon kan ha använts av någon annan innan: samma adress flyttas då
-- över till den som är inloggad nu.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_ua text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Ej inloggad'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'Ogiltig adress'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, tenant_id)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_ua, ''), 300), public.my_tenant());
end $$;

-- ============ 3. VEM KAN LÄSA EN KANAL ============
-- Samma regler som can_read_channel, men för vilken person som helst
create or replace function public.channel_reader_ids(ch uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select p.id
  from public.channels c
  join public.profiles p on p.tenant_id = c.tenant_id
  where c.id = ch and (
    p.id = c.created_by
    or exists (select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = p.id)
    or (c.is_open and c.kind <> 'direkt' and public.role_tier(p.role) >= c.min_tier)
    or (c.kind = 'plats' and c.location_id is not null and (
          public.role_tier(p.role) >= 5
          or exists (select 1 from public.staff_scope s where s.user_id = p.id and (
                (s.location_type = c.location_type and s.location_id = c.location_id)
                or s.area_id = (select area_id from public.schools where id = c.location_id)
                or s.area_id = (select area_id from public.arenas where id = c.location_id)))))
  )
$$;

-- ============ 4. NYA TILLFÄLLEN ============
create or replace function public.notify_crisis() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active and not coalesce(old.active, false) then
    insert into public.notifications (user_id, title, body, url, tenant_id)
    select p.id, 'KRISLÄGE', coalesce(nullif(new.message, ''), 'Krisläge är aktiverat. Öppna appen.'), '/dashboard', new.tenant_id
    from public.profiles p where p.tenant_id = new.tenant_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_crisis on public.crisis_state;
create trigger trg_notify_crisis after update on public.crisis_state
  for each row execute function public.notify_crisis();

create or replace function public.notify_priority_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.priority and new.channel_id is not null then
    insert into public.notifications (user_id, title, body, url, tenant_id)
    select r, 'Driftmeddelande · ' || coalesce(nullif((select name from public.channels where id = new.channel_id), ''), 'Chatt'),
           left(new.body, 160), '/chat', new.tenant_id
    from public.channel_reader_ids(new.channel_id) r
    where r is distinct from new.sender;
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_priority_message on public.messages;
create trigger trg_notify_priority_message after insert on public.messages
  for each row execute function public.notify_priority_message();

create or replace function public.notify_critical_incident() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.severity = 'critical' and (tg_op = 'INSERT' or old.severity is distinct from 'critical') then
    insert into public.notifications (user_id, title, body, url, tenant_id)
    select p.id, 'Kritisk incident', left(new.title, 160), '/incidents/' || new.id, new.tenant_id
    from public.profiles p
    where p.tenant_id = new.tenant_id
      and p.role in ('security_lead', 'coordinator', 'admin', 'leadership')
      and p.id is distinct from new.reported_by;
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_critical_incident on public.incidents;
create trigger trg_notify_critical_incident after insert or update of severity on public.incidents
  for each row execute function public.notify_critical_incident();

-- Sjukvården: samma notis som i del 26, nu med länk till sidan
create or replace function public.medical_request_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, title, body, url, tenant_id)
  select p.id, 'Begäran om sjukvård',
         case new.urgency when 'akut' then 'AKUT' when 'snart' then 'Snart' else 'Inte bråttom' end
           || coalesce(' · ' || nullif(new.place_text, ''), ''),
         '/sjukvard', new.tenant_id
  from public.profiles p
  where p.tenant_id = new.tenant_id and p.role in ('medic', 'security_lead');
  return new;
end $$;

-- ============ 5. BEHÖRIGHET ============
revoke execute on function public.claim_pushes(int) from public, anon, authenticated;
grant execute on function public.claim_pushes(int) to service_role;
revoke execute on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
revoke execute on function public.channel_reader_ids(uuid) from public, anon, authenticated;
grant execute on function public.channel_reader_ids(uuid) to service_role;
grant select, delete on public.push_subscriptions to authenticated;

-- ============ 6. KONTROLL ============
select
  (select count(*) from information_schema.columns where table_schema = 'public'
     and table_name = 'notifications' and column_name in ('pushed_at', 'url'))                 as kolumner,
  (select count(*) from pg_trigger where tgname in ('trg_notify_crisis', 'trg_notify_priority_message',
     'trg_notify_critical_incident') and not tgisinternal)                                      as triggrar,
  (select count(*) from pg_proc where proname in ('claim_pushes', 'save_push_subscription')) as funktioner;
-- Ska vara 2, 3 och 2.
