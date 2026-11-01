-- TournamentOps · Diagnos
-- ============================================================================
-- Visar vilka delar som är körda i databasen. Säker att köra när som helst:
-- den läser bara systemkatalogen och ändrar ingenting. Den rör aldrig en
-- tabell eller kolumn som kanske saknas, så den kraschar inte av det den
-- ska upptäcka.
--
-- Resultatet är en rad per del, och alla rader ska stå "ja".
-- Står det NEJ: kör filen i kolumnen "fil" och sedan alla senare delar i
-- nummerordning. Alla filer går att köra om utan skada.
--
-- Sist visas lagringen för bilagor, plattformsägare och aktiv turnering.
-- ============================================================================

with
fn as (
  select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
delar (ordning, del, vad, fil, ok) as (
  values
  (1,  '1',   'Grund',                'schema.sql',
       to_regclass('public.profiles') is not null
       and to_regclass('public.staff_scope') is not null),
  (2,  '2',   'Områdesdrift',         'schema_part2.sql',
       to_regclass('public.classrooms') is not null),
  (3,  '3',   'Chatt, nyheter, kris', 'schema_part3.sql',
       to_regclass('public.crisis_state') is not null),
  (4,  '4',   'AI och inbjudningar',  'schema_part4.sql',
       to_regclass('public.invites') is not null),
  (5,  'vyer', 'Prestandavyer',       'stats_views.sql',
       to_regclass('public.school_stats') is not null),
  (6,  '6',   'Turneringar',          'schema_part6_tenants.sql',
       to_regclass('public.tenants') is not null),
  (7,  '7',   'Multi-tenancy',        'schema_part7_multitenant.sql',
       exists (select 1 from fn where proname = 'my_tenant')
       and exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'incidents'
                     and policyname = 'tenant isolering')),
  (8,  '8',   'Paket',                'schema_part8_plans.sql',
       to_regclass('public.plans') is not null),
  (9,  '9',   'Modulregler',          'tops_del9-12a.sql',
       exists (select 1 from fn where proname = 'module_keys')),
  (10, '10',  'Boenden och hotell',   'tops_del9-12a.sql',
       to_regtype('public.accommodation_kind') is not null),
  (11, '11',  'Spelare och ledare',   'tops_del9-12a.sql',
       to_regclass('public.participants') is not null),
  (12, '12a', 'Nya roller',           'tops_del9-12a.sql',
       exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
               where t.typname = 'app_role' and e.enumlabel = 'security_staff')),
  (13, '12b', 'Roller per modul',     'tops_del12b-15.sql',
       to_regclass('public.role_modules') is not null),
  (14, '13',  'Lager',                'tops_del12b-15.sql',
       to_regclass('public.stock_items') is not null),
  (15, '14',  'Transport',            'tops_del12b-15.sql',
       to_regclass('public.vehicles') is not null),
  (16, '15',  'Måltider',             'tops_del12b-15.sql',
       to_regclass('public.meal_services') is not null),
  (17, '16',  'Ekonomi',              'tops_del16_ekonomi.sql',
       to_regclass('public.budget_lines') is not null),
  (18, '17',  'Jour och nödinfo',     'tops_del17_jour.sql',
       to_regclass('public.on_call_shifts') is not null),
  (19, '18',  'Bemanning',            'tops_del18-21.sql',
       to_regclass('public.absences') is not null),
  (20, '19',  'Ärenden',              'tops_del18-21.sql',
       to_regclass('public.task_comments') is not null),
  (21, '20',  'Matcher',              'tops_del18-21.sql',
       to_regclass('public.referees') is not null),
  (22, '21',  'Chatt',                'tops_del18-21.sql',
       to_regclass('public.channels') is not null),
  (23, '22',  'Komplettering',        'tops_del22.sql',
       to_regclass('public.channel_reads') is not null
       and exists (select 1 from fn where proname = 'can_manage_channel')),
  (24, '23',  'Inbjudningar',         'tops_del23.sql',
       exists (select 1 from pg_proc where proname = 'protect_role_change'
               and prosrc like '%auth.uid() is null%')),
  (25, '24',  'Tvåfaktor',            'tops_del24.sql',
       exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'tenants' and column_name = 'require_mfa')),
  (26, '25',  'GDPR',                 'tops_del25.sql',
       to_regclass('public.retention_runs') is not null
       and exists (select 1 from fn where proname = 'person_export')),
  (27, '26',  'Sjukvård',             'tops_del26.sql',
       to_regclass('public.medical_requests') is not null),
  (28, '27',  'Pushnotiser',          'tops_del27.sql',
       exists (select 1 from fn where proname = 'claim_pushes'))
),
-- Frågor mot tabeller som kanske saknas körs via query_to_xml, och bara
-- när tabellen eller kolumnen finns. Annars hade hela filen kraschat.
extra as (
  select
    case when to_regclass('storage.buckets') is null then null
      else (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from storage.buckets where id = ''bilagor''',
        false, true, '')))[1]::text
    end as hinkar,
    case when not exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'profiles'
                            and column_name = 'platform_owner') then null
      else (xpath('/row/v/text()', query_to_xml(
        'select string_agg(email, '', '' order by email) as v
           from public.profiles where platform_owner',
        true, true, '')))[1]::text
    end as agare,
    case when to_regclass('public.tenants') is null then null
      else (xpath('/row/v/text()', query_to_xml(
        'select string_agg(name, '', '' order by name) as v
           from public.tenants where active',
        true, true, '')))[1]::text
    end as aktiv
)
select del, vad, status, fil
from (
  select ordning, del, vad,
         case when ok then 'ja' else 'NEJ' end as status,
         case when ok then '' else fil end     as fil
  from delar
  union all
  select 30, 'lagring', 'Bilagor',
         case when coalesce(hinkar, '0') <> '0' then 'ja' else 'NEJ' end,
         case when coalesce(hinkar, '0') <> '0' then '' else 'tops_del22.sql' end
  from extra
  union all
  select 31, 'konto', 'Plattformsägare', coalesce(agare, 'ingen'),
         case when agare is null then 'make_me_owner.sql' else '' end
  from extra
  union all
  select 32, 'konto', 'Aktiv turnering', coalesce(aktiv, 'ingen'), ''
  from extra
) rader
order by ordning;
