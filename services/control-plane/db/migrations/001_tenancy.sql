-- Control plane, migration 001: tenants, people, versioned dealership config, call records, audit.
--
-- Tenancy is enforced by Postgres row-level security (PRD "Data model"): the application connects as
-- a role without BYPASSRLS and, per request, sets the signed-in person:
--     begin; set local role app_user; select set_config('app.user_id', '<uuid>', true); ...
-- Every policy decides from that, so a bug in application filtering cannot leak another tenant's rows.
--
-- Roles:
--   app_user       people using the portal (platform owner, agency admin, dealership manager/approver/viewer)
--   brain_service  the brain: reads dealerships and their LIVE config only
--   worker_service the voice worker: writes call records
--   gate_service   the release test gate: records simulator results on versions in test

-- Needs Postgres 13+ (gen_random_uuid is built in).

do $$ begin
  create role app_user nologin;        exception when duplicate_object then null; end $$;
do $$ begin
  create role brain_service nologin;   exception when duplicate_object then null; end $$;
do $$ begin
  create role worker_service nologin;  exception when duplicate_object then null; end $$;
do $$ begin
  create role gate_service nologin;    exception when duplicate_object then null; end $$;

create schema if not exists app;
grant usage on schema app to app_user, brain_service, worker_service, gate_service;

-- ---------------------------------------------------------------------------------------------------
-- Tenants and people
-- ---------------------------------------------------------------------------------------------------

create table agency (
  id              text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name            text not null check (length(trim(name)) > 0),
  wholesale_plan  jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create table dealership (
  id               text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  agency_id        text references agency(id),
  name             text not null check (length(trim(name)) > 0),
  max_display_name text not null default 'Max',
  branding         jsonb not null default '{}',   -- logo, colours, font
  avatar           jsonb not null default '{}',   -- {avatar_id, voice}
  mode             text not null default 'guided' check (mode in ('scripted', 'guided', 'free')),
  default_vehicle  jsonb not null default '{}',   -- {year, make, model}
  speech_keyterms  text[] not null default '{}',
  timezone         text not null default 'America/Chicago',
  region           text not null default 'us-east',
  retention        jsonb not null default '{"recordings_days": 90, "transcripts_days": 365}',
  created_at       timestamptz not null default now()
);
create index on dealership (agency_id);

create table app_user (
  id                uuid primary key default gen_random_uuid(),
  email             text not null unique check (email = lower(email) and email like '%@%'),
  display_name      text not null default '',
  is_platform_owner boolean not null default false,
  created_at        timestamptz not null default now()
);

create table membership (
  user_id       uuid not null references app_user(id) on delete cascade,
  agency_id     text references agency(id) on delete cascade,
  dealership_id text references dealership(id) on delete cascade,
  role          text not null,
  created_at    timestamptz not null default now(),
  check ((agency_id is null) <> (dealership_id is null)),
  check ((agency_id is not null and role = 'agency_admin')
      or (dealership_id is not null and role in ('manager', 'approver', 'viewer')))
);
create unique index membership_agency_uq on membership (user_id, agency_id) where agency_id is not null;
create unique index membership_dealership_uq on membership (user_id, dealership_id, role) where dealership_id is not null;

-- ---------------------------------------------------------------------------------------------------
-- Who may do what (SECURITY DEFINER so policies can read membership without granting it wholesale)
-- ---------------------------------------------------------------------------------------------------

create function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- The caller's role, also inside SECURITY DEFINER functions (where current_user is the owner):
-- the role set with SET ROLE, else the login role.
create function app.caller_role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('role', true), 'none'), session_user::text)
$$;

create function app.is_platform_owner() returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((select is_platform_owner from app_user where id = app.current_user_id()), false)
$$;

-- Every role the current person holds for a dealership, including through its agency
create function app.dealership_roles(d text) returns text[]
language sql stable security definer set search_path = public, app as $$
  select coalesce(array_agg(distinct r), '{}') from (
    select 'platform_owner' as r where app.is_platform_owner()
    union all
    select m.role from membership m where m.user_id = app.current_user_id() and m.dealership_id = d
    union all
    select 'agency_admin' from membership m join dealership x on x.agency_id = m.agency_id
      where m.user_id = app.current_user_id() and x.id = d
  ) s
$$;

create function app.can_read(d text) returns boolean
language sql stable as $$ select cardinality(app.dealership_roles(d)) > 0 $$;

