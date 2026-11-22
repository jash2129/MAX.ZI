/**
 * Onboarding without code, the deal intake API, retention and deletion on request (migration 009).
 */
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser, migrate, type Db } from "../src/db.ts";
import { loadLiveConfig } from "../src/live-config.ts";
import { forgetCall, maintain } from "../src/maintenance.ts";
import { pgliteDb } from "../src/pglite.ts";
import { seedDemo } from "../src/seed-demo.ts";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");
let db: Db & { close(): Promise<void> };
const U: Record<string, string> = {};
const as = (u: string, sql: string, params: unknown[] = []) => asUser(db, U[u], async (tx) => (await tx.query<any>(sql, params)).rows);

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  U.owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  await db.query("insert into agency (id, name) values ('acme', 'Acme Agency')");
  const add = async (key: string, email: string) => (U[key] = (await db.query<{ id: string }>("insert into app_user (email) values ($1) returning id", [email])).rows[0].id);
  await add("agency", "admin@acme.test");
  await db.query("insert into membership (user_id, agency_id, role) values ($1, 'acme', 'agency_admin')", [U.agency]);
  await add("mgr", "mgr@mazda.test");
  await db.query("insert into membership (user_id, dealership_id, role) values ($1, 'demo-mazda', 'manager')", [U.mgr]);
  await add("viewer", "viewer@mazda.test");
  await db.query("insert into membership (user_id, dealership_id, role) values ($1, 'demo-mazda', 'viewer')", [U.viewer]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("onboarding", () => {
  it("the platform owner creates a dealership; it starts with drafts copied from the template, nothing live", async () => {
    await as("owner", "select app.create_dealership('kia-north', 'Kia North', null, 'demo-mazda', $1, $2)", [
      JSON.stringify({ year: "2026", make: "Kia", model: "Sportage" }),
      ["Kia", "Sportage"],
    ]);
    const versions = await as("owner", "select 'script' k, status from script_version where dealership_id = 'kia-north' union all select 'price', status from price_ladder_version where dealership_id = 'kia-north' union all select 'kb', status from kb_version where dealership_id = 'kia-north'");
    expect(versions.map((v) => `${v.k}:${v.status}`).sort()).toEqual(["kb:draft", "price:draft", "script:draft"]);
    // the brain sees the dealership but no live versions: it refuses its calls until they are approved
    const live = await loadLiveConfig(db, "kia-north");
    expect(live).toMatchObject({ name: "Kia North", script: null, price: null, kb: null });
  });

  it("an agency admin creates dealerships in their agency only; managers cannot create any", async () => {
    await as("agency", "select app.create_dealership('acme-ford', 'Acme Ford', 'acme', 'demo-mazda', null, null)").catch((e) => {
      // the agency admin cannot read demo-mazda (not in their agency): use an agency template instead
      expect(String(e)).toMatch(/unknown template/);
    });
    await as("owner", "select app.create_dealership('acme-template', 'Acme Template', 'acme', 'demo-mazda', null, null)");
    await as("agency", "select app.create_dealership('acme-ford', 'Acme Ford', 'acme', 'acme-template', null, null)");
    expect((await as("agency", "select id from dealership order by id")).map((r) => r.id)).toEqual(["acme-ford", "acme-template"]);
    await expect(as("agency", "select app.create_dealership('loose', 'Loose', null, 'acme-template', null, null)")).rejects.toThrow(/only the platform owner/);
    await expect(as("mgr", "select app.create_dealership('mine', 'Mine', null, 'demo-mazda', null, null)")).rejects.toThrow(/only the platform owner/);
    await expect(as("mgr", "select app.create_dealership('mine', 'Mine', 'acme', 'demo-mazda', null, null)")).rejects.toThrow(/only the agency admin/);
  });
});

describe("deal intake API", () => {
  let key = "";

  it("a manager creates a key (shown once; only its hash is stored); viewers cannot", async () => {
    key = (await as("mgr", "select app.create_api_key('demo-mazda', 'DMS') as k"))[0].k;
    expect(key).toMatch(/^mxk_[0-9a-f]{64}$/);
    const rows = await as("mgr", "select prefix, key_hash from api_key where dealership_id = 'demo-mazda'");
    expect(rows[0].prefix).toBe(key.slice(0, 12));
    expect(rows[0].key_hash).not.toContain(key.slice(4));
    await expect(as("viewer", "select app.create_api_key('demo-mazda', 'x')")).rejects.toThrow(/only a manager/);
    expect(await as("viewer", "select * from api_key")).toEqual([]);
  });

  it("a deal posted with the key belongs to the key's dealership and expires in 2 hours", async () => {
    const [d] = (await db.query<any>("select * from app.intake_deal($1, 'DEAL-1001', $2, 'Sam')", [key, JSON.stringify({ year: "2026", make: "Mazda", model: "CX-50" })])).rows;
    expect(d.dealership_id).toBe("demo-mazda");
    const mins = (new Date(d.expires_at).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(115);
    expect(mins).toBeLessThan(125);
    // the brain can read it while it is valid
    const seen = await asService(db, "brain_service", async (tx) => (await tx.query<any>("select vehicle, customer_first_name from deal where id = $1", [d.deal_id])).rows);
    expect(seen).toEqual([{ vehicle: { year: "2026", make: "Mazda", model: "CX-50" }, customer_first_name: "Sam" }]);
  });

  it("a wrong or revoked key is refused", async () => {
    await expect(db.query("select * from app.intake_deal('mxk_nope', 'X', '{}', 'x')")).rejects.toThrow(/invalid API key/);
    const [{ id }] = await as("mgr", "select id from api_key where dealership_id = 'demo-mazda'");
    await as("mgr", "select app.revoke_api_key($1)", [id]);
    await expect(db.query("select * from app.intake_deal($1, 'X', '{}', 'x')", [key])).rejects.toThrow(/invalid API key/);
  });

  it("another dealership's manager cannot revoke or see the key", async () => {
    await db.query("insert into membership (user_id, dealership_id, role) values ($1, 'kia-north', 'manager')", [U.viewer]);
    const [{ id }] = await as("mgr", "select id from api_key where dealership_id = 'demo-mazda'");
    await expect(as("viewer", "select app.revoke_api_key($1)", [id])).rejects.toThrow(/not allowed/);
  });
});

describe("retention and deletion", () => {
  async function oldCall(id: string, daysAgo: number, ended = true) {
    await asService(db, "brain_service", async (tx) => {
      await tx.query(
        `insert into call (id, dealership_id, started_at, ended_at) values ($1, 'demo-mazda', now() - make_interval(secs => $2), ${ended ? "now() - make_interval(secs => $2)" : "null"})`,
        [id, daysAgo * 86400]
      );
      await tx.query("insert into turn (call_id, dealership_id, idx, customer_text, max_text) values ($1, 'demo-mazda', 1, 'yes', 'hello')", [id]);
      await tx.query("insert into call_review (call_id, dealership_id, score, summary) values ($1, 'demo-mazda', 9, 'Accepted')", [id]);
    });
  }

  it("maintenance closes abandoned calls and deletes transcripts past retention, nothing newer", async () => {
    await oldCall("old-call", 400);
    await oldCall("recent-call", 10);
    await oldCall("stuck-call", 0.5, false);
    const r = await maintain(db, { staleHours: 3 });
    expect(r.abandoned).toBe(1);
    expect(r.turns_deleted).toBe(1);
    const left = (await db.query<{ call_id: string }>("select call_id from turn order by call_id")).rows.map((x) => x.call_id);
    expect(left).toContain("recent-call");
    expect(left).not.toContain("old-call");
    expect((await db.query<any>("select end_reason from call where id = 'stuck-call'")).rows[0].end_reason).toBe("abandoned");
    expect(await maintain(db, { staleHours: 3 })).toMatchObject({ abandoned: 0, turns_deleted: 0 });
  });

  it("deletion on request: a manager forgets a call's content; the outcome row stays", async () => {
    await as("mgr", "select app.forget_call('recent-call')");
    expect((await db.query("select * from turn where call_id = 'recent-call'")).rows).toEqual([]);
    expect((await db.query<any>("select summary from call_review where call_id = 'recent-call'")).rows[0].summary).toBeNull();
    expect((await db.query("select id from call where id = 'recent-call'")).rows).toHaveLength(1);
    const log = await as("viewer", "select action from audit_log where table_name = 'call' and row_id = 'recent-call'");
    expect(log).toEqual([{ action: "forget" }]);
  });

  it("viewers, other dealerships and the portal login without a person cannot forget calls", async () => {
    await oldCall("keep-call", 1);
    await expect(as("viewer", "select app.forget_call('keep-call')")).rejects.toThrow(/not allowed/);
    // no signed-in person (the portal's own login before sign-in)
    await expect(db.transaction(async (tx) => {
      await tx.query("set local role app_user");
      await tx.query("select app.forget_call('keep-call')");
    })).rejects.toThrow(/not allowed/);
    await expect(db.transaction(async (tx) => {
      await tx.query("set local role app_user");
      await tx.query("select app.forget_call_now('keep-call')");
    })).rejects.toThrow(/permission denied/);
    // the owner can (CLI)
    await forgetCall(db, "keep-call");
    expect((await db.query("select * from turn where call_id = 'keep-call'")).rows).toEqual([]);
  });
});
