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
import { DEFAULT_FREE_PROMPT } from "../../../../tavus-avatar/src/lib/free-ai";
import { isValidLadder } from "../../../../tavus-avatar/src/lib/price-ladder";
import { runReleaseGate } from "../../../../tavus-avatar/src/lib/release-gate";
import { freePromptProblems } from "../../../../tavus-avatar/src/lib/self-learn";
import { DEFAULT_NATIVE_PROMPT, agentProblems, nativePromptProblems, normalizeAgent, type AgentConfig } from "../../../../tavus-avatar/src/lib/native-engine";
import { asService, asUser, type Db, type Queryable } from "../../../control-plane/src/db";

export type Kind = "script" | "price" | "kb";
export const KINDS: Kind[] = ["script", "price", "kb"];
const TABLE: Record<Kind, string> = { script: "script_version", price: "price_ladder_version", kb: "kb_version" };
const CONTENT_COLUMNS: Record<Kind, string> = {
  script: "beats, disclosure, fixed_lines, recaps, free_prompt, native_prompt, agent",
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
  const prompt = freePromptOf(content);
  if (prompt) {
    const problems = freePromptProblems(prompt);
    if (problems.length) return `Free-mode prompt: ${problems.join("; ")}.`;
  }
  const native = nativePromptOf(content);
  if (native) {
    const problems = nativePromptProblems(native);
    if (problems.length) return `Max's prompt: ${problems.join("; ")}.`;
  }
  if (content.agent !== undefined) {
    const problems = agentProblems(content.agent);
    if (problems.length) return `Agent: ${problems.join("; ")}.`;
  }
  return validateScript(
    { beats: content.beats, disclosure: content.disclosure, fixed_lines: content.fixed_lines ?? {}, recaps: content.recaps ?? {} } as CallScript,
    RECAP_BEATS
  );
}

/** Free mode's built-in prompt: what a script version without its own prompt runs on */
export const BUILT_IN_FREE_PROMPT = DEFAULT_FREE_PROMPT;

/** The free-mode prompt in draft content: null when empty or the built-in one (the built-in prompt is used) */
export function freePromptOf(content: Record<string, unknown>): string | null {
  const p = typeof content.free_prompt === "string" ? content.free_prompt.replace(/\r\n/g, "\n").trim() : "";
  return p && p !== DEFAULT_FREE_PROMPT.trim() ? p : null;
}

/** The native engine's built-in prompt: what a script version without its own prompt runs on */
export const BUILT_IN_NATIVE_PROMPT = DEFAULT_NATIVE_PROMPT;

