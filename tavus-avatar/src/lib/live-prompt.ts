import "server-only";

import { Pool } from "pg";

/**
 * Free mode's prompt from the portal: the LIVE script version's `free_prompt` for one dealership,
 * read from the control-plane database (services/control-plane, migration 012).
 *
 *   MAX_CONFIG_DATABASE_URL  the brain's read-only login (brain_login): as brain_service the database
 *                            shows it live versions only, so a draft or an unapproved prompt can never
 *                            reach a call, whatever this code does
 *   MAX_DEALERSHIP_ID        whose prompt (e.g. demo-mazda)
 *
 * Unset, unreachable, or no prompt on the live version: the built-in prompt (free-ai.ts). Cached for
 * 30 seconds per server instance; the call pins the prompt it starts with (beat-controller.ts).
 */
const TTL_MS = 30_000;
const TIMEOUT_MS = 2_000;

let pool: Pool | undefined;
let cache: { at: number; prompt: string | null; version: number | null } | undefined;
let lastError: string | undefined;

export interface LivePromptStatus {
  source: "portal" | "built-in";
  dealership?: string;
  version?: number | null;
  error?: string;
}

function configured(): { url: string; dealership: string } | null {
  const url = process.env.MAX_CONFIG_DATABASE_URL?.trim();
  const dealership = process.env.MAX_DEALERSHIP_ID?.trim();
  return url && dealership ? { url, dealership } : null;
}

async function load(url: string, dealership: string): Promise<{ prompt: string | null; version: number | null }> {
  pool ??= new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: TIMEOUT_MS, idleTimeoutMillis: 10_000, query_timeout: TIMEOUT_MS });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role brain_service");
    const r = await client.query<{ free_prompt: string | null; version: number }>(
      "select free_prompt, version from script_version where dealership_id = $1 and status = 'live'",
      [dealership]
    );
    await client.query("commit");
    return { prompt: r.rows[0]?.free_prompt ?? null, version: r.rows[0]?.version ?? null };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The approved live free-mode prompt, or undefined for the built-in one. Never throws. */
export async function liveFreePrompt(now = Date.now()): Promise<string | undefined> {
  const cfg = configured();
  if (!cfg) return undefined;
  if (cache && now - cache.at < TTL_MS) return cache.prompt ?? undefined;
  try {
    const { prompt, version } = await load(cfg.url, cfg.dealership);
    cache = { at: now, prompt, version };
    lastError = undefined;
  } catch (err) {
    lastError = String((err as Error)?.message ?? err).slice(0, 200);
    console.error(JSON.stringify({ event: "live_prompt_failed", dealership: cfg.dealership, error: lastError }));
    // Keep the last good prompt for a while; with none, the built-in one
    cache = { at: now, prompt: cache?.prompt ?? null, version: cache?.version ?? null };
  }
  return cache.prompt ?? undefined;
}

/** For /api/health: where free mode's prompt comes from right now */
export async function livePromptStatus(): Promise<LivePromptStatus> {
  const cfg = configured();
  if (!cfg) return { source: "built-in" };
  const prompt = await liveFreePrompt();
  return {
    source: prompt ? "portal" : "built-in",
    dealership: cfg.dealership,
    version: cache?.version ?? null,
    ...(lastError ? { error: lastError } : {}),
  };
}
