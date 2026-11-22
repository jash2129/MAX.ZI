/**
 * Calls, dashboard and webhook in the portal, on records written by the real brain + recorder.
 */
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrain } from "../../brain/src/app";
import { PostgresConfigSource } from "../../brain/src/pg-config";
import { PgCallRecorder } from "../../brain/src/recorder";
import { migrate } from "../../control-plane/src/db";
import { pgliteDb } from "../../control-plane/src/pglite";
import { seedDemo } from "../../control-plane/src/seed-demo";
import { PortalError, dashboard, getCall, getWebhook, listCalls, removeWebhook, setWebhook } from "../src/server/portal";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");
let db: Awaited<ReturnType<typeof pgliteDb>>;
const U: Record<string, string> = {};
let recorder: PgCallRecorder;

const answer = (beat: number) =>
  beat === 0 ? "Yes, I can hear and see you, it's been great." : beat === 23 ? "The warranty and the tires." : beat >= 25 ? "John Smith, 12 Main Street, Dallas." : "Yes, that makes sense.";

beforeAll(async () => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING", "MAX_STREAM"]) delete process.env[k];
  db = await pgliteDb();
  await migrate(db);
  U.owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  for (const [key, email, d, role] of [
    ["mgr", "mgr@mazda.test", "demo-mazda", "manager"],
    ["viewer", "viewer@mazda.test", "demo-mazda", "viewer"],
    ["other", "mgr@hyundai.test", "demo-hyundai", "manager"],
  ]) {
    U[key] = (await db.query<{ id: string }>("insert into app_user (email) values ($1) returning id", [email])).rows[0].id;
    await db.query("insert into membership (user_id, dealership_id, role) values ($1, $2, $3)", [U[key], d, role]);
  }
  recorder = new PgCallRecorder(db, { fetchImpl: (async () => new Response("")) as unknown as typeof fetch, webhookRetryMs: [0] });
  const brain = createBrain({ registry: new PostgresConfigSource(db, 0), recorder });
  const post = (path: string, body: unknown) => brain(new Request(`http://brain${path}`, { method: "POST", body: JSON.stringify(body) }));
  // one complete call (accepted at $4), one that ends early
  for (const [callId, maxTurns] of [["full", 60], ["short", 3]] as const) {
    await post("/calls", { dealership_id: "demo-mazda", call_id: callId });
    let beat = 0;
    for (let t = 1; t <= maxTurns; t++) {
      const lines = (await (await post("/turn", { dealership_id: "demo-mazda", call_id: callId, turn_id: t, transcript: answer(beat) })).text()).split("\n").filter(Boolean);
      const f = JSON.parse(lines.at(-1)!);
      await post("/commit", { dealership_id: "demo-mazda", call_id: callId, turn_id: t, heard: true, fraction_heard: 1, timings: { first_audio_ms: 600 + t * 10 } });
      beat = f.beat;
      if (f.is_complete) break;
    }
    await post("/end", { dealership_id: "demo-mazda", call_id: callId, reason: callId === "full" ? "script_complete" : "customer_left" });
  }
  await recorder.flush();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

describe("calls", () => {
  it("the dealership's people see its calls, newest first, with outcome and checks", async () => {
    const calls = await listCalls(db, U.viewer, "demo-mazda");
    expect(calls.map((c) => c.id)).toEqual(["demo-mazda:short", "demo-mazda:full"]);
    const full = calls.find((c) => c.id === "demo-mazda:full")!;
    expect(full).toMatchObject({ end_reason: "script_complete", furthest_beat: 25, declined: false, compliance_ok: true });
    expect(Number(full.final_rate)).toBe(4);
    expect(calls.find((c) => c.id === "demo-mazda:short")!.end_reason).toBe("customer_left");
  });

  it("another dealership's people see none of them", async () => {
    expect(await listCalls(db, U.other, "demo-mazda")).toEqual([]);
    await expect(getCall(db, U.other, "demo-mazda", "demo-mazda:full")).rejects.toThrow(/No such call/);
  });

  it("a call's detail: every turn, what was heard, timings, the review", async () => {
    const { call, turns, review } = await getCall(db, U.viewer, "demo-mazda", "demo-mazda:full");
    expect(call.consent_at).not.toBeNull();
    expect(turns.length).toBe(call.turns_count);
    expect(turns[0].timings.first_audio_ms).toBe(610);
    expect(review.compliance_checks.disclosure_said).toBe(true);
  });

  it("the dashboard: rates, take rate, average rate, latency", async () => {
    const d = await dashboard(db, U.viewer, "demo-mazda");
    expect(d.calls).toBe(2);
    expect(d.completed_rate).toBe(50);
    expect(d.price_reached_rate).toBe(50);
    expect(d.take_rate).toBe(100);
    expect(d.avg_final_rate).toBe(4);
    expect(d.compliance_failures).toBe(0);
    expect(d.first_audio_ms.turns).toBeGreaterThan(20);
    expect(d.first_audio_ms.median).toBeGreaterThan(600);
    expect(d.first_audio_ms.p90).toBeGreaterThanOrEqual(d.first_audio_ms.median!);
    expect(d.per_day).toHaveLength(1);
    expect((await dashboard(db, U.other, "demo-mazda")).calls).toBe(0);
  });
});

describe("webhook settings", () => {
  it("a manager sets the URL and gets a new secret once; it is never read back", async () => {
    const secret = await setWebhook(db, U.mgr, "demo-mazda", "https://crm.example.com/max");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await getWebhook(db, U.mgr, "demo-mazda")).toEqual({ url: "https://crm.example.com/max", active: true });
    await expect(setWebhook(db, U.mgr, "demo-mazda", "http://insecure.example.com")).rejects.toThrow(/https/);
  });

  it("viewers and other dealerships cannot see or change it", async () => {
    expect(await getWebhook(db, U.viewer, "demo-mazda")).toBeNull();
    await expect(setWebhook(db, U.viewer, "demo-mazda", "https://evil.example.com/x")).rejects.toThrow(PortalError);
    await expect(setWebhook(db, U.other, "demo-mazda", "https://evil.example.com/x")).rejects.toThrow(PortalError);
    await removeWebhook(db, U.other, "demo-mazda"); // RLS: affects nothing
    expect(await getWebhook(db, U.mgr, "demo-mazda")).not.toBeNull();
  });
});
