-- Invite links for the portal. Sign-up is invite-only: without email verification, open sign-up would
-- let anyone register an invited person's email first and inherit their access. An admin who can add
-- the person to a dealership creates a one-time link; only its SHA-256 hash is stored; it expires.
create table invite (
  token_hash  text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  used_at     timestamptz
);
alter table invite enable row level security;
-- no policies: reached only through the two functions below

-- Who may invite this person: the platform owner, or anyone who can edit a dealership they belong to
-- (agency admins and managers), or the agency admin of an agency they belong to.
create function app.can_invite(u uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_platform_owner() or exists (
    select 1 from membership m
    where m.user_id = u
      and ((m.dealership_id is not null and app.can_edit(m.dealership_id))
        or (m.agency_id is not null and app.is_agency_member(m.agency_id)))
  )
$$;

-- A one-time token for the person (returned once, stored only as a hash)
create function app.create_invite(u uuid) returns text
language plpgsql volatile security definer set search_path = public, app as $$
declare
  token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if app.current_user_id() is null or not app.can_invite(u) then
    raise exception 'not allowed to invite this person';
  end if;
  -- one live invite per person: a new link replaces the old one
  delete from invite where user_id = u and used_at is null;
  insert into invite (token_hash, user_id, created_by)
  values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), u, app.current_user_id());
  return token;
end $$;

-- The invited email, if the token is valid (unused, not expired); marks it used
create function app.redeem_invite(token text) returns text
language plpgsql volatile security definer set search_path = public, app as $$
declare
  e text;
begin
  update invite i set used_at = now()
    from app_user u
   where i.token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
     and i.used_at is null and i.expires_at > now() and u.id = i.user_id
  returning u.email into e;
  return e;
end $$;

-- What an invite link is for, without using it (the sign-up page shows the email)
create function app.peek_invite(token text) returns text
language sql stable security definer set search_path = public, app as $$
  select u.email from invite i join app_user u on u.id = i.user_id
   where i.token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex') and i.used_at is null and i.expires_at > now()
$$;

-- Add a person to a dealership in a role, creating them if new (a new person is not yet visible to the
-- caller, so this cannot be two plain inserts under row-level security). Same rules as the membership
-- policies: managers and viewers by anyone who can edit the dealership; approvers by its agency admin
-- or the platform owner.
create function app.add_person(e text, d text, r text) returns uuid
language plpgsql volatile security definer set search_path = public, app as $$
declare
  u uuid;
begin
  if r not in ('manager', 'approver', 'viewer') then raise exception 'unknown role %', r; end if;
  if r in ('manager', 'viewer') and not app.can_edit(d) then raise exception 'not allowed to add people to this dealership'; end if;
  if r = 'approver' and not (app.dealership_roles(d) && array['platform_owner', 'agency_admin']) then
    raise exception 'only the agency admin or the platform owner can add an approver';
  end if;
  insert into app_user (email) values (lower(trim(e))) on conflict (email) do nothing;
  select id into u from app_user where email = lower(trim(e));
  insert into membership (user_id, dealership_id, role) values (u, d, r) on conflict do nothing;
  return u;
end $$;

revoke all on function app.can_invite(uuid), app.create_invite(uuid), app.redeem_invite(text), app.peek_invite(text), app.add_person(text, text, text) from public;
grant execute on function app.create_invite(uuid), app.redeem_invite(text), app.peek_invite(text), app.add_person(text, text, text) to app_user;