create function app.can_edit(d text) returns boolean
language sql stable as $$ select app.dealership_roles(d) && array['platform_owner', 'agency_admin', 'manager'] $$;

-- Approval (the TXM sign-off). Open PRD question: should an agency admin also approve for its
-- dealerships? Until answered, only the dealership's approver (or the platform owner) can.
create function app.can_approve(d text) returns boolean
language sql stable as $$ select app.dealership_roles(d) && array['platform_owner', 'approver'] $$;

create function app.is_agency_member(a text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_platform_owner()
      or exists (select 1 from membership m where m.user_id = app.current_user_id() and m.agency_id = a)
$$;

-- People the current person may see: themselves, and anyone sharing a tenant they can read
create function app.can_see_user(u uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select u = app.current_user_id() or app.is_platform_owner() or exists (
    select 1 from membership m
    where m.user_id = u
      and ((m.dealership_id is not null and app.can_read(m.dealership_id))
        or (m.agency_id is not null and app.is_agency_member(m.agency_id)))
  )
$$;

-- ---------------------------------------------------------------------------------------------------
-- Versioned config: script, price ladder, knowledge base (PRD "Script, price and knowledge-base versions")
--
--   draft -> in_test -> (gate passes, approver approves) -> live -> retired
--                 \-> draft (back to editing)                  retired -> live (one-step rollback)
--
-- Content is immutable once a version leaves draft. One live version per dealership per kind.
-- Calls in progress keep the version they started with (the call row records the version ids).
-- ---------------------------------------------------------------------------------------------------

create function app.valid_ladder(steps numeric[]) returns boolean
language sql immutable as $$
  select cardinality(steps) between 1 and 8
     and (select bool_and(s > 0 and s <= 100) from unnest(steps) s)
     and (select bool_and(steps[i] > steps[i + 1]) from generate_subscripts(steps, 1) i where i < cardinality(steps)) is not false
$$;

create table script_version (
  id            uuid primary key default gen_random_uuid(),
  dealership_id text not null references dealership(id) on delete cascade,
  version       int not null,
  status        text not null default 'draft' check (status in ('draft', 'in_test', 'approved', 'live', 'retired')),
  beats         jsonb not null check (jsonb_typeof(beats) = 'array' and jsonb_array_length(beats) > 0),
  disclosure    text not null check (length(trim(disclosure)) > 0),
  fixed_lines   jsonb not null default '{}',     -- unknown question, handoff, closing ...
  notes         text not null default '',
  test_result   jsonb,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  approved_by   uuid references app_user(id),
  approved_at   timestamptz,
  live_at       timestamptz,
  retired_at    timestamptz,
  unique (dealership_id, version)
);

create table price_ladder_version (
  id            uuid primary key default gen_random_uuid(),
  dealership_id text not null references dealership(id) on delete cascade,
  version       int not null,
  status        text not null default 'draft' check (status in ('draft', 'in_test', 'approved', 'live', 'retired')),
  steps         numeric(6, 2)[] not null check (app.valid_ladder(steps::numeric[])),  -- daily rates, highest first
  floor         numeric(6, 2) generated always as (steps[cardinality(steps)]) stored,
  products      jsonb not null default '[]',     -- the bundle and its coverage terms
  notes         text not null default '',
  test_result   jsonb,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  approved_by   uuid references app_user(id),
  approved_at   timestamptz,
  live_at       timestamptz,
  retired_at    timestamptz,
  unique (dealership_id, version)
);

create table kb_version (
  id            uuid primary key default gen_random_uuid(),
  dealership_id text not null references dealership(id) on delete cascade,
  version       int not null,
  status        text not null default 'draft' check (status in ('draft', 'in_test', 'approved', 'live', 'retired')),
  facts         jsonb not null default '[]' check (jsonb_typeof(facts) = 'array'),  -- [{topic, answer, keywords}]
  notes         text not null default '',
  test_result   jsonb,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  approved_by   uuid references app_user(id),
  approved_at   timestamptz,
  live_at       timestamptz,
  retired_at    timestamptz,
  unique (dealership_id, version)
);

create unique index script_one_live on script_version (dealership_id) where status = 'live';
create unique index price_one_live on price_ladder_version (dealership_id) where status = 'live';
create unique index kb_one_live on kb_version (dealership_id) where status = 'live';

-- Facts every dealership inherits (platform owner maintains them)
create table shared_fact (
  id         uuid primary key default gen_random_uuid(),
  topic      text not null,
  answer     text not null,
  keywords   text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Lifecycle guard, shared by the three version tables
create function app.guard_version() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  -- Lifecycle fields may change after draft; `floor` is generated from steps (and is not yet computed
  -- in a BEFORE trigger), so it is compared through steps.
  lifecycle constant text[] := array['status', 'test_result', 'approved_by', 'approved_at', 'live_at', 'retired_at', 'floor'];
  old_content jsonb;
  new_content jsonb;
  publishing boolean := coalesce(current_setting('app.publishing', true), '') = 'on';
  gate boolean := coalesce(current_setting('app.gate', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'new versions start as draft';
    end if;
    execute format('select coalesce(max(version), 0) + 1 from %I where dealership_id = $1', tg_table_name)
      into new.version using new.dealership_id;
    new.created_by := app.current_user_id();
    new.test_result := null; new.approved_by := null; new.approved_at := null; new.live_at := null; new.retired_at := null;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'only drafts can be deleted (version % is %)', old.version, old.status;
    end if;
    return old;
  end if;

  -- UPDATE
  old_content := to_jsonb(old) - lifecycle;
  new_content := to_jsonb(new) - lifecycle;
  if old.status <> 'draft' and old_content is distinct from new_content then
    raise exception 'version % is %: its content cannot change (start a new draft)', old.version, old.status;
  end if;
  if new.id <> old.id or new.dealership_id <> old.dealership_id or new.version <> old.version then
    raise exception 'id, dealership and version number never change';
  end if;

  if new.test_result is distinct from old.test_result and not gate then
    raise exception 'test results are recorded by the test gate only';
  end if;

  if new.status is distinct from old.status then
    if (old.status, new.status) in (('draft', 'in_test'), ('in_test', 'draft')) then
      if not app.can_edit(new.dealership_id) then raise exception 'not allowed to submit for test'; end if;
      if new.status = 'draft' then new.test_result := null; end if;
    elsif publishing and (old.status, new.status) in (('in_test', 'live'), ('approved', 'live'), ('retired', 'live'), ('live', 'retired')) then
      null;  -- only through app.approve_version / app.rollback_to
    else
      raise exception 'status cannot go from % to % directly', old.status, new.status;
    end if;
  elsif old.status <> 'draft' and (new.approved_by is distinct from old.approved_by or new.live_at is distinct from old.live_at) and not publishing then
    raise exception 'approval fields are set by app.approve_version only';
  end if;
  return new;
end $$;

create trigger guard before insert or update or delete on script_version for each row execute function app.guard_version();
create trigger guard before insert or update or delete on price_ladder_version for each row execute function app.guard_version();
create trigger guard before insert or update or delete on kb_version for each row execute function app.guard_version();

create function app.version_table(kind text) returns text
language sql immutable as $$
  select case kind when 'script' then 'script_version' when 'price' then 'price_ladder_version' when 'kb' then 'kb_version' end
$$;

-- Release gate (PRD): at least 16 simulated calls, zero hard failures, and completion no more than
-- 5 points below the live version's.
create function app.gate_passes(result jsonb, live_result jsonb) returns boolean
language sql immutable as $$
  select result is not null
     and coalesce((result ->> 'calls')::int, 0) >= 16
     and coalesce((result ->> 'hard_failures')::int, 1) = 0
     and (live_result is null or live_result ->> 'completion_rate' is null
          or (result ->> 'completion_rate')::numeric >= (live_result ->> 'completion_rate')::numeric - 5)
$$;

-- The test gate records its simulator suite result on a version in test
create function app.record_test_result(kind text, version_id uuid, result jsonb) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  t text := app.version_table(kind);
  st text;
begin
  if t is null then raise exception 'unknown kind %', kind; end if;
  if app.caller_role() <> 'gate_service' and not app.is_platform_owner() then
    raise exception 'only the test gate records results';
  end if;
  execute format('select status from %I where id = $1', t) into st using version_id;
  if st is distinct from 'in_test' then raise exception 'version is not in test'; end if;
  perform set_config('app.gate', 'on', true);
  execute format('update %I set test_result = $2 where id = $1', t) using version_id, result;
  perform set_config('app.gate', '', true);
end $$;

-- Approve a version in test and make it live for new calls; the previous live version is retired.
create function app.approve_version(kind text, version_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  t text := app.version_table(kind);
  d text; st text; res jsonb; live_res jsonb;
begin
  if t is null then raise exception 'unknown kind %', kind; end if;
  execute format('select dealership_id, status, test_result from %I where id = $1 for update', t)
    into d, st, res using version_id;
  if d is null then raise exception 'no such version'; end if;
  if not app.can_approve(d) then raise exception 'only an approver can approve'; end if;
  if st <> 'in_test' then raise exception 'only a version in test can be approved (this one is %)', st; end if;
  execute format('select test_result from %I where dealership_id = $1 and status = ''live''', t) into live_res using d;
  if not app.gate_passes(res, live_res) then
    raise exception 'release gate not passed: %', coalesce(res::text, 'no test result');
  end if;
  perform set_config('app.publishing', 'on', true);
  execute format('update %I set status = ''retired'', retired_at = now() where dealership_id = $1 and status = ''live''', t) using d;
  execute format('update %I set status = ''live'', approved_by = $2, approved_at = now(), live_at = now() where id = $1', t)
    using version_id, app.current_user_id();
  perform set_config('app.publishing', '', true);
end $$;

-- One-step rollback: a retired (previously approved) version becomes live again
create function app.rollback_to(kind text, version_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  t text := app.version_table(kind);
  d text; st text;
begin
  if t is null then raise exception 'unknown kind %', kind; end if;
  execute format('select dealership_id, status from %I where id = $1 for update', t) into d, st using version_id;
  if d is null then raise exception 'no such version'; end if;
  if not app.can_approve(d) then raise exception 'only an approver can roll back'; end if;
  if st <> 'retired' then raise exception 'only a retired version can be restored (this one is %)', st; end if;
  perform set_config('app.publishing', 'on', true);
  execute format('update %I set status = ''retired'', retired_at = now() where dealership_id = $1 and status = ''live''', t) using d;
  execute format('update %I set status = ''live'', live_at = now(), retired_at = null where id = $1', t) using version_id;
  perform set_config('app.publishing', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Call records (written by the voice worker; tables exist now so tenancy is never retrofitted)
-- ---------------------------------------------------------------------------------------------------

create table deal (
  id                  uuid primary key default gen_random_uuid(),
  dealership_id       text not null references dealership(id) on delete cascade,
  external_ref        text,
  vehicle             jsonb not null default '{}',
  customer_first_name text,
  expires_at          timestamptz not null default now() + interval '2 hours',
  created_at          timestamptz not null default now()
);

create table call (
  id                text primary key,
  dealership_id     text not null references dealership(id) on delete cascade,
  deal_id           uuid references deal(id) on delete set null,
  script_version_id uuid references script_version(id),
  price_version_id  uuid references price_ladder_version(id),
  kb_version_id     uuid references kb_version(id),
  consent_at        timestamptz,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  end_reason        text,
  furthest_beat     int,
  final_rate        numeric(6, 2),
  declined          boolean,
  cost              jsonb not null default '{}'
);
create index on call (dealership_id, started_at desc);

create table turn (
  call_id        text not null references call(id) on delete cascade,
  dealership_id  text not null references dealership(id) on delete cascade,
  idx            int not null,
  customer_text  text,
  max_text       text,
  beat_before    int,
  beat_after     int,
  understanding  text,
  wording_source text,
  heard          boolean,
  fraction_heard numeric(4, 3),
  timings        jsonb not null default '{}',
  primary key (call_id, idx)
);

create table recording (
  call_id         text primary key references call(id) on delete cascade,
  dealership_id   text not null references dealership(id) on delete cascade,
  storage_key     text not null,
  duration_s      numeric,
  retention_until timestamptz not null
);

create table call_review (
  call_id           text primary key references call(id) on delete cascade,
  dealership_id     text not null references dealership(id) on delete cascade,
  score             numeric,
  summary           text,
  problems          jsonb not null default '[]',
  sentiment         text,
  compliance_checks jsonb not null default '{}',
  created_at        timestamptz not null default now()
);

create table usage_event (
  id            bigserial primary key,
  dealership_id text not null references dealership(id) on delete cascade,
  agency_id     text references agency(id),
  call_id       text references call(id) on delete set null,
  minutes       numeric not null default 0,
  vendor_costs  jsonb not null default '{}',
  at            timestamptz not null default now()
);

-- A call's rows must belong to the call's dealership (no cross-tenant child rows)
create function app.same_tenant_as_call() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.call_id is not null and not exists (select 1 from call c where c.id = new.call_id and c.dealership_id = new.dealership_id) then
    raise exception 'row belongs to a call of another dealership';
  end if;
  return new;
end $$;
create trigger tenant_check before insert or update on turn for each row execute function app.same_tenant_as_call();
create trigger tenant_check before insert or update on recording for each row execute function app.same_tenant_as_call();
create trigger tenant_check before insert or update on call_review for each row execute function app.same_tenant_as_call();
create trigger tenant_check before insert or update on usage_event for each row execute function app.same_tenant_as_call();

-- ---------------------------------------------------------------------------------------------------
-- Audit log: every config change and approval (PRD "Access")
-- ---------------------------------------------------------------------------------------------------

create table audit_log (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor         uuid,
  db_role       text not null,
  table_name    text not null,
  row_id        text,
  dealership_id text,
  action        text not null,
  before        jsonb,
  after         jsonb
);
create index on audit_log (dealership_id, at desc);

create function app.audit() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  rowj jsonb := coalesce(a, b);
begin
  insert into audit_log (actor, db_role, table_name, row_id, dealership_id, action, before, after)
  values (app.current_user_id(), app.caller_role(), tg_table_name, coalesce(rowj ->> 'id', rowj ->> 'user_id'),
          case when tg_table_name = 'dealership' then rowj ->> 'id' else rowj ->> 'dealership_id' end,
          lower(tg_op), b, a);
  return null;
end $$;

create trigger audit after insert or update or delete on dealership for each row execute function app.audit();
create trigger audit after insert or update or delete on membership for each row execute function app.audit();
create trigger audit after insert or update or delete on script_version for each row execute function app.audit();
create trigger audit after insert or update or delete on price_ladder_version for each row execute function app.audit();
create trigger audit after insert or update or delete on kb_version for each row execute function app.audit();
create trigger audit after insert or update or delete on shared_fact for each row execute function app.audit();

-- ---------------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------------

alter table agency enable row level security;
alter table dealership enable row level security;
alter table app_user enable row level security;
alter table membership enable row level security;
alter table script_version enable row level security;
alter table price_ladder_version enable row level security;
alter table kb_version enable row level security;
alter table shared_fact enable row level security;
alter table deal enable row level security;
alter table call enable row level security;
alter table turn enable row level security;
alter table recording enable row level security;
alter table call_review enable row level security;
alter table usage_event enable row level security;
alter table audit_log enable row level security;

-- People (app_user)
create policy read on agency for select to app_user using (app.is_agency_member(id));
create policy owner_write on agency for all to app_user using (app.is_platform_owner()) with check (app.is_platform_owner());

create policy read on dealership for select to app_user using (app.can_read(id));
create policy edit on dealership for update to app_user using (app.can_edit(id)) with check (app.can_edit(id));
create policy create_d on dealership for insert to app_user
  with check (app.is_platform_owner() or (agency_id is not null and app.is_agency_member(agency_id)));

create policy read on app_user for select to app_user using (app.can_see_user(id));
create policy self_edit on app_user for update to app_user
  using (id = app.current_user_id() or app.is_platform_owner())
  with check (app.is_platform_owner() or (id = app.current_user_id() and is_platform_owner = false));
create policy owner_insert on app_user for insert to app_user with check (app.is_platform_owner() or not is_platform_owner);

create policy read on membership for select to app_user
  using ((dealership_id is not null and app.can_read(dealership_id)) or (agency_id is not null and app.is_agency_member(agency_id)));
-- Managers add managers and viewers; approvers and agency admins are granted by the agency or platform
create policy grant_d on membership for insert to app_user
  with check (dealership_id is not null and (
      (role in ('manager', 'viewer') and app.can_edit(dealership_id))
   or (role = 'approver' and app.dealership_roles(dealership_id) && array['platform_owner', 'agency_admin'])));
create policy grant_a on membership for insert to app_user with check (agency_id is not null and app.is_platform_owner());
create policy revoke on membership for delete to app_user
  using ((dealership_id is not null and app.dealership_roles(dealership_id) && array['platform_owner', 'agency_admin'])
      or (agency_id is not null and app.is_platform_owner()));

-- Versions: read by anyone in the dealership; written by editors; lifecycle enforced by the trigger
create policy read on script_version for select to app_user using (app.can_read(dealership_id));
create policy read on price_ladder_version for select to app_user using (app.can_read(dealership_id));
create policy read on kb_version for select to app_user using (app.can_read(dealership_id));
create policy write on script_version for insert to app_user with check (app.can_edit(dealership_id));
create policy write on price_ladder_version for insert to app_user with check (app.can_edit(dealership_id));
create policy write on kb_version for insert to app_user with check (app.can_edit(dealership_id));
create policy edit on script_version for update to app_user using (app.can_edit(dealership_id)) with check (app.can_edit(dealership_id));
create policy edit on price_ladder_version for update to app_user using (app.can_edit(dealership_id)) with check (app.can_edit(dealership_id));
create policy edit on kb_version for update to app_user using (app.can_edit(dealership_id)) with check (app.can_edit(dealership_id));
create policy del on script_version for delete to app_user using (app.can_edit(dealership_id));
create policy del on price_ladder_version for delete to app_user using (app.can_edit(dealership_id));
create policy del on kb_version for delete to app_user using (app.can_edit(dealership_id));

create policy read on shared_fact for select to app_user using (true);
create policy owner_write on shared_fact for all to app_user using (app.is_platform_owner()) with check (app.is_platform_owner());

-- Call records: read by anyone in the dealership; never written by people
create policy read on deal for select to app_user using (app.can_read(dealership_id));
create policy read on call for select to app_user using (app.can_read(dealership_id));
create policy read on turn for select to app_user using (app.can_read(dealership_id));
create policy read on recording for select to app_user using (app.can_read(dealership_id));
create policy read on call_review for select to app_user using (app.can_read(dealership_id));
create policy read on usage_event for select to app_user using (app.can_read(dealership_id));
create policy read on audit_log for select to app_user
  using (app.is_platform_owner() or (dealership_id is not null and app.can_read(dealership_id)));

-- Brain: dealerships and LIVE config only (never drafts, never call records)
create policy brain_read on dealership for select to brain_service using (true);
create policy brain_read on script_version for select to brain_service using (status = 'live');
create policy brain_read on price_ladder_version for select to brain_service using (status = 'live');
create policy brain_read on kb_version for select to brain_service using (status = 'live');
create policy brain_read on shared_fact for select to brain_service using (active);

-- Voice worker: writes call records for any dealership (it serves them all), reads dealerships
create policy worker_read on dealership for select to worker_service using (true);
create policy worker_all on deal for all to worker_service using (true) with check (true);
create policy worker_all on call for all to worker_service using (true) with check (true);
create policy worker_all on turn for all to worker_service using (true) with check (true);
create policy worker_all on recording for all to worker_service using (true) with check (true);
create policy worker_all on call_review for all to worker_service using (true) with check (true);
create policy worker_all on usage_event for all to worker_service using (true) with check (true);

-- Test gate: reads versions in test, records results through app.record_test_result
create policy gate_read on script_version for select to gate_service using (status in ('in_test', 'live'));
create policy gate_read on price_ladder_version for select to gate_service using (status in ('in_test', 'live'));
create policy gate_read on kb_version for select to gate_service using (status in ('in_test', 'live'));
create policy gate_read on dealership for select to gate_service using (true);

-- Table grants (RLS then narrows every one of them to rows)
grant select, insert, update, delete on agency, dealership, app_user, membership,
  script_version, price_ladder_version, kb_version, shared_fact to app_user;
grant select on deal, call, turn, recording, call_review, usage_event, audit_log to app_user;
grant select on dealership, script_version, price_ladder_version, kb_version, shared_fact to brain_service;
grant select on dealership to worker_service;
grant select, insert, update on deal, call, turn, recording, call_review, usage_event to worker_service;
grant usage on sequence usage_event_id_seq to worker_service;
grant select on dealership, script_version, price_ladder_version, kb_version to gate_service;

revoke all on function app.approve_version(text, uuid), app.rollback_to(text, uuid), app.record_test_result(text, uuid, jsonb) from public;
grant execute on function app.approve_version(text, uuid), app.rollback_to(text, uuid) to app_user;
grant execute on function app.record_test_result(text, uuid, jsonb) to gate_service, app_user;
