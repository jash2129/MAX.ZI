/**
 * Everything the portal reads or changes. Each function runs as the signed-in person (asUser), so
 * Postgres row-level security decides what they may see and do; this file never filters by tenant
 * itself. The version lifecycle (draft -> in_test -> live -> retired, approval, rollback, frozen
 * content) is enforced by the database; content checks here only give friendlier errors earlier.
 */
import { isDeepStrictEqual } from "node:util";

import { RECAP_BEATS } from "../../../../tavus-avatar/src/lib/beat-controller";
import { validateKnowledge, validateScript, type CallScript, type KnowledgeBase } from "../../../../tavus-avatar/src/lib/call-content";
import { DEFAULT_DEAL_CONFIG, type DealConfig } from "../../../../tavus-avatar/src/lib/deal-config";
import { isValidLadder } from "../../../../tavus-avatar/src/lib/price-ladder";
import { runReleaseGate } from "../../../../tavus-avatar/src/lib/release-gate";
import { asService, asUser, type Db, type Queryable } from "../../../control-plane/src/db";

export type Kind = "script" | "price" | "kb";
export const KINDS: Kind[] = ["script", "price", "kb"];
const TABLE: Record<Kind, string> = { script: "script_version", price: "price_ladder_version", kb: "kb_version" };
const CONTENT_COLUMNS: Record<Kind, string> = {
  script: "beats, disclosure, fixed_lines, recaps",
  price: "steps, products",
  kb: "facts",
};

export class PortalError extends Error {}

/** Postgres' own refusals (row-level security, the lifecycle trigger, check constraints) as plain words */
function explain(err: unknown): never {
  const msg = String((err as Error)?.message ?? err);
  if (/row-level security|permission denied/.test(msg)) throw new PortalError("You don't have permission to do that for this dealership.");
  if (/valid_ladder|check constraint/.test(msg)) throw new PortalError("That price ladder is not valid: highest first, each step lower, over $0 and at most $100.");
  throw new PortalError(msg.replace(/^error:\s*/i, ""));
}

async function run<T>(db: Db, userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  try {
    return await asUser(db, userId, fn);
  } catch (err) {
    if (err instanceof PortalError) throw err;
    explain(err);
  }
}

// ---------------------------------------------------------------------------------------------------
// People and dealerships
// ---------------------------------------------------------------------------------------------------

export interface Me {
  id: string;
  email: string;
  display_name: string;
  is_platform_owner: boolean;
}

/** The app_user for a signed-in email, or null (people are added by an admin before they can sign in). */
export async function userIdForEmail(db: Db, email: string): Promise<string | null> {
  const r = await db.query<{ id: string }>("select app.user_id_for_email($1) as id", [email.toLowerCase()]);
  return r.rows[0]?.id ?? null;
}

export async function me(db: Db, userId: string): Promise<Me> {
  return run(db, userId, async (tx) => (await tx.query<Me>("select id, email, display_name, is_platform_owner from app_user where id = $1", [userId])).rows[0]);
}

/** Can edit or approve somewhere: the PRD's "admins", who must use two-factor sign-in */
export async function needsTwoFactor(db: Db, userId: string): Promise<boolean> {
  return run(db, userId, async (tx) => {
    const r = await tx.query<{ admin: boolean }>(
      `select app.is_platform_owner()
          or exists (select 1 from membership m where m.user_id = $1 and m.role in ('agency_admin', 'manager', 'approver')) as admin`,
      [userId]
    );
    return Boolean(r.rows[0]?.admin);
  });
}

export interface DealershipRow {
  id: string;
  name: string;
  agency_id: string | null;
  roles: string[];
  live: Record<Kind, number | null>;
  pending: number;
}

