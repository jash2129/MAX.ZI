-- Portal sign-in: the signed-in email's app_user id, looked up before the portal knows who the person is
-- (row-level security on app_user would hide the row until app.user_id is set). Returns only the id, and
-- only for an exact email, so it reveals nothing that the sign-in itself does not.
create function app.user_id_for_email(e text) returns uuid
language sql stable security definer set search_path = public, app as $$
  select id from app_user where email = lower(e)
$$;
revoke all on function app.user_id_for_email(text) from public;
grant execute on function app.user_id_for_email(text) to app_user;
