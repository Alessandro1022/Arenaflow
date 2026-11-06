-- TournamentOps · Del 10 · Boenden, och en läcka i statistikvyerna
-- ============================================================================
-- KÖR DEN HÄR SÅ SNART DU KAN. Sektion 1 täpper till en riktig läcka:
-- innebandychefen kunde se ArenaFlows samtliga boenden.
--
-- Vyer i PostgreSQL körs som sin ÄGARE, inte som den som frågar, om inte
-- security_invoker är påslaget. school_stats och area_stats ägs av postgres,
-- så RLS på schools och areas gällde inte genom dem. Boenden-sidan läser
-- just school_stats, alltså visade den allas boenden för alla.
--
-- Verifierat: före fixen såg innebandychefen ArenaFlows boenden genom vyn men
-- inte genom tabellen. Efter fixen ser han noll genom båda.
--
-- Sektion 2 och framåt: hotell blir en boendetyp i stället för en egen
-- modul, så att nattrondering, incidenter, beläggning och kontaktvägar
-- gäller hotell direkt utan att något av det byggs om.
--
-- Kör efter schema_part9_modulregler.sql.
-- ============================================================================

-- ============ 1. LÄCKAN I VYERNA ============
do $$
begin
  if exists (select 1 from pg_views where schemaname='public' and viewname='school_stats') then
    execute 'alter view public.school_stats set (security_invoker = on)';
  end if;
  if exists (select 1 from pg_views where schemaname='public' and viewname='area_stats') then
    execute 'alter view public.area_stats set (security_invoker = on)';
  end if;
end $$;

-- ============ 2. KOORDINATER ============
-- Lades till av kartarbetet men saknas i repots skript, så vyerna nedan
-- kan annars inte skapas på en färsk databas.
alter table public.schools
  add column if not exists lat double precision,
  add column if not exists lng double precision;
alter table public.arenas
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- ============ 3. BOENDETYP ============
do $$
begin
  create type accommodation_kind as enum ('skola', 'hotell', 'vandrarhem', 'camping');
exception when duplicate_object then null;
end $$;

alter table public.schools
  add column if not exists kind accommodation_kind not null default 'skola',
  -- Kontaktvägar. Säkerhetsgruppen ronderar hotell och behöver nå någon.
  add column if not exists contact_name text not null default '',
  add column if not exists contact_phone text not null default '',
  add column if not exists contact_email text not null default '',
  -- Hotell räknas i rum, skolor i sovsalar. capacity är kvar som antal bäddar.
  add column if not exists rooms int,
  add column if not exists check_in_from text not null default '',
  add column if not exists check_out_by text not null default '',
  add column if not exists notes text not null default '';

create index if not exists idx_schools_kind on public.schools (tenant_id, kind);

-- ============ 4. VYERNA MED BOENDETYP ============
-- create or replace kan inte lägga till kolumner mitt i en vy, så båda
-- släpps och byggs om. area_stats bygger på school_stats och måste därför
-- skapas om i samma veva.
-- security_invoker sätts direkt vid skapandet, så en ny vy aldrig läcker.
drop view if exists public.area_stats;
drop view if exists public.school_stats;

create view public.school_stats
with (security_invoker = on) as
select
  s.id, s.name, s.address, s.capacity, s.area_id, s.lat, s.lng,
  s.kind, s.contact_name, s.contact_phone, s.rooms, s.tenant_id,
  coalesce(ti.in_house, 0)       as in_house,
  coalesce(ti.teams_in, 0)       as teams_in,
  coalesce(te.teams_expected, 0) as teams_expected,
  coalesce(ri.open_issues, 0)    as open_issues,
  coalesce(ic.open_incidents, 0) as open_incidents
from public.schools s
left join (
  select school_id, sum(group_size) as in_house, count(*) as teams_in
  from public.team_assignments where status = 'checked_in' group by school_id
) ti on ti.school_id = s.id
left join (
  select school_id, count(*) as teams_expected
  from public.team_assignments where status = 'expected' group by school_id
) te on te.school_id = s.id
left join (
  select school_id, count(*) as open_issues
  from public.room_issues where status <> 'resolved' group by school_id
) ri on ri.school_id = s.id
left join (
  select location_id, count(*) as open_incidents
  from public.incidents
  where status <> 'resolved' and location_type = 'school' group by location_id
) ic on ic.location_id = s.id;

create view public.area_stats
with (security_invoker = on) as
select
  a.id, a.name, a.description,
  coalesce(sc.n_schools, 0)      as n_schools,
  coalesce(ar.n_arenas, 0)       as n_arenas,
  coalesce(sc.teams_in, 0)       as teams_in,
  coalesce(sc.in_house, 0)       as in_house,
  coalesce(sc.capacity, 0)       as capacity,
  coalesce(sc.open_issues, 0)    as open_issues,
  coalesce(sc.open_incidents, 0) + coalesce(ar.open_incidents, 0) as open_incidents
from public.areas a
left join (
  select area_id,
         count(*) as n_schools,
         sum(teams_in) as teams_in,
         sum(in_house) as in_house,
         sum(capacity) as capacity,
         sum(open_issues) as open_issues,
         sum(open_incidents) as open_incidents
  from public.school_stats group by area_id
) sc on sc.area_id = a.id
left join (
  select ar.area_id, count(*) as n_arenas,
         coalesce(sum(ic.open_incidents), 0) as open_incidents
  from public.arenas ar
  left join (
    select location_id, count(*) as open_incidents
    from public.incidents
    where status <> 'resolved' and location_type = 'arena' group by location_id
  ) ic on ic.location_id = ar.id
  group by ar.area_id
) ar on ar.area_id = a.id;

grant select on public.school_stats to authenticated;
grant select on public.area_stats   to authenticated;

-- ============ 5. ORDET BYTS FRÅN SKOLA TILL BOENDE ============
-- Modulen rymmer nu både skolor och hotell, så etiketten ska säga boende.
update public.tenants
   set labels = labels || '{"school":"Boende","schools":"Boenden"}'::jsonb;

-- ============ 6. KONTROLL ============
select
  (select count(*) from pg_views v
    join pg_class c on c.relname = v.viewname
   where v.schemaname = 'public' and v.viewname in ('school_stats','area_stats')
     and c.reloptions::text like '%security_invoker=on%')        as vyer_sakrade,
  (select count(*) from information_schema.columns
    where table_name = 'schools' and column_name = 'kind')        as boendetyp_finns;

select kind, count(*) as antal from public.schools group by kind order by kind;
