-- TournamentOps · Del 28 · Chattgrupper efter roll och plats, områdesansvariga
-- ============================================================================
-- Chatten får grupper som följer rollerna: alla med rätt roll är med, även de
-- som läggs till senare. Exempel:
--   - Säkerhet: säkerhetsansvariga och säkerhetspersonal
--   - Boende: områdesansvariga för boende och boendevärdar
--   - Skola 5 · boende och kök: boendevärdar och måltidspersonal med ansvar
--     för just Skola 5 (där maten serveras på plats)
--   - Info från ledningen: alla läser, bara ledningen skriver
--
-- Direktmeddelanden är som förut aldrig öppna för någon annan. Ledningen
-- (admin och uppåt) kan läsa alla grupper, men aldrig direktmeddelanden.
--
-- Dessutom: vyn area_managers, så att alla ser vem som är områdesansvarig.
--
-- Kör efter schema_part27_push.sql. Går att köra flera gånger.
-- ============================================================================

-- ============ 0. FÖRKONTROLL ============
do $$
begin
  if to_regclass('public.channels') is null or not exists (select 1 from pg_proc where proname = 'channel_reader_ids') then
    raise exception 'Del 21 och del 27 saknas. Kör dem först (se diagnos.sql).';
  end if;
end $$;

-- ============ 1. KANALERNA FÅR ROLLER OCH SKRIVRÄTT ============
-- roles: tom = som förut. Annars är det rollerna som avgör vilka som är med.
-- post_min_tier: lägsta nivå för att skriva. 4 = bara ledningen
-- (koordinator, säkerhetsansvarig och uppåt). Den som skapat kanalen får alltid.
alter table public.channels
  add column if not exists roles text[] not null default '{}',
  add column if not exists post_min_tier int not null default 1;

-- ============ 2. VEM FÅR LÄSA ============
-- En roll räknas bara när den är fullt aktiv: en säkerhetsansvarig som inte
-- angett tvåfaktorkoden får inte läsa säkerhetsgruppen (del 24).
create or replace function public.can_read_channel(ch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.channels c
    where c.id = ch
      and c.tenant_id = public.my_tenant()
      and (
        c.created_by = auth.uid()
        or exists (
          select 1 from public.channel_members m
          where m.channel_id = c.id and m.user_id = auth.uid()
        )
        or (c.kind <> 'direkt' and (
          -- Kanal för vissa roller (på en plats, om en plats är vald)
          (cardinality(c.roles) > 0 and (
             public.my_tier() >= 5
             or (public.auth_role()::text = any (c.roles)
                 and public.my_tier() = public.role_tier(public.auth_role())
                 and (c.location_id is null or public.has_scope(c.location_type, c.location_id)))))
          -- Som förut: öppen kanal från en viss nivå, eller platskanal
          or (cardinality(c.roles) = 0 and (
             (c.is_open and public.my_tier() >= c.min_tier)
             or (c.kind = 'plats' and c.location_id is not null
                 and public.has_scope(c.location_type, c.location_id))))
        ))
      )
  )
$$;

