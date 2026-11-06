-- TournamentOps · Del 8 · Paket och pris
-- ============================================================================
-- Plattformsägaren säljer moduler. Ett paket är en namngiven uppsättning
-- moduler med ett pris; ArenaFlow kör det maxade.
--
-- Viktigt designval: paketets moduler KOPIERAS in i tenants.features när
-- paketet väljs. De läses inte live från plans. Annars skulle en ändring av
-- vad "Standard" innehåller tyst ta bort moduler hos kunder som redan betalat
-- för dem. Vill man uppdatera en befintlig kund görs det med flit.
--
-- Kör efter schema_part7_multitenant.sql.
-- ============================================================================

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,                       -- 'Bas', 'Standard', 'Komplett'
  description text not null default '',
  features jsonb not null default '{}',     -- vilka moduler som ingår
  price_per_year numeric(10,2),             -- kr per år, null = offert
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Paketregistret är inte turneringsdata: det tillhör plattformen.
-- Därför ingen tenant-isolering här, utan egna regler.
alter table public.plans enable row level security;

-- Alla inloggade får läsa paketen (turneringschefen ska kunna se vad hen har)
drop policy if exists "plans läs" on public.plans;
create policy "plans läs" on public.plans for select to authenticated using (true);

-- Bara plattformsägaren skapar och ändrar paket
drop policy if exists "plans ägare" on public.plans;
create policy "plans ägare" on public.plans for all to authenticated
  using (public.is_platform_owner()) with check (public.is_platform_owner());

-- ============ TURNERINGEN FÅR ETT PAKET OCH ETT PRIS ============
alter table public.tenants
  add column if not exists plan_id uuid references public.plans(id) on delete set null,
  add column if not exists plan_name text not null default '',   -- ögonblicksbild
  add column if not exists price_per_year numeric(10,2),         -- förhandlat pris
  add column if not exists plan_customized boolean not null default false,
  add column if not exists billing_note text not null default '';

-- ============ PAKETEN ============
-- Modulnycklarna måste matcha FEATURE_KEYS i lib/features.ts.
-- En modul som inte nämns räknas som PÅ, så avstängda moduler sätts
-- uttryckligen till false.
insert into public.plans (slug, name, description, price_per_year, sort_order, features)
values
('bas', 'Bas', 'Grundläggande drift: incidenter, uppgifter, pass och kommunikation.', 29000, 1,
 '{"incidents":true,"tasks":true,"shifts":true,"news":true,"chat":true,"docs":true,
   "areas":false,"schools":false,"arenas":false,"map":false,
   "reports":false,"ai":false,"crisis":false,"staff":false,"history":false,"structure":false}'),

('standard', 'Standard', 'Bas plus boende, spelplatser, karta och personalhantering.', 69000, 2,
 '{"incidents":true,"tasks":true,"shifts":true,"news":true,"chat":true,"docs":true,
   "areas":true,"schools":true,"arenas":true,"map":true,"staff":true,"reports":true,
   "ai":false,"crisis":false,"history":false,"structure":false}'),

('komplett', 'Komplett', 'Alla moduler, inklusive AI-rapporter, krisläge och historik. Paketet ArenaFlow kör.', 149000, 3,
 '{"incidents":true,"tasks":true,"shifts":true,"news":true,"chat":true,"docs":true,
   "areas":true,"schools":true,"arenas":true,"map":true,"staff":true,"reports":true,
   "ai":true,"crisis":true,"history":true,"structure":true}')
on conflict (slug) do nothing;

-- ============ SÄTT PAKET PÅ BEFINTLIGA TURNERINGAR ============
-- ArenaFlow kör det maxade. Övriga får Standard tills du ändrar.
do $$
declare komplett uuid; standard uuid;
begin
  select id into komplett from public.plans where slug = 'komplett';
  select id into standard from public.plans where slug = 'standard';

  update public.tenants t
     set plan_id = komplett,
         plan_name = 'Komplett',
         price_per_year = (select price_per_year from public.plans where id = komplett),
         features = (select features from public.plans where id = komplett)
   where t.slug = 'gothia-cup' and t.plan_id is null;

  update public.tenants t
     set plan_id = standard,
         plan_name = 'Standard',
         price_per_year = (select price_per_year from public.plans where id = standard),
         features = (select features from public.plans where id = standard)
   where t.plan_id is null;
end $$;

-- ============ KONTROLL ============
select t.name as turnering, t.plan_name, t.price_per_year,
       (select count(*) from jsonb_each(t.features) f where f.value::text = 'true') as moduler_pa
from public.tenants t
order by t.name;
