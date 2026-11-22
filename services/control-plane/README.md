# Control plane database

One Postgres database for every tenant (PRD: "Data model"). Tenancy is enforced **by Postgres**, with
row-level security on every table, so a bug in application filtering cannot show one dealership
another's data.

## How the services connect

| Who | Postgres role | Sees |
| --- | --- | --- |
| Portal (people) | `app_user`, with `app.user_id` set per transaction (`asUser`) | Only the dealerships and agencies they belong to; the platform owner sees all |
| Brain | `brain_service` (`asService`) | Dealerships and **live** versions only; never drafts or call records |
| Voice worker | `worker_service` | Writes call records; can't attach a row to another dealership's call |
| Test gate | `gate_service` | Versions in test; records simulator results |

Give each service its own login that is a member of its role and nothing else, for example
`create role brain_login login password '…' in role brain_service;`. Never connect a service as the
table owner: owners bypass row-level security.

## Roles for people

| Role | Can |
| --- | --- |
| Platform owner | Everything, across tenants (support view) |
| Agency admin | Read and edit its agency's dealerships; add dealerships; grant any dealership role |
| Manager | Edit drafts; add managers and viewers |
| Approver | Approve versions and roll back (the TXM sign-off) |
| Viewer | Read only |

Open PRD question, not yet decided: should an agency admin also approve for its dealerships? Today
only the dealership's approver (or the platform owner) can.

## Versions: script, price ladder, knowledge base

```
draft --> in_test --(test gate result + approver)--> live --> retired
  ^          |                                          ^        |
  +----------+                                          +--------+  rollback (one step)
```

All enforced in the database:
- Content is frozen once a version leaves draft; only drafts can be deleted.
- A version reaches `live` only through `app.approve_version` (approver, gate passed) or
  `app.rollback_to`. There is one live version per dealership per kind.
- Release gate (PRD): at least 16 simulated calls, zero hard failures, completion no more than 5
  points below the live version's.
- Price ladders must be strictly decreasing and positive; the floor is the last step.
- Every config change and approval is in `audit_log`, with who did it, readable only by that
  dealership's people.

## Use

```bash
npm install
npm test                                   # PGlite (real Postgres 18 in WebAssembly): no server needed
DATABASE_URL=postgres://owner@host/db npm run migrate
DATABASE_URL=… npm run seed-demo -- ../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json
```

`seed-demo` loads the two demo dealerships with the demo's current beats, disclosure, knowledge base
and ladder as approved version 1. Its gate result is computed from the simulator report given, which
is stored with it (that report ran in Free AI mode, which is recorded as `mode: "free"`).

## Tests

30 tests in `test/tenancy.test.ts`. The cross-tenant test finds every table with a `dealership_id`
column by itself, so new tables are covered. It checks both that each user sees nothing of other
dealerships and that they do see their own records.