-- ============ 3. VEM FÅR SKRIVA ============
create or replace function public.can_post_channel(ch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_read_channel(ch) and exists (
    select 1 from public.channels c
    where c.id = ch and (c.created_by = auth.uid() or public.my_tier() >= c.post_min_tier)
  )
$$;

drop policy if exists "chatt skriv" on public.messages;
create policy "chatt skriv" on public.messages for insert to authenticated
  with check (sender = auth.uid()
              and (channel_id is null or public.can_post_channel(channel_id)));

-- ============ 4. VILKA FÅR PUSHNOTIS (samma regler, för vem som helst) ============
create or replace function public.person_has_scope(uid uuid, t location_type, lid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = uid and public.role_tier(p.role) >= 5)
    or exists (select 1 from public.staff_scope s
               where s.user_id = uid and s.location_type = t and s.location_id = lid)
    or exists (
      select 1 from public.staff_scope s
      where s.user_id = uid and s.area_id is not null and s.area_id in (
        select area_id from public.schools where t = 'school' and id = lid
        union all
        select area_id from public.arenas  where t = 'arena'  and id = lid
      )
    )
$$;

create or replace function public.channel_reader_ids(ch uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select p.id
  from public.channels c
  join public.profiles p on p.tenant_id = c.tenant_id
  where c.id = ch and (
    p.id = c.created_by
    or exists (select 1 from public.channel_members m where m.channel_id = c.id and m.user_id = p.id)
    or (c.kind <> 'direkt' and (
      (cardinality(c.roles) > 0 and (
         public.role_tier(p.role) >= 5
         or (p.role::text = any (c.roles)
             and (c.location_id is null or public.person_has_scope(p.id, c.location_type, c.location_id)))))
      or (cardinality(c.roles) = 0 and (
         (c.is_open and public.role_tier(p.role) >= c.min_tier)
         or (c.kind = 'plats' and c.location_id is not null
             and public.person_has_scope(p.id, c.location_type, c.location_id))))
    ))
  )
$$;

-- ============ 5. STANDARDGRUPPERNA MED EN KNAPP ============
-- Läggs bara upp om det inte redan finns en kanal med samma namn.
create or replace function public.create_standard_channels() returns int
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.my_tenant();
  n int := 0;
  g record;
begin
  if auth.uid() is null or public.my_tier() < 4 then
    raise exception 'Bara ledningen kan lägga upp standardgrupperna';
  end if;
  for g in
    select * from (values
      ('Info från ledningen', true,  4, '{}'::text[]),
      ('Ledning',             false, 1, '{leadership,admin,coordinator}'::text[]),
      ('Säkerhet',            false, 1, '{security_lead,security_staff}'::text[]),
      ('Boende',              false, 1, '{area_housing,school_staff}'::text[]),
      ('Kök och måltider',    false, 1, '{food_staff}'::text[]),
      ('Planer',              false, 1, '{area_arenas,arena_staff}'::text[]),
      ('Sjukvård',            false, 1, '{medic}'::text[]),
      ('Transport och lager', false, 1, '{transport_staff,stock_staff}'::text[])
    ) as v(name, is_open, post_min_tier, roles)
  loop
    if not exists (
      select 1 from public.channels c
      where c.tenant_id = t and c.kind <> 'direkt' and lower(c.name) = lower(g.name)
    ) then
      insert into public.channels (tenant_id, kind, name, is_open, min_tier, post_min_tier, roles, created_by)
      values (t, 'grupp', g.name, g.is_open, 1, g.post_min_tier, g.roles, auth.uid());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ============ 6. OMRÅDESANSVARIGA ============
-- Vem som ansvarar för vilket område, med telefon, för alla i turneringen.
-- staff_scope får bara admin läsa i sin helhet. Funktionen lämnar bara ut
-- områdesansvariga i den egna turneringen, och vyn har security_invoker
-- som alla andra vyer (del 10), så att den aldrig kringgår RLS av misstag.
create or replace function public.area_manager_rows()
returns table (area_id uuid, user_id uuid, full_name text, phone text, role text)
language sql stable security definer set search_path = public as $$
  select s.area_id, p.id, p.full_name, coalesce(p.phone, ''), p.role::text
  from public.staff_scope s
  join public.profiles p on p.id = s.user_id
  where s.area_id is not null
    and p.role in ('area_housing', 'area_arenas')
    and p.tenant_id = public.my_tenant()
    and s.tenant_id = public.my_tenant()
$$;

drop view if exists public.area_managers;
create view public.area_managers with (security_invoker = on) as
  select * from public.area_manager_rows();

-- ============ 7. BEHÖRIGHET ============
revoke execute on function public.person_has_scope(uuid, location_type, uuid) from public, anon, authenticated;
revoke execute on function public.channel_reader_ids(uuid) from public, anon, authenticated;
grant execute on function public.channel_reader_ids(uuid) to service_role;
grant execute on function public.can_post_channel(uuid) to authenticated;
revoke execute on function public.create_standard_channels() from public, anon;
grant execute on function public.create_standard_channels() to authenticated;
revoke execute on function public.area_manager_rows() from public, anon;
grant execute on function public.area_manager_rows() to authenticated;
revoke all on public.area_managers from anon;
grant select on public.area_managers to authenticated;

-- ============ 8. KONTROLL ============
select
  (select count(*) from information_schema.columns where table_schema = 'public'
     and table_name = 'channels' and column_name in ('roles', 'post_min_tier'))              as kolumner,
  (select count(*) from pg_proc where proname in ('can_post_channel', 'create_standard_channels',
     'person_has_scope', 'area_manager_rows'))                                               as funktioner,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'area_managers'
       and c.reloptions::text like '%security_invoker=on%')                                  as vyer_sakrade;
-- Ska vara 2, 4 och 1.
