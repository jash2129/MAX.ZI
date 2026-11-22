import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../../control-plane/src/db";
import { pgliteDb } from "../../control-plane/src/pglite";
import { seedDemo } from "../../control-plane/src/seed-demo";
import {
  PortalError,
  createApiKey,
  createDealership,
  creatableAgencies,
  intakeDeal,
  listApiKeys,
  listDealerships,
  listVersions,
  revokeApiKey,
} from "../src/server/portal";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");
let db: Awaited<ReturnType<typeof pgliteDb>>;
const U: Record<string, string> = {};

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  U.owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  U.mgr = (await db.query<{ id: string }>("insert into app_user (email) values ('mgr@mazda.test') returning id")).rows[0].id;
  await db.query("insert into membership (user_id, dealership_id, role) values ($1, 'demo-mazda', 'manager')", [U.mgr]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("onboarding in the portal", () => {
  it("the owner can create dealerships, a manager cannot", async () => {
    expect((await creatableAgencies(db, U.owner)).owner).toBe(true);
    expect(await creatableAgencies(db, U.mgr)).toEqual({ owner: false, agencies: [] });
    await createDealership(db, U.owner, { id: "kia-austin", name: "Kia of Austin", agency: null, template: "demo-mazda", vehicle: { year: "2026", make: "Kia", model: "Sportage" }, keyterms: ["Kia"] });
    expect((await listDealerships(db, U.owner)).find((d) => d.id === "kia-austin")).toMatchObject({ live: { script: null, price: null, kb: null }, pending: 3 });
    expect((await listVersions(db, U.owner, "kia-austin", "price"))[0]).toMatchObject({ status: "draft", notes: "Copied from demo-mazda v1" });
    await expect(createDealership(db, U.mgr, { id: "mine", name: "Mine", agency: null, template: "demo-mazda", vehicle: { year: "", make: "", model: "" }, keyterms: [] })).rejects.toThrow(/platform owner/);
  });

  it("a duplicate or malformed id is refused with a clear message", async () => {
    await expect(createDealership(db, U.owner, { id: "kia-austin", name: "Again", agency: null, template: "demo-mazda", vehicle: { year: "", make: "", model: "" }, keyterms: [] })).rejects.toThrow(/already exists/);
    await expect(createDealership(db, U.owner, { id: "Bad Id!", name: "X", agency: null, template: "demo-mazda", vehicle: { year: "", make: "", model: "" }, keyterms: [] })).rejects.toThrow(/lower-case/);
  });
});

describe("deal intake API", () => {
  let key = "";
  it("a manager's key takes deals for that dealership", async () => {
    key = await createApiKey(db, U.mgr, "demo-mazda", "DMS");
    const deal = await intakeDeal(db, key, { external_ref: "D-1", vehicle: { year: "2026", make: "Mazda", model: "CX-50" }, customer_first_name: "Sam" });
    expect(deal?.dealership_id).toBe("demo-mazda");
    expect((await listApiKeys(db, U.mgr, "demo-mazda"))[0]).toMatchObject({ label: "DMS", created_by: "mgr@mazda.test" });
    expect((await listApiKeys(db, U.mgr, "demo-mazda"))[0].last_used_at).not.toBeNull();
  });

  it("bad input and bad keys are refused", async () => {
    await expect(intakeDeal(db, key, { vehicle: { year: "26", make: "Mazda", model: "X" } })).rejects.toThrow(PortalError);
    expect(await intakeDeal(db, "mxk_" + "0".repeat(64), { vehicle: { year: "2026", make: "M", model: "X" } })).toBeNull();
    expect(await intakeDeal(db, "not-a-key", { vehicle: { year: "2026", make: "M", model: "X" } })).toBeNull();
    const [k] = await listApiKeys(db, U.mgr, "demo-mazda");
    await revokeApiKey(db, U.mgr, k.id);
    expect(await intakeDeal(db, key, { vehicle: { year: "2026", make: "Mazda", model: "CX-50" } })).toBeNull();
  });
});
