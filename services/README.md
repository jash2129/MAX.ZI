# Platform services

The multi-dealership platform from `AI Finance Manager Platform PRD.md`, built next to the Max demo
(`tavus-avatar/`) and reusing its proven logic.

| Service | Stack | Role |
| --- | --- | --- |
| [`brain/`](brain/README.md) | TypeScript, Node | Decides what Max says. Runs the demo's beat controller, guards, AI layers and knowledge base unchanged, as an HTTP service: `/calls`, `/turn` (streamed), `/commit`, `/reprompt`. |
| [`voice-worker/`](voice-worker/README.md) | Python, Pipecat 1.16 | Runs live calls: room, noise removal, VAD, Smart Turn, Deepgram STT and TTS, barge-in, LiveAvatar, panels. Calls the brain once per turn. |

```
browser ──(Daily room: mic in; avatar video, Max's audio, panel events out)── voice worker ──HTTP── brain ── Redis (call state)
```

## Roadmap status

- **Phase 1, voice pipeline + brain service:** built and tested offline (brain 14 tests, worker 78,
  demo controller still 565). Next: first live call with real keys, then measure latency against the
  PRD targets (median under 1.0 s, 90th percentile under 1.6 s).
- **Later phases** (tenancy in Postgres with row-level security, versioned and approved script, price
  and knowledge-base config, admin portal, call records and recordings, dashboards, billing): not
  started. Until tenancy lands, the price ladder, beats and knowledge base are still the demo's, and
  the brain refuses any dealership config whose price ladder differs from the one the code enforces.
