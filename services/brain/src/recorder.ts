import { createHmac } from "node:crypto";

import { scoreCall, type ScoredTurn } from "../../../tavus-avatar/src/lib/call-scorecard.ts";
import { BUILT_IN_DISCLOSURE } from "../../../tavus-avatar/src/lib/call-content.ts";
import type { DealConfig } from "../../../tavus-avatar/src/lib/deal-config.ts";
import { ladderOf, priceAtStage } from "../../../tavus-avatar/src/lib/price-ladder.ts";
import { asService, type Db, type Queryable } from "../../control-plane/src/db.ts";

/**
 * Call records (PRD "Call records, analytics and testing" > After every call). The brain writes them as
 * the call happens, OFF the call's critical path: every write goes on a per-call queue that /turn and
 * /commit never wait for, so a slow database can never delay Max. A failed write is logged and the call
 * goes on.
 *
 *   started  -> call row (versions the call runs on)
 *   turn     -> turn row (what the customer said, what Max said, beats, who understood / worded it, panels)
 *   committed-> the turn's heard / fraction heard, and the voice worker's stage timings
 *   ended    -> end of call, outcome, after-call review (scorecard + compliance checks), usage, webhook
 */

export interface TurnRecord {
  turnId: number;
  customer: string;
  max: string;
  beatBefore: number;
  beatAfter: number;
  understanding: string;
  wordingSource: string;
  panels: unknown[];
  timings: Record<string, unknown>;
}

export interface EndRecord {
  reason: string;
  dealConfig: DealConfig;
  furthestBeat: number;
  concessionStage: number | undefined;
  declined: boolean;
  finalized: boolean;
}

export interface CallRecorder {
  started(key: string, dealershipId: string, versions: { script: string | null; price: string | null; kb: string | null } | null): void;
  turn(key: string, dealershipId: string, t: TurnRecord): void;
  committed(key: string, turnId: number, heard: boolean, fractionHeard: number, timings?: Record<string, unknown>): void;
  ended(key: string, dealershipId: string, e: EndRecord): void;
  /** Waits for queued writes (tests, shutdown) */
  flush(key?: string): Promise<void>;
}

/** File-config dealerships (development): no database, nothing recorded */
export const noRecorder: CallRecorder = { started() {}, turn() {}, committed() {}, ended() {}, flush: async () => {} };

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The deterministic compliance checks (PRD): disclosure said, consent before Beat 2, prices, refusals */
export function complianceChecks(turns: ScoredTurn[], dealConfig: DealConfig, consentAt: string | null) {
  const disclosure = norm(dealConfig.script?.disclosure ?? BUILT_IN_DISCLOSURE);
  const card = scoreCall(turns, ladderOf(dealConfig));
  const check = (id: string) => card.checks.find((c) => c.id === id);
  const reachedBeat2 = turns.some((t) => t.beat >= 2);
  const disclosureSaid = turns.some((t) => norm(t.max).includes(disclosure));
  return {
    card,
    compliance: {
      disclosure_said: disclosureSaid || !turns.some((t) => t.beat >= 1),
      consent_before_beat_2: !reachedBeat2 || consentAt !== null,
      prices_approved: check("price_approved")?.pass ?? true,
      no_confirmed_refusal: check("no_confirm_after_refusal")?.pass ?? true,
    },
  };
}

