-- Recap lines per beat, for beats a dealership rewords (call-content.ts validateScript: a reworded beat
-- with a built-in recap must bring its own, or Max would recite the demo's coverage terms).
-- Part of the version's content: frozen with the rest once the version leaves draft (guard_version
-- compares every column except the lifecycle ones).
alter table script_version add column if not exists recaps jsonb not null default '{}'
  check (jsonb_typeof(recaps) = 'object');