export async function listDealerships(db: Db, userId: string): Promise<DealershipRow[]> {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>(
      `select d.id, d.name, d.agency_id, app.dealership_roles(d.id) as roles,
              (select version from script_version where dealership_id = d.id and status = 'live') as script_live,
              (select version from price_ladder_version where dealership_id = d.id and status = 'live') as price_live,
              (select version from kb_version where dealership_id = d.id and status = 'live') as kb_live,
              (select count(*)::int from (
                 select 1 from script_version where dealership_id = d.id and status in ('draft', 'in_test')
                 union all select 1 from price_ladder_version where dealership_id = d.id and status in ('draft', 'in_test')
                 union all select 1 from kb_version where dealership_id = d.id and status in ('draft', 'in_test'))
               s) as pending
         from dealership d order by d.name`
    );
    return r.rows.map((x) => ({
      id: x.id,
      name: x.name,
      agency_id: x.agency_id,
      roles: x.roles,
      live: { script: x.script_live, price: x.price_live, kb: x.kb_live },
      pending: x.pending,
    }));
  });
}

export interface Permissions {
  read: boolean;
  edit: boolean;
  approve: boolean;
}

export async function permissions(db: Db, userId: string, dealershipId: string): Promise<Permissions> {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>("select app.can_read($1) as read, app.can_edit($1) as edit, app.can_approve($1) as approve", [dealershipId]);
    return r.rows[0];
  });
}

export async function getDealership(db: Db, userId: string, id: string) {
  return run(db, userId, async (tx) => {
    const d = (await tx.query<any>("select id, name, agency_id, max_display_name, mode, default_vehicle, speech_keyterms from dealership where id = $1", [id])).rows[0];
    if (!d) throw new PortalError("No such dealership, or you don't have access to it.");
    return d as { id: string; name: string; agency_id: string | null; max_display_name: string; mode: string; default_vehicle: Record<string, string>; speech_keyterms: string[] };
  });
}

// ---------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------

export interface VersionSummary {
  id: string;
  version: number;
  status: "draft" | "in_test" | "approved" | "live" | "retired";
  notes: string;
  created_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  test_result: { calls: number; hard_failures: number; completion_rate: number; source?: string; mode?: string } | null;
}

export async function listVersions(db: Db, userId: string, dealershipId: string, kind: Kind): Promise<VersionSummary[]> {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>(
      `select v.id, v.version, v.status, v.notes, v.created_at, v.approved_at, v.test_result,
              cu.email as created_by, au.email as approved_by
         from ${TABLE[kind]} v
         left join app_user cu on cu.id = v.created_by
         left join app_user au on au.id = v.approved_by
        where v.dealership_id = $1 order by v.version desc`,
      [dealershipId]
    );
    return r.rows;
  });
}

export async function getVersion(db: Db, userId: string, kind: Kind, versionId: string) {
  return run(db, userId, async (tx) => {
    const v = (await tx.query<any>(`select id, dealership_id, version, status, notes, test_result, ${CONTENT_COLUMNS[kind]} from ${TABLE[kind]} where id = $1`, [versionId])).rows[0];
    if (!v) throw new PortalError("No such version, or you don't have access to it.");
    if (kind === "price") v.steps = (v.steps as Array<string | number>).map(Number);
    return v as Record<string, any> & { id: string; dealership_id: string; version: number; status: VersionSummary["status"] };
  });
}

async function liveId(tx: Queryable, kind: Kind, dealershipId: string): Promise<string | null> {
  return (await tx.query<{ id: string }>(`select id from ${TABLE[kind]} where dealership_id = $1 and status = 'live'`, [dealershipId])).rows[0]?.id ?? null;
}

/** A new draft, starting from the live version (or `fromVersionId`) */
export async function createDraft(db: Db, userId: string, dealershipId: string, kind: Kind, fromVersionId?: string): Promise<string> {
  return run(db, userId, async (tx) => {
    const source = fromVersionId ?? (await liveId(tx, kind, dealershipId));
    if (!source) throw new PortalError("There is no live version to start from.");
    const cols = CONTENT_COLUMNS[kind];
    const r = await tx.query<{ id: string }>(
      `insert into ${TABLE[kind]} (dealership_id, ${cols}, notes)
       select dealership_id, ${cols}, 'Draft from v' || version from ${TABLE[kind]} where id = $1 and dealership_id = $2
       returning id`,
      [source, dealershipId]
    );
    if (!r.rows[0]) throw new PortalError("That version does not belong to this dealership.");
    return r.rows[0].id;
  });
}

