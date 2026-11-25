-- Client test links (2026-11-25): a link a manager sends to a client so they can test Max on one
-- version (draft included) with no account and no sign-in: the portal's test panel (type, voice,
-- video) at /t/<token>, nothing else.
--
-- The token is shown once and stored only as its sha256 (like API keys, 009). A link is tied to one
-- version of one dealership, runs as the manager who made it (so it stops working if they lose access),
-- expires (1-30 days), can be revoked, and has caps on test turns and video sessions, because every
-- turn is an AI call and every video session spends avatar minutes.

create table test_link (
  id            uuid primary key default gen_random_uuid(),
  dealership_id text not null references dealership(id) on delete cascade,
  kind          text not null check (kind in ('script', 'price', 'kb')),
  version_id    uuid not null,
  prefix        text not null,
  token_hash    text not null unique,
  label         text not null default '' check (length(label) <= 80),
  created_by    uuid not null references app_user(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  turns_used    int not null default 0,
  max_turns     int not null default 400 check (max_turns between 1 and 5000),
  video_used    int not null default 0,
  max_video     int not null default 20 check (max_video between 0 and 200),
  last_used_at  timestamptz
);
create index test_link_dealership on test_link (dealership_id, created_at desc);
alter table test_link enable row level security;
create policy editors_read on test_link for select to app_user using (app.can_edit(dealership_id));
grant select on test_link to app_user;
create trigger audit after insert or update or delete on test_link for each row execute function app.audit();

-- A manager makes a link for a version of their dealership; returns the token (shown once)
create function app.create_test_link(d text, k text, v uuid, label text, days int) returns text
language plpgsql volatile security definer set search_path = public, app as $$
declare
  token text := 'mxt_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  ok boolean;
begin
  if app.current_user_id() is null or not app.can_edit(d) then raise exception 'only a manager of this dealership can share test links'; end if;
  if k = 'script' then select exists (select 1 from script_version where id = v and dealership_id = d) into ok;
  elsif k = 'price' then select exists (select 1 from price_ladder_version where id = v and dealership_id = d) into ok;
  elsif k = 'kb' then select exists (select 1 from kb_version where id = v and dealership_id = d) into ok;
  else ok := false;
  end if;
  if not ok then raise exception 'that version does not belong to this dealership'; end if;
  insert into test_link (dealership_id, kind, version_id, prefix, token_hash, label, created_by, expires_at)
  values (d, k, v, left(token, 12), encode(sha256(convert_to(token, 'UTF8')), 'hex'), left(coalesce(label, ''), 80),
          app.current_user_id(), now() + make_interval(days => greatest(1, least(coalesce(days, 7), 30))));
  return token;
end $$;

create function app.revoke_test_link(l uuid) returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare d text;
begin
  select dealership_id into d from test_link where id = l;
  if d is null or app.current_user_id() is null or not app.can_edit(d) then raise exception 'not allowed to turn off this link'; end if;
  update test_link set revoked_at = coalesce(revoked_at, now()) where id = l;
end $$;

-- The public side: a valid link (unrevoked, unexpired, under its caps) says what to test and as whom.
-- what = 'open' (the page; counts nothing), 'turn' (one test turn) or 'video' (one avatar session).
create function app.use_test_link(token text, what text)
returns table (created_by uuid, dealership_id text, dealership_name text, kind text, version_id uuid, expires_at timestamptz, label text)
language plpgsql volatile security definer set search_path = public, app as $$
declare
  t test_link;
begin
  select * into t from test_link x
   where x.token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex') and x.revoked_at is null and x.expires_at > now();
  if t.id is null then raise exception 'this test link has expired or was turned off' using errcode = '28000'; end if;
  if what = 'turn' then
    if t.turns_used >= t.max_turns then raise exception 'this test link has used all its test turns' using errcode = '53400'; end if;
    update test_link set turns_used = turns_used + 1, last_used_at = now() where id = t.id;
  elsif what = 'video' then
    if t.video_used >= t.max_video then raise exception 'this test link has used all its video calls' using errcode = '53400'; end if;
    update test_link set video_used = video_used + 1, last_used_at = now() where id = t.id;
  end if;
  return query select t.created_by, t.dealership_id, (select name from dealership where id = t.dealership_id), t.kind, t.version_id, t.expires_at, t.label;
end $$;

revoke all on function app.create_test_link(text, text, uuid, text, int), app.revoke_test_link(uuid), app.use_test_link(text, text) from public;
grant execute on function app.create_test_link(text, text, uuid, text, int), app.revoke_test_link(uuid), app.use_test_link(text, text) to app_user;
