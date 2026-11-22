-- Call records are written by the brain (it decides every turn, so it has the turns, the beats, the
-- versions and, via the voice worker's commits, what was heard and the stage timings). It writes them
-- off the call's critical path. brain_service may now also write call records, for any dealership (it
-- serves them all), and read them back for the after-call review.
grant select, insert, update on call, turn, call_review, usage_event to brain_service;
grant usage on sequence usage_event_id_seq to brain_service;
create policy brain_write on call for all to brain_service using (true) with check (true);
create policy brain_write on turn for all to brain_service using (true) with check (true);
create policy brain_write on call_review for all to brain_service using (true) with check (true);
create policy brain_write on usage_event for all to brain_service using (true) with check (true);

-- What was on screen and how the call went, and the dealership webhook's delivery
alter table call add column if not exists panels_shown jsonb not null default '[]';
alter table call add column if not exists turns_count int not null default 0;
alter table call add column if not exists webhook_delivered_at timestamptz;
alter table call add column if not exists webhook_error text;
alter table turn add column if not exists panels jsonb not null default '[]';
alter table turn add column if not exists created_at timestamptz not null default now();

-- One review per call; reviews are written again if the call is re-reviewed
alter table call_review add column if not exists scorecard jsonb not null default '{}';

-- The dealership's webhook (PRD: "a webhook delivered to the dealership" after every call). The secret
-- signs each delivery (HMAC-SHA256); it is readable by the dealership's editors and the brain, not by
-- viewers.
create table dealership_webhook (
  dealership_id text primary key references dealership(id) on delete cascade,
  url           text not null check (url ~ '^https://'),
  secret        text not null check (length(secret) >= 32),
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);
alter table dealership_webhook enable row level security;
create policy editors on dealership_webhook for all to app_user using (app.can_edit(dealership_id)) with check (app.can_edit(dealership_id));
create policy brain_read on dealership_webhook for select to brain_service using (active);
grant select, insert, update, delete on dealership_webhook to app_user;
grant select on dealership_webhook to brain_service;
-- The audit log is readable by everyone in the dealership: never copy a secret into it
create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'secret' end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'secret' end;
  rowj jsonb := coalesce(a, b);
begin
  insert into audit_log (actor, db_role, table_name, row_id, dealership_id, action, before, after)
  values (app.current_user_id(), app.caller_role(), tg_table_name, coalesce(rowj ->> 'id', rowj ->> 'user_id', rowj ->> 'dealership_id'),
          case when tg_table_name = 'dealership' then rowj ->> 'id' else rowj ->> 'dealership_id' end,
          lower(tg_op), b, a);
  return null;
end $$;
create trigger audit after insert or update or delete on dealership_webhook for each row execute function app.audit();