/** Problems with draft content, before saving (the database checks the ladder again; the brain checks all) */
export function contentProblem(kind: Kind, content: Record<string, unknown>): string | null {
  if (kind === "price") return isValidLadder(content.steps) ? null : "The price ladder must be 1-8 daily rates, highest first, each lower than the one before, over $0 and at most $100, in cents.";
  if (kind === "kb") return validateKnowledge({ facts: content.facts });
  return validateScript(
    { beats: content.beats, disclosure: content.disclosure, fixed_lines: content.fixed_lines ?? {}, recaps: content.recaps ?? {} } as CallScript,
    RECAP_BEATS
  );
}

export async function saveDraft(db: Db, userId: string, kind: Kind, versionId: string, content: Record<string, unknown>, notes?: string): Promise<void> {
  const problem = contentProblem(kind, content);
  if (problem) throw new PortalError(problem);
  await run(db, userId, async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [versionId];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (kind === "price") {
      add("steps", content.steps);
      if (content.products !== undefined) add("products", JSON.stringify(content.products));
    } else if (kind === "kb") add("facts", JSON.stringify(content.facts));
    else {
      add("beats", JSON.stringify(content.beats));
      add("disclosure", content.disclosure);
      add("fixed_lines", JSON.stringify(content.fixed_lines ?? {}));
      add("recaps", JSON.stringify(content.recaps ?? {}));
    }
    if (notes !== undefined) add("notes", notes);
    const r = await tx.query(`update ${TABLE[kind]} set ${sets.join(", ")} where id = $1 and status = 'draft' returning id`, params);
    if (!r.rows.length) throw new PortalError("Only a draft can be edited, by a manager of this dealership.");
  });
}

export async function setStatus(db: Db, userId: string, kind: Kind, versionId: string, to: "in_test" | "draft"): Promise<void> {
  await run(db, userId, async (tx) => {
    const r = await tx.query(`update ${TABLE[kind]} set status = $2 where id = $1 returning id`, [versionId, to]);
    if (!r.rows.length) throw new PortalError("You don't have permission to do that for this dealership.");
  });
}

export async function deleteDraft(db: Db, userId: string, kind: Kind, versionId: string): Promise<void> {
  await run(db, userId, async (tx) => {
    const r = await tx.query(`delete from ${TABLE[kind]} where id = $1 returning id`, [versionId]);
    if (!r.rows.length) throw new PortalError("You don't have permission to delete that draft.");
  });
}

export async function approve(db: Db, userId: string, kind: Kind, versionId: string): Promise<void> {
  await run(db, userId, (tx) => tx.query("select app.approve_version($1, $2)", [kind, versionId]));
}

export async function rollbackTo(db: Db, userId: string, kind: Kind, versionId: string): Promise<void> {
  await run(db, userId, (tx) => tx.query("select app.rollback_to($1, $2)", [kind, versionId]));
}

// ---------------------------------------------------------------------------------------------------
// Release gate: the scripted suite, on the version in test, with the dealership's other live versions
// ---------------------------------------------------------------------------------------------------

