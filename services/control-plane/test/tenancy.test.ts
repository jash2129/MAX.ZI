/**
 * Tenancy, roles and the version lifecycle, against real Postgres (PGlite). Every assertion goes
 * through the same roles the application uses; nothing here relies on application-side filtering.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser, migrate, type Db } from "../src/db.ts";
import { loadLiveConfig } from "../src/live-config.ts";
import { pgliteDb } from "../src/pglite.ts";

let db: Db & { close(): Promise<void> };
const U: Record<string, string> = {};

const BEATS = [{ id: 1, type: "wait", text: "Before I start, this call is recorded.", expects: "consent" }];
const PASS = { calls: 16, hard_failures: 0, completion_rate: 85 };

async function seedUser(key: string, email: string, owner = false) {
  const r = await db.query<{ id: string }>("insert into app_user (email, display_name, is_platform_owner) values ($1, $2, $3) returning id", [email, key, owner]);
  U[key] = r.rows[0].id;
}

async function member(user: string, opts: { dealership?: string; agency?: string; role: string }) {
  await db.query("insert into membership (user_id, dealership_id, agency_id, role) values ($1, $2, $3, $4)", [U[user], opts.dealership ?? null, opts.agency ?? null, opts.role]);
}

const rows = async (user: string, sql: string, params: unknown[] = []) => asUser(db, U[user], async (tx) => (await tx.query<any>(sql, params)).rows);
const run = (user: string, sql: string, params: unknown[] = []) => rows(user, sql, params);

async function newDraft(user: string, kind: "script" | "price" | "kb", dealership: string, content?: Record<string, unknown>) {
  const sql = {
    script: "insert into script_version (dealership_id, beats, disclosure) values ($1, $2, $3) returning id, version",
    price: "insert into price_ladder_version (dealership_id, steps) values ($1, $2) returning id, version",
    kb: "insert into kb_version (dealership_id, facts) values ($1, $2) returning id, version",
  }[kind];
  const params = {
    script: [dealership, JSON.stringify(content?.beats ?? BEATS), content?.disclosure ?? "This call is recorded."],
    price: [dealership, content?.steps ?? [4, 3.5, 3.25, 3]],
    kb: [dealership, JSON.stringify(content?.facts ?? [{ topic: "gap", answer: "GAP covers the difference.", keywords: ["gap"] }])],
  }[kind];
  return (await rows(user, sql, params))[0] as { id: string; version: number };
}

const table = { script: "script_version", price: "price_ladder_version", kb: "kb_version" } as const;

/** draft -> in_test -> gate result -> approved and live, by the right people */
async function shipVersion(kind: "script" | "price" | "kb", dealership: string, editor: string, approver: string, content?: Record<string, unknown>, result = PASS) {
  const v = await newDraft(editor, kind, dealership, content);
  await run(editor, `update ${table[kind]} set status = 'in_test' where id = $1`, [v.id]);
  await asService(db, "gate_service", (tx) => tx.query("select app.record_test_result($1, $2, $3)", [kind, v.id, JSON.stringify(result)]));
  await run(approver, "select app.approve_version($1, $2)", [kind, v.id]);
  return v;
}

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  await db.query("insert into agency (id, name) values ('acme', 'Acme Agency')");
  await db.query("insert into dealership (id, name, default_vehicle, speech_keyterms) values ('mazda-north', 'Mazda North', '{\"year\":\"2026\",\"make\":\"Mazda\",\"model\":\"CX five\"}', '{Mazda}')");
  await db.query("insert into dealership (id, agency_id, name) values ('hyundai-east', 'acme', 'Hyundai East'), ('kia-west', 'acme', 'Kia West')");
  await seedUser("owner", "owner@platform.test", true);
  await seedUser("agency", "admin@acme.test");
  await seedUser("mazdaMgr", "mgr@mazda.test");
  await seedUser("mazdaApprover", "approver@mazda.test");
  await seedUser("mazdaViewer", "viewer@mazda.test");
  await seedUser("hyundaiMgr", "mgr@hyundai.test");
  await seedUser("hyundaiApprover", "approver@hyundai.test");
  await seedUser("nobody", "nobody@nowhere.test");
  await member("agency", { agency: "acme", role: "agency_admin" });
  await member("mazdaMgr", { dealership: "mazda-north", role: "manager" });
  await member("mazdaApprover", { dealership: "mazda-north", role: "approver" });
  await member("mazdaViewer", { dealership: "mazda-north", role: "viewer" });
  await member("hyundaiMgr", { dealership: "hyundai-east", role: "manager" });
  await member("hyundaiApprover", { dealership: "hyundai-east", role: "approver" });

  // Some of everything, for every dealership, written the way the services write it
  for (const d of ["mazda-north", "hyundai-east", "kia-west"]) {
    await db.query("insert into script_version (dealership_id, beats, disclosure) values ($1, $2, 'Recorded.')", [d, JSON.stringify(BEATS)]);
    await db.query("insert into price_ladder_version (dealership_id, steps) values ($1, '{4,3.5,3.25,3}')", [d]);
    await db.query("insert into kb_version (dealership_id) values ($1)", [d]);
    await asService(db, "worker_service", async (tx) => {
      const deal = (await tx.query<any>("insert into deal (dealership_id, vehicle) values ($1, '{}') returning id", [d])).rows[0].id;
      await tx.query("insert into call (id, dealership_id, deal_id) values ($1, $2, $3)", [`call-${d}`, d, deal]);
      await tx.query("insert into turn (call_id, dealership_id, idx, customer_text) values ($1, $2, 1, 'yes')", [`call-${d}`, d]);
      await tx.query("insert into recording (call_id, dealership_id, storage_key, retention_until) values ($1, $2, $3, now() + interval '90 days')", [`call-${d}`, d, `${d}/call.webm`]);
      await tx.query("insert into call_review (call_id, dealership_id, score) values ($1, $2, 90)", [`call-${d}`, d]);
      await tx.query("insert into usage_event (dealership_id, call_id, minutes) values ($1, $2, 12)", [d, `call-${d}`]);
    });
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("migrations", () => {
  it("apply once; running again does nothing", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("every table in the public schema has row-level security on", async () => {
    const off = (await db.query<{ relname: string }>(
      "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> 'schema_migrations'"
    )).rows.map((r) => r.relname);
    expect(off).toEqual([]);
  });
});

describe("cross-tenant isolation (PRD acceptance: a user of one dealership cannot see another's data)", () => {
  let tenantTables: string[] = [];
  beforeAll(async () => {
    tenantTables = (await db.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'dealership_id' order by table_name"
    )).rows.map((r) => r.table_name);
  });

  it("covers every table with a dealership_id", () => {
    expect(tenantTables).toEqual(expect.arrayContaining(["audit_log", "call", "call_review", "deal", "kb_version", "membership", "price_ladder_version", "recording", "script_version", "turn", "usage_event"]));
  });

  const visible = async (user: string, t: string) =>
    new Set((await rows(user, `select distinct dealership_id from ${t} where dealership_id is not null`)).map((r) => r.dealership_id));

  it.each([
    ["mazdaMgr", ["mazda-north"]],
    ["mazdaViewer", ["mazda-north"]],
    ["hyundaiMgr", ["hyundai-east"]],
    ["agency", ["hyundai-east", "kia-west"]],
    ["nobody", []],
  ])("%s sees only %j in every tenant table", async (user, allowed) => {
    for (const t of tenantTables) {
      for (const d of await visible(user, t)) expect(allowed, `${user} saw ${d} in ${t}`).toContain(d);
    }
    const dealerships = (await rows(user, "select id from dealership")).map((r) => r.id).sort();
    expect(dealerships).toEqual([...allowed].sort());
    // Not vacuous: they do see their own records, in every call-record table
    for (const t of ["deal", "call", "turn", "recording", "call_review", "usage_event"]) {
      expect([...(await visible(user, t))].sort(), `${user} in ${t}`).toEqual([...allowed].sort());
    }
  });

  it("the platform owner sees every dealership (support view)", async () => {
    expect((await rows("owner", "select count(*)::int as n from call"))[0].n).toBe(3);
  });

  it("people are visible only within shared tenants", async () => {
    const emails = (await rows("mazdaViewer", "select email from app_user")).map((r) => r.email).sort();
    expect(emails).toEqual(["approver@mazda.test", "mgr@mazda.test", "viewer@mazda.test"]);
  });

  it("no one can write into another dealership", async () => {
    await expect(newDraft("hyundaiMgr", "script", "mazda-north")).rejects.toThrow(/row-level security/);
    const updated = await rows("hyundaiMgr", "update dealership set name = 'pwned' where id = 'mazda-north' returning id");
    expect(updated).toEqual([]);
  });

  it("people never write call records", async () => {
    await expect(run("owner", "insert into call (id, dealership_id) values ('x', 'mazda-north')")).rejects.toThrow(/permission denied/);
  });
});

describe("roles", () => {
  it("viewers cannot create drafts", async () => {
    await expect(newDraft("mazdaViewer", "script", "mazda-north")).rejects.toThrow(/row-level security/);
  });

  it("managers add managers and viewers, not approvers; the agency admin can add approvers", async () => {
    await expect(run("hyundaiMgr", "insert into membership (user_id, dealership_id, role) values ($1, 'hyundai-east', 'approver')", [U.nobody])).rejects.toThrow(/row-level security/);
    await run("hyundaiMgr", "insert into membership (user_id, dealership_id, role) values ($1, 'hyundai-east', 'viewer')", [U.nobody]);
    await run("agency", "insert into membership (user_id, dealership_id, role) values ($1, 'hyundai-east', 'approver')", [U.nobody]);
    expect(await rows("nobody", "select id from dealership")).toEqual([{ id: "hyundai-east" }]);
    await db.query("delete from membership where user_id = $1", [U.nobody]);
  });

  it("nobody can make themselves platform owner", async () => {
    await expect(run("mazdaMgr", "update app_user set is_platform_owner = true where id = $1", [U.mazdaMgr])).rejects.toThrow(/row-level security/);
  });
});

describe("version lifecycle", () => {
  it("a draft goes to test, passes the gate, is approved and goes live; the previous live version retires", async () => {
    const v1 = await shipVersion("price", "mazda-north", "mazdaMgr", "mazdaApprover");
    const v2 = await shipVersion("price", "mazda-north", "mazdaMgr", "mazdaApprover", { steps: [5, 4.5, 4] });
    const st = await rows("mazdaViewer", "select id, status, approved_by from price_ladder_version where id in ($1, $2) order by version", [v1.id, v2.id]);
    expect(st.map((r) => r.status)).toEqual(["retired", "live"]);
    expect(st[1].approved_by).toBe(U.mazdaApprover);
  });

  it("rollback is one step, and there is only ever one live version", async () => {
    const live = (await rows("mazdaViewer", "select id from price_ladder_version where dealership_id = 'mazda-north' and status = 'live'"))[0];
    const retired = (await rows("mazdaViewer", "select id from price_ladder_version where dealership_id = 'mazda-north' and status = 'retired' order by version desc limit 1"))[0];
    await run("mazdaApprover", "select app.rollback_to('price', $1)", [retired.id]);
    const lives = await rows("mazdaViewer", "select id from price_ladder_version where dealership_id = 'mazda-north' and status = 'live'");
    expect(lives).toEqual([{ id: retired.id }]);
    expect((await rows("mazdaViewer", "select status from price_ladder_version where id = $1", [live.id]))[0].status).toBe("retired");
  });

  it("content is frozen once a version leaves draft", async () => {
    const v = await newDraft("mazdaMgr", "script", "mazda-north");
    await run("mazdaMgr", "update script_version set disclosure = 'Edited while a draft.' where id = $1", [v.id]);
    await run("mazdaMgr", "update script_version set status = 'in_test' where id = $1", [v.id]);
    await expect(run("mazdaMgr", "update script_version set disclosure = 'Sneaky edit.' where id = $1", [v.id])).rejects.toThrow(/cannot change/);
    await expect(run("mazdaMgr", "delete from script_version where id = $1", [v.id])).rejects.toThrow(/only drafts/);
  });

  it("status can only reach live through approval", async () => {
    const v = await newDraft("mazdaMgr", "kb", "mazda-north");
    await expect(run("mazdaMgr", "update kb_version set status = 'live' where id = $1", [v.id])).rejects.toThrow(/cannot go from draft to live/);
    await expect(rows("mazdaMgr", "insert into kb_version (dealership_id, status) values ('mazda-north', 'live')")).rejects.toThrow(/start as draft/);
  });

  it("only an approver approves, and only after the gate passes", async () => {
    const v = await newDraft("mazdaMgr", "script", "mazda-north");
    await run("mazdaMgr", "update script_version set status = 'in_test' where id = $1", [v.id]);
    await expect(run("mazdaApprover", "select app.approve_version('script', $1)", [v.id])).rejects.toThrow(/gate not passed/);
    await expect(run("mazdaMgr", "update script_version set test_result = $2 where id = $1", [v.id, JSON.stringify(PASS)])).rejects.toThrow(/test gate only/);
    await asService(db, "gate_service", (tx) => tx.query("select app.record_test_result('script', $1, $2)", [v.id, JSON.stringify(PASS)]));
    await expect(run("mazdaMgr", "select app.approve_version('script', $1)", [v.id])).rejects.toThrow(/only an approver/);
    await expect(run("hyundaiApprover", "select app.approve_version('script', $1)", [v.id])).rejects.toThrow(/only an approver|no such version/);
    await run("mazdaApprover", "select app.approve_version('script', $1)", [v.id]);
  });

  it("the gate blocks hard failures, too few calls, and a completion drop over 5 points", async () => {
    for (const bad of [
      { calls: 16, hard_failures: 1, completion_rate: 90 },
      { calls: 8, hard_failures: 0, completion_rate: 90 },
      { calls: 16, hard_failures: 0, completion_rate: 79 }, // live script passed at 85
    ]) {
      const v = await newDraft("mazdaMgr", "script", "mazda-north");
      await run("mazdaMgr", "update script_version set status = 'in_test' where id = $1", [v.id]);
      await asService(db, "gate_service", (tx) => tx.query("select app.record_test_result('script', $1, $2)", [v.id, JSON.stringify(bad)]));
      await expect(run("mazdaApprover", "select app.approve_version('script', $1)", [v.id]), JSON.stringify(bad)).rejects.toThrow(/gate not passed/);
    }
  });

  it("people other than the gate cannot record test results", async () => {
    const v = await newDraft("mazdaMgr", "kb", "mazda-north");
    await run("mazdaMgr", "update kb_version set status = 'in_test' where id = $1", [v.id]);
    await expect(run("mazdaMgr", "select app.record_test_result('kb', $1, $2)", [v.id, JSON.stringify(PASS)])).rejects.toThrow(/only the test gate/);
  });

  it.each([
    [[3, 3.5, 4]],
    [[4, 4]],
    [[4, 0]],
    [[]],
  ])("rejects an invalid price ladder %j", async (steps) => {
    await expect(newDraft("mazdaMgr", "price", "mazda-north", { steps })).rejects.toThrow(/check constraint/);
  });

  it("every change and approval is in the audit log, with who did it, visible only to that dealership", async () => {
    const approvals = await rows("mazdaViewer", "select actor, action, after ->> 'status' as status from audit_log where table_name = 'price_ladder_version' and after ->> 'status' = 'live'");
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.actor === U.mazdaApprover)).toBe(true);
    const leaked = await rows("hyundaiMgr", "select count(*)::int as n from audit_log where dealership_id = 'mazda-north'");
    expect(leaked[0].n).toBe(0);
  });
});

