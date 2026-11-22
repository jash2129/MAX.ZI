-- On managed Postgres (Neon, Supabase) the migrating owner is not a superuser, and since Postgres 16
-- creating a role does not make you a member of it. The owner needs to act as these roles for admin
-- work such as seeding (asUser / asService use SET LOCAL ROLE). It can already change every table, so
-- this grants no new reach. Services still log in as their own roles, never as the owner.
do $$
declare r text;
begin
  foreach r in array array['app_user', 'brain_service', 'worker_service', 'gate_service'] loop
    if not pg_has_role(current_user, r, 'member') then
      execute format('grant %I to %I', r, current_user);
    end if;
  end loop;
end $$;
