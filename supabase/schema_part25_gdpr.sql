-- TournamentOps · Del 25 · GDPR: lagringstider, gallring, registerutdrag och radering
-- ============================================================================
-- Personuppgifter ska inte ligga kvar längre än de behövs. Varje turnering
-- får en sista dag och en lagringstid per sorts uppgift, räknat från den
-- dagen. Varje morgon gallras det som har passerat sin tid, automatiskt.
--
-- Standardtiderna nedan är förslag. Det är arrangören (ArenaFlow) som är
-- personuppgiftsansvarig och bestämmer de riktiga tiderna – de ändras under
-- Inställningar → Lagring och GDPR.
--
--   Deltagare (namn, födelseår, lag)            90 dagar
--   Lagledares namn och telefon                 90 dagar (töms, laget finns kvar)
--   Chatt och bilagor i chatten                180 dagar
--   Uppgifter och felanmälningar               365 dagar
--   Pass, frånvaro, jour, kvittenser           365 dagar
--   Nattronder, säkerhetslogg, publikräkning   365 dagar
--   Domarregistret                             365 dagar
--   Ändringshistorik                           365 dagar
--   Incidenter                                 730 dagar
--
-- Bara uppgifter från den avslutade turneringen gallras (skapade senast den
-- sista dagen). Det som läggs in inför nästa år rörs inte.
--
-- Dessutom: registerutdrag och radering per person, och en publik sida med
-- integritetsinformation (/integritet) som också vänder sig till föräldrar.
--
-- Kör efter schema_part24_tvafaktor.sql. Går att köra flera gånger.
-- ============================================================================

-- ============ 0. FÖRKONTROLL ============
do $$
begin
  if to_regclass('public.attachments') is null or to_regclass('public.participants') is null
     or to_regclass('public.referees') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'Del 11, 19 och 20 saknas. Kör dem först (se diagnos.sql).';
  end if;
end $$;

-- ============ 1. INSTÄLLNINGAR PER TURNERING ============
alter table public.tenants
  add column if not exists ends_on date,                                    -- turneringens sista dag
  add column if not exists retention jsonb not null default '{}'::jsonb,    -- dagar per sort, avvikelser från standard
  add column if not exists privacy_text text not null default '';           -- egen integritetstext, tom = mallen

create or replace function public.retention_defaults() returns jsonb
language sql immutable as $$
  select '{"deltagare":90,"lagkontakter":90,"chatt":180,"arenden":365,"pass":365,"ronder":365,"domare":365,"historik":365,"incidenter":730}'::jsonb
$$;

