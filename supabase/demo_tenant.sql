-- TournamentOps · Demodata per turnering
-- ============================================================================
-- Kör EFTER schema_part7_multitenant.sql.
--
-- Två saker den löser:
--  1. Namnen. Den gamla generatorn använde (array[8 förnamn])[i % 8] och
--     (array[6 efternamn])[i % 6]. Minsta gemensamma nämnare är 24, så
--     2 500 funktionärer delade på 24 namn – därav tio stycken "Ali Holm".
--     Här används i stället en bijektion mod 80*80: varje nummer ger ett
--     unikt namnpar, utan upprepning upp till 6 400 personer.
--  2. Turneringen. All data får tenant_id, så innebandy får egen personal,
--     egna boenden och egna matcher i stället för att dela ArenaFlows.
--
-- STÄLL IN HÄR NERE vilken turnering och hur mycket data.
-- ============================================================================

do $$
declare
  -- ===================== INSTÄLLNINGAR =====================
  v_slug      text := 'gothia-innebandy';  -- vilken turnering
  n_areas     int  := 4;
  n_schools   int  := 12;
  n_arenas    int  := 8;
  n_staff     int  := 300;
  n_matches   int  := 400;
  -- =========================================================

  t_id uuid;
  fnames text[] := array[
    'Alva','Liam','Ebba','Noah','Maja','Hugo','Elsa','Oliver','Astrid','William',
    'Wilma','Lucas','Alice','Elias','Olivia','Adam','Lilly','Viktor','Saga','Theo',
    'Ida','Jonas','Linnea','Erik','Sofia','Karl','Hanna','Anton','Emma','Filip',
    'Amina','Omar','Leila','Yusuf','Sara','Ali','Noor','Hassan','Zara','Ahmed',
    'Marek','Zofia','Piotr','Anna','Tomas','Eva','Janne','Kaisa','Mikko','Satu',
    'Nikolaj','Freja','Mads','Signe','Lars','Kari','Bjørn','Ingrid','Ola','Silje',
    'Diego','Lucia','Marco','Giulia','Pedro','Ines','Joao','Rita','Luis','Carmen',
    'Kwame','Aisha','Tunde','Amara','Kofi','Zainab','Chidi','Nia','Musa','Fatou'
  ];
  lnames text[] := array[
    'Andersson','Johansson','Karlsson','Nilsson','Eriksson','Larsson','Olsson','Persson',
    'Svensson','Gustafsson','Pettersson','Jonsson','Jansson','Hansson','Bengtsson','Lindberg',
    'Jakobsson','Magnusson','Olofsson','Lindström','Lindqvist','Lindgren','Axelsson','Berg',
    'Bergström','Lundberg','Lundgren','Lundqvist','Mattsson','Berglund','Fredriksson','Sandberg',
    'Henriksson','Forsberg','Sjöberg','Wallin','Engström','Eklund','Danielsson','Håkansson',
    'Holm','Bergman','Björk','Wikström','Isaksson','Fransson','Alm','Nyström',
    'Hassan','Ahmed','Ali','Osman','Farah','Abdi','Yusuf','Mohamed',
    'Kowalski','Nowak','Wójcik','Novak','Horvat','Virtanen','Korhonen','Mäkinen',
    'Hansen','Nielsen','Jensen','Larsen','Olsen','Dahl','Haugen','Moen',
    'Silva','Santos','Costa','Rossi','Ferrari','Romero','Garcia','Lopez'
  ];
  nf int := 80;  -- antal förnamn
  nl int := 80;  -- antal efternamn
