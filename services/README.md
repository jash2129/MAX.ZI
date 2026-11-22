# Platform services

The multi-dealership platform from `AI Finance Manager Platform PRD.md`, built next to the Max demo
(`tavus-avatar/`) and reusing its proven logic.

| Service | Stack | Role |
| --- | --- | --- |
| [`brain/`](brain/README.md) | TypeScript, Node | Decides what Max says. Runs the demo's beat controller, guards, AI layers and knowledge base unchanged, as an HTTP service: `/calls`, `/turn` (streamed), `/commit`, `/reprompt`. |
| [`voice-worker/`](voice-worker/README.md) | Python, Pipecat 1.16 | Runs live calls: room, noise removal, VAD, Smart Turn, Deepgram STT and TTS, barge-in, LiveAvatar, panels. Calls the brain once per turn. |
| [`portal/`](portal/README.md) | Next.js, Better Auth | The admin portal: invite-only sign-in with required two-factor for admins, versions with drafts, release gate, side-by-side approval and rollback, people and invites, audit log. Reads and writes as the signed-in person under row-level security. |
| [`control-plane/`](control-plane/README.md) | Postgres, TypeScript | Tenants, people and roles, versioned script / price / knowledge-base config with approval and a release gate, call records, audit log. Row-level security on every table. |

```
browser ──(Daily room: mic in; avatar video, Max's audio, panel events out)── voice worker ──HTTP── brain ── Redis (call state)
```

## Production database (Neon project MAX.ZI, branch `production`)

Set up 2026-11-23:

- **Migrations:** 001-010 applied (010, the call page, on 2026-11-23).
- **Snapshots:** taken before 007-009, as branch `pre-migration-2026-11-23`, and before 010, as branch
  `pre-migration-010-2026-11-23` (both kept until 2026-12-06).
- **Call page checks, read-only with `portal_login`:** both demo dealerships are ready (no product
  terms yet); unknown dealerships return nothing; claiming a deal that doesn't exist uses nothing.
  Deals stay hidden from the portal login without a signed-in person (proved on the test branch,
  which has deals: 1 there, 0 visible).
- **Logins:** each is a member of its role only; none is a superuser or can bypass row-level security.
  - `brain_login` (`brain_service`): its connection string is in `brain/.env.local`.
  - `portal_login` (`app_user`, `gate_service`) and `auth_login` (`auth_service`, `search_path = auth`):
    in `portal/.env.prod`, a deploy-only file that nothing loads automatically, so local tests never
    reach production. That file also holds a production `BETTER_AUTH_SECRET`; `PORTAL_URL` is still to
    be set once the portal has an address.
- **Sign-in tables:** Better Auth's tables are in the `auth` schema.
- **Data:** the two demo dealerships with live v1, and no calls.
- **Platform owner:** still the placeholder `owner@example.com`. Rename it with
  `npm run owner-email -- <email>` in control-plane. Its one-time invite link (7 days) is in
  `control-plane/.env.owner-invite`; make a new one with
  `npm run invite -- <owner email> .env.owner-invite`.
- **Verified read-only with each login:**
  - the brain sees live config, may write calls, and is refused people;
  - the portal is refused the auth schema, and a stranger sees 0 dealerships;
  - deleting a call without a signed-in person is refused;
  - the auth login is refused tenant tables.

All `.env*` files are git-ignored. On a host, set the same variables as secrets.

## Roadmap status

- **Phase 1, voice pipeline + brain service:** built and tested offline (brain 14 tests, worker 78,
  demo controller still 565). Next: first live call with real keys, then measure latency against the
  PRD targets (median under 1.0 s, 90th percentile under 1.6 s).
- **Phase 2, tenancy:**
  - Done: the control-plane database (row-level security, roles, version lifecycle, release gate,
    audit, cross-tenant test; 30 tests), and the brain reading live config from it (6 more tests).
    The demo's content is seeded as approved v1.
  - Done: **per-dealership price ladders.** Every price Max says, shows or checks comes from the
    call's own approved ladder (`tavus-avatar/src/lib/price-ladder.ts`), tested on five different
    ladders with the hard rules checked on every turn. Calls in progress keep their ladder.
  - Done: **per-dealership script, fixed lines, recaps and knowledge base**
    (`tavus-avatar/src/lib/call-content.ts`). A new dealership is now configuration only: ladder,
    wording and facts from its approved versions, with the controller's flow and its hard rules
    unchanged.
  - Limits: product-specific fixed lines (tire and wheel, maintenance, markup answers) state the
    demo's coverage. A dealership with different products must override them, which its approver
    and the release gate must catch; nothing checks it automatically. Echo detection only knows the
    built-in lines.
  - Tenancy phase complete.
- **Phase 3, admin portal:** built (`portal/`). Data layer 19 tests on real Postgres; a 24-step
  browser end-to-end run passes against a disposable Neon branch. Release gate: a scripted
  16-journey suite through the real controller (`tavus-avatar/src/lib/release-gate.ts`). Not yet:
  dashboards, calls list and inspector (needs call records from the worker), agency and dealership
  creation screens, billing; the AI-persona simulator as a second gate.
- **Phase 4, call records:**
  - Done: the brain records every call off the critical path (call, turns with what was heard and
    stage timings, consent time, outcome). After each call it writes a review (scorecard plus the
    PRD's compliance checks), usage minutes, and a signed webhook to the dealership.
  - In the portal: a 30-day dashboard (calls, completion, price reached, take rate, average rate,
    latency median and 90th percentile, compliance failures), the calls list, and the call inspector.
  - Done: **recordings.** Recorded on the voice worker (customer left, Max right) and kept only if the
    customer got past the Beat 1 disclosure; the database checks the consent time again. Encrypted
    with a per-recording key wrapped by a public key: the worker can't read recordings back, only the
    portal's private key can. Any S3-compatible bucket, by dealership. Played in the call inspector,
    every playback audited. Retention and deletion on request delete the row at once and the file at
    the next maintenance run. Needs a bucket and `npm run recording-keys` (DEPLOY-RENDER.md).
  - Not yet: the AI review (summary and sentiment).
- **Phase 5, onboarding and integrations:**
  - Dealerships are created in the portal without code: drafts are copied from a template, then go
    through the gate and approval.
  - Deal intake API (`POST /api/v1/deals`, per-dealership keys that are hashed, shown once and
    revocable). The voice worker and brain start a call from a `deal_id`; an unknown, expired or other
    dealership's deal is refused.
  - Maintenance: abandoned calls closed, expired deals deleted, transcript and recording retention per
    dealership. Deletion on request from the call viewer.
  - Next: the first live call to measure latency. It needs your accounts and keys.
  - Open question (yours to decide): a lowball under the floor ("can you do two dollars?") gets the
    floor at once, skipping steps. That's the demo's existing TXM-approved behavior; read strictly,
    the PRD's "one step down per refusal" would forbid it.
- **Later phases** (admin portal, call records written by the worker, recordings, dashboards,
  billing): not started. The tables for call records already exist under row-level security.
