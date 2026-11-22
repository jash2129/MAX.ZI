import { timingSafeEqual } from "node:crypto";

import {
  activeStates,
  commitTurn,
  getOrCreateCallState,
  processClientTurn,
  repromptText,
  resetCallState,
  type ControllerDecision,
} from "../../../tavus-avatar/src/lib/beat-controller.ts";
import type { DealConfig } from "../../../tavus-avatar/src/lib/deal-config.ts";
import { streamingEnabled } from "../../../tavus-avatar/src/lib/llm-stream.ts";
import { loadSession, saveSession, sharedStoreEnabled } from "../../../tavus-avatar/src/lib/session-store.ts";

import { toPanelEvents } from "./panels.ts";
import { noRecorder, type CallRecorder } from "./recorder.ts";
import { ID_PATTERN, type ConfigSource, type DealershipConfig } from "./tenants.ts";

/**
 * Max's brain as a service (PRD "Conversation brain" > Interface). Stateless between requests: each
 * request loads the call's state (Redis when configured), runs the existing controller, saves it back.
 *
 *   POST /calls    {call_id, dealership_id, deal?}            -> {text, beat, panels}   (opening line)
 *   POST /turn     {call_id, dealership_id, turn_id, transcript} -> NDJSON: early*, then final
 *   POST /commit   {call_id, dealership_id, turn_id, heard, fraction_heard} -> {rolled_back}
 *   POST /reprompt {call_id, dealership_id, kind}             -> {text}
 *   POST /end      {call_id, dealership_id}                   -> {ok}
 *   GET  /health
 */

export interface BrainOptions {
  /** Dealership config: JSON files (dev) or the control plane's Postgres (live, approved versions) */
  registry: ConfigSource;
  /** Shared secret between voice workers and the brain. Unset: open in dev, 503 in production. */
  token?: string;
  production?: boolean;
  now?: () => number;
  /** Call records (PgCallRecorder with the control plane; none with file config) */
  recorder?: CallRecorder;
}

/** Said when the controller itself throws: never silence (PRD rule 8). */
export const FALLBACK_LINE = "Sorry, I didn't catch that.";

type Json = Record<string, unknown>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Calls are namespaced by dealership so two tenants can never share a state, even with equal call ids. */
export const sessionKey = (dealershipId: string, callId: string) => `${dealershipId}:${callId}`;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** One request at a time per call: a commit for turn N always lands before turn N+1 is processed. */
const callLocks = new Map<string, Promise<unknown>>();
async function withCallLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = callLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  callLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (callLocks.get(key) === tail) callLocks.delete(key);
  }
}

function dealConfigFor(dealership: DealershipConfig, deal: unknown): DealConfig {
  const d = (deal && typeof deal === "object" ? deal : {}) as Json;
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : fallback);
  return {
    dealership_name: dealership.name,
    vehicle_year: str(d.vehicle_year, dealership.default_vehicle.year),
    vehicle_make: str(d.vehicle_make, dealership.default_vehicle.make),
    vehicle_model: str(d.vehicle_model, dealership.default_vehicle.model),
    // The controller sets per_day_price from the ladder's opening price when the call starts
    per_day_price: "",
    price_ladder: [...dealership.price_ladder],
    // Pinned to the call: a call in progress keeps them even if a new version goes live
    ...(dealership.script ? { script: dealership.script } : {}),
    ...(dealership.knowledge ? { knowledge: dealership.knowledge } : {}),
  };
}

function finalBody(decision: ControllerDecision, timing: Json) {
  return {
    type: "final",
    text: decision.textToSpeak,
    early_text: decision.earlyText ?? "",
    beat: decision.beatId,
    beat_type: decision.beatType,
    intent: decision.intent,
    panels: toPanelEvents(decision.toolCalls),
    is_complete: Boolean(decision.isScriptComplete),
    metrics: decision.metrics ?? null,
    timing,
  };
}

/** Stage timings from the voice worker: numbers only, a few known keys (never free text in records) */
function cleanTimings(raw: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k) || Object.keys(out).length >= 20) continue;
    if (v === null || (typeof v === "number" && Number.isFinite(v))) out[k] = v as number | null;
  }
  return out;
}