create or replace function public.retention_days(t uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.retention_defaults() || coalesce((select retention from public.tenants where id = t), '{}'::jsonb)
$$;

-- ============ 2. VEM FÅR GALLRA ============
-- Servern (morgonkörningen med service-nyckeln) eller turneringens egen admin
create or replace function public.gdpr_allowed(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or (t = public.my_tenant() and public.is_admin())
$$;

-- ============ 3. LOGG ============
create table if not exists public.retention_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ran_at timestamptz not null default now(),
  ran_by uuid references public.profiles(id) on delete set null,
  result jsonb not null default '{}'::jsonb
);
create index if not exists idx_retention_runs on public.retention_runs (tenant_id, ran_at desc);
alter table public.retention_runs enable row level security;
drop policy if exists "gallring läs" on public.retention_runs;
create policy "gallring läs" on public.retention_runs for select to authenticated
  using (tenant_id = public.my_tenant() and public.is_admin());
grant select on public.retention_runs to authenticated;

-- ============ 4. GALLRINGEN ============
-- Gränsen: allt skapat före midnatt efter sista dagen, svensk tid
create or replace function public.retention_edge(t uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select ((ends_on + 1)::timestamp at time zone 'Europe/Stockholm') from public.tenants where id = t
$$;

create or replace function public.retention_due(t uuid, kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_date >= (select ends_on from public.tenants where id = t)
                  + (public.retention_days(t) ->> kind)::int, false)
$$;

-- Filerna som ska bort ur lagringen. Servern tar bort dem via Storage-API:t
-- innan raderna raderas – att bara radera raden lämnar filen kvar.
create or replace function public.retention_attachment_paths(t uuid) returns setof text
language plpgsql stable security definer set search_path = public as $$
declare edge timestamptz;
begin
  if not public.gdpr_allowed(t) then raise exception 'Behörighet saknas'; end if;
  edge := public.retention_edge(t);
  if edge is null then return; end if;
  return query
    select a.storage_path from public.attachments a
    where a.tenant_id = t and (
      (a.parent_type = 'message' and public.retention_due(t, 'chatt')
        and exists (select 1 from public.messages m where m.id = a.parent_id and m.created_at < edge))
      or (a.parent_type = 'task' and public.retention_due(t, 'arenden')
        and exists (select 1 from public.tasks x where x.id = a.parent_id and x.created_at < edge))
      or (a.parent_type = 'room_issue' and public.retention_due(t, 'arenden')
        and exists (select 1 from public.room_issues x where x.id = a.parent_id and x.created_at < edge))
      or (a.parent_type = 'incident' and public.retention_due(t, 'incidenter')
        and exists (select 1 from public.incidents x where x.id = a.parent_id and x.created_at < edge))
    );
end $$;

-- Gallrar det som har passerat sin tid och returnerar hur mycket.
-- dry = true räknar bara: allt görs, och rullas sedan tillbaka.
create or replace function public.run_retention(t uuid, dry boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  edge timestamptz;
  res jsonb := '{}'::jsonb;
  n int;
  a int;
begin
  if not public.gdpr_allowed(t) then raise exception 'Behörighet saknas'; end if;
  edge := public.retention_edge(t);
  if edge is null then
    return jsonb_build_object('hoppades_over', 'Turneringens sista dag är inte satt');
  end if;

  begin
    if public.retention_due(t, 'deltagare') then
      delete from public.participants where tenant_id = t and created_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('deltagare', n);
    end if;

    if public.retention_due(t, 'lagkontakter') then
      update public.team_assignments set contact_name = '', contact_phone = ''
       where tenant_id = t and created_at < edge
         and (coalesce(contact_name, '') <> '' or coalesce(contact_phone, '') <> '');
      get diagnostics n = row_count; res := res || jsonb_build_object('lagkontakter', n);
    end if;

    if public.retention_due(t, 'chatt') then
      delete from public.attachments x where x.tenant_id = t and x.parent_type = 'message'
        and exists (select 1 from public.messages m where m.id = x.parent_id and m.created_at < edge);
      get diagnostics a = row_count;
      delete from public.messages where tenant_id = t and created_at < edge;
      get diagnostics n = row_count;
      delete from public.channels where tenant_id = t and kind = 'direkt' and created_at < edge;
      res := res || jsonb_build_object('chatt', n, 'chatt_bilagor', a);
    end if;

    if public.retention_due(t, 'arenden') then
      delete from public.attachments x where x.tenant_id = t and (
        (x.parent_type = 'task' and exists (select 1 from public.tasks k where k.id = x.parent_id and k.created_at < edge))
        or (x.parent_type = 'room_issue' and exists (select 1 from public.room_issues k where k.id = x.parent_id and k.created_at < edge)));
      get diagnostics a = row_count;
      delete from public.tasks where tenant_id = t and created_at < edge;
      get diagnostics n = row_count;
      res := res || jsonb_build_object('uppgifter', n, 'arenden_bilagor', a);
      delete from public.room_issues where tenant_id = t and created_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('felanmalningar', n);
    end if;

    if public.retention_due(t, 'incidenter') then
      delete from public.attachments x where x.tenant_id = t and x.parent_type = 'incident'
        and exists (select 1 from public.incidents k where k.id = x.parent_id and k.created_at < edge);
      get diagnostics a = row_count;
      delete from public.incidents where tenant_id = t and created_at < edge;
      get diagnostics n = row_count;
      res := res || jsonb_build_object('incidenter', n, 'incidenter_bilagor', a);
    end if;

    if public.retention_due(t, 'pass') then
      delete from public.shifts where tenant_id = t and ends_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('pass', n);
      delete from public.absences where tenant_id = t and created_at < edge;
      delete from public.availability where tenant_id = t and created_at < edge;
      delete from public.on_call_shifts where tenant_id = t and ends_at < edge;
      delete from public.news_acks where tenant_id = t and acked_at < edge;
      delete from public.notifications where tenant_id = t and created_at < edge;
      delete from public.invites where tenant_id = t and created_at < edge;
      -- Förarnas namn, nummer och senaste position
      update public.vehicles set driver_name = '', driver_phone = '', last_lat = null, last_lng = null, last_seen = null
       where tenant_id = t and created_at < edge
         and (driver_name <> '' or driver_phone <> '' or last_lat is not null);
    end if;

    if public.retention_due(t, 'ronder') then
      delete from public.night_rounds where tenant_id = t and performed_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('nattronder', n);
      delete from public.security_logs where tenant_id = t and created_at < edge;
      delete from public.crowd_counts where tenant_id = t and created_at < edge;
    end if;

    if public.retention_due(t, 'domare') then
      delete from public.referees where tenant_id = t and created_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('domare', n);
    end if;

    if public.retention_due(t, 'historik') then
      delete from public.audit_log where tenant_id = t and created_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('historik', n);
    end if;

    if dry then
      raise exception using errcode = 'P0001', message = 'tops_provkorning';
    end if;
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'tops_provkorning' then raise; end if;
    return res || jsonb_build_object('provkorning', true);
  end;

  insert into public.retention_runs (tenant_id, ran_by, result) values (t, auth.uid(), res);
  return res;
end $$;

-- ============ 5. INSTÄLLNINGAR FRÅN APPEN ============
create or replace function public.set_gdpr_settings(p_ends_on date, p_retention jsonb, p_privacy text)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'Endast admin kan ändra lagringstider'; end if;
  for k, v in select * from jsonb_each(coalesce(p_retention, '{}'::jsonb)) loop
    if not (public.retention_defaults() ? k) then continue; end if;
    if jsonb_typeof(v) <> 'number' or (v::text)::numeric < 1 or (v::text)::numeric > 3650 then
      raise exception 'Lagringstiden för % måste vara mellan 1 och 3650 dagar', k;
    end if;
    clean := clean || jsonb_build_object(k, round((v::text)::numeric)::int);
  end loop;
  update public.tenants
     set ends_on = p_ends_on, retention = clean, privacy_text = left(coalesce(p_privacy, ''), 20000)
   where id = public.my_tenant();
end $$;

-- ============ 6. REGISTERUTDRAG ============
-- Allt om en person i turneringen. Personen själv eller turneringens admin.
create or replace function public.person_export(p uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pr record;
begin
  select * into pr from public.profiles where id = p;
  if pr is null then raise exception 'Personen hittades inte'; end if;
  if not (p = auth.uid() or (pr.tenant_id = public.my_tenant() and public.is_admin())) then
    raise exception 'Behörighet saknas';
  end if;
  return jsonb_build_object(
    'utdrag_skapat', now(),
    'turnering', (select name from public.tenants where id = pr.tenant_id),
    'person', to_jsonb(pr) - 'tenant_id' - 'platform_owner',
    'behorigheter', (select coalesce(jsonb_agg(jsonb_build_object(
        'omrade', (select name from public.areas a where a.id = s.area_id),
        'plats', coalesce((select name from public.schools x where x.id = s.location_id),
                          (select name from public.arenas x where x.id = s.location_id)))), '[]')
      from public.staff_scope s where s.user_id = p),
    'pass', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id' order by x.starts_at), '[]') from public.shifts x where x.user_id = p),
    'franvaro', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.absences x where x.user_id = p),
    'tillganglighet', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.availability x where x.user_id = p),
    'jour', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.on_call_shifts x where x.user_id = p),
    'meddelanden', (select coalesce(jsonb_agg(jsonb_build_object('skickat', x.created_at, 'text', x.body,
        'kanal', (select c.name from public.channels c where c.id = x.channel_id)) order by x.created_at), '[]')
      from public.messages x where x.sender = p),
    'incidenter_rapporterade', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.incidents x where x.reported_by = p),
    'incidenter_tilldelade', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.incidents x where x.assigned_to = p),
    'incidentkommentarer', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.incident_comments x where x.author = p),
    'uppgifter_skapade', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.tasks x where x.created_by = p),
    'uppgifter_tilldelade', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.tasks x where x.assigned_to = p),
    'uppgiftskommentarer', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.task_comments x where x.author = p),
    'felanmalningar', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.room_issues x where x.reported_by = p),
    'nattronder', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.night_rounds x where x.performed_by = p),
    'bilagor', (select coalesce(jsonb_agg(jsonb_build_object('fil', x.file_name, 'uppladdad', x.created_at)), '[]') from public.attachments x where x.uploaded_by = p),
    'kvittenser', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.news_acks x where x.user_id = p),
    'domare', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.referees x where x.user_id = p),
    'andringar_av_personen', (select count(*) from public.audit_log x where x.actor = p),
    'andringar_av_profilen', (select coalesce(jsonb_agg(jsonb_build_object('tid', x.created_at, 'andring', x.changes) order by x.created_at), '[]')
      from public.audit_log x where x.table_name = 'profiles' and x.record_id = p::text)
  );
