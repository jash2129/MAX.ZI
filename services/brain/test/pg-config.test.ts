/**
 * The brain with config from the control plane (real Postgres via PGlite): demo content seeded as
 * approved v1, calls run on live versions only, and anything the controller cannot honour yet is refused.
 */
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, asService, migrate } from "../../control-plane/src/db.ts";
import { pgliteDb } from "../../control-plane/src/pglite.ts";
import { seedDemo } from "../../control-plane/src/seed-demo.ts";
import { createBrain } from "../src/app.ts";
import { PostgresConfigSource } from "../src/pg-config.ts";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");

let db: Awaited<ReturnType<typeof pgliteDb>>;
let owner: string;
let clock = 0;

beforeAll(async () => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING", "MAX_STREAM", "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]) delete process.env[k];
  db = await pgliteDb();
  await migrate(db);
  owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
}, 60_000);

afterAll(async () => {
  await db?.close();
});

function brain(ttlMs = 0) {
  return createBrain({ registry: new PostgresConfigSource(db, ttlMs, () => clock) });
}

async function post(b: ReturnType<typeof createBrain>, path: string, body: unknown) {
  return b(new Request(`http://brain${path}`, { method: "POST", body: JSON.stringify(body) }));
}

const finalOf = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.type === "final");

async function shipPrice(steps: number[]) {
  const passed = { calls: 16, hard_failures: 0, completion_rate: 94 };
  return asUser(db, owner, async (tx) => {
    const v = (await tx.query<{ id: string }>("insert into price_ladder_version (dealership_id, steps) values ('demo-hyundai', $1) returning id", [steps])).rows[0];
    await tx.query("update price_ladder_version set status = 'in_test' where id = $1", [v.id]);
    await tx.query("select app.record_test_result('price', $1, $2)", [v.id, JSON.stringify(passed)]);
    await tx.query("select app.approve_version('price', $1)", [v.id]);
    return v.id;
  });
}

describe("seed", () => {
  it("records a real gate result, from the report, with its source and mode", async () => {
    const r = await asService(db, "brain_service", async (tx) => (await tx.query<any>("select test_result from script_version where dealership_id = 'demo-mazda'")).rows[0]);
    expect(r.test_result).toMatchObject({ calls: 16, hard_failures: 0, completion_rate: 93.8, source: expect.stringContaining("sim-batch-2026-11-21T06-26-38"), mode: "free" });
  });
});

describe("brain on control-plane config", () => {
  it("starts a call on the live versions and returns their ids", async () => {
    const b = brain();
    const res = await (await post(b, "/calls", { dealership_id: "demo-mazda", call_id: "pg-1" })).json();
    expect(res.text).toBe("Can you hear and see me alright?");
    expect(res.versions).toEqual({ script: expect.any(String), price: expect.any(String), kb: expect.any(String) });
    expect(res.speech_keyterms).toContain("Mazda");
    const f = await finalOf(await post(b, "/turn", { dealership_id: "demo-mazda", call_id: "pg-1", turn_id: 1, transcript: "Yes I can hear you." }));
    expect(f.text).toMatch(/experience/);
  });

  it("unknown dealerships are 404", async () => {
    expect((await post(brain(), "/calls", { dealership_id: "nobody", call_id: "pg-2" })).status).toBe(404);
  });

  it("refuses a dealership whose live ladder the controller does not enforce, and a call in progress keeps going", async () => {
    const b = brain();
    await post(b, "/calls", { dealership_id: "demo-hyundai", call_id: "pg-3" });
    await shipPrice([5, 4.5, 4]);
    // New calls: refused (never quoted a ladder the controller would not follow)
    expect((await post(b, "/calls", { dealership_id: "demo-hyundai", call_id: "pg-4" })).status).toBe(404);
    // The call already running is unaffected
    const f = await finalOf(await post(b, "/turn", { dealership_id: "demo-hyundai", call_id: "pg-3", turn_id: 1, transcript: "Yes I can hear you." }));
    expect(f.text).toMatch(/experience/);
    // Roll the ladder back: new calls work again
    const retired = await asUser(db, owner, async (tx) => (await tx.query<{ id: string }>("select id from price_ladder_version where dealership_id = 'demo-hyundai' and status = 'retired'")).rows[0].id);
    await asUser(db, owner, (tx) => tx.query("select app.rollback_to('price', $1)", [retired]));
    expect((await post(b, "/calls", { dealership_id: "demo-hyundai", call_id: "pg-5" })).status).toBe(200);
  });

  it("drafts never reach a call", async () => {
    await asUser(db, owner, (tx) => tx.query("insert into price_ladder_version (dealership_id, steps) values ('demo-mazda', '{9,8}')"));
    expect((await post(brain(), "/calls", { dealership_id: "demo-mazda", call_id: "pg-6" })).status).toBe(200);
  });

  it("caches config for its TTL, then sees the change", async () => {
    const b = brain(30_000);
    clock = 1_000;
    expect((await post(b, "/calls", { dealership_id: "demo-hyundai", call_id: "pg-7" })).status).toBe(200);
    await shipPrice([6, 5]);
    clock = 2_000; // within the TTL: still the cached (valid) config
    expect((await post(b, "/calls", { dealership_id: "demo-hyundai", call_id: "pg-8" })).status).toBe(200);
    clock = 40_000; // expired: the new live ladder is seen, and refused
    expect((await post(b, "/calls", { dealership_id: "demo-hyundai", call_id: "pg-9" })).status).toBe(404);
  });
});
