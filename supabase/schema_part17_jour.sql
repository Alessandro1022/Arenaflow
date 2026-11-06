-- TournamentOps · Del 17 · Jour, nödinformation och läsbekräftelse
-- ============================================================================
-- Etapp 4, första klustret. De tre punkter du markerade "viktigt" hänger
-- ihop: de handlar alla om ögonblicket då något går fel.
--
--   Kontaktväg till jouransvarig   — vem ringer jag just nu?
--   Krisplaner och nödnummer       — vad gör jag, och vilket nummer?
--   Läsbekräftelse                 — har alla faktiskt läst instruktionen?
--
-- Tilldela säkerhetspersonal per område hör till samma stund och ligger
-- därför också här.
--
-- Kör efter schema_part16_ekonomi.sql.
-- ============================================================================

-- ============ 1. JOUR ============
-- Jouren är ett SCHEMA, inte ett telefonnummer i ett dokument. Numret till
-- "säkerhetsansvarig" ska svara den som har passet just nu, inte den som
-- råkade skriva dokumentet i våras.
do $$
begin
  create type on_call_function as enum
    ('ledning', 'sakerhet', 'boende', 'planer', 'transport', 'maltider', 'sjukvard');
exception when duplicate_object then null;
end $$;

create table if not exists public.on_call_shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants(id) on delete cascade,
  function on_call_function not null,
  user_id uuid references public.profiles(id) on delete set null,
  -- Namn och nummer skrivs av, så att jouren fungerar även för någon som
  -- inte har konto i systemet — en inhyrd vakt, en vaktmästare.
  contact_name text not null default '',
  phone text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists idx_oncall_window
  on public.on_call_shifts (tenant_id, function, starts_at, ends_at);

-- Vem som har jouren just nu, per funktion. Vid överlappande pass vinner
-- det som börjat senast — det är det som gäller vid en överlämning.
create or replace view public.on_call_now
with (security_invoker = on) as
select distinct on (o.tenant_id, o.function)
  o.tenant_id, o.function, o.id as shift_id,
  coalesce(nullif(o.contact_name, ''), p.full_name) as contact_name,
  coalesce(nullif(o.phone, ''), p.phone)            as phone,
  o.starts_at, o.ends_at, o.note
from public.on_call_shifts o
left join public.profiles p on p.id = o.user_id
where now() between o.starts_at and o.ends_at
order by o.tenant_id, o.function, o.starts_at desc;

grant select on public.on_call_now to authenticated;

-- ============ 2. NÖDNUMMER OCH UTRYMNING ============
create table if not exists public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants(id) on delete cascade,
  label text not null,                       -- 'SOS Alarm', 'Vakthavande befäl'
  phone text not null,
  kind text not null default 'ovrigt',       -- nod, vard, polis, intern, ovrigt
  note text not null default '',
  sort_order int not null default 0
);

-- Utrymning och närmaste vård hör till PLATSEN, inte till ett dokument.
-- Står det i en PDF hittar ingen det klockan två på natten.
alter table public.schools
  add column if not exists assembly_point text not null default '',
  add column if not exists nearest_care text not null default '',
  add column if not exists emergency_note text not null default '';

alter table public.arenas
  add column if not exists assembly_point text not null default '',
  add column if not exists nearest_care text not null default '',
  add column if not exists emergency_note text not null default '';

-- ============ 3. SÄKERHETSBEMANNING PER OMRÅDE ============
-- Räknas fram ur roller, scope och pass. Ingen separat tilldelning att
-- hålla uppdaterad: den som har säkerhetsroll, är knuten till området och
-- står på pass just nu ÄR områdets säkerhetspersonal.
create or replace view public.security_coverage
with (security_invoker = on) as
select
  a.tenant_id,
  a.id   as area_id,
  a.name as area_name,
  count(distinct p.id) filter (
    where s.id is not null and s.starts_at <= now() and s.ends_at >= now()
  ) as on_duty_now,
  count(distinct p.id) as assigned_total,
  coalesce(
    string_agg(distinct p.full_name, ', ') filter (
      where s.id is not null and s.starts_at <= now() and s.ends_at >= now()
    ), ''
  ) as on_duty_names
from public.areas a
left join public.staff_scope sc on sc.area_id = a.id
left join public.profiles p
       on p.id = sc.user_id
      and p.role in ('security_lead', 'security_staff')
