-- TournamentOps · Del 7 · Riktig multi-tenancy
-- ============================================================================
-- Före denna fil delar alla turneringar samma data: aktiverar man innebandy
-- ser man ArenaFlows skolor, incidenter och personal. Efter den är varje
-- turnering helt isolerad och flera kan pågå samtidigt.
--
-- Metod: varje tabell får tenant_id, och varje tabell får en RESTRIKTIV
-- policy. PostgreSQL ANDar restriktiva policies med de befintliga, så de 68
-- policies som redan finns lämnas orörda och kan inte råka glömmas bort.
--
-- Kör efter schema_part6_tenants.sql.
-- ============================================================================

-- ============ 1. FLERA TURNERINGAR SAMTIDIGT ============
-- Triggern tvingade fram exakt en aktiv turnering. Fel antagande:
-- ArenaFlow och ArenaFlow Innebandy pågår parallellt, inte i tur och ordning.
drop trigger if exists trg_single_active on public.tenants;

-- updated_at ska fortfarande underhållas
create or replace function public.touch_tenant() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_touch_tenant on public.tenants;
create trigger trg_touch_tenant before update on public.tenants
  for each row execute function public.touch_tenant();

-- ============ 2. ANVÄNDARE TILLHÖR EN TURNERING ============
alter table public.profiles
  add column if not exists tenant_id uuid references public.tenants(id) on delete restrict,
  add column if not exists platform_owner boolean not null default false;

-- Befintliga användare hör till ArenaFlow
update public.profiles
   set tenant_id = (select id from public.tenants where slug = 'gothia-cup')
 where tenant_id is null;

-- ============ 3. GRUNDFUNKTIONER ============
-- SECURITY DEFINER: kringgår RLS, annars skulle my_tenant() läsa profiles
-- som i sin tur filtreras av my_tenant() – ett cirkelberoende.
create or replace function public.my_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_platform_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select platform_owner from public.profiles where id = auth.uid()), false)
$$;

-- ============ 4. SÄKERHETSLUCKA: BYTA TURNERING ============
-- Utan detta kan vem som helst uppdatera sin egen tenant_id och hoppa in i
-- en annan turnering. Bara plattformsägaren får byta.
create or replace function public.protect_tenant_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tenant_id is distinct from old.tenant_id and not public.is_platform_owner() then
    raise exception 'Endast plattformsägaren kan byta turnering';
  end if;
  if new.platform_owner is distinct from old.platform_owner and not public.is_platform_owner() then
    raise exception 'Endast plattformsägaren kan dela ut ägarrollen';
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_tenant on public.profiles;
create trigger trg_protect_tenant before update on public.profiles
  for each row execute function public.protect_tenant_change();

-- ============ 5. TENANT_ID PÅ ALLA TABELLER ============
-- Loop i stället för 30 handskrivna block: ingen tabell kan glömmas bort.
--
-- Triggrarna stängs av per tabell under backfillen. Annars utlöser UPDATE:n
-- audit-triggern, som skriver en rad i audit_log med tenant_id = my_tenant().
-- I SQL Editor finns ingen inloggad användare, så det blir null – och
-- audit_log har redan hunnit få NOT NULL tidigare i samma loop.
do $$
declare
  t text;
  gothia uuid;
  tables text[] := array[
    'ai_reports','areas','arena_matches','arenas','audit_log','car_routes',
    'checklist_items','checklist_runs','checklist_templates','classrooms',
    'crowd_counts','documents','incident_comments','incidents','invites',
    'materials','messages','news_posts','night_rounds','notifications',
    'room_issues','room_keys','schools','security_cars','security_logs',
    'shift_swaps','shifts','staff_scope','tasks','team_assignments'
  ];