/** Max's prompt (native engine) in draft content: null when empty or the built-in one */
export function nativePromptOf(content: Record<string, unknown>): string | null {
  const p = typeof content.native_prompt === "string" ? content.native_prompt.replace(/\r\n/g, "\n").trim() : "";
  return p && p !== DEFAULT_NATIVE_PROMPT.trim() ? p : null;
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
      if (content.free_prompt !== undefined) add("free_prompt", freePromptOf(content));
      if (content.native_prompt !== undefined) add("native_prompt", nativePromptOf(content));
      if (content.agent !== undefined) add("agent", JSON.stringify(normalizeAgent(content.agent)));
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
    ...(script.free_prompt ? { free_prompt: script.free_prompt } : {}),
    ...(script.native_prompt ? { native_prompt: script.native_prompt } : {}),
    ...(script.agent && Object.keys(script.agent).length ? { agent: normalizeAgent(script.agent) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// The Agent page: Max's prompt and the agent settings of a script draft, and test calls on any version
// ---------------------------------------------------------------------------------------------------

/** Saves only Max's prompt and the agent settings of a draft (the beats and lines stay as they are) */
export async function saveAgentDraft(db: Db, userId: string, versionId: string, input: { native_prompt: string; agent: AgentConfig }, notes?: string): Promise<void> {
  const prompt = nativePromptOf({ native_prompt: input.native_prompt });
  if (prompt) {
    const problems = nativePromptProblems(prompt);
    if (problems.length) throw new PortalError(`Max's prompt: ${problems.join("; ")}.`);
  }
  const agent = normalizeAgent(input.agent);
  const problems = agentProblems(agent);
  if (problems.length) throw new PortalError(`Agent: ${problems.join("; ")}.`);
  await run(db, userId, async (tx) => {
    const params: unknown[] = [versionId, prompt, JSON.stringify(agent)];
    let sql = "update script_version set native_prompt = $2, agent = $3";
    if (notes !== undefined) {
      params.push(notes);
      sql += ", notes = $4";
    }
    const r = await tx.query(`${sql} where id = $1 and status = 'draft' returning id`, params);
    if (!r.rows.length) throw new PortalError("Only a draft can be edited, by a manager of this dealership.");
  });
}

/**
 * The call config a test chat runs on: this script version (any status the person can read) with the
 * dealership's live price ladder and knowledge base, on the prompt-native engine.
 */
export async function agentTestConfig(db: Db, userId: string, versionId: string): Promise<DealConfig> {
  return run(db, userId, async (tx) => {
    const v = (await tx.query<any>(`select dealership_id, ${CONTENT_COLUMNS.script} from script_version where id = $1`, [versionId])).rows[0];
    if (!v) throw new PortalError("No such version, or you don't have access to it.");
    return { ...(await callConfigFor(tx, v.dealership_id, "script", v)), engine: "native" as const };
  });
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
    cmp("Max's prompt", live?.native_prompt ?? "(the built-in prompt)", v.native_prompt ?? "(the built-in prompt)");
    const ag = (x: any) => normalizeAgent(x?.agent);
    const [la, va] = [ag(live), ag(v)];
    cmp("Agent context", la.context ?? "(none)", va.context ?? "(none)");
    cmp("Agent greeting", la.greeting ?? "(the built-in greeting)", va.greeting ?? "(the built-in greeting)");
    cmp("Agent guardrails", la.guardrails ?? "(all on)", va.guardrails ?? "(all on)");
    const docs = (a: AgentConfig) => new Map((a.docs ?? []).map((d) => [d.title, d.text]));
    const [ld, vd] = [docs(la), docs(va)];
    for (const t of new Set([...ld.keys(), ...vd.keys()])) cmp(`Document "${t}"`, ld.get(t) ?? "(none)", vd.get(t) ?? "(none)");
    cmp("Free-mode prompt", live?.free_prompt ?? "(the built-in prompt)", v.free_prompt ?? "(the built-in prompt)");
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

// ---------------------------------------------------------------------------------------------------
// Calls, dashboard and webhook (records are written by the brain; see brain/src/recorder.ts)
// ---------------------------------------------------------------------------------------------------

export interface CallRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  furthest_beat: number | null;
  final_rate: string | null;
  declined: boolean | null;
  turns_count: number;
  score: string | null;
  compliance_ok: boolean | null;
  webhook: "delivered" | "failed" | "none";
}

export async function listCalls(db: Db, userId: string, dealershipId: string, limit = 50): Promise<CallRow[]> {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>(
      `select c.id, c.started_at, c.ended_at, c.end_reason, c.furthest_beat, c.final_rate, c.declined, c.turns_count,
              r.score,
              case when r.compliance_checks is null then null
                   else not exists (select 1 from jsonb_each(r.compliance_checks) e where e.value = 'false'::jsonb) end as compliance_ok,
              case when c.webhook_delivered_at is not null then 'delivered' when c.webhook_error is not null then 'failed' else 'none' end as webhook
         from call c left join call_review r on r.call_id = c.id
        where c.dealership_id = $1 order by c.started_at desc limit $2`,
      [dealershipId, Math.min(Math.max(limit, 1), 200)]
    );
    return r.rows;
  });
}

export async function getCall(db: Db, userId: string, dealershipId: string, callId: string) {
  return run(db, userId, async (tx) => {
    const call = (await tx.query<any>("select * from call where id = $1 and dealership_id = $2", [callId, dealershipId])).rows[0];
    if (!call) throw new PortalError("No such call, or you don't have access to it.");
    const turns = (
      await tx.query<any>(
        "select idx, customer_text, max_text, beat_before, beat_after, understanding, wording_source, heard, fraction_heard, timings, panels from turn where call_id = $1 order by idx",
        [callId]
      )
    ).rows;
    const review = (await tx.query<any>("select score, summary, problems, compliance_checks, created_at from call_review where call_id = $1", [callId])).rows[0] ?? null;
    const recording =
      (await tx.query<RecordingInfo>("select duration_s, bytes, format, created_at, retention_until from recording where call_id = $1", [callId])).rows[0] ?? null;
    return { call, turns, review, recording };
  });
}

export interface RecordingInfo {
  duration_s: string | null;
  bytes: string | null;
  format: string;
  created_at: string;
  retention_until: string;
}

/**
 * A call's recording, to play it: its storage key and decryption metadata (only for people of the
 * dealership, by row-level security). Writes the playback to the audit log first, in the same
 * transaction: no audit entry, no recording. `audit: false` only for the player's later pieces of the
 * same playback.
 */
export async function openRecording(db: Db, userId: string, dealershipId: string, callId: string, opts: { audit?: boolean } = {}) {
  return run(db, userId, async (tx) => {
    const r = (
      await tx.query<{ storage_key: string; key_id: string | null; key_wrapped: string | null; nonce: string | null; sha256: string | null; format: string }>(
        "select storage_key, key_id, key_wrapped, nonce, sha256, format from recording where call_id = $1 and dealership_id = $2",
        [callId, dealershipId]
      )
    ).rows[0];
    if (!r || !r.key_id || !r.key_wrapped || !r.nonce || !r.sha256) throw new PortalError("This call has no recording, or you don't have access to it.");
    // The player asks for the file in pieces (seeking): one entry per playback, at its start
    if (opts.audit !== false) await tx.query("select app.note_recording_access($1)", [callId]);
    return { storageKey: r.storage_key, keyId: r.key_id, keyWrapped: r.key_wrapped, nonce: r.nonce, sha256: r.sha256, format: r.format };
  });
}

export interface Dashboard {
  days: number;
  calls: number;
  completed_rate: number | null;
  price_reached_rate: number | null;
  take_rate: number | null;
  avg_final_rate: number | null;
  compliance_failures: number;
  first_audio_ms: { median: number | null; p90: number | null; turns: number };
  per_day: Array<{ day: string; calls: number }>;
}

/** PRD dashboard figures over the last `days` days (only ended calls count toward rates) */
export async function dashboard(db: Db, userId: string, dealershipId: string, days = 30): Promise<Dashboard> {
  return run(db, userId, async (tx) => {
    const since = `now() - make_interval(days => $2)`;
    const a = (
      await tx.query<any>(
        `select count(*)::int as calls,
                avg((furthest_beat >= 25)::int) filter (where ended_at is not null) as completed_rate,
                avg((furthest_beat >= 22)::int) filter (where ended_at is not null) as price_reached_rate,
                avg((final_rate is not null)::int) filter (where ended_at is not null and furthest_beat >= 22) as take_rate,
                avg(final_rate) as avg_final_rate
           from call where dealership_id = $1 and started_at > ${since}`,
        [dealershipId, days]
      )
    ).rows[0];
    const cf = (
      await tx.query<{ n: number }>(
        `select count(*)::int as n from call_review r join call c on c.id = r.call_id
          where c.dealership_id = $1 and c.started_at > ${since}
            and exists (select 1 from jsonb_each(r.compliance_checks) e where e.value = 'false'::jsonb)`,
        [dealershipId, days]
      )
    ).rows[0].n;
    const lat = (
      await tx.query<any>(
        `select count(*)::int as turns,
                percentile_cont(0.5) within group (order by (t.timings ->> 'first_audio_ms')::numeric) as median,
                percentile_cont(0.9) within group (order by (t.timings ->> 'first_audio_ms')::numeric) as p90
           from turn t join call c on c.id = t.call_id
          where c.dealership_id = $1 and c.started_at > ${since} and t.timings ? 'first_audio_ms' and t.timings ->> 'first_audio_ms' is not null`,
        [dealershipId, days]
      )
    ).rows[0];
    const perDay = (
      await tx.query<{ day: string; calls: number }>(
        `select to_char(date_trunc('day', started_at), 'YYYY-MM-DD') as day, count(*)::int as calls
           from call where dealership_id = $1 and started_at > ${since} group by 1 order by 1`,
        [dealershipId, days]
      )
    ).rows;
    const pct = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 10);
    return {
      days,
      calls: a.calls,
      completed_rate: pct(a.completed_rate),
      price_reached_rate: pct(a.price_reached_rate),
      take_rate: pct(a.take_rate),
      avg_final_rate: a.avg_final_rate === null ? null : Math.round(Number(a.avg_final_rate) * 100) / 100,
      compliance_failures: cf,
      first_audio_ms: { median: lat.median === null ? null : Math.round(Number(lat.median)), p90: lat.p90 === null ? null : Math.round(Number(lat.p90)), turns: lat.turns },
      per_day: perDay,
    };
  });
}

