-- Portal sign-in (Better Auth) keeps its tables (users' passwords, sessions, two-factor secrets) in their
-- own schema, reached only through auth_service. auth_service has no rights on any tenant table, and
-- the people-facing roles have none on the auth schema. Better Auth creates its tables itself
-- (services/portal: npm run auth:migrate), connected as a login in auth_service whose search_path is
-- auth (control-plane: npm run service-login -- auth_service ...).
create schema if not exists auth;

do $$ begin
  create role auth_service nologin;    exception when duplicate_object then null; end $$;

grant usage, create on schema auth to auth_service;
revoke all on schema auth from public;

-- the migrating owner may act as it, like the other service roles (see 003)
do $$
begin
  if not exists (
    select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
    where g.rolname = 'auth_service' and u.rolname = current_user and m.set_option
  ) and not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant auth_service to %I with set true, inherit false', current_user);
  end if;
end $$;
