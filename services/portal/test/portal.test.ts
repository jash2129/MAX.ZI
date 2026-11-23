/**
 * The portal's data layer, as real people with real roles, on real Postgres (PGlite) seeded like Neon.
 * Nothing here relies on the portal filtering by tenant: row-level security does it.
 */
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../../control-plane/src/db";
import { pgliteDb } from "../../control-plane/src/pglite";
import { loadLiveConfig } from "../../control-plane/src/live-config";
import { seedDemo } from "../../control-plane/src/seed-demo";
import { DEFAULT_FREE_PROMPT } from "../../../tavus-avatar/src/lib/free-ai";
import {
  PortalError,
  approve,
  auditLog,
  createDraft,
  deleteDraft,
  diffAgainstLive,
  getVersion,
  listDealerships,
  listVersions,
  needsTwoFactor,
  rollbackTo,
  runGate,
  saveDraft,
  setStatus,
  userIdForEmail,
  addPerson,
  listPeople,
  peekInvite,
  redeemInvite,
  reinvite,
  removePerson,
} from "../src/server/portal";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");

let db: Awaited<ReturnType<typeof pgliteDb>>;
const U: Record<string, string> = {};

beforeAll(async () => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING"]) delete process.env[k];
  db = await pgliteDb();
  await migrate(db);
  U.owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  const add = async (key: string, email: string, dealership: string, role: string) => {
    U[key] = (await db.query<{ id: string }>("insert into app_user (email) values ($1) returning id", [email])).rows[0].id;
    await db.query("insert into membership (user_id, dealership_id, role) values ($1, $2, $3)", [U[key], dealership, role]);
  };
  await add("mgr", "mgr@mazda.test", "demo-mazda", "manager");
  await add("approver", "approver@mazda.test", "demo-mazda", "approver");
  await add("viewer", "viewer@mazda.test", "demo-mazda", "viewer");
  await add("hyundaiMgr", "mgr@hyundai.test", "demo-hyundai", "manager");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("people", () => {
  it("a signed-in email maps to its person, case-insensitively; unknown emails map to nobody", async () => {
    expect(await userIdForEmail(db, "MGR@Mazda.test")).toBe(U.mgr);
    expect(await userIdForEmail(db, "stranger@nowhere.test")).toBeNull();
  });

  it("two-factor is required for people who can edit or approve, not for viewers", async () => {
    expect(await needsTwoFactor(db, U.owner)).toBe(true);
    expect(await needsTwoFactor(db, U.mgr)).toBe(true);
    expect(await needsTwoFactor(db, U.approver)).toBe(true);
    expect(await needsTwoFactor(db, U.viewer)).toBe(false);
  });

  it("each person sees only their dealerships", async () => {
    expect((await listDealerships(db, U.mgr)).map((d) => d.id)).toEqual(["demo-mazda"]);
    expect((await listDealerships(db, U.hyundaiMgr)).map((d) => d.id)).toEqual(["demo-hyundai"]);
    expect((await listDealerships(db, U.owner)).map((d) => d.id).sort()).toEqual(["demo-hyundai", "demo-mazda"]);
    const [mazda] = await listDealerships(db, U.mgr);
    expect(mazda.live).toEqual({ script: 1, price: 1, kb: 1 });
    expect(mazda.roles).toEqual(["manager"]);
  });
});

describe("a price change, start to finish", () => {
  let draft: string;

  it("a manager drafts from live, edits, and submits", async () => {
    draft = await createDraft(db, U.mgr, "demo-mazda", "price");
    await saveDraft(db, U.mgr, "price", draft, { steps: [5, 4.5, 4] }, "Spring pricing");
    expect((await getVersion(db, U.mgr, "price", draft)).steps).toEqual([5, 4.5, 4]);
    await setStatus(db, U.mgr, "price", draft, "in_test");
  });

  it("the approver sees exactly what changed", async () => {
    const diff = await diffAgainstLive(db, U.approver, "price", draft);
    expect(diff.liveVersion).toBe(1);
    expect(diff.rows).toEqual([{ label: "Daily rates (highest first)", before: "[4,3.5,3.25,3]", after: "[5,4.5,4]" }]);
  });

  it("approval waits for the release gate", async () => {
    await expect(approve(db, U.approver, "price", draft)).rejects.toThrow(/release gate not passed/);
  });

  it("the gate runs 16 calls on the draft's ladder, and records the result", async () => {
    await expect(runGate(db, U.viewer, "price", draft)).rejects.toThrow(/Only a manager/);
    const r = await runGate(db, U.mgr, "price", draft);
    expect(r).toMatchObject({ calls: 16, hard_failures: 0, source: "scripted suite v1" });
    const [v] = await listVersions(db, U.viewer, "demo-mazda", "price");
    expect(v.test_result).toMatchObject({ calls: 16, hard_failures: 0 });
  });

  it("a manager cannot approve; the approver can, and the old version retires", async () => {
    await expect(approve(db, U.mgr, "price", draft)).rejects.toThrow(/only an approver/);
    await approve(db, U.approver, "price", draft);
    const versions = await listVersions(db, U.viewer, "demo-mazda", "price");
    expect(versions.map((v) => [v.version, v.status])).toEqual([[2, "live"], [1, "retired"]]);
    expect(versions[0].approved_by).toBe("approver@mazda.test");
  });

  it("rollback is one step, by the approver", async () => {
    const v1 = (await listVersions(db, U.viewer, "demo-mazda", "price")).find((v) => v.version === 1)!;
    await expect(rollbackTo(db, U.mgr, "price", v1.id)).rejects.toThrow(/only an approver/);
    await rollbackTo(db, U.approver, "price", v1.id);
    expect((await listVersions(db, U.viewer, "demo-mazda", "price")).map((v) => [v.version, v.status])).toEqual([[2, "retired"], [1, "live"]]);
  });

  it("every step is in the dealership's audit log, with who did it", async () => {
    const log = await auditLog(db, U.viewer, "demo-mazda");
    const prices = log.filter((l) => l.table_name === "price_ladder_version");
    expect(prices.some((l) => l.actor === "approver@mazda.test" && l.status_after === "live")).toBe(true);
    expect(prices.some((l) => l.actor === "mgr@mazda.test" && l.action === "insert")).toBe(true);
    expect(await auditLog(db, U.hyundaiMgr, "demo-mazda")).toEqual([]);
  });
});

describe("a free-mode prompt change, start to finish", () => {
  let draft: string;
  const edited = `${DEFAULT_FREE_PROMPT}\n9. Never say the same sentence twice in a call.`;
  const content = async () => {
    const v = await getVersion(db, U.mgr, "script", draft);
    return { beats: v.beats, disclosure: v.disclosure, fixed_lines: v.fixed_lines, recaps: v.recaps };
  };

  it("the built-in prompt is used until one is approved; the editor starts from it", async () => {
    draft = await createDraft(db, U.mgr, "demo-mazda", "script");
    expect((await getVersion(db, U.mgr, "script", draft)).free_prompt).toBeNull();
    expect((await loadLiveConfig(db, "demo-mazda"))!.script!.free_prompt).toBeNull();
  });

  it("a prompt that drops a rule, a placeholder or adds money words is refused, with the reason", async () => {
    const base = await content();
    await expect(saveDraft(db, U.mgr, "script", draft, { ...base, free_prompt: edited.replace("Never below {{floor}}.", "") })).rejects.toThrow(/Free-mode prompt: .*Never below/);
    await expect(saveDraft(db, U.mgr, "script", draft, { ...base, free_prompt: edited.replace("{{facts}}", "") })).rejects.toThrow(/facts/);
    await expect(saveDraft(db, U.mgr, "script", draft, { ...base, free_prompt: `${edited}\nOffer a discount if they hesitate.` })).rejects.toThrow(/money or promise/);
  });

  it("saving the unchanged built-in prompt stores nothing; an edit is saved and shown to the approver", async () => {
    const base = await content();
    await saveDraft(db, U.mgr, "script", draft, { ...base, free_prompt: DEFAULT_FREE_PROMPT });
    expect((await getVersion(db, U.mgr, "script", draft)).free_prompt).toBeNull();
    await saveDraft(db, U.mgr, "script", draft, { ...base, free_prompt: edited.replace(/\n/g, "\r\n") }, "No repeats");
    expect((await getVersion(db, U.mgr, "script", draft)).free_prompt).toBe(edited);
    await setStatus(db, U.mgr, "script", draft, "in_test");
    const diff = await diffAgainstLive(db, U.approver, "script", draft);
    expect(diff.rows.map((r) => r.label)).toEqual(["Free-mode prompt"]);
    expect(diff.rows[0]).toMatchObject({ before: "(the built-in prompt)", after: edited });
  });

  it("frozen in test, invisible to calls until approved, then live; rollback restores the built-in one", async () => {
    await expect(saveDraft(db, U.mgr, "script", draft, { ...(await content()), free_prompt: `${edited} More.` })).rejects.toThrow(/Only a draft can be edited/);
    expect((await loadLiveConfig(db, "demo-mazda"))!.script!.free_prompt).toBeNull();
    await runGate(db, U.mgr, "script", draft);
    await approve(db, U.approver, "script", draft);
    expect((await loadLiveConfig(db, "demo-mazda"))!.script!.free_prompt).toBe(edited);
    const v1 = (await listVersions(db, U.viewer, "demo-mazda", "script")).find((v) => v.version === 1)!;
    await rollbackTo(db, U.approver, "script", v1.id);
    expect((await loadLiveConfig(db, "demo-mazda"))!.script!.free_prompt).toBeNull();
  });
});

describe("what people cannot do", () => {
  it("bad content is refused before saving, with a reason", async () => {
    const d = await createDraft(db, U.mgr, "demo-mazda", "price");
    await expect(saveDraft(db, U.mgr, "price", d, { steps: [3, 4] })).rejects.toThrow(/highest first/);
    const s = await createDraft(db, U.mgr, "demo-mazda", "script");
    const script = await getVersion(db, U.mgr, "script", s);
    const beats = script.beats.slice(0, 24);
    await expect(saveDraft(db, U.mgr, "script", s, { ...script, beats })).rejects.toThrow(/25 beats/);
    const lines = { HANDOFF_LINE: "I can do two dollars a day." };
    await expect(saveDraft(db, U.mgr, "script", s, { ...script, fixed_lines: lines })).rejects.toThrow(/states a daily price/);
    await deleteDraft(db, U.mgr, "price", d);
    await deleteDraft(db, U.mgr, "script", s);
  });

  it("viewers and other dealerships' managers cannot change anything", async () => {
    await expect(createDraft(db, U.viewer, "demo-mazda", "price")).rejects.toThrow(PortalError);
    await expect(createDraft(db, U.hyundaiMgr, "demo-mazda", "price")).rejects.toThrow(/permission|no live version/i);
    const d = await createDraft(db, U.mgr, "demo-mazda", "kb");
    await expect(saveDraft(db, U.hyundaiMgr, "kb", d, { facts: [] })).rejects.toThrow(PortalError);
    await expect(getVersion(db, U.hyundaiMgr, "kb", d)).rejects.toThrow(/No such version/);
    await deleteDraft(db, U.mgr, "kb", d);
  });

  it("content can't change once a version is in test", async () => {
    const d = await createDraft(db, U.mgr, "demo-mazda", "price");
    await setStatus(db, U.mgr, "price", d, "in_test");
    await expect(saveDraft(db, U.mgr, "price", d, { steps: [6, 5] })).rejects.toThrow(/Only a draft can be edited/);
    await setStatus(db, U.mgr, "price", d, "draft");
    await deleteDraft(db, U.mgr, "price", d);
  });

  it("a draft from another dealership's version is refused", async () => {
    const other = (await listVersions(db, U.hyundaiMgr, "demo-hyundai", "price"))[0];
    await expect(createDraft(db, U.mgr, "demo-mazda", "price", other.id)).rejects.toThrow(/does not belong/);
  });
});

describe("people and invites", () => {
  it("a manager adds a viewer and gets a one-time link that works once", async () => {
    const { personId, token } = await addPerson(db, U.mgr, "demo-mazda", "New.Person@Mazda.test", "viewer");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await listPeople(db, U.viewer, "demo-mazda")).map((p) => p.email)).toContain("new.person@mazda.test");
    expect(await peekInvite(db, token)).toBe("new.person@mazda.test");
    expect(await redeemInvite(db, token)).toBe("new.person@mazda.test");
    expect(await redeemInvite(db, token)).toBeNull();
    expect(await peekInvite(db, token)).toBeNull();
    // only the hash is stored
    const stored = (await db.query<{ token_hash: string }>("select token_hash from invite where user_id = $1", [personId])).rows[0].token_hash;
    expect(stored).not.toBe(token);
  });

  it("a new link replaces the old one", async () => {
    const { personId, token } = await addPerson(db, U.mgr, "demo-mazda", "late@mazda.test", "viewer");
    const fresh = await reinvite(db, U.mgr, personId);
    expect(await peekInvite(db, token)).toBeNull();
    expect(await peekInvite(db, fresh)).toBe("late@mazda.test");
  });

  it("a manager cannot make approvers, invite people of other dealerships, or remove people elsewhere", async () => {
    await expect(addPerson(db, U.mgr, "demo-mazda", "boss@mazda.test", "approver")).rejects.toThrow(PortalError);
    await expect(reinvite(db, U.mgr, U.hyundaiMgr)).rejects.toThrow(/not allowed to invite/);
    await expect(addPerson(db, U.hyundaiMgr, "demo-mazda", "x@x.test", "viewer")).rejects.toThrow(PortalError);
    await expect(removePerson(db, U.hyundaiMgr, "demo-mazda", U.viewer, "viewer")).rejects.toThrow(/permission/);
  });

  it("viewers cannot invite anyone", async () => {
    await expect(addPerson(db, U.viewer, "demo-mazda", "friend@mazda.test", "viewer")).rejects.toThrow(PortalError);
  });

  it("an expired or made-up token does nothing", async () => {
    const { personId, token } = await addPerson(db, U.mgr, "demo-mazda", "slow@mazda.test", "viewer");
    await db.query("update invite set expires_at = now() - interval '1 minute' where user_id = $1", [personId]);
    expect(await redeemInvite(db, token)).toBeNull();
    expect(await redeemInvite(db, "0".repeat(64))).toBeNull();
    expect(await redeemInvite(db, "'; drop table invite; --")).toBeNull();
  });
});