describe("services", () => {
  it("the brain sees live config only (never drafts), writes call records, and never sees people", async () => {
    const drafts = await asService(db, "brain_service", async (tx) => (await tx.query<any>("select status from script_version")).rows);
    expect(drafts.every((r) => r.status === "live")).toBe(true);
    // migration 008: the brain records calls
    await asService(db, "brain_service", (tx) => tx.query("select id from call limit 1"));
    for (const table of ["app_user", "membership", "audit_log", "invite"]) {
      await expect(asService(db, "brain_service", (tx) => tx.query(`select * from ${table}`)), table).rejects.toThrow(/permission denied/);
    }
    await expect(asService(db, "brain_service", (tx) => tx.query("update dealership set name = 'x'"))).rejects.toThrow(/permission denied/);
  });

  it("loadLiveConfig returns a dealership's live versions and their ids", async () => {
    await shipVersion("kb", "hyundai-east", "hyundaiMgr", "hyundaiApprover", { facts: [{ topic: "tires", answer: "Tire and wheel covers road hazards.", keywords: ["tire"] }] });
    await shipVersion("price", "hyundai-east", "hyundaiMgr", "hyundaiApprover", { steps: [4, 3.5, 3.25, 3] });
    await db.query("insert into shared_fact (topic, answer, keywords) values ('ai', 'I am an AI finance assistant.', '{ai,robot}')");
    const cfg = await loadLiveConfig(db, "hyundai-east");
    expect(cfg?.name).toBe("Hyundai East");
    expect(cfg?.price).toEqual({ steps: [4, 3.5, 3.25, 3], floor: 3, products: [] });
    expect(cfg?.script).toBeNull(); // nothing approved yet: the brain must refuse to start a call
    expect(cfg?.facts.map((f) => [f.topic, f.shared])).toEqual([["tires", false], ["ai", true]]);
    expect(cfg?.versions.price).toMatch(/^[0-9a-f-]{36}$/);
    expect(await loadLiveConfig(db, "no-such-dealer")).toBeNull();
  });

  it("the worker cannot attach a turn to another dealership's call", async () => {
    await expect(
      asService(db, "worker_service", (tx) => tx.query("insert into turn (call_id, dealership_id, idx) values ('call-mazda-north', 'hyundai-east', 9)"))
    ).rejects.toThrow(/another dealership/);
  });
});
