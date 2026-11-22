# Max brain service

Max's conversation brain as an always-on HTTP service (PRD: "Conversation brain"). The voice worker
calls it once per customer turn. It does **not** re-implement any rules: it imports the beat
controller, guards, AI layers and knowledge base from `../../tavus-avatar/src/lib` unchanged, so the
demo and the platform run the same code and the existing 565 tests keep guarding it.

## Run

```bash
npm install
npm run dev          # http://localhost:8787, reloads on change
npm test             # offline: real controller, no AI keys, no Redis
npm run typecheck    # also type-checks the controller files it imports
```

`--conditions=react-server` (in the npm scripts) makes the controller's `import "server-only"` a no-op
outside Next.js. Keep it when you write a Dockerfile or start command.

## Environment

| Variable | Purpose |
| --- | --- |
| `BRAIN_TOKEN` | Shared secret with the voice workers (`Authorization: Bearer …`). Unset: open in dev, **503 in production**. |
| `PORT` | Default 8787 |
| `DEALERSHIP_CONFIG_DIR` | Default `config/dealerships` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Call state in Redis (2-hour expiry). Needed as soon as there is more than one brain instance. |
| `XAI_API_KEY`, `MAX_UNDERSTANDING`, `MAX_SPEECH`, `MAX_STREAM`, `MAX_MODE`, `GROK_MODEL` | Same AI switches as the demo (see the root `CLAUDE.md`). Set `MAX_STREAM=on` so `/turn` sends `early` lines. |

## API

All `POST` bodies are JSON and carry `dealership_id` and `call_id`. Calls are stored under
`<dealership_id>:<call_id>`, so two dealerships can never share a call's state. Requests for one call are
handled one at a time: a commit always lands before the next turn.

| Endpoint | Body | Reply |
| --- | --- | --- |
| `POST /calls` | `deal?: {vehicle_year, vehicle_make, vehicle_model}` | `{text, beat, panels, resumed, max_display_name, speech_keyterms}`: the opening line. Calling it again returns `resumed: true` and keeps the call's place. |
| `POST /turn` | `turn_id` (1, 2, 3 …), `transcript` | NDJSON: zero or one `{"type":"early","text"}`, then `{"type":"final", text, early_text, beat, beat_type, intent, panels, is_complete, metrics, timing}`. `text` starts with `early_text`. A controller crash gives a `final` with `fallback: true` and a short spoken line, never silence. |
| `POST /commit` | `turn_id`, `heard`, `fraction_heard` (0–1) | `{rolled_back, reason}`. Not heard: the call goes back to before that turn, and "yeah / go on" resumes from the cut sentence. |
| `POST /reprompt` | `kind`: `resume`, `still_with_me` or `clarify` | `{text}`. For silences; never moves the script on. |
| `POST /end` | | `{ok}` |
| `GET /health` | | `{ok, dealerships, streaming, sharedStore, auth}` |

`panels` are the PRD's data-channel events: `{"event":"panel.show","panel":"warranty_terms" | "repair_costs" | "coverage_grid" | "price" | "deal_summary","data":{…}}` and `{"event":"panel.hide"}`. The price panel only ever carries the single rate Max is saying.

## Dealerships (Phase 1)

One JSON file per dealership in `config/dealerships/`. An invalid file stops start-up.

What is per dealership **today**: name, Max's display name, default vehicle, speech keyterms.
What is **not yet** per dealership (still the demo's files and code): the 25 beats, fixed lines,
knowledge base, AI mode, and the price ladder. Because the ladder is still enforced in
`beat-controller.ts`, a config whose `price_ladder` is not `[4, 3.5, 3.25, 3]` is **refused**. That is
deliberate: no dealership is quietly quoted another dealership's prices. Phase 3 (tenancy) moves
beats, lines, knowledge base and ladder into versioned, approved config read per call.
