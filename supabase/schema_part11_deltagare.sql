-- TournamentOps · Del 11 · Spelare, ledare och deltagarkort
-- ============================================================================
-- Systemet känner idag lag, inte personer. group_size är en siffra, inte en
-- lista. Det räcker inte för fyra saker som redan står på checklistan:
-- måltidsrättigheter per person, kontroll av åldersklass, föräldrainformation
-- för minderåriga, och att kunna nå en enskild deltagare.
--
-- OM PERSONUPPGIFTER: deltagarna är till stor del minderåriga. Den här filen
-- lägger bara till det som behövs för driften — namn, roll, födelseår för
-- åldersklass, tröjnummer. Ingen hälsodata, inga anhöriguppgifter. Allergier
-- och specialkost hör till måltidsmodulen och ska byggas tillsammans med
-- lagringstider och radering, inte före.
--
-- Kör efter schema_part10_boenden.sql.
-- ============================================================================

-- ============ 1. ANKOMST, AVRESA OCH ÅLDERSKLASS ============
alter table public.team_assignments
  add column if not exists arrival_date date,
  add column if not exists departure_date date,
  add column if not exists age_class text not null default '',   -- 'P15', 'F16'
  add column if not exists club_name text not null default '';   -- flera lag per förening

create index if not exists idx_team_assignments_club
  on public.team_assignments (tenant_id, club_name);

-- ============ 2. DELTAGARE ============
do $$
begin
  create type participant_role as enum ('spelare', 'ledare');
exception when duplicate_object then null;
end $$;

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  team_assignment_id uuid not null references public.team_assignments(id) on delete cascade,
  tenant_id uuid not null default public.my_tenant() references public.tenants(id) on delete cascade,
  full_name text not null,
  role participant_role not null default 'spelare',
  birth_year int,                       -- bara år, inte datum: räcker för åldersklass
  jersey_number int,
  card_code text not null unique default encode(gen_random_bytes(6), 'hex'),
  checked_in_at timestamptz,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_participants_team on public.participants (team_assignment_id);
create index if not exists idx_participants_tenant on public.participants (tenant_id);

alter table public.participants enable row level security;

-- Samma mönster som övriga tabeller: scope styr vem som får se laget,
-- och den restriktiva policyn håller turneringarna isär.
drop policy if exists "deltagare scope" on public.participants;
create policy "deltagare scope" on public.participants for all to authenticated
  using (
    exists (
      select 1 from public.team_assignments ta
      where ta.id = participants.team_assignment_id
        and public.has_scope('school'::location_type, ta.school_id)
    )
  )
  with check (
    exists (
      select 1 from public.team_assignments ta
      where ta.id = participants.team_assignment_id
        and public.has_scope('school'::location_type, ta.school_id)
    )
  );

drop policy if exists "tenant isolering" on public.participants;
create policy "tenant isolering" on public.participants
  as restrictive for all to authenticated
  using (tenant_id = public.my_tenant())
  with check (tenant_id = public.my_tenant());

-- ============ 3. ÅLDERSKLASSKONTROLL ============
-- ArenaFlows klasser skrivs P15, F16, P17 och så vidare: bokstaven är kön,
-- talet är den högsta åldern i klassen. En spelare i P15 under 2026 får
-- alltså vara född 2011 eller senare.
--
-- Returnerar null när klassen är tom eller inte går att tolka, så att en
-- oifylld klass aldrig flaggar någon felaktigt.
create or replace function public.age_class_max_age(cls text) returns int
language sql immutable as $$
  select nullif(regexp_replace(coalesce(cls, ''), '\D', '', 'g'), '')::int
$$;

create or replace function public.participant_too_old(
  cls text, birth_year int, season_year int default null
) returns boolean
language sql stable as $$
  select case
    when birth_year is null then false
    when public.age_class_max_age(cls) is null then false
    else birth_year < coalesce(season_year, extract(year from now())::int)
                      - public.age_class_max_age(cls)
  end
$$;

-- ============ 4. LAGÖVERSIKT ============
-- Vad som faktiskt är registrerat mot vad laget anmält, plus flaggade
-- deltagare. security_invoker så att RLS gäller genom vyn — samma fälla
-- som statistikvyerna gick i.
create or replace view public.team_roster_stats
with (security_invoker = on) as
select
  ta.id as team_assignment_id,
  ta.tenant_id,
  ta.school_id,
  ta.team_name,
  ta.club_name,
  ta.country,
  ta.age_class,
  ta.group_size,
  ta.arrival_date,
  ta.departure_date,
  ta.status,
  count(p.id)                                             as registered,
  count(p.id) filter (where p.role = 'spelare')           as players,
  count(p.id) filter (where p.role = 'ledare')            as leaders,
  count(p.id) filter (where p.checked_in_at is not null)  as checked_in,
  -- Bara spelare. En ledare är vuxen per definition och ska aldrig
  -- flaggas mot lagets åldersklass.
  -- Säsongsåret tas från ankomstdatumet när det finns: registrerar man ett
  -- lag till nästa sommar ska klassen räknas mot den turneringen, inte
  -- mot året man råkar sitta och mata in.
  count(p.id) filter (
    where p.role = 'spelare'
      and public.participant_too_old(
            ta.age_class, p.birth_year,
            coalesce(extract(year from ta.arrival_date)::int,
                     extract(year from now())::int))
  )                                                       as age_flagged
from public.team_assignments ta
left join public.participants p on p.team_assignment_id = ta.id
group by ta.id;

grant select on public.team_roster_stats to authenticated;

-- ============ 5. DELTAGARKORT ============
-- Slås upp på kortets kod. SECURITY DEFINER så att en planvärd kan läsa
-- kortet utan att ha scope på boendet, men funktionen lämnar bara ut det
-- som behövs vid en kontroll — aldrig födelseår eller noteringar.
create or replace function public.participant_by_card(code text)
returns table (
  full_name text,
  role participant_role,
  team_name text,
  club_name text,
  age_class text,
  country text,
  school_name text,
  tenant_name text,
  checked_in boolean
)
language sql stable security definer set search_path = public as $$
  select p.full_name, p.role, ta.team_name, ta.club_name, ta.age_class,
         ta.country, s.name, t.name, p.checked_in_at is not null
  from public.participants p
  join public.team_assignments ta on ta.id = p.team_assignment_id
  join public.schools s on s.id = ta.school_id
  join public.tenants t on t.id = p.tenant_id
  where p.card_code = code
$$;

-- Funktioner är körbara av alla som standard. Kortet lämnar ut vilket
-- boende en i regel minderårig deltagare sover på, så det ska kräva
-- inloggning. Koden i sig är oknäckbar, men det räcker inte som skydd.
revoke execute on function public.participant_by_card(text) from public, anon;
grant execute on function public.participant_by_card(text) to authenticated;

-- ============ 6. KONTROLL ============
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'participants')      as deltagartabell,
  (select count(*) from information_schema.columns
    where table_name = 'team_assignments'
      and column_name in ('arrival_date','departure_date','age_class'))  as nya_lagfalt,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'participants')          as policies;

-- Snabbtest av åldersklassen: P15 under 2026 tillåter födda 2011 och senare
select
  public.participant_too_old('P15', 2011, 2026) as f2011_ska_vara_false,
  public.participant_too_old('P15', 2010, 2026) as f2010_ska_vara_true,
  public.participant_too_old('', 2005, 2026)    as tom_klass_ska_vara_false,
  public.participant_too_old('P15', null, 2026) as okant_ar_ska_vara_false;
