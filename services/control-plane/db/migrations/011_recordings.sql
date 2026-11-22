-- Call recordings (PRD: "Audio in object storage, encrypted"; "the disclosure is spoken word for word
-- before any recording is used"; retention per dealership; deletion on request).
--
-- The voice worker records the call's audio (customer left, Max right), and keeps it only if the
-- customer consented (passed the recording disclosure at Beat 1). It encrypts it with a fresh AES-256-GCM
-- key, wraps that key with the platform's RSA PUBLIC key (only the portal holds the private key), and
-- uploads it to S3-compatible storage under <dealership>/... . The brain records it here through
-- app.add_recording, which stores it only for a call with a consent time, and otherwise queues the file
-- for deletion. Deleting a recording row (retention, deletion on request) queues its file for deletion;
-- the maintenance job deletes queued files from storage.

alter table recording add column if not exists format     text not null default 'flac';
alter table recording add column if not exists bytes      bigint;
alter table recording add column if not exists sha256     text;   -- of the encrypted object
alter table recording add column if not exists key_id     text;   -- which public key wrapped it
alter table recording add column if not exists key_wrapped text;  -- the data key, RSA-OAEP-SHA256, base64
alter table recording add column if not exists nonce      text;   -- AES-GCM nonce, base64
alter table recording add column if not exists created_at timestamptz not null default now();

-- Files to delete from storage (owner-only; processed by `npm run maintain`)
create table storage_deletion (
  storage_key text primary key,
  reason      text not null,
  queued_at   timestamptz not null default now()
);
alter table storage_deletion enable row level security;

create function app.queue_recording_deletion() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into storage_deletion (storage_key, reason) values (old.storage_key, 'recording deleted')
  on conflict (storage_key) do nothing;
  return old;
end $$;
create trigger queue_deletion after delete on recording for each row execute function app.queue_recording_deletion();

-- The brain's way in: stores the recording only for this dealership's call WITH a consent time; else
-- queues the file for deletion. Returns whether it was stored.
create function app.add_recording(c text, d text, key text, duration numeric, size bigint, fmt text, digest text, kid text, wrapped text, iv text)
returns boolean
language plpgsql volatile security definer set search_path = public, app as $$
declare
  stored boolean := false;
begin
  if key is null or left(key, length(d) + 1) <> d || '/' then
    raise exception 'storage key must start with the dealership';
  end if;
  insert into recording (call_id, dealership_id, storage_key, duration_s, bytes, format, sha256, key_id, key_wrapped, nonce, retention_until)
  select c, d, key, duration, size, fmt, digest, kid, wrapped, iv,
         now() + make_interval(days => coalesce((x.retention ->> 'recordings_days')::int, 90))
    from call k join dealership x on x.id = k.dealership_id
   where k.id = c and k.dealership_id = d and k.consent_at is not null
  on conflict (call_id) do nothing
  returning true into stored;
  if not coalesce(stored, false) then
    insert into storage_deletion (storage_key, reason) values (key, 'no consent or unknown call') on conflict do nothing;
  end if;
  return coalesce(stored, false);
end $$;
revoke all on function app.add_recording(text, text, text, numeric, bigint, text, text, text, text, text) from public;
grant execute on function app.add_recording(text, text, text, numeric, bigint, text, text, text, text, text) to brain_service;

-- Every playback is in the dealership's audit log (and the platform owner's support access with it)
create function app.note_recording_access(c text) returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare d text;
begin
  select dealership_id into d from call where id = c;
  if d is null or app.current_user_id() is null or not app.can_read(d) then raise exception 'not allowed'; end if;
  insert into audit_log (actor, db_role, table_name, row_id, dealership_id, action)
  values (app.current_user_id(), app.caller_role(), 'recording', c, d, 'listen');
end $$;
revoke all on function app.note_recording_access(text) from public;
grant execute on function app.note_recording_access(text) to app_user;