/** HMAC-SHA256 over "<timestamp>.<body>", hex (header X-Max-Signature: t=<timestamp>,v1=<hex>) */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export class PgCallRecorder implements CallRecorder {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly opts: { fetchImpl?: typeof fetch; now?: () => number; webhookRetryMs?: number[] } = {}
  ) {}

  private enqueue(key: string, what: string, fn: (tx: Queryable) => Promise<void>): void {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => asService(this.db, "brain_service", fn))
      .catch((err) => console.error(JSON.stringify({ event: "call_record_failed", call: key, what, error: String((err as Error)?.message ?? err) })));
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  started(key: string, dealershipId: string, versions: { script: string | null; price: string | null; kb: string | null } | null): void {
    this.enqueue(key, "started", async (tx) => {
      await tx.query(
        `insert into call (id, dealership_id, script_version_id, price_version_id, kb_version_id)
         values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
        [key, dealershipId, versions?.script ?? null, versions?.price ?? null, versions?.kb ?? null]
      );
    });
  }

  turn(key: string, dealershipId: string, t: TurnRecord): void {
    this.enqueue(key, "turn", async (tx) => {
      // One statement (one round trip): the turn, then the call's counters, panels and, when the call
      // moved past the recording disclosure (Beat 1) on this turn, its consent time
      await tx.query(
        `with t as (
           insert into turn (call_id, dealership_id, idx, customer_text, max_text, beat_before, beat_after, understanding, wording_source, panels, timings)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (call_id, idx) do update set customer_text = excluded.customer_text, max_text = excluded.max_text,
             beat_after = excluded.beat_after, understanding = excluded.understanding, wording_source = excluded.wording_source,
             panels = excluded.panels, timings = turn.timings || excluded.timings
           returning call_id)
         update call set
           turns_count = greatest(turns_count, $3),
           furthest_beat = greatest(coalesce(furthest_beat, 0), $7),
           panels_shown = panels_shown || $10::jsonb,
           consent_at = case when $6 <= 1 and $7 >= 2 then coalesce(consent_at, now()) else consent_at end
         where id = (select call_id from t)`,
        [key, dealershipId, t.turnId, t.customer, t.max, t.beatBefore, t.beatAfter, t.understanding, t.wordingSource, JSON.stringify(t.panels), JSON.stringify(t.timings)]
      );
    });
  }

  committed(key: string, turnId: number, heard: boolean, fractionHeard: number, timings: Record<string, unknown> = {}): void {
    this.enqueue(key, "committed", async (tx) => {
      await tx.query("update turn set heard = $3, fraction_heard = $4, timings = timings || $5::jsonb where call_id = $1 and idx = $2", [
        key,
        turnId,
        heard,
        Math.round(fractionHeard * 1000) / 1000,
        JSON.stringify(timings),
      ]);
    });
  }

  ended(key: string, dealershipId: string, e: EndRecord): void {
    let summary: Record<string, unknown> | null = null;
    this.enqueue(key, "ended", async (tx) => {
      const call = (await tx.query<any>("select started_at, consent_at, ended_at from call where id = $1", [key])).rows[0];
      if (!call || call.ended_at) return; // unknown call, or already ended
      const ladder = ladderOf(e.dealConfig);
      const finalRate = e.finalized && !e.declined ? priceAtStage(ladder, e.concessionStage) : null;
      await tx.query(
        `update call set ended_at = now(), end_reason = $2, furthest_beat = greatest(coalesce(furthest_beat, 0), $3), final_rate = $4, declined = $5
         where id = $1`,
        [key, e.reason.slice(0, 60), e.furthestBeat, finalRate, e.declined]
      );
      const turns = (await tx.query<any>("select idx, customer_text, max_text, beat_after from turn where call_id = $1 order by idx", [key])).rows;
      const scored: ScoredTurn[] = turns.map((t) => ({ customer: t.customer_text ?? "", max: t.max_text ?? "", beat: t.beat_after ?? 0 }));
      const { card, compliance } = complianceChecks(scored, e.dealConfig, call.consent_at);
      const problems = card.checks.filter((c) => !c.pass).map((c) => ({ id: c.id, severity: c.severity, detail: c.detail ?? null }));
      for (const [k, ok] of Object.entries(compliance)) if (!ok) problems.push({ id: k, severity: "hard", detail: null });
      const passed = card.checks.filter((c) => c.pass).length + Object.values(compliance).filter(Boolean).length;
      const total = card.checks.length + Object.keys(compliance).length;
      const score = Math.round((passed / total) * 100) / 10;
      await tx.query(
        `insert into call_review (call_id, dealership_id, score, summary, problems, compliance_checks, scorecard)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (call_id) do update set score = excluded.score, summary = excluded.summary, problems = excluded.problems,
           compliance_checks = excluded.compliance_checks, scorecard = excluded.scorecard, created_at = now()`,
        [
          key,
          dealershipId,
          score,
          `${e.declined ? "Declined" : finalRate !== null ? `Accepted at $${finalRate}/day` : "No decision"}; reached beat ${Math.max(e.furthestBeat, card.furthestBeat)}; ${turns.length} turns; ended: ${e.reason}.`,
          JSON.stringify(problems),
          JSON.stringify(compliance),
          JSON.stringify(card),
        ]
      );
      const minutes = Math.max(0, (Date.now() - new Date(call.started_at).getTime()) / 60000);
      await tx.query("insert into usage_event (dealership_id, call_id, minutes) values ($1, $2, $3)", [dealershipId, key, Math.round(minutes * 100) / 100]);
      const hook = (await tx.query<{ url: string; secret: string }>("select url, secret from dealership_webhook where dealership_id = $1", [dealershipId])).rows[0];
      if (hook) {
        summary = {
          event: "call.completed",
          call_id: key,
          dealership_id: dealershipId,
          started_at: call.started_at,
          ended_at: new Date().toISOString(),
          end_reason: e.reason,
          furthest_beat: Math.max(e.furthestBeat, card.furthestBeat),
          outcome: e.declined ? "declined" : finalRate !== null ? "accepted" : "no_decision",
          final_daily_rate: finalRate,
          consent_at: call.consent_at,
          compliance,
          score,
          turns: turns.length,
          __hook: hook,
        };
      }
    });
    // The webhook is delivered after the records are saved, on the same queue (no call data in logs)
    this.enqueue(key, "webhook", async (tx) => {
      if (!summary) return;
      const { __hook, ...payload } = summary as Record<string, unknown> & { __hook: { url: string; secret: string } };
      const result = await this.deliver(__hook.url, __hook.secret, payload);
      await tx.query("update call set webhook_delivered_at = $2, webhook_error = $3 where id = $1", [key, result.ok ? new Date() : null, result.ok ? null : result.error]);
    });
  }

  private async deliver(url: string, secret: string, payload: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const body = JSON.stringify(payload);
    const waits = this.opts.webhookRetryMs ?? [0, 2_000, 10_000];
    let error = "";
    for (const wait of waits) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const t = Math.floor((this.opts.now ?? Date.now)() / 1000);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Max-Signature": `t=${t},v1=${signWebhook(secret, t, body)}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return { ok: true };
        error = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // their error: retrying won't help
      } catch (err) {
        error = String((err as Error)?.message ?? err).slice(0, 200);
      }
    }
    console.error(JSON.stringify({ event: "webhook_failed", error }));
    return { ok: false, error };
  }

  async flush(key?: string): Promise<void> {
    if (key) await (this.queues.get(key) ?? Promise.resolve());
    else await Promise.all([...this.queues.values()]);
    // writes queued while flushing (the webhook after "ended")
    if ((key && this.queues.has(key)) || (!key && this.queues.size)) await this.flush(key);
  }
}
