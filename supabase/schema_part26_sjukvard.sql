-- TournamentOps · Del 26 · Sjukvård, minsta användbara version
-- ============================================================================
-- Tre saker:
--   1. Sjukvårdsstationer, första hjälpen och hjärtstartare: var de finns,
--      telefon och öppettider. Visas på kartan och i offlineläget.
--   2. Begäran om sjukvård: vem som helst kan larma med plats och hur
--      bråttom det är. Sjukvården och säkerhetsansvariga ser det direkt.
--   3. Hälsouppgifterna hålls för sig: en begäran syns bara för den som
--      skickade den, sjukvården, säkerhetsansvariga och ledningen. Den
--      följer inte med i säkerhetskopiorna och gallras efter 30 dagar.
--
-- Fältet "vad har hänt" ska vara kort. Appen ber om att inte skriva
-- personnummer eller journaluppgifter.
--
-- Kör efter schema_part25_gdpr.sql. Går att köra flera gånger.
-- ============================================================================

-- ============ 0. FÖRKONTROLL ============
do $$
begin
  if to_regprocedure('public.run_retention(uuid, boolean)') is null then
    raise exception 'Del 25 saknas. Kör den först (se diagnos.sql).';
  end if;
end $$;

-- ============ 1. SJUKVÅRDSPLATSER ============
create table if not exists public.medical_points (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants(id) on delete cascade,
  kind text not null default 'station' check (kind in ('station', 'forsta_hjalpen', 'hjartstartare')),
  name text not null,
  address text not null default '',
  lat double precision,
  lng double precision,
  phone text not null default '',
  hours text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_medical_points_tenant on public.medical_points (tenant_id);

-- ============ 2. BEGÄRAN OM SJUKVÅRD ============
create table if not exists public.medical_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.my_tenant() references public.tenants(id) on delete cascade,
  urgency text not null default 'akut' check (urgency in ('akut', 'snart', 'ej_bradskande')),
  location_type location_type,
  location_id uuid,
  place_text text not null default '',
  lat double precision,
  lng double precision,
  what text not null default '' check (char_length(what) <= 300),
  status text not null default 'ny' check (status in ('ny', 'pa_vag', 'klar', 'avbruten')),
  requested_by uuid default auth.uid() references public.profiles(id) on delete set null,
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_medical_requests_open on public.medical_requests (tenant_id, status, created_at desc);

-- ============ 3. VEM HANTERAR ============
-- Sjukvården, säkerhetsansvariga (med tvåfaktor när det krävs) och admin
create or replace function public.can_handle_medical() returns boolean
language sql stable security definer set search_path = public as $$
  select public.auth_role() = 'medic'
      or (public.auth_role() = 'security_lead' and public.my_tier() >= 4)
      or public.is_admin()
$$;

-- Den som larmade får bara avbryta sin egen begäran, inget annat
create or replace function public.medical_request_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if not public.can_handle_medical() then
      if old.requested_by is distinct from auth.uid()
         or new.status <> 'avbruten'
         or (to_jsonb(new) - 'status' - 'updated_at' - 'closed_at') <> (to_jsonb(old) - 'status' - 'updated_at' - 'closed_at') then
        raise exception 'Du kan bara avbryta din egen begäran';
      end if;
    end if;
    new.updated_at := now();
    if new.status in ('klar', 'avbruten') and old.status not in ('klar', 'avbruten') then
      new.closed_at := now();
    end if;
    if new.status = 'pa_vag' and new.handled_by is null then
      new.handled_by := auth.uid();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_medical_request_guard on public.medical_requests;
create trigger trg_medical_request_guard before update on public.medical_requests
  for each row execute function public.medical_request_guard();

-- Notis till sjukvården och säkerhetsansvariga när någon larmar
create or replace function public.medical_request_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, title, body, tenant_id)
  select p.id, 'Begäran om sjukvård',
         case new.urgency when 'akut' then 'AKUT' when 'snart' then 'Snart' else 'Inte bråttom' end
           || coalesce(' · ' || nullif(new.place_text, ''), ''),
         new.tenant_id
  from public.profiles p
  where p.tenant_id = new.tenant_id and p.role in ('medic', 'security_lead');
  return new;
