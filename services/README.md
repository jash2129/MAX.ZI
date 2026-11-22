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
  - Open question (yours to decide): a lowball under the floor ("can you do two dollars?") gets the
    floor at once, skipping steps. That's the demo's existing TXM-approved behavior; read strictly,
    the PRD's "one step down per refusal" would forbid it.
- **Later phases** (admin portal, call records written by the worker, recordings, dashboards,
  billing): not started. The tables for call records already exist under row-level security.