export function createBrain(opts: BrainOptions) {
  const now = opts.now ?? Date.now;
  const recorder = opts.recorder ?? noRecorder;

  function authorize(req: Request): void {
    if (!opts.token) {
      if (opts.production) throw new HttpError(503, "BRAIN_TOKEN is not set");
      return;
    }
    const header = req.headers.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameSecret(given, opts.token)) throw new HttpError(401, "unauthorized");
  }

  async function readBody(req: Request): Promise<Json> {
    try {
      const body = await req.json();
      if (body && typeof body === "object" && !Array.isArray(body)) return body as Json;
    } catch {
      /* fall through */
    }
    throw new HttpError(400, "body must be a JSON object");
  }

  /** The call's key. Only format is checked: an existing call is proven by its saved state. */
  function keyOf(body: Json): { key: string; dealershipId: string } {
    const callId = body.call_id;
    const dealershipId = body.dealership_id;
    if (typeof callId !== "string" || !ID_PATTERN.test(callId)) throw new HttpError(400, "call_id is required (a-z, 0-9, - and _)");
    if (typeof dealershipId !== "string" || !ID_PATTERN.test(dealershipId)) throw new HttpError(400, "dealership_id is required");
    return { key: sessionKey(dealershipId, callId), dealershipId };
  }

  /**
   * Only a new call resolves the dealership's config. Later requests for the call run on what it started
   * with (PRD: calls in progress keep their version), even if a new version goes live meanwhile.
   */
  async function callOf(body: Json): Promise<{ key: string; dealership: DealershipConfig }> {
    const { key, dealershipId } = keyOf(body);
    const dealership = await opts.registry.get(dealershipId);
    if (!dealership) throw new HttpError(404, "unknown dealership");
    return { key, dealership };
  }

  /** The call must have been started with POST /calls (its deal is fixed at the start). */
  function requireStarted(key: string): void {
    if (!activeStates.has(key)) throw new HttpError(409, "call not started (POST /calls first) or expired");
  }

  async function startCall(body: Json): Promise<Response> {
    const { key, dealership } = await callOf(body);
    return withCallLock(key, async () => {
      await loadSession(key);
      const resumed = activeStates.has(key);
      const state = getOrCreateCallState(key, dealConfigFor(dealership, body.deal));
      await saveSession(key);
      if (!resumed) recorder.started(key, dealership.id, dealership.versions ?? null);
      return json({ text: state.last_spoken_text, beat: state.current_beat, panels: [], resumed, max_display_name: dealership.max_display_name, speech_keyterms: dealership.speech_keyterms, versions: dealership.versions ?? null });
    });
  }

  async function turn(body: Json): Promise<Response> {
    const routeStart = now();
    const { key, dealershipId } = keyOf(body);
    const transcript = typeof body.transcript === "string" ? body.transcript.slice(0, 2000) : "";
    const turnId = Number(body.turn_id);
    if (!Number.isInteger(turnId) || turnId < 1) throw new HttpError(400, "turn_id must be a positive integer");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        // The voice worker drops the stream when the customer interrupts; the turn still completes and
        // is saved (its commit then rolls it back), so writes to a closed stream are simply skipped
        let open = true;
        const send = (o: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
          } catch {
            open = false;
          }
        };
        try {
          await withCallLock(key, async () => {
            await loadSession(key);
            const state = activeStates.get(key);
            if (!state) {
              send({ type: "error", status: 409, error: "call not started (POST /calls first) or expired" });
              return;
            }
            let earlyAt: number | null = null;
            try {
              const decision = await processClientTurn(key, transcript, turnId, state.dealConfig, {
                onEarly: streamingEnabled()
                  ? (text) => {
                      earlyAt = now() - routeStart;
                      send({ type: "early", text, at_ms: earlyAt });
                    }
                  : undefined,
              });
              await saveSession(key);
              const timing = { early_ms: earlyAt, final_ms: now() - routeStart };
              const reply = finalBody(decision, timing);
              send(reply);
              const m = decision.metrics;
              recorder.turn(key, dealershipId, {
                turnId,
                customer: transcript,
                max: decision.textToSpeak,
                beatBefore: m?.beatBefore ?? decision.beatId,
                beatAfter: decision.beatId,
                understanding: `${m?.understanding ?? (m?.usedLLM ? "ai" : "rules")}:${decision.intent}`,
                wordingSource: m?.mode === "free" ? "free-ai" : m?.speech === "ai" ? "ai" : "approved-line",
                panels: reply.panels,
                timings: { brain_early_ms: timing.early_ms, brain_final_ms: timing.final_ms },
              });
            } catch (err) {
              console.error(JSON.stringify({ event: "brain_turn_failed", call: key, turnId, error: String(err) }));
              const s = activeStates.get(key);
              send({ type: "final", text: FALLBACK_LINE, early_text: "", beat: s?.current_beat ?? 0, beat_type: "wait", intent: "garbled", panels: [], is_complete: false, metrics: null, timing: { final_ms: now() - routeStart }, fallback: true });
            }
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      },
      cancel() {
        /* client went away: see `send` */
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  }

  async function commit(body: Json): Promise<Response> {
    const { key } = keyOf(body);
    const turnId = Number(body.turn_id);
    if (!Number.isInteger(turnId)) throw new HttpError(400, "turn_id is required");
    const fraction = Math.min(1, Math.max(0, Number(body.fraction_heard) || 0));
    return withCallLock(key, async () => {
      await loadSession(key);
      requireStarted(key);
      const result = commitTurn(key, turnId, Boolean(body.heard), fraction);
      await saveSession(key);
      recorder.committed(key, turnId, Boolean(body.heard), fraction, cleanTimings(body.timings));
      return json({ rolled_back: result.rolledBack, reason: result.reason ?? null });
    });
  }

  async function reprompt(body: Json): Promise<Response> {
    const { key } = keyOf(body);
    const kind = ["resume", "still_with_me", "clarify"].includes(String(body.kind)) ? (body.kind as "resume" | "still_with_me" | "clarify") : "resume";
    return withCallLock(key, async () => {
      await loadSession(key);
      requireStarted(key);
      const text = repromptText(key, kind);
      await saveSession(key);
      return json({ text, kind });
    });
  }

  async function end(body: Json): Promise<Response> {
    const { key, dealershipId } = keyOf(body);
    const reason = typeof body.reason === "string" && /^[a-z_]{1,40}$/.test(body.reason) ? body.reason : "ended";
    return withCallLock(key, async () => {
      await loadSession(key);
      const state = activeStates.get(key);
      if (state) {
        recorder.ended(key, dealershipId, {
          reason,
          dealConfig: state.dealConfig,
          furthestBeat: state.current_beat,
          concessionStage: state.concession_stage,
          declined: Boolean(state.package_declined),
          finalized: !state.package_declined && (Boolean(state.finalize_confirmed) || state.delivered_beats.includes(24)),
        });
      }
      // Redis copies expire on their own (2 h); this frees this process's memory now
      resetCallState(key);
      return json({ ok: true });
    });
  }

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === "GET" && pathname === "/health") {
        return json({ ok: true, config: opts.registry.kind, dealerships: opts.registry.ids?.().length ?? null, streaming: streamingEnabled(), sharedStore: sharedStoreEnabled(), auth: Boolean(opts.token) });
      }
      if (req.method !== "POST") throw new HttpError(404, "not found");
      authorize(req);
      const body = await readBody(req);
      switch (pathname) {
        case "/calls":
          return await startCall(body);
        case "/turn":
          return await turn(body);
        case "/commit":
          return await commit(body);
        case "/reprompt":
          return await reprompt(body);
        case "/end":
          return await end(body);
        default:
          throw new HttpError(404, "not found");
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(JSON.stringify({ event: "brain_error", path: pathname, error: String(err) }));
      return json({ error: "internal error" }, 500);
    }
  };
}
