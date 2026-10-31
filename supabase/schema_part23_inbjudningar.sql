-- TournamentOps · Del 23 · Inbjudningar som fungerar
-- ============================================================================
-- Hittat när importen av personal testades från början till slut:
-- INBJUDNINGAR MED ROLL HAR INTE FUNGERAT SEDAN DEL 7.
--
-- Så här går en inbjudan till: Supabase skapar kontot direkt, profilen
-- skapas av en trigger, och apply_invite sätter roll, turnering och
-- behörighet från inbjudan. Den sista uppdateringen stoppades av två spärrar
-- som kräver en inloggad admin respektive plattformsägare. När Supabase
-- skapar kontot finns ingen inloggad användare alls, så båda spärrarna slog
-- till och hela kontot rullades tillbaka. Supabase svarar då bara "Database
-- error saving new user".
--
-- Rättningen: spärrarna gäller personer, inte systemet. Utan inloggad
-- användare (inbjudan som tas emot, SQL Editor, servern) släpps ändringen
-- igenom. En inloggad användare utan admin stoppas precis som förut.
--
-- Samtidigt stängs en lucka: en admin kunde ge sig själv eller någon annan
-- rollen Ledning, som är högre än admin. Nu kan ingen ge eller ändra en roll
-- som är högre än den egna.
--
-- Kör efter schema_part22_komplettering.sql. Går att köra flera gånger.
-- ============================================================================

-- ============ 0. FÖRKONTROLL ============
do $$
begin
  if to_regprocedure('public.role_tier(app_role)') is null
     or to_regprocedure('public.is_platform_owner()') is null then
    raise exception 'Del 7 och del 12 saknas. Kör dem först (se diagnos.sql).';
  end if;
end $$;

-- ============ 1. ROLLSPÄRREN ============
create or replace function public.protect_role_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    -- Ingen inloggad användare: systemet ändrar, t.ex. en inbjudan som tas emot
    if auth.uid() is null then
      return new;
    end if;
    if not public.is_admin() then
      raise exception 'Endast admin kan ändra roll';
    end if;
    if public.role_tier(old.role) > public.my_tier() then
      raise exception 'Du kan inte ändra rollen för någon som har högre roll än du';
    end if;
    if public.role_tier(new.role) > public.my_tier() then
      raise exception 'Du kan inte ge någon högre roll än din egen';
    end if;
  end if;
  return new;
end $$;

-- ============ 2. TURNERINGSSPÄRREN ============
create or replace function public.protect_tenant_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.tenant_id is distinct from old.tenant_id and not public.is_platform_owner() then
    raise exception 'Endast plattformsägaren kan byta turnering';
  end if;
  if new.platform_owner is distinct from old.platform_owner and not public.is_platform_owner() then
    raise exception 'Endast plattformsägaren kan dela ut ägarrollen';
  end if;
  return new;
end $$;

-- ============ 3. KONTROLL ============
select
  (select count(*) from pg_proc where proname = 'protect_role_change'
     and prosrc like '%auth.uid() is null%')                          as rollsparr,
  (select count(*) from pg_proc where proname = 'protect_tenant_change'
     and prosrc like '%auth.uid() is null%')                          as turneringssparr,
  (select count(*) from pg_trigger where tgname in ('trg_protect_role', 'trg_protect_tenant', 'trg_apply_invite')
     and not tgisinternal)                                            as triggrar;
-- Allt ska vara 1, 1 och 3.
