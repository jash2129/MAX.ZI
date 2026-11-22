/**
 * Call records: a real call through the brain on real Postgres (PGlite), then every record checked:
 * the call, its turns (heard, timings), consent, the after-call review, usage, and the signed webhook.
 */
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser, migrate, type Db } from "../../control-plane/src/db";
import { pgliteDb } from "../../control-plane/src/pglite";
import { seedDemo } from "../../control-plane/src/seed-demo";
import { createBrain } from "../src/app";
import { PostgresConfigSource } from "../src/pg-config";
import { PgCallRecorder, signWebhook } from "../src/recorder";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");
const SECRET = "a-webhook-secret-that-is-long-enough-1234";

let db: Awaited<ReturnType<typeof pgliteDb>>;
let owner: string;
const deliveries: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let webhookStatus = 200;

const fakeFetch = (async (url: string, init: RequestInit) => {
  deliveries.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
  return new Response("", { status: webhookStatus });
}) as unknown as typeof fetch;

let recorder: PgCallRecorder;
let brain: ReturnType<typeof createBrain>;

beforeAll(async () => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING", "MAX_STREAM", "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]) delete process.env[k];
  db = await pgliteDb();
  await migrate(db);
  owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  await asUser(db, owner, (tx) => tx.query("insert into dealership_webhook (dealership_id, url, secret) values ('demo-mazda', 'https://crm.example.com/hooks/max', $1)", [SECRET]));
  recorder = new PgCallRecorder(db, { fetchImpl: fakeFetch, webhookRetryMs: [0, 0, 0] });
  brain = createBrain({ registry: new PostgresConfigSource(db, 0), recorder });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const post = (path: string, body: unknown) => brain(new Request(`http://brain${path}`, { method: "POST", body: JSON.stringify(body) }));
const finalOf = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.type === "final");

const answer = (beat: number) =>
  beat === 0 ? "Yes, I can hear and see you, it's been great." : beat === 23 ? "The warranty and the tires." : beat >= 25 ? "John Smith, 12 Main Street, Dallas." : "Yes, that makes sense.";

/** A cooperative call to the end, every reply heard, with the worker's timings on each commit */
async function playCall(dealership: string, callId: string) {
  await post("/calls", { dealership_id: dealership, call_id: callId });
  let beat = 0;
  for (let turn = 1; turn <= 60; turn++) {
    const f = await finalOf(await post("/turn", { dealership_id: dealership, call_id: callId, turn_id: turn, transcript: answer(beat) }));
    await post("/commit", { dealership_id: dealership, call_id: callId, turn_id: turn, heard: true, fraction_heard: 1, timings: { first_audio_ms: 640, end_of_turn_ms: 230, note: "free text is dropped" } });
    beat = f.beat;
    if (f.is_complete) return turn;
  }
  throw new Error("call did not complete");
}

const records = (sql: string, params: unknown[] = []) => asService(db, "brain_service", async (tx) => (await tx.query<any>(sql, params)).rows);