begin
  select id into gothia from public.tenants where slug = 'gothia-cup';
  if gothia is null then
    raise exception 'Hittar ingen turnering med slug gothia-cup. Kör schema_part6_tenants.sql först.';
  end if;

  foreach t in array tables loop
    -- Kolumnen
    execute format(
      'alter table public.%I add column if not exists tenant_id uuid references public.tenants(id) on delete cascade', t);

    -- All befintlig data tillhör ArenaFlow. Triggrar av under tiden.
    execute format('alter table public.%I disable trigger user', t);
    execute format('update public.%I set tenant_id = %L where tenant_id is null', t, gothia);
    execute format('alter table public.%I enable trigger user', t);

    -- Nya rader ärver den inloggades turnering automatiskt
    execute format('alter table public.%I alter column tenant_id set default public.my_tenant()', t);

    -- Krav på värde: en rad utan tenant_id vore osynlig för alla
    execute format('alter table public.%I alter column tenant_id set not null', t);

    -- Snabbare uppslag, eftersom varje fråga nu filtrerar på tenant_id
    execute format('create index if not exists %I on public.%I (tenant_id)', 'idx_' || t || '_tenant', t);

    -- ISOLERINGEN. Restriktiv = ANDas med alla befintliga policies.
    execute format('drop policy if exists "tenant isolering" on public.%I', t);
    execute format($p$
      create policy "tenant isolering" on public.%I
        as restrictive for all to authenticated
        using (tenant_id = public.my_tenant())
        with check (tenant_id = public.my_tenant())
    $p$, t);
  end loop;
end $$;

-- ============ 5a. AUDIT-LOGGEN FÅR RÄTT TURNERING ============
-- Tog tidigare tenant_id från kolumndefaulten, alltså den inloggade. Fel
-- när cron-jobbet skriver med service-nyckeln: då finns ingen inloggad.
-- Hämtas nu ur raden som ändrades.
create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare row_tenant uuid;
begin
  begin
    row_tenant := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end
                   ->> 'tenant_id')::uuid;
  exception when others then
    row_tenant := null;
  end;

  insert into public.audit_log (table_name, record_id, action, actor, changes, tenant_id)
  values (tg_table_name,
          coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, ''),
          tg_op, auth.uid(),
          case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end,
          coalesce(row_tenant, public.my_tenant()));
  return coalesce(new, old);
end $$;

-- ============ 5b. PERSONALLISTAN ============
-- profiles behöver isolering som alla andra tabeller, annars ser
-- innebandychefen ArenaFlows samtliga funktionärer under Personal.
-- Undantag för den egna raden: utan det låses en användare vars tenant_id
-- ännu inte hunnit sättas ute från hela appen, inklusive sin egen profil.
create index if not exists idx_profiles_tenant on public.profiles (tenant_id);

drop policy if exists "tenant isolering" on public.profiles;
create policy "tenant isolering" on public.profiles
  as restrictive for all to authenticated
  using (tenant_id = public.my_tenant() or id = auth.uid())
  with check (tenant_id = public.my_tenant() or id = auth.uid());

-- ============ 6. KRISLÄGE PER TURNERING ============
-- Var en singleton-rad (id = 1). ArenaFlow i krisläge fick inte utlösa
-- krisbanner hos innebandy.
alter table public.crisis_state
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

update public.crisis_state
   set tenant_id = (select id from public.tenants where slug = 'gothia-cup')
 where tenant_id is null;

-- Släpp singleton-konstruktionen och nyckla om på turnering.
-- id kan inte bara få NOT NULL borttaget – den är primärnyckel – så
-- kolumnen tas bort helt och tenant_id blir nyckeln i stället.
-- Att droppa id tar samtidigt bort check-villkoret (id = 1).
alter table public.crisis_state alter column tenant_id set not null;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'crisis_state'
               and column_name = 'id') then
    -- Behåll bara en rad per turnering innan nyckeln sätts
    delete from public.crisis_state a
      using public.crisis_state b
     where a.tenant_id = b.tenant_id and a.id > b.id;

    alter table public.crisis_state drop constraint if exists crisis_state_pkey;
    alter table public.crisis_state drop column id;
    alter table public.crisis_state add primary key (tenant_id);
  end if;
end $$;

alter table public.crisis_state alter column tenant_id set default public.my_tenant();

-- En krisrad per turnering
insert into public.crisis_state (tenant_id, active)
select t.id, false from public.tenants t
where not exists (select 1 from public.crisis_state c where c.tenant_id = t.id);

drop policy if exists "tenant isolering" on public.crisis_state;
create policy "tenant isolering" on public.crisis_state
  as restrictive for all to authenticated
  using (tenant_id = public.my_tenant())
  with check (tenant_id = public.my_tenant());

