-- TournamentOps · Del 6 · White-label i databasen
-- Turneringar skapas, färgsätts och aktiveras från appen i stället för miljövariabler.
-- Kör i SQL Editor efter schema_part4.sql.

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,                     -- 'ArenaFlow'
  short_name text not null default '',    -- 'ArenaFlow'
  sport text not null default 'fotboll',
  city text not null default '',
  logo_text text not null default '',     -- bokstäverna i brickan, t.ex. 'GC'
  logo_url text,                          -- valfri bild i stället för text
  colors jsonb not null default '{}',     -- primary, primaryDark, panel2, accent, bg
  labels jsonb not null default '{}',     -- playingArea, playingAreas, matchStart m.fl.
  features jsonb not null default '{}',   -- vilka moduler som är på
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bara en turnering kan vara aktiv åt gången
create or replace function public.single_active_tenant() returns trigger
language plpgsql as $$
begin
  if new.active then
    update public.tenants set active = false where id <> new.id and active;
  end if;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_single_active on public.tenants;
create trigger trg_single_active before insert or update on public.tenants
  for each row execute function public.single_active_tenant();

alter table public.tenants enable row level security;

-- Alla inloggade läser aktiv konfiguration; endast ledning (tier 6) ändrar
drop policy if exists "tenants läs" on public.tenants;
create policy "tenants läs" on public.tenants for select to authenticated using (true);

drop policy if exists "tenants skriv" on public.tenants;
create policy "tenants skriv" on public.tenants for all to authenticated
  using (public.my_tier() >= 6) with check (public.my_tier() >= 6);

-- Realtime: färgbyten slår igenom direkt hos alla inloggade
do $$
begin
  alter publication supabase_realtime add table public.tenants;
exception when duplicate_object then null;
end $$;

-- ============ STARTVÄRDEN ============
insert into public.tenants (slug, name, short_name, sport, city, logo_text, colors, labels, features, active)
values
('gothia-cup', 'ArenaFlow', 'ArenaFlow', 'fotboll', 'Göteborg', 'GC',
 '{"primary":"#1D6FA8","primaryDark":"#155A8C","panel2":"#25618F","accent":"#FFC845","bg":"#F2F5F9"}',
 '{"playingArea":"Plan","playingAreas":"Planer","matchStart":"Avspark","school":"Skola","schools":"Skolor","area":"Område","areas":"Områden"}',
 '{"incidents":true,"tasks":true,"shifts":true,"areas":true,"schools":true,"arenas":true,"map":true,"news":true,"chat":true,"docs":true,"reports":true,"ai":true,"crisis":true,"staff":true,"history":true,"structure":true}',
 true),

('gothia-innebandy', 'Demo Innebandy', 'Demo IBK', 'innebandy', 'Göteborg', 'GI',
 '{"primary":"#1D6FA8","primaryDark":"#155A8C","panel2":"#1B4F73","accent":"#FFC845","bg":"#F2F5F9"}',
 '{"playingArea":"Hall","playingAreas":"Hallar","matchStart":"Nedkast","school":"Skola","schools":"Skolor","area":"Område","areas":"Områden"}',
 '{"incidents":true,"tasks":true,"shifts":true,"areas":true,"schools":true,"arenas":true,"map":true,"news":true,"chat":true,"docs":true,"reports":true,"ai":true,"crisis":true,"staff":true,"history":true,"structure":true}',
 false),

('partille-cup', 'Partille Cup', 'Partille', 'handboll', 'Partille', 'PC',
 '{"primary":"#1E9E5A","primaryDark":"#177C46","panel2":"#1E6B45","accent":"#FFD24C","bg":"#F3F7F4"}',
 '{"playingArea":"Hall","playingAreas":"Hallar","matchStart":"Nedkast","school":"Skola","schools":"Skolor","area":"Område","areas":"Områden"}',
 '{"incidents":true,"tasks":true,"shifts":true,"areas":true,"schools":true,"arenas":true,"map":true,"news":true,"chat":true,"docs":true,"reports":true,"ai":true,"crisis":true,"staff":true,"history":true,"structure":true}',
 false)
on conflict (slug) do nothing;

select slug, name, sport, active from public.tenants order by name;
