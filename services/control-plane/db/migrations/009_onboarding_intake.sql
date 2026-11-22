-- Onboarding without code, the deal intake API, and retention.

-- ---------------------------------------------------------------------------------------------------
-- 1. Onboarding: a new dealership starts with DRAFT versions copied from a template dealership. They go
--    through the release gate and approval like any change; until then the brain refuses its calls.
-- ---------------------------------------------------------------------------------------------------
create function app.create_dealership(new_id text, new_name text, agency text, template text, vehicle jsonb, keyterms text[])
returns void
language plpgsql volatile security definer set search_path = public, app as $$
begin
  if app.current_user_id() is null then raise exception 'sign in first'; end if;
  if agency is null and not app.is_platform_owner() then
    raise exception 'only the platform owner can create a dealership outside an agency';
  end if;
  if agency is not null and not (app.is_platform_owner() or exists (
      select 1 from membership m where m.user_id = app.current_user_id() and m.agency_id = agency and m.role = 'agency_admin')) then
    raise exception 'only the agency admin can create dealerships in this agency';
  end if;
  -- the template must be one the creator can read (its content becomes the new dealership's drafts)
  if not app.can_read(template) then raise exception 'unknown template dealership'; end if;

  insert into dealership (id, agency_id, name, default_vehicle, speech_keyterms)
  values (new_id, agency, new_name, coalesce(vehicle, '{}'), coalesce(keyterms, '{}'));

  insert into script_version (dealership_id, beats, disclosure, fixed_lines, recaps, notes)
    select new_id, beats, disclosure, fixed_lines, recaps, 'Copied from ' || template || ' v' || version
      from script_version where dealership_id = template and status = 'live';
  insert into price_ladder_version (dealership_id, steps, products, notes)
    select new_id, steps, products, 'Copied from ' || template || ' v' || version
      from price_ladder_version where dealership_id = template and status = 'live';
  insert into kb_version (dealership_id, facts, notes)
    select new_id, facts, 'Copied from ' || template || ' v' || version
      from kb_version where dealership_id = template and status = 'live';
end $$;
revoke all on function app.create_dealership(text, text, text, text, jsonb, text[]) from public;
grant execute on function app.create_dealership(text, text, text, text, jsonb, text[]) to app_user;

-- ---------------------------------------------------------------------------------------------------
-- 2. Deal intake: per-dealership API keys (hashed, shown once, revocable) and one narrow function
--    that takes a deal for the key's dealership only.
-- ---------------------------------------------------------------------------------------------------
create table api_key (
  id            uuid primary key default gen_random_uuid(),
  dealership_id text not null references dealership(id) on delete cascade,
  prefix        text not null,             -- first characters, to tell keys apart in the portal
  key_hash      text not null unique,      -- sha256 hex of the whole key
  label         text not null default '',
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
alter table api_key enable row level security;
create policy editors_read on api_key for select to app_user using (app.can_edit(dealership_id));
grant select on api_key to app_user;
create trigger audit after insert or update or delete on api_key for each row execute function app.audit();

create function app.create_api_key(d text, label text) returns text
language plpgsql volatile security definer set search_path = public, app as $$
declare
  token text := 'mxk_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if app.current_user_id() is null or not app.can_edit(d) then raise exception 'only a manager of this dealership can create API keys'; end if;
  insert into api_key (dealership_id, prefix, key_hash, label, created_by)
  values (d, left(token, 12), encode(sha256(convert_to(token, 'UTF8')), 'hex'), coalesce(label, ''), app.current_user_id());
  return token;
end $$;

create function app.revoke_api_key(k uuid) returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare d text;
begin
  select dealership_id into d from api_key where id = k;
  if d is null or app.current_user_id() is null or not app.can_edit(d) then raise exception 'not allowed to revoke this key'; end if;
  update api_key set revoked_at = coalesce(revoked_at, now()) where id = k;
end $$;

-- The intake itself: a valid, unrevoked key takes a deal for ITS dealership (2-hour expiry)
create function app.intake_deal(token text, external_ref text, vehicle jsonb, customer_first_name text) returns table (deal_id uuid, dealership_id text, expires_at timestamptz)
language plpgsql volatile security definer set search_path = public, app as $$
declare
  d text;
  kid uuid;
begin
  select k.dealership_id, k.id into d, kid from api_key k
   where k.key_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex') and k.revoked_at is null;
  if d is null then raise exception 'invalid API key' using errcode = '28000'; end if;
  update api_key set last_used_at = now() where id = kid;
  return query
    insert into deal (dealership_id, external_ref, vehicle, customer_first_name)
    values (d, left(external_ref, 80), coalesce(vehicle, '{}'), left(customer_first_name, 60))
    returning deal.id, deal.dealership_id, deal.expires_at;
end $$;

revoke all on function app.create_api_key(text, text), app.revoke_api_key(uuid), app.intake_deal(text, text, jsonb, text) from public;
grant execute on function app.create_api_key(text, text), app.revoke_api_key(uuid), app.intake_deal(text, text, jsonb, text) to app_user;

-- The brain reads a call's deal (unexpired) to know the vehicle before the first word
grant select on deal to brain_service;
create policy brain_read on deal for select to brain_service using (expires_at > now());

-- ---------------------------------------------------------------------------------------------------
-- 3. Retention and maintenance (run by the owner on a schedule: control-plane `npm run maintain`)
-- ---------------------------------------------------------------------------------------------------
-- Forget one call's content on request (PRD: deletion on request within 30 days): transcript, review
-- text and recording go; the call row stays with its outcome and no content, for counts and billing.
-- Internal: no permission check, so not granted to anyone (the owner runs it: CLI `forget-call`)
create function app.forget_call_now(c text) returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare d text;
begin
  select dealership_id into d from call where id = c;
  if d is null then raise exception 'no such call'; end if;
  delete from turn where call_id = c;
  delete from recording where call_id = c;
  update call_review set summary = null, problems = '[]', scorecard = '{}' where call_id = c;
  update call set panels_shown = '[]', deal_id = null where id = c;
  insert into audit_log (actor, db_role, table_name, row_id, dealership_id, action)
  values (app.current_user_id(), app.caller_role(), 'call', c, d, 'forget');
end $$;
revoke all on function app.forget_call_now(text) from public;

-- For people (the portal): a signed-in manager of the call's dealership
create function app.forget_call(c text) returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare d text;
begin
  select dealership_id into d from call where id = c;
  if d is null or app.current_user_id() is null or not app.can_edit(d) then raise exception 'not allowed to delete this call'; end if;
  perform app.forget_call_now(c);
end $$;
revoke all on function app.forget_call(text) from public;
grant execute on function app.forget_call(text) to app_user;