end $$;

create or replace function public.participant_export(p uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pa record;
begin
  select * into pa from public.participants where id = p;
  if pa is null then raise exception 'Deltagaren hittades inte'; end if;
  if not (pa.tenant_id = public.my_tenant() and public.is_admin()) then raise exception 'Behörighet saknas'; end if;
  return jsonb_build_object(
    'utdrag_skapat', now(),
    'turnering', (select name from public.tenants where id = pa.tenant_id),
    'deltagare', to_jsonb(pa) - 'tenant_id',
    'lag', (select jsonb_build_object('lag', ta.team_name, 'forening', ta.club_name, 'klass', ta.age_class,
              'boende', (select name from public.schools s where s.id = ta.school_id),
              'ankomst', ta.arrival_date, 'avresa', ta.departure_date)
            from public.team_assignments ta where ta.id = pa.team_assignment_id),
    'maltider', (select coalesce(jsonb_agg(jsonb_build_object('datum', m.service_date, 'maltid', m.meal, 'registrerad', m.checked_at)), '[]')
      from public.meal_checkins m where m.participant_id = p)
  );
end $$;

-- ============ 7. RADERING ============
-- Deltagare tas bort direkt i lagets lista (soptunnan). Personal kan inte
-- tas bort rakt av – de finns i incidenter, uppgifter och meddelanden –
-- och görs därför anonyma.
-- Personal raderas genom att göras anonym: namn, e-post och telefon tas bort,
-- och allt som bara handlar om personen raderas. Det personen gjort i driften
-- (incidenter, uppgifter) finns kvar utan namn. Inloggningen spärras av
-- servern efteråt. Returnerar den gamla e-posten.
create or replace function public.anonymize_person(p uuid) returns text
language plpgsql security definer set search_path = public as $$
declare pr record;
begin
  select * into pr from public.profiles where id = p;
  if pr is null then raise exception 'Personen hittades inte'; end if;
  if p = auth.uid() then raise exception 'Du kan inte radera dig själv'; end if;
  if not (pr.tenant_id = public.my_tenant() and public.is_admin()
          and public.role_tier(pr.role) <= public.my_tier()) then
    raise exception 'Behörighet saknas';
  end if;
  if pr.platform_owner then raise exception 'Plattformsägaren kan inte raderas här'; end if;

  update public.profiles
     set full_name = 'Raderad person', phone = null,
         email = 'raderad-' || substr(p::text, 1, 8) || '@raderad.invalid'
   where id = p;
  delete from public.staff_scope where user_id = p;
  delete from public.availability where user_id = p;
  delete from public.absences where user_id = p;
  delete from public.onboarding_done where user_id = p;
  delete from public.news_acks where user_id = p;
  delete from public.notifications where user_id = p;
  delete from public.channel_members where user_id = p;
  delete from public.channel_reads where user_id = p;
  delete from public.push_subscriptions where user_id = p;
  update public.on_call_shifts set contact_name = 'Raderad person', phone = '' where user_id = p;
  update public.referees set user_id = null where user_id = p;
  delete from public.invites where lower(email) = lower(pr.email);
  delete from public.audit_log where table_name = 'profiles' and record_id = p::text;
  return pr.email;
end $$;

-- ============ 8. INTEGRITETSINFORMATION (PUBLIK) ============
-- Sidan /integritet visas utan inloggning, för föräldrar och deltagare.
-- Bara turneringens namn, texten och lagringstiderna – inga personuppgifter.
create or replace function public.privacy_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', t.name, 'text', t.privacy_text, 'ends_on', t.ends_on,
                            'retention', public.retention_days(t.id))
  from public.tenants t
  where t.id = coalesce(public.my_tenant(), (select id from public.tenants where active limit 1))
$$;

-- ============ 9. BEHÖRIGHET PÅ FUNKTIONERNA ============
do $$
declare f text;
begin
  foreach f in array array[
    'gdpr_allowed(uuid)', 'retention_attachment_paths(uuid)', 'run_retention(uuid, boolean)',
    'set_gdpr_settings(date, jsonb, text)', 'person_export(uuid)', 'participant_export(uuid)',
    'anonymize_person(uuid)', 'retention_days(uuid)', 'retention_edge(uuid)',
    'retention_due(uuid, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  execute 'grant execute on function public.privacy_info() to anon, authenticated';
end $$;

-- ============ 10. KONTROLL ============
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants' and column_name in ('ends_on', 'retention', 'privacy_text')) as installningar,
  (select count(*) from pg_proc where proname in ('run_retention', 'person_export', 'participant_export',
     'anonymize_person', 'privacy_info', 'set_gdpr_settings'))                                                            as funktioner,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'retention_runs')        as logg;
-- Ska vara 3, 6 och 1.