/** A call config made of `override` for one kind and the live versions for the others */
async function callConfigFor(tx: Queryable, dealershipId: string, kind: Kind, override: Record<string, any>): Promise<DealConfig> {
  const d = (await tx.query<any>("select name, default_vehicle from dealership where id = $1", [dealershipId])).rows[0];
  const pick = async (k: Kind) => (k === kind ? override : (await tx.query<any>(`select ${CONTENT_COLUMNS[k]} from ${TABLE[k]} where dealership_id = $1 and status = 'live'`, [dealershipId])).rows[0]);
  const [script, price, kb] = [await pick("script"), await pick("price"), await pick("kb")];
  if (!script || !price || !kb) throw new PortalError("The dealership needs a live script, price ladder and knowledge base before a test can run.");
  const v = d.default_vehicle ?? {};
  return {
    ...DEFAULT_DEAL_CONFIG,
    dealership_name: d.name,
    vehicle_year: v.year || DEFAULT_DEAL_CONFIG.vehicle_year,
    vehicle_make: v.make || DEFAULT_DEAL_CONFIG.vehicle_make,
    vehicle_model: v.model || DEFAULT_DEAL_CONFIG.vehicle_model,
    per_day_price: "",
    price_ladder: (price.steps as Array<string | number>).map(Number),
    script: { beats: script.beats, disclosure: script.disclosure, fixed_lines: script.fixed_lines ?? {}, recaps: script.recaps ?? {} },
    knowledge: { facts: kb.facts } as KnowledgeBase,
  };
}

/** Runs the gate on a version in test and records the result (as the test gate). Editors may run it. */
export async function runGate(db: Db, userId: string, kind: Kind, versionId: string) {
  const config = await run(db, userId, async (tx) => {
    const v = (await tx.query<any>(`select dealership_id, status, ${CONTENT_COLUMNS[kind]} from ${TABLE[kind]} where id = $1`, [versionId])).rows[0];
    if (!v) throw new PortalError("No such version, or you don't have access to it.");
    if (v.status !== "in_test") throw new PortalError("Submit the draft for testing first.");
    if (!(await tx.query<{ ok: boolean }>("select app.can_edit($1) as ok", [v.dealership_id])).rows[0].ok) throw new PortalError("Only a manager can run the test.");
    return callConfigFor(tx, v.dealership_id, kind, v);
  });
  const result = await runReleaseGate(config);
  try {
    await asService(db, "gate_service", (tx) => tx.query("select app.record_test_result($1, $2, $3)", [kind, versionId, JSON.stringify(result)]));
  } catch (err) {
    explain(err);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Side-by-side diff for approval
// ---------------------------------------------------------------------------------------------------

export interface DiffRow {
  label: string;
  before: string;
  after: string;
}

/** What changed between the live version and this one (only the parts that differ) */
export async function diffAgainstLive(db: Db, userId: string, kind: Kind, versionId: string): Promise<{ liveVersion: number | null; rows: DiffRow[] }> {
  const v = await getVersion(db, userId, kind, versionId);
  // One transaction at a time: never open another (getVersion) while this one is still running
  const id = await run(db, userId, (tx) => liveId(tx, kind, v.dealership_id));
  const live = id && id !== versionId ? await getVersion(db, userId, kind, id) : null;
  const rows: DiffRow[] = [];
  const cmp = (label: string, a: unknown, b: unknown) => {
    if (!isDeepStrictEqual(a, b)) rows.push({ label, before: show(a), after: show(b) });
  };
  if (kind === "price") {
    cmp("Daily rates (highest first)", live?.steps, v.steps);
    cmp("Products", live?.products, v.products);
  } else if (kind === "kb") {
    const byId = (facts: any[] | undefined) => new Map((facts ?? []).map((f) => [String(f.id), f]));
    const a = byId(live?.facts);
    const b = byId(v.facts);
    for (const id of new Set([...a.keys(), ...b.keys()])) cmp(`Fact "${id}"`, a.get(id)?.answer, b.get(id)?.answer);
  } else {
    cmp("Recording disclosure", live?.disclosure, v.disclosure);
    const beats = (x: any) => new Map(((x?.beats ?? []) as any[]).map((bt) => [bt.id, bt.text]));
    const a = beats(live);
    const b = beats(v);
    for (const id of new Set([...a.keys(), ...b.keys()])) cmp(`Beat ${id}`, a.get(id), b.get(id));
    const lines = new Set([...Object.keys(live?.fixed_lines ?? {}), ...Object.keys(v.fixed_lines ?? {})]);
    for (const k of lines) cmp(`Line ${k}`, live?.fixed_lines?.[k], v.fixed_lines?.[k]);
    const recaps = new Set([...Object.keys(live?.recaps ?? {}), ...Object.keys(v.recaps ?? {})]);
    for (const k of recaps) cmp(`Recap, beat ${k}`, live?.recaps?.[k], v.recaps?.[k]);
  }
  return { liveVersion: live?.version ?? null, rows };
}

const show = (x: unknown) => (x === undefined || x === null ? "(none)" : typeof x === "string" ? x : JSON.stringify(x));

// ---------------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------------

export async function auditLog(db: Db, userId: string, dealershipId: string, limit = 50) {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>(
      `select a.at, u.email as actor, a.table_name, a.action, a.before ->> 'status' as status_before, a.after ->> 'status' as status_after,
              coalesce(a.after ->> 'version', a.before ->> 'version') as version
         from audit_log a left join app_user u on u.id = a.actor
        where a.dealership_id = $1 order by a.at desc limit $2`,
      [dealershipId, limit]
    );
    return r.rows as Array<{ at: string; actor: string | null; table_name: string; action: string; status_before: string | null; status_after: string | null; version: string | null }>;
  });
}

