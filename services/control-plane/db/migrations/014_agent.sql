-- The agent settings, versioned with the script (2026-11-24): the portal's Agent page.
--
-- One jsonb document per script version: free-form context, the greeting, knowledge documents (title +
-- text, pasted or uploaded) and the guardrail switches (price ladder, recording disclosure, the script's
-- beats as talking points). Read by the prompt-native engine (tavus-avatar/src/lib/native-engine.ts,
-- AgentConfig). Same lifecycle as the prompts (012, 013): edited only as a draft, frozen once in test
-- (app.guard_version compares every content column), live only through app.approve_version, one-step
-- rollback, every change audited. '{}' = the built-in behavior.
--
-- Always enforced in code, whatever the switches say: no invented numbers or claims, never claims to be
-- human, a no is never a yes, no repeated sentences, a word-for-word greeting checked when saved.

alter table script_version add column if not exists agent jsonb not null default '{}'::jsonb
  check (jsonb_typeof(agent) = 'object' and octet_length(agent::text) <= 400000);

-- New dealerships copy the template's live agent settings along with its script
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

  insert into script_version (dealership_id, beats, disclosure, fixed_lines, recaps, free_prompt, native_prompt, agent, notes)
    select new_id, beats, disclosure, fixed_lines, recaps, free_prompt, native_prompt, agent, 'Copied from ' || template || ' v' || version
      from script_version where dealership_id = template and status = 'live';
  insert into price_ladder_version (dealership_id, steps, products, notes)
    select new_id, steps, products, 'Copied from ' || template || ' v' || version
      from price_ladder_version where dealership_id = template and status = 'live';
  insert into kb_version (dealership_id, facts, notes)
    select new_id, facts, 'Copied from ' || template || ' v' || version
      from kb_version where dealership_id = template and status = 'live';
end $$;
