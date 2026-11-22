# Max voice worker

The server-side real-time pipeline for live calls (PRD: "Real-time voice pipeline"), built on Pipecat
1.16. The browser only sends the microphone and plays the room; every turn-taking decision is made
here, and every word Max says comes from the [brain service](../brain/README.md).

```
customer mic (Daily room)
  -> noise filter (Krisp if licensed, else RNNoise) -> Silero VAD
  -> Deepgram nova-3 streaming STT, the dealership's keyterms
  -> user turn: MaxBargeInStartStrategy (start / barge-in) + Smart Turn v3 (end of turn)
  -> BrainProcessor: brain /turn (early, then final), /commit, /reprompt
  -> Deepgram Aura-2 TTS, 24 kHz
  -> DeliveryTap: counts the audio, for "how much of the reply was heard"
  -> HeyGen LiveAvatar, LITE mode (voice-only fallback)
  -> Daily room: avatar video, Max's audio, data channel (panels, captions, call state)
```

## Files

| File | What it does |
| --- | --- |
| `max_worker/server.py` | `POST /calls` (creates a private Daily room, starts the call, returns the room URL and the customer's token), `GET /health`. Each worker runs `MAX_CALLS_PER_WORKER` calls at once, then answers 503 so the caller tries another worker. |
| `max_worker/bot.py` | Builds one call's pipeline. |
| `max_worker/brain_processor.py` | Sits where an LLM would. Speaks the brain's `early` sentences at once and the rest on `final`, sends panels and captions, commits what was heard, re-prompts after silences, ends the call after the closing line, and logs one `turn_timing` line per turn. |
| `max_worker/turn_start.py`, `policy.py` | The demo's tuned barge-in rule, ported as-is: backchannels never cut Max off; in a line's first 1.5 s only a stop word does; after that, a stop phrase or 4+ words. While Max is silent, any speech starts the turn at once. |
| `max_worker/delivery.py` | How much of a reply was played when Max was cut off: `heard` is true from 80%, the same rule as the demo. |
| `max_worker/avatar.py` | LiveAvatar with a fallback. If the avatar fails to start, stops sending media for 3 s, or doesn't speak back within 4 s of being sent speech, Max's audio goes straight to the room. The browser gets `{"event":"avatar.state","state":"unavailable"}` and shows the still image. |
| `max_worker/recording.py` | Call recordings: stereo (customer left, Max right), 16 kHz, to a temporary file. After the call, kept only if the brain says the customer consented: FLAC, encrypted with a fresh AES-256-GCM key wrapped by `RECORDING_PUBLIC_KEY` (this worker can't decrypt), uploaded to `S3_*`, then recorded by the brain. Without consent the file is deleted and nothing leaves the machine. Not configured: calls aren't recorded. |
| `max_worker/brain_client.py` | HTTP client for the brain. If the brain can't be reached, Max says "Sorry, could you say that one more time?", never silence. |

## Data channel events (to the browser)

`caption {text, final}`, `panel.show {panel, data}`, `panel.hide`, `call.state {beat, phase}`,
`call.ended {reason}`, `avatar.state {state, reason}`. Each is a JSON object with an `event` field, sent as a Daily
app message.

## Run locally

```bash
py -3.13 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt     # macOS/Linux: .venv/bin/python
cp .env.example .env                                             # fill in the keys

# terminal 1: the brain
cd ../brain && npm install && MAX_STREAM=on npm run dev
# terminal 2: the worker
.venv/Scripts/python -m max_worker.server
# terminal 3: a call (opens Daily's call page in your browser)
.venv/Scripts/python scripts/start_call.py demo-mazda
```

Without `HEYGEN_API_KEY` the call is voice-only. Each turn logs a line like:

```json
{"event": "turn_timing", "turn_id": 3, "brain_early_ms": 420, "brain_final_ms": 1310, "first_audio_ms": 690, "heard": true, "fraction_heard": 1.0, "interrupted": false}
```

The times are measured from the moment the end of the customer's turn was decided. The PRD's full
"customer stops speaking → first audible word" figure also includes the end-of-turn wait and the
network to the customer. Measuring that end to end is the next step: it needs a live call.

## Tests

```bash
.venv/Scripts/python -m pytest
```

92 tests, offline. `tests/test_brain_processor.py` starts the real brain service (Node) and runs the
processor in a real Pipecat pipeline against it. Covered: speaking, committing, interruption,
rollback with "yeah" resuming, speculative turns ignored, and brain down. `tests/test_recording.py`:
consent gate, encryption, a recording through a real Pipecat processor, and the portal's Node code
decrypting what this worker encrypted. Live audio, Deepgram,
Daily and HeyGen are not exercised by the tests; they need keys and a real call.

## Status and known gaps

- **Not yet run on a live call.** Everything up to the vendors is tested; the vendor calls follow
  Pipecat 1.16's own services, but the first real call is where the latency numbers come from.
- **Room.** Calls use our own Daily room, not the LiveKit room LiveAvatar provisions. Your PRD allows
  either. A LiveAvatar-owned room disappears when the avatar fails, which would break the "the avatar
  failing mid-call leaves a working voice call" acceptance criterion. Pipecat's HeyGen transport also
  logs the customer's room token. Daily is a fourth vendor to add to the sub-processor list.
- **Sandbox avatar.** `HEYGEN_SANDBOX=true` asks HeyGen for a sandbox session, but the sandbox avatar
  ID has not been confirmed. Set `HEYGEN_AVATAR_ID` to the one in your HeyGen dashboard.
- **Recording is audio only.** The disclosure says the transaction "is recorded audio and video";
  only audio is kept. Have the wording checked by counsel either way.
- **Recording starts when the customer joins**, before consent, to a temporary file on this machine
  only. It is deleted at the end unless the customer consented. If the worker crashes mid-call, the
  temporary file is left in the container's temp directory until the container restarts.
- **Docker images** are written but untested here (no Docker on this machine). The brain image's
  layout was reproduced and run locally.
