-- TournamentOps · Del 24 · Tvåfaktor för känsliga roller
-- ============================================================================
-- Ledning, admin, koordinatorer, säkerhetsansvariga och ekonomi (nivå 4 och
-- uppåt) måste logga in med en engångskod från telefonen, utöver lösenordet.
-- Supabase har stödet inbyggt (TOTP) och det är gratis.
--
-- Spärren sitter i databasen, inte bara i appen. Ett stulet lösenord räcker
-- inte: tills koden är angiven räknas personen som volontär i varje regel
-- (my_tier blir 1), och plattformsägarens rättigheter är avstängda. Appen
-- skickar dessutom vidare till sidan där koden anges.
--
-- Stänga av för en turnering (t.ex. om något strular under turneringen):
--   update public.tenants set require_mfa = false where slug = 'gothia-cup';
-- Nollställa någons tvåfaktor görs i appen under Personal. Har du själv
-- tappat telefonen: kör nollstall_tvafaktor.sql i SQL Editor.
--
-- Kör efter schema_part23_inbjudningar.sql. Går att köra flera gånger.
-- ============================================================================

-- ============ 0. FÖRKONTROLL ============
do $$
begin
  if to_regprocedure('public.role_tier(app_role)') is null
     or to_regprocedure('public.auth_role()') is null
     or to_regclass('public.tenants') is null then
    raise exception 'Del 7 och del 12 saknas. Kör dem först (se diagnos.sql).';
  end if;
end $$;

-- ============ 1. INSTÄLLNING PER TURNERING ============
alter table public.tenants
  add column if not exists require_mfa boolean not null default true;

-- ============ 2. HJÄLPFUNKTIONER ============
-- Inloggningens nivå enligt Supabase: aal1 = bara lösenord, aal2 = även kod
create or replace function public.session_aal() returns text
language sql stable set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1')
$$;

create or replace function public.mfa_enforced() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select t.require_mfa from public.tenants t where t.id = public.my_tenant()), true)
$$;

-- ============ 3. NIVÅN SOM ALLA REGLER BYGGER PÅ ============
-- Utan kod räknas en känslig roll som volontär. is_admin, is_coordinator
-- och has_scope bygger på my_tier och följer därmed med av sig själva.
create or replace function public.my_tier() returns integer
language sql stable security definer set search_path = public as $$
  select case
    when x.t >= 4 and public.session_aal() <> 'aal2' and public.mfa_enforced() then 1
    else x.t
  end
  from (select coalesce(public.role_tier(public.auth_role()), 0) as t) x
$$;

create or replace function public.is_platform_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.platform_owner from public.profiles p where p.id = auth.uid()), false)
     and (public.session_aal() = 'aal2' or not public.mfa_enforced())
$$;

-- ============ 4. KONTROLL ============
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants' and column_name = 'require_mfa') as installning,
  (select count(*) from pg_proc where proname = 'my_tier' and prosrc like '%session_aal%')  as nivaregel,
  (select count(*) from pg_proc where proname = 'is_platform_owner' and prosrc like '%session_aal%') as agarregel,
  (select string_agg(name || ': ' || case when require_mfa then 'på' else 'av' end, ', ')
     from public.tenants)                                                                   as turneringar;
-- Allt ska vara 1, och turneringarna står som "på".