/** The dealership's webhook (URL and whether active; the secret is never read back after it is set) */
export async function getWebhook(db: Db, userId: string, dealershipId: string): Promise<{ url: string; active: boolean } | null> {
  return run(db, userId, async (tx) => (await tx.query<any>("select url, active from dealership_webhook where dealership_id = $1", [dealershipId])).rows[0] ?? null);
}

/** Sets the webhook URL with a new signing secret, returned once to show to the editor */
export async function setWebhook(db: Db, userId: string, dealershipId: string, url: string): Promise<string> {
  const u = url.trim();
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(u)) throw new PortalError("The webhook must be an https:// address.");
  const { randomBytes } = await import("node:crypto");
  const secret = randomBytes(32).toString("hex");
  await run(db, userId, (tx) =>
    tx.query(
      `insert into dealership_webhook (dealership_id, url, secret) values ($1, $2, $3)
       on conflict (dealership_id) do update set url = excluded.url, secret = excluded.secret, active = true, updated_at = now()`,
      [dealershipId, u, secret]
    )
  );
  return secret;
}

export async function removeWebhook(db: Db, userId: string, dealershipId: string): Promise<void> {
  await run(db, userId, (tx) => tx.query("delete from dealership_webhook where dealership_id = $1", [dealershipId]));
}