end $$;

drop trigger if exists trg_medical_request_notify on public.medical_requests;
create trigger trg_medical_request_notify after insert on public.medical_requests
  for each row execute function public.medical_request_notify();

-- ============ 4. BEHÖRIGHET ============
alter table public.medical_points enable row level security;
alter table public.medical_requests enable row level security;

drop policy if exists "sjukvardsplats läs" on public.medical_points;
create policy "sjukvardsplats läs" on public.medical_points for select to authenticated using (true);
drop policy if exists "sjukvardsplats skriv" on public.medical_points;
create policy "sjukvardsplats skriv" on public.medical_points for all to authenticated
  using (public.is_coordinator() or public.can_handle_medical())
  with check (public.is_coordinator() or public.can_handle_medical());

drop policy if exists "sjukvardsbegaran läs" on public.medical_requests;
create policy "sjukvardsbegaran läs" on public.medical_requests for select to authenticated
  using (requested_by = auth.uid() or public.can_handle_medical());
drop policy if exists "sjukvardsbegaran skapa" on public.medical_requests;
create policy "sjukvardsbegaran skapa" on public.medical_requests for insert to authenticated
  with check (requested_by = auth.uid());
drop policy if exists "sjukvardsbegaran andra" on public.medical_requests;
create policy "sjukvardsbegaran andra" on public.medical_requests for update to authenticated
  using (requested_by = auth.uid() or public.can_handle_medical())
  with check (requested_by = auth.uid() or public.can_handle_medical());

do $$
declare t text;
begin
  foreach t in array array['medical_points', 'medical_requests'] loop
    execute format('drop policy if exists "tenant isolering" on public.%I', t);
    execute format(
      'create policy "tenant isolering" on public.%I
         as restrictive for all to authenticated
         using (tenant_id = public.my_tenant())
         with check (tenant_id = public.my_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on public.medical_points to authenticated;
grant select, insert, update on public.medical_requests to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.medical_requests;
exception when duplicate_object or undefined_object then null;
end $$;

-- ============ 5. GALLRING OCH REGISTERUTDRAG ============
-- Begäran om sjukvård gallras efter 30 dagar som standard, och ingår i
-- registerutdraget för den som larmade.
create or replace function public.retention_defaults() returns jsonb
language sql immutable as $$
  select '{"deltagare":90,"lagkontakter":90,"chatt":180,"arenden":365,"pass":365,"ronder":365,"domare":365,"historik":365,"incidenter":730,"sjukvard":30}'::jsonb
$$;

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

    if public.retention_due(t, 'sjukvard') then
      delete from public.medical_requests where tenant_id = t and created_at < edge;
      get diagnostics n = row_count; res := res || jsonb_build_object('sjukvard', n);
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
    'sjukvardsbegaran', (select coalesce(jsonb_agg(to_jsonb(x) - 'tenant_id'), '[]') from public.medical_requests x where x.requested_by = p),
    'andringar_av_personen', (select count(*) from public.audit_log x where x.actor = p),
    'andringar_av_profilen', (select coalesce(jsonb_agg(jsonb_build_object('tid', x.created_at, 'andring', x.changes) order by x.created_at), '[]')
      from public.audit_log x where x.table_name = 'profiles' and x.record_id = p::text)
  );
end $$;

-- ============ 6. KONTROLL ============
select
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('medical_points', 'medical_requests'))                                as tabeller,
  (select count(*) from pg_proc where proname = 'run_retention' and prosrc like '%medical_requests%') as gallring,
  (select count(*) from pg_proc where proname = 'person_export' and prosrc like '%medical_requests%') as utdrag;
-- Ska vara 2, 1 och 1.