-- ============ 7. EVENT_SETTINGS AVVECKLAS ============
-- Namn och primärfärg fanns både här och i tenants. Två sanningskällor för
-- samma sak gjorde temalogiken svårläst. tenants är nu enda källan.
do $$
declare gothia uuid;
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'event_settings') then
    select id into gothia from public.tenants where slug = 'gothia-cup';
    -- Rädda eventuella överstyrningar in i tenants innan tabellen försvinner
    update public.tenants t set
      name = coalesce(nullif(e.event_name, ''), t.name),
      colors = case
        when e.primary_color ~ '^#[0-9a-fA-F]{6}$'
        then t.colors || jsonb_build_object('primary', e.primary_color, 'primaryDark', e.primary_color)
        else t.colors end
    from public.event_settings e
    where t.id = gothia and e.id = 1;

    drop table public.event_settings cascade;
  end if;
end $$;

-- ============ 8. AI-RAPPORTER PER TURNERING ============
-- unique (kind, slot, report_date) hade låst dagens rapport till EN turnering.
alter table public.ai_reports drop constraint if exists ai_reports_kind_slot_report_date_key;
do $$
begin
  alter table public.ai_reports
    add constraint ai_reports_tenant_kind_slot_date_key unique (tenant_id, kind, slot, report_date);
exception when duplicate_table or duplicate_object then null;
end $$;

-- ============ 9. INBJUDNINGAR LANDAR I RÄTT TURNERING ============
-- apply_invite satte roll och scope men inte turnering. En inbjuden av
-- innebandychefen hade hamnat i ArenaFlow.
create or replace function public.apply_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from public.invites
    where lower(email) = lower(new.email) and accepted_at is null
    order by created_at desc limit 1;

  if inv.id is not null then
    update public.profiles
       set role = inv.role,
           tenant_id = coalesce(inv.tenant_id, tenant_id)
     where id = new.id;

    if inv.area_id is not null then
      insert into public.staff_scope (user_id, area_id, tenant_id)
      values (new.id, inv.area_id, inv.tenant_id);
    elsif inv.location_type is not null and inv.location_id is not null then
      insert into public.staff_scope (user_id, location_type, location_id, tenant_id)
      values (new.id, inv.location_type, inv.location_id, inv.tenant_id);
    end if;

    update public.invites set accepted_at = now() where id = inv.id;
  end if;
  return new;
end $$;

-- ============ 10. TURNERINGSREGISTRET ============
-- tenants får INGEN tenant-isolering: det är registret över alla turneringar.
-- Ägaren ser och skapar allt. En turneringschef ser och ändrar bara sin egen.
drop policy if exists "tenants läs" on public.tenants;
create policy "tenants läs" on public.tenants for select to authenticated
  using (public.is_platform_owner() or id = public.my_tenant());

drop policy if exists "tenants skriv" on public.tenants;

drop policy if exists "tenants ägare" on public.tenants;
create policy "tenants ägare" on public.tenants for all to authenticated
  using (public.is_platform_owner()) with check (public.is_platform_owner());

-- Turneringschef får ändra sin egen profilering, men inte skapa eller radera
drop policy if exists "tenants egen uppdatering" on public.tenants;
create policy "tenants egen uppdatering" on public.tenants for update to authenticated
  using (id = public.my_tenant() and public.my_tier() >= 6)
  with check (id = public.my_tenant() and public.my_tier() >= 6);

-- Appen behöver den inloggades egen turnering i ETT anrop. För ägaren
-- returnerar tenants alla rader, så "första träffen" vore fel svar.
create or replace function public.my_tenant_row() returns setof public.tenants
language sql stable security definer set search_path = public as $$
  select t.* from public.tenants t where t.id = public.my_tenant()
$$;

-- ============ 11. KONTROLL ============
select
  (select count(*) from public.tenants) as turneringar,
  (select count(*) from public.profiles where tenant_id is null) as profiler_utan_turnering,
  (select count(*) from pg_policies
    where schemaname = 'public' and policyname = 'tenant isolering') as isoleringspolicies;
