# Platform services

The multi-dealership platform from `AI Finance Manager Platform PRD.md`, built next to the Max demo
(`tavus-avatar/`) and reusing its proven logic.

| Service | Stack | Role |
| --- | --- | --- |
| [`brain/`](brain/README.md) | TypeScript, Node | Decides what Max says. Runs the demo's beat controller, guards, AI layers and knowledge base unchanged, as an HTTP service: `/calls`, `/turn` (streamed), `/commit`, `/reprompt`. |
| [`voice-worker/`](voice-worker/README.md) | Python, Pipecat 1.16 | Runs live calls: room, noise removal, VAD, Smart Turn, Deepgram STT and TTS, barge-in, LiveAvatar, panels. Calls the brain once per turn. |
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
  - Next: beats, fixed lines and knowledge base per call. Until then the brain refuses a live script
    or knowledge base that differs from the demo's, so an approval never claims something customers
    don't hear.
  - Open question (yours to decide): a lowball under the floor ("can you do two dollars?") gets the
    floor at once, skipping steps. That's the demo's existing TXM-approved behavior; read strictly,
    the PRD's "one step down per refusal" would forbid it.
- **Later phases** (admin portal, call records written by the worker, recordings, dashboards,
  billing): not started. The tables for call records already exist under row-level security.
