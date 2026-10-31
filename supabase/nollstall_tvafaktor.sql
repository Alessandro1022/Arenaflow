-- TournamentOps · Nollställ tvåfaktor för ett konto
-- ============================================================================
-- För när någon har tappat telefonen och ingen admin kan nollställa i appen,
-- till exempel om det är du själv. Byt e-posten nedan och kör i SQL Editor.
-- Personen får slå på tvåfaktor igen vid nästa inloggning.
-- ============================================================================

do $$
declare
  target_email text := 'DIN@EPOST.SE';      -- << BYT HÄR
  uid uuid;
  n int;
begin
  select id into uid from auth.users where lower(email) = lower(target_email);
  if uid is null then
    raise exception 'Hittar ingen användare med e-post %', target_email;
  end if;
  delete from auth.mfa_factors where user_id = uid;
  get diagnostics n = row_count;
  raise notice 'Klart: % kodapp(ar) borttagna för %', n, target_email;
end $$;

select u.email, count(f.id) as kvar
from auth.users u left join auth.mfa_factors f on f.user_id = u.id
where lower(u.email) = lower('DIN@EPOST.SE')     -- << OCH HÄR
group by u.email;