// ---------------------------------------------------------------------------------------------------
// Onboarding, API keys, deletion on request (control-plane migration 009)
// ---------------------------------------------------------------------------------------------------

/** Who may create dealerships: the platform owner (anywhere) and agency admins (in their agency) */
export async function creatableAgencies(db: Db, userId: string): Promise<{ owner: boolean; agencies: Array<{ id: string; name: string }> }> {
  return run(db, userId, async (tx) => {
    const owner = (await tx.query<{ o: boolean }>("select app.is_platform_owner() as o")).rows[0].o;
    const agencies = (
      await tx.query<{ id: string; name: string }>(
        `select a.id, a.name from agency a
          where app.is_platform_owner() or exists (select 1 from membership m where m.user_id = $1 and m.agency_id = a.id and m.role = 'agency_admin')
          order by a.name`,
        [userId]
      )
    ).rows;
    return { owner, agencies };
  });
}

export interface NewDealership {
  id: string;
  name: string;
  agency: string | null;
  template: string;
  vehicle: { year: string; make: string; model: string };
  keyterms: string[];
}

/** A new dealership with draft versions copied from the template (nothing live until approved) */
export async function createDealership(db: Db, userId: string, d: NewDealership): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(d.id)) throw new PortalError("The id must be lower-case letters, digits, - or _ (it appears in call links).");
  if (!d.name.trim()) throw new PortalError("The dealership needs a name.");
  await run(db, userId, (tx) =>
    tx.query("select app.create_dealership($1, $2, $3, $4, $5, $6)", [d.id, d.name.trim(), d.agency, d.template, JSON.stringify(d.vehicle), d.keyterms])
  ).catch((err) => {
    if (err instanceof PortalError && /duplicate key|already exists/.test(err.message)) throw new PortalError(`A dealership with the id "${d.id}" already exists.`);
    throw err;
  });
}

export async function listApiKeys(db: Db, userId: string, dealershipId: string) {
  return run(db, userId, async (tx) => {
    const r = await tx.query<any>(
      `select k.id, k.prefix, k.label, k.created_at, k.last_used_at, k.revoked_at, u.email as created_by
         from api_key k left join app_user u on u.id = k.created_by
        where k.dealership_id = $1 order by k.created_at desc`,
      [dealershipId]
    );
    return r.rows as Array<{ id: string; prefix: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null; created_by: string | null }>;
  });
}

/** A new intake API key, returned once (only its hash is stored) */
export async function createApiKey(db: Db, userId: string, dealershipId: string, label: string): Promise<string> {
  return run(db, userId, async (tx) => (await tx.query<{ k: string }>("select app.create_api_key($1, $2) as k", [dealershipId, label.trim().slice(0, 60)])).rows[0].k);
}

export async function revokeApiKey(db: Db, userId: string, keyId: string): Promise<void> {
  await run(db, userId, (tx) => tx.query("select app.revoke_api_key($1)", [keyId]));
}

/** Deletion on request: the call's transcript, review text and recording; its outcome row stays */
export async function forgetCall(db: Db, userId: string, callId: string): Promise<void> {
  await run(db, userId, (tx) => tx.query("select app.forget_call($1)", [callId]));
}

export interface DealInput {
  external_ref?: unknown;
  vehicle?: { year?: unknown; make?: unknown; model?: unknown };
  customer_first_name?: unknown;
}

/**
 * The deal intake API (no signed-in person: the API key decides the dealership). Returns null for a
 * wrong or revoked key.
 */
export async function intakeDeal(db: Db, apiKey: string, input: DealInput): Promise<{ deal_id: string; dealership_id: string; expires_at: string } | null> {
  if (!/^mxk_[0-9a-f]{64}$/.test(apiKey)) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const vehicle = { year: text(input.vehicle?.year, 4), make: text(input.vehicle?.make, 40), model: text(input.vehicle?.model, 60) };
  if (!/^\d{4}$/.test(vehicle.year) || !vehicle.make || !vehicle.model) throw new PortalError("vehicle needs year (4 digits), make and model");
  try {
    const r = await db.query<any>("select * from app.intake_deal($1, $2, $3, $4)", [apiKey, text(input.external_ref, 80) || null, JSON.stringify(vehicle), text(input.customer_first_name, 60) || null]);
    return r.rows[0];
  } catch (err) {
    if (/invalid API key/.test(String((err as Error)?.message))) return null;
    throw err;
  }
}
