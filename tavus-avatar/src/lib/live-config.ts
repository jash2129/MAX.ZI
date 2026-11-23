import "server-only";

import { Pool } from "pg";

import { RECAP_BEATS } from "./beat-controller";
import { validateKnowledge, validateScript, type CallScript, type KnowledgeBase } from "./call-content";
import type { DealConfig } from "./deal-config";
import { isValidLadder } from "./price-ladder";

/**
 * The dealership's approved content from the portal, for the call app: the LIVE script version (with
 * free mode's prompt), price ladder and knowledge base, plus the platform's shared facts. The same
 * versions the brain runs (services/control-plane/src/live-config.ts), read the same way.
 *
 *   MAX_CONFIG_DATABASE_URL  the brain's read-only login (brain_login): as brain_service the database
 *                            shows it live versions only, so a draft or anything unapproved can never
 *                            reach a call, whatever this code does
 *   MAX_DEALERSHIP_ID        whose content (e.g. demo-mazda)
 *
 * Unset, unreachable, or a live version the controller cannot run (checked like the brain does): the
 * built-in content, loudly (one JSON log line, and /api/health). Cached for 30 seconds per server
 * instance; a call keeps the content it started with (its state copies dealConfig on the first turn).
 */
const TTL_MS = 30_000;
// Neon's free tier sleeps when idle and takes a few seconds to wake: connecting may take that long
const CONNECT_TIMEOUT_MS = 6_000;
const QUERY_TIMEOUT_MS = 3_000;

/** What the portal's live versions set on a call */
export type LiveOverrides = Pick<DealConfig, "script" | "knowledge" | "price_ladder" | "free_prompt">;

export interface LiveRows {
  script?: { version: number; beats: unknown; disclosure: string; fixed_lines: unknown; recaps: unknown; free_prompt: string | null };
  price?: { version: number; steps: Array<string | number> };
  kb?: { version: number; facts: unknown };
  shared: Array<{ topic: string; answer: string; keywords: string[] | null }>;
}

export interface LiveConfigStatus {
  source: "portal" | "built-in";
  dealership?: string;
  versions?: { script: number | null; price: number | null; kb: number | null };
  freePrompt?: "portal" | "built-in";
  error?: string;
}

/**
 * The live rows as call overrides, or why they can't run (then the call uses the built-in content).
 * All or nothing: never a dealership's prices with the built-in script, say.
 */
export function toLiveOverrides(rows: LiveRows): { overrides: LiveOverrides } | { problem: string } {
  if (!rows.script || !rows.price || !rows.kb) return { problem: "no live script, price ladder or knowledge base" };
  const ladder = rows.price.steps.map(Number);
  if (!isValidLadder(ladder)) return { problem: `live price ladder ${JSON.stringify(rows.price.steps)} is invalid` };
  const script: CallScript = {
    beats: rows.script.beats as CallScript["beats"],
    disclosure: rows.script.disclosure,
    fixed_lines: (rows.script.fixed_lines ?? {}) as Record<string, string>,
    recaps: (rows.script.recaps ?? {}) as Record<string, string>,
  };
  const scriptProblem = validateScript(script, RECAP_BEATS);
  if (scriptProblem) return { problem: `live script: ${scriptProblem}` };
  // The dealership's facts plus the platform's shared facts (as the brain does)
  const shared = rows.shared.map((f, i) => ({ id: `shared-${i + 1}`, topic: f.topic, answer: f.answer, keywords: f.keywords ?? [], status: "approved" }));
  const knowledge: KnowledgeBase = { facts: [...((rows.kb.facts ?? []) as KnowledgeBase["facts"]), ...shared] };
  const kbProblem = validateKnowledge(knowledge);
  if (kbProblem) return { problem: `live knowledge base: ${kbProblem}` };
  return {
    overrides: {
      script,
      knowledge,
      price_ladder: ladder,
      ...(rows.script.free_prompt ? { free_prompt: rows.script.free_prompt } : {}),
    },
  };
}

let pool: Pool | undefined;
let cache: { at: number; overrides: LiveOverrides | null; status: LiveConfigStatus } | undefined;

function configured(): { url: string; dealership: string } | null {
  const url = process.env.MAX_CONFIG_DATABASE_URL?.trim();
  const dealership = process.env.MAX_DEALERSHIP_ID?.trim();
  return url && dealership ? { url, dealership } : null;
}

async function loadRows(url: string, dealership: string): Promise<LiveRows> {
  pool ??= new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, idleTimeoutMillis: 10_000, query_timeout: QUERY_TIMEOUT_MS });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role brain_service");
    const one = async <T extends Record<string, unknown>>(sql: string) => (await client.query<T>(sql, [dealership])).rows[0];
    const script = await one<NonNullable<LiveRows["script"]>>(
      "select version, beats, disclosure, fixed_lines, recaps, free_prompt from script_version where dealership_id = $1 and status = 'live'"
    );
    const price = await one<NonNullable<LiveRows["price"]>>("select version, steps from price_ladder_version where dealership_id = $1 and status = 'live'");
    const kb = await one<NonNullable<LiveRows["kb"]>>("select version, facts from kb_version where dealership_id = $1 and status = 'live'");
    const shared = (await client.query<LiveRows["shared"][number]>("select topic, answer, keywords from shared_fact where active order by created_at")).rows;
    await client.query("commit");
    return { script, price, kb, shared };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function refresh(now: number): Promise<NonNullable<typeof cache>> {
  const cfg = configured();
  if (!cfg) return { at: now, overrides: null, status: { source: "built-in" } };
  if (cache && now - cache.at < TTL_MS) return cache;
  try {
    const rows = await loadRows(cfg.url, cfg.dealership);
    const versions = { script: rows.script?.version ?? null, price: rows.price?.version ?? null, kb: rows.kb?.version ?? null };
    const r = toLiveOverrides(rows);
    if ("problem" in r) {
      console.error(JSON.stringify({ event: "live_config_refused", dealership: cfg.dealership, reason: r.problem }));
      cache = { at: now, overrides: null, status: { source: "built-in", dealership: cfg.dealership, versions, error: r.problem } };
    } else {
      cache = {
        at: now,
        overrides: r.overrides,
        status: { source: "portal", dealership: cfg.dealership, versions, freePrompt: r.overrides.free_prompt ? "portal" : "built-in" },
      };
    }
  } catch (err) {
    const error = String((err as Error)?.message ?? err).slice(0, 200);
    console.error(JSON.stringify({ event: "live_config_failed", dealership: cfg.dealership, error }));
    // Keep the last good content for a while; with none, the built-in content
    cache = { at: now, overrides: cache?.overrides ?? null, status: { ...(cache?.status ?? { source: "built-in", dealership: cfg.dealership }), error } };
  }
  return cache;
}

/** The portal's live content for new calls, or null for the built-in content. Never throws. */
export async function liveOverrides(now = Date.now()): Promise<LiveOverrides | null> {
  return (await refresh(now)).overrides;
}

/** For /api/health: where calls' content comes from right now */
export async function liveConfigStatus(now = Date.now()): Promise<LiveConfigStatus> {
  return (await refresh(now)).status;
}
