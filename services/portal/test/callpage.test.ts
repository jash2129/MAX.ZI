import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { asUser, migrate } from "../../control-plane/src/db";
import { pgliteDb } from "../../control-plane/src/pglite";
import { seedDemo } from "../../control-plane/src/seed-demo";
import { callPageInfo, startCustomerCall, workerUrl } from "../src/server/callpage";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");
let db: Awaited<ReturnType<typeof pgliteDb>>;
let owner = "";
const sent: Array<{ url: string; auth: string; body: any }> = [];
let workerStatus = 200;
const fakeWorker = (async (url: string, init: RequestInit) => {
  sent.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ call_id: "c_1", room_url: "https://x.daily.co/r", customer_token: "customer-token" }), { status: workerStatus });
}) as unknown as typeof fetch;

async function newDeal(dealership = "demo-mazda") {
  const key = await asUser(db, owner, async (tx) => (await tx.query<{ k: string }>("select app.create_api_key($1, 't') as k", [dealership])).rows[0].k);
  return (await db.query<any>("select * from app.intake_deal($1, 'R', $2, 'Ana')", [key, JSON.stringify({ year: "2026", make: "Mazda", model: "CX-30" })])).rows[0].deal_id as string;
}

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  process.env.WORKER_URL = "http://worker.internal:7860";
  process.env.WORKER_TOKEN = "worker-secret";
}, 120_000);

afterEach(() => {
  workerStatus = 200;
});

afterAll(async () => {
  delete process.env.WORKER_URL;
  delete process.env.WORKER_TOKEN;
  await db?.close();
});

describe("call page", () => {
  it("public details only, and whether the dealership takes calls", async () => {
    expect(await callPageInfo(db, "demo-mazda")).toEqual({ id: "demo-mazda", name: "Mazda Dealership", max_display_name: "Max", branding: {}, products: [], ready: true });
    expect(await callPageInfo(db, "nope")).toBeNull();
    expect(await callPageInfo(db, "../etc")).toBeNull();
  });

  it("a valid deal link starts a call through the worker (its token stays on the server)", async () => {
    const deal = await newDeal();
    const r = await startCustomerCall(db, "demo-mazda", deal, fakeWorker);
    expect(r).toEqual({ ok: true, room_url: "https://x.daily.co/r", customer_token: "customer-token", call_id: "c_1", vehicle: { year: "2026", make: "Mazda", model: "CX-30" }, first_name: "Ana" });
    expect(sent.at(-1)).toEqual({ url: "http://worker.internal:7860/calls", auth: "Bearer worker-secret", body: { dealership_id: "demo-mazda", deal_id: deal } });
    expect(JSON.stringify(r)).not.toContain("worker-secret");
  });

  it("a link starts at most 3 calls; another dealership's link and a broken link start none", async () => {
    const deal = await newDeal();
    for (let i = 0; i < 3; i++) expect((await startCustomerCall(db, "demo-mazda", deal, fakeWorker)).ok).toBe(true);
    expect(await startCustomerCall(db, "demo-mazda", deal, fakeWorker)).toMatchObject({ ok: false, status: 410 });
    const other = await newDeal();
    expect(await startCustomerCall(db, "demo-hyundai", other, fakeWorker)).toMatchObject({ ok: false, status: 410 });
    expect(await startCustomerCall(db, "demo-mazda", "not-a-uuid", fakeWorker)).toMatchObject({ ok: false, status: 400 });
  });

  it("busy and refusing workers give the customer plain messages", async () => {
    workerStatus = 503;
    expect(await startCustomerCall(db, "demo-mazda", await newDeal(), fakeWorker)).toMatchObject({ ok: false, status: 503, message: expect.stringMatching(/busy/) });
    workerStatus = 404;
    expect(await startCustomerCall(db, "demo-mazda", await newDeal(), fakeWorker)).toMatchObject({ ok: false, status: 404, message: expect.stringMatching(/not taking calls/) });
  });

  it("without a configured worker, nothing is used up", async () => {
    const deal = await newDeal();
    delete process.env.WORKER_TOKEN;
    expect(await startCustomerCall(db, "demo-mazda", deal, fakeWorker)).toMatchObject({ ok: false, status: 503 });
    process.env.WORKER_TOKEN = "worker-secret";
    expect((await db.query<{ starts: number }>("select starts from deal where id = $1", [deal])).rows[0].starts).toBe(0);
  });

  it("the worker's address from Render's internal host:port", () => {
    const keep = process.env.WORKER_URL;
    delete process.env.WORKER_URL;
    process.env.WORKER_HOSTPORT = "max-voice-worker-x1:10000";
    expect(workerUrl()).toBe("http://max-voice-worker-x1:10000");
    process.env.WORKER_HOSTPORT = "http://evil/x";
    expect(workerUrl()).toBeNull();
    delete process.env.WORKER_HOSTPORT;
    process.env.WORKER_URL = keep;
  });
});