begin
  select id into t_id from public.tenants where slug = v_slug;
  if t_id is null then
    raise exception 'Hittar ingen turnering med slug %. Kör schema_part6_tenants.sql först.', v_slug;
  end if;

  -- ---------- Rensa gammal demodata för just denna turnering ----------
  -- Bara demokonton rensas (e-postmönstret), aldrig riktiga användare.
  -- auth.users kaskaderar till profiles.
  delete from auth.users where email like 'demo%.' || v_slug || '@exempel.se';

  delete from public.arena_matches where tenant_id = t_id;
  delete from public.team_assignments where tenant_id = t_id;
  delete from public.classrooms where tenant_id = t_id;
  delete from public.shifts where tenant_id = t_id;
  delete from public.arenas where tenant_id = t_id;
  delete from public.schools where tenant_id = t_id;
  delete from public.areas where tenant_id = t_id;

  -- ---------- Områden ----------
  insert into public.areas (name, description, tenant_id)
  select 'Område ' || n, 'Demoområde', t_id
  from generate_series(1, n_areas) n;

  -- ---------- Boenden ----------
  insert into public.schools (area_id, name, capacity, tenant_id)
  select a.id,
         'Skola ' || n,
         200 + (n * 37) % 400,
         t_id
  from generate_series(1, n_schools) n
  join lateral (
    select id from public.areas
    where tenant_id = t_id
    order by name
    offset ((n - 1) % n_areas) limit 1
  ) a on true;

  -- ---------- Spelplatser ----------
  insert into public.arenas (area_id, name, tenant_id)
  select a.id, 'Hall ' || n, t_id
  from generate_series(1, n_arenas) n
  join lateral (
    select id from public.areas
    where tenant_id = t_id
    order by name
    offset ((n - 1) % n_areas) limit 1
  ) a on true;

  -- ---------- Personal ----------
  -- profiles.id pekar på auth.users, så demopersonal måste skapas där först.
  -- Triggern on_auth_user_created lägger upp profilraden åt oss; därefter
  -- fyller vi i namn, roll och turnering.
  --
  -- Bijektionen: m = (n * 2654435761) mod 6400 är en permutation, eftersom
  -- multiplikatorn är udda och inte delbar med 5 (6400 = 2^8 * 5^2).
  -- Varje n ger därmed ett eget (förnamn, efternamn)-par.
  --
  -- Lösenordsfältet får en ogiltig sträng med flit: demokontona ska synas i
  -- personallistan men inte gå att logga in på.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  select
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated', 'authenticated',
    'demo' || n || '.' || v_slug || '@exempel.se',
    'DEMO-KONTO-UTAN-LOSENORD',
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object(
      'full_name',
      fnames[1 + (((n * 2654435761::bigint) % (nf * nl)) % nf)] || ' ' ||
      lnames[1 + ((((n * 2654435761::bigint) % (nf * nl)) / nf) % nl)]
    ),
    false, '', '', '', ''
  from generate_series(1, n_staff) n
  on conflict (id) do nothing;

  -- Roll och turnering. Triggrarna skyddar mot rolländring respektive
  -- turneringsbyte och känner ingen inloggad användare här, så de måste
  -- stängas av tillfälligt.
  alter table public.profiles disable trigger trg_protect_role;
  alter table public.profiles disable trigger trg_protect_tenant;

  update public.profiles p
     set tenant_id = t_id,
         full_name = coalesce(nullif(p.full_name, ''), u.raw_user_meta_data->>'full_name'),
         role = (array['volunteer','school_staff','arena_staff','area_housing','area_arenas','coordinator'])[
                  1 + (abs(hashtext(p.email)) % 6)
                ]::app_role
    from auth.users u
   where u.id = p.id
     and p.email like 'demo%.' || v_slug || '@exempel.se';

  alter table public.profiles enable trigger trg_protect_role;
  alter table public.profiles enable trigger trg_protect_tenant;


  -- ---------- Matcher ----------
  insert into public.arena_matches
    (arena_id, surface_label, home_team, away_team, category, starts_at, status, risk_level, tenant_id)
  select
    ar.id,
    'Plan ' || (1 + (n % 3)),
    'Lag ' || (1 + (n * 7) % 120),
    'Lag ' || (1 + (n * 13) % 120),
    (array['P15','P16','F15','F16','P17','F17'])[1 + (n % 6)],
    now()::date + ((n % 5) || ' days')::interval + ((8 + (n % 10)) || ' hours')::interval,
    'scheduled',
    -- Riskfördelning som speglar verkligheten: de allra flesta gröna
    (case when n % 23 = 0 then 'red' when n % 7 = 0 then 'yellow' else 'green' end)::risk_level,
    t_id
  from generate_series(1, n_matches) n
  join lateral (
    select id from public.arenas
    where tenant_id = t_id
    order by name
    offset ((n - 1) % n_arenas) limit 1
  ) ar on true;

  raise notice 'Demodata klar för %: % områden, % boenden, % spelplatser, % funktionärer, % matcher',
    v_slug, n_areas, n_schools, n_arenas, n_staff, n_matches;
end $$;

-- ---------- Kontroll: hur många unika namn blev det? ----------
select
  t.name as turnering,
  count(*) as funktionarer,
  count(distinct p.full_name) as unika_namn
from public.profiles p
join public.tenants t on t.id = p.tenant_id
group by t.name
order by t.name;
