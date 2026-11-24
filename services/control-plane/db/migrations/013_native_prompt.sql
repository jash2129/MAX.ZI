-- The prompt-native engine's prompt, versioned with the script (2026-11-23).
--
-- MAX.ZI's default engine runs the whole call from one prompt (tavus-avatar/src/lib/native-engine.ts,
-- DEFAULT_NATIVE_PROMPT): persona, goal, guidelines, tone. No beats: the dealership's approved content
-- (talking points, facts, price ladder, disclosure) is appended by code, so the prompt is behavior only.
-- Same lifecycle as free_prompt (012): edited only as a draft, frozen once submitted for test
-- (app.guard_version compares every content column), live only through app.approve_version after the
-- release gate, one-step rollback, every change in the audit log. NULL = the built-in prompt.
--
-- Code still enforces the word-for-word disclosure, the price ladder (one step at a time, only after
-- pushback), no invented figures and "a no is never a yes", whatever the prompt says.

alter table script_version add column if not exists native_prompt text
  check (native_prompt is null or length(native_prompt) between 1 and 20000);

-- New dealerships copy the template's live prompts along with its script
create or replace function app.create_dealership(new_id text, new_name text, agency text, template text, vehicle jsonb, keyterms text[])
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

  insert into script_version (dealership_id, beats, disclosure, fixed_lines, recaps, free_prompt, native_prompt, notes)
    select new_id, beats, disclosure, fixed_lines, recaps, free_prompt, native_prompt, 'Copied from ' || template || ' v' || version
      from script_version where dealership_id = template and status = 'live';
  insert into price_ladder_version (dealership_id, steps, products, notes)
    select new_id, steps, products, 'Copied from ' || template || ' v' || version
      from price_ladder_version where dealership_id = template and status = 'live';
  insert into kb_version (dealership_id, facts, notes)
    select new_id, facts, 'Copied from ' || template || ' v' || version
      from kb_version where dealership_id = template and status = 'live';
end $$;