describe("call records", () => {
  let turns = 0;
  const key = "demo-mazda:rec-1";

  beforeAll(async () => {
    turns = await playCall("demo-mazda", "rec-1");
    await post("/end", { dealership_id: "demo-mazda", call_id: "rec-1", reason: "script_complete" });
    await recorder.flush();
  }, 120_000);

  it("the call: versions it ran on, consent time, outcome", async () => {
    const [call] = await records("select * from call where id = $1", [key]);
    expect(call.dealership_id).toBe("demo-mazda");
    expect(call.script_version_id && call.price_version_id && call.kb_version_id).toBeTruthy();
    expect(call.consent_at).not.toBeNull();
    expect(call.ended_at).not.toBeNull();
    expect(call.end_reason).toBe("script_complete");
    expect(call.furthest_beat).toBe(25);
    expect(Number(call.final_rate)).toBe(4);
    expect(call.declined).toBe(false);
    expect(call.turns_count).toBe(turns);
    expect((call.panels_shown as any[]).some((p) => p.panel === "price")).toBe(true);
  });

  it("every turn, with what was heard and the stage timings (numbers only)", async () => {
    const rows = await records("select * from turn where call_id = $1 order by idx", [key]);
    expect(rows).toHaveLength(turns);
    expect(rows[0].customer_text).toBe(answer(0));
    expect(rows[0].max_text).toMatch(/experience/);
    expect(rows.every((r) => r.heard === true && Number(r.fraction_heard) === 1)).toBe(true);
    expect(rows[3].timings).toMatchObject({ brain_final_ms: expect.any(Number), first_audio_ms: 640, end_of_turn_ms: 230 });
    expect(rows[3].timings.note).toBeUndefined();
    expect(rows[3].understanding).toMatch(/^rules:/);
    expect(rows[3].wording_source).toBe("approved-line");
  });

  it("the after-call review: compliance checks and scorecard", async () => {
    const [review] = await records("select * from call_review where call_id = $1", [key]);
    expect(review.compliance_checks).toEqual({ disclosure_said: true, consent_before_beat_2: true, prices_approved: true, no_confirmed_refusal: true });
    expect(Number(review.score)).toBeGreaterThan(8);
    expect(review.summary).toMatch(/Accepted at \$4\/day; reached beat 25/);
  });

  it("usage is recorded", async () => {
    const [u] = await records("select * from usage_event where call_id = $1", [key]);
    expect(Number(u.minutes)).toBeGreaterThanOrEqual(0);
  });

  it("the dealership's webhook gets a signed summary (no transcript)", async () => {
    const d = deliveries.find((x) => JSON.parse(x.body).call_id === key)!;
    expect(d.url).toBe("https://crm.example.com/hooks/max");
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(d.headers["X-Max-Signature"])!;
    expect(v1).toBe(signWebhook(SECRET, Number(t), d.body));
    const payload = JSON.parse(d.body);
    expect(payload).toMatchObject({ event: "call.completed", outcome: "accepted", final_daily_rate: 4, compliance: { prices_approved: true } });
    expect(d.body).not.toMatch(/John Smith|Main Street/);
    expect(d.body).not.toContain(SECRET);
    const [call] = await records("select webhook_delivered_at, webhook_error from call where id = $1", [key]);
    expect(call.webhook_delivered_at).not.toBeNull();
  });

  it("people of the dealership see the records; another dealership's people do not", async () => {
    const viewer = (await db.query<{ id: string }>("insert into app_user (email) values ('viewer@mazda.test') returning id")).rows[0].id;
    await db.query("insert into membership (user_id, dealership_id, role) values ($1, 'demo-mazda', 'viewer')", [viewer]);
    const other = (await db.query<{ id: string }>("insert into app_user (email) values ('mgr@hyundai.test') returning id")).rows[0].id;
    await db.query("insert into membership (user_id, dealership_id, role) values ($1, 'demo-hyundai', 'manager')", [other]);
    expect((await asUser(db, viewer, (tx) => tx.query("select id from call where id = $1", [key]))).rows).toHaveLength(1);
    expect((await asUser(db, other, (tx) => tx.query("select id from call where id = $1", [key]))).rows).toHaveLength(0);
    expect((await asUser(db, other, (tx) => tx.query("select * from turn where call_id = $1", [key]))).rows).toHaveLength(0);
  });

  it("viewers cannot read the webhook secret; the audit log never contains it", async () => {
    const viewer = (await db.query<{ id: string }>("select id from app_user where email = 'viewer@mazda.test'")).rows[0].id;
    expect((await asUser(db, viewer, (tx) => tx.query("select * from dealership_webhook"))).rows).toHaveLength(0);
    const audit = await asUser(db, viewer, async (tx) => (await tx.query<any>("select before, after from audit_log where table_name = 'dealership_webhook'")).rows);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });
});

describe("a failing webhook and a failing database never affect the call", () => {
  it("a webhook that keeps failing is recorded as failed, after retries", async () => {
    webhookStatus = 500;
    const before = deliveries.length;
    await post("/calls", { dealership_id: "demo-mazda", call_id: "rec-2" });
    await post("/turn", { dealership_id: "demo-mazda", call_id: "rec-2", turn_id: 1, transcript: "Yes I can hear you" });
    await post("/end", { dealership_id: "demo-mazda", call_id: "rec-2", reason: "customer_left" });
    await recorder.flush();
    webhookStatus = 200;
    expect(deliveries.length - before).toBe(3);
    const [call] = await records("select webhook_delivered_at, webhook_error, end_reason from call where id = 'demo-mazda:rec-2'");
    expect(call).toMatchObject({ webhook_delivered_at: null, webhook_error: "HTTP 500", end_reason: "customer_left" });
  });

  it("with the database down for records, Max still answers every turn", async () => {
    const broken = { query: async () => { throw new Error("db down"); }, exec: async () => { throw new Error("db down"); }, transaction: async () => { throw new Error("db down"); } } as unknown as Db;
    const b = createBrain({ registry: new PostgresConfigSource(db, 0), recorder: new PgCallRecorder(broken) });
    await b(new Request("http://brain/calls", { method: "POST", body: JSON.stringify({ dealership_id: "demo-mazda", call_id: "rec-3" }) }));
    const f = await finalOf(await b(new Request("http://brain/turn", { method: "POST", body: JSON.stringify({ dealership_id: "demo-mazda", call_id: "rec-3", turn_id: 1, transcript: "Yes I can hear you" }) })));
    expect(f.text).toMatch(/experience/);
    expect(f.fallback).toBeUndefined();
  });
});
