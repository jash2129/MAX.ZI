-- 002 skipped its grants on Postgres 16+: a role's creator already holds an ADMIN membership, which
-- pg_has_role reports as membership, but with SET off, so SET ROLE is still refused (seen on Neon,
-- Postgres 18.7). Grant SET explicitly. INHERIT stays off: the owner does not silently take on these
-- roles' privileges, it only switches to them when asked (asUser / asService).
do $$
declare r text;
begin
  foreach r in array array['app_user', 'brain_service', 'worker_service', 'gate_service'] loop
    if not exists (
      select 1 from pg_auth_members m
      join pg_roles g on g.oid = m.roleid
      join pg_roles u on u.oid = m.member
      where g.rolname = r and u.rolname = current_user and m.set_option
    ) and not (select rolsuper from pg_roles where rolname = current_user) then
      execute format('grant %I to %I with set true, inherit false', r, current_user);
    end if;
  end loop;
end $$;