// ---------------------------------------------------------------------------------------------------
// People and invites (sign-up is invite-only; see control-plane migration 007)
// ---------------------------------------------------------------------------------------------------

export const ROLES = ["manager", "approver", "viewer"] as const;
export type DealershipRole = (typeof ROLES)[number];

export async function listPeople(db: Db, userId: string, dealershipId: string) {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>(
      `select u.id, u.email, u.display_name, m.role, m.created_at
         from membership m join app_user u on u.id = m.user_id
        where m.dealership_id = $1 order by u.email, m.role`,
      [dealershipId]
    );
    return r.rows as Array<{ id: string; email: string; display_name: string; role: DealershipRole; created_at: string }>;
  });
}

/**
 * Adds a person to a dealership in a role and returns a one-time invite token for their sign-up link.
 * The database decides who may grant which role (managers: manager and viewer; agency admins and the
 * platform owner: any).
 */
export async function addPerson(db: Db, userId: string, dealershipId: string, email: string, role: DealershipRole): Promise<{ personId: string; token: string }> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new PortalError("That is not an email address.");
  if (!ROLES.includes(role)) throw new PortalError("Unknown role.");
  return run(db, userId, async (tx) => {
    const personId = (await tx.query<{ id: string }>("select app.add_person($1, $2, $3) as id", [e, dealershipId, role])).rows[0].id;
    const token = (await tx.query<{ t: string }>("select app.create_invite($1) as t", [personId])).rows[0].t;
    return { personId, token };
  });
}

/** A fresh invite link for someone already added (the old link stops working) */
export async function reinvite(db: Db, userId: string, personId: string): Promise<string> {
  return run(db, userId, async (tx) => (await tx.query<{ t: string }>("select app.create_invite($1) as t", [personId])).rows[0].t);
}

export async function removePerson(db: Db, userId: string, dealershipId: string, personId: string, role: DealershipRole): Promise<void> {
  await run(db, userId, async (tx) => {
    const r = await tx.query("delete from membership where user_id = $1 and dealership_id = $2 and role = $3 returning user_id", [personId, dealershipId, role]);
    if (!r.rows.length) throw new PortalError("You don't have permission to remove that person.");
  });
}

/** The email an invite is for, without using it, or null (expired, used, wrong) */
export async function peekInvite(db: Db, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return (await db.query<{ e: string | null }>("select app.peek_invite($1) as e", [token])).rows[0]?.e ?? null;
}

/** Uses an invite: its email if it was valid (it can't be used again), else null */
export async function redeemInvite(db: Db, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return (await db.query<{ e: string | null }>("select app.redeem_invite($1) as e", [token])).rows[0]?.e ?? null;
}