left join public.shifts s on s.user_id = p.id
group by a.tenant_id, a.id, a.name;

grant select on public.security_coverage to authenticated;

-- ============ 4. LÄSBEKRÄFTELSE ============
alter table public.news_posts
  add column if not exists requires_ack boolean not null default false,
  add column if not exists tenant_id uuid default public.my_tenant()
    references public.tenants(id) on delete cascade;

create table if not exists public.news_acks (
  post_id uuid not null references public.news_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  tenant_id uuid not null default public.my_tenant() references public.tenants(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.news_acks enable row level security;

-- Alla får kvittera åt sig själva, och ledningen får se vem som gjort det.
drop policy if exists "kvittens egen" on public.news_acks;
create policy "kvittens egen" on public.news_acks for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "kvittens läs" on public.news_acks;
create policy "kvittens läs" on public.news_acks for select to authenticated
  using (user_id = auth.uid() or public.my_tier() >= 4);

drop policy if exists "tenant isolering" on public.news_acks;
create policy "tenant isolering" on public.news_acks
  as restrictive for all to authenticated
  using (tenant_id = public.my_tenant()) with check (tenant_id = public.my_tenant());

-- Hur många som kvitterat, och hur många som borde. Nämnaren är alla med
-- tillräcklig behörighet för inlägget — annars räknas volontärer in i
-- krav som bara gäller ledningen.
create or replace view public.news_ack_status
with (security_invoker = on) as
select
  n.id as post_id,
  n.tenant_id,
  n.title,
  n.requires_ack,
  n.created_at,
  (select count(*) from public.news_acks a where a.post_id = n.id) as acked,
  (select count(*) from public.profiles p
    where p.tenant_id = n.tenant_id
      and public.role_tier(p.role) >= n.min_tier)                   as should_ack
from public.news_posts n
where n.requires_ack;

grant select on public.news_ack_status to authenticated;

-- ============ 5. BEHÖRIGHET ============
alter table public.on_call_shifts enable row level security;
alter table public.emergency_contacts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['on_call_shifts', 'emergency_contacts'] loop
    -- Jour och nödnummer ska ALLA kunna läsa. Att gömma numret till
    -- jouren bakom en behörighet vore att missa hela poängen.
    execute format('drop policy if exists "jour läs" on public.%I', t);
    execute format(
      'create policy "jour läs" on public.%I for select to authenticated using (true)', t);

    execute format('drop policy if exists "jour skriv" on public.%I', t);
    execute format(
      'create policy "jour skriv" on public.%I for all to authenticated
         using (public.my_tier() >= 4) with check (public.my_tier() >= 4)', t);

    execute format('drop policy if exists "tenant isolering" on public.%I', t);
    execute format(
      'create policy "tenant isolering" on public.%I
         as restrictive for all to authenticated
         using (tenant_id = public.my_tenant())
         with check (tenant_id = public.my_tenant())', t);
  end loop;
end $$;

-- Befintliga nyhetsinlägg tillhör ArenaFlow
update public.news_posts
   set tenant_id = (select id from public.tenants where slug = 'gothia-cup')
 where tenant_id is null;

do $$
begin
  alter publication supabase_realtime add table public.on_call_shifts;
exception when duplicate_object then null;
end $$;

-- ============ 6. STARTVÄRDEN ============
insert into public.emergency_contacts (label, phone, kind, sort_order, tenant_id)
select v.label, v.phone, v.kind, v.sort, t.id
from public.tenants t,
(values
  ('SOS Alarm', '112', 'nod', 1),
  ('Sjukvårdsrådgivning', '1177', 'vard', 2),
  ('Polis, ej akut', '114 14', 'polis', 3)
) as v(label, phone, kind, sort)
where not exists (
  select 1 from public.emergency_contacts e
  where e.tenant_id = t.id and e.phone = v.phone
);

-- ============ 7. KONTROLL ============
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='on_call_shifts')    as jourtabell,
  (select count(*) from pg_views where schemaname='public'
    and viewname in ('on_call_now','security_coverage','news_ack_status')) as vyer,
  (select count(*) from public.emergency_contacts)                   as nodnummer,
  (select count(*) from information_schema.columns
    where table_name='schools' and column_name='assembly_point')     as utrymning;
