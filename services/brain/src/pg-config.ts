import { RECAP_BEATS } from "../../../tavus-avatar/src/lib/beat-controller.ts";
import { validateKnowledge, validateScript, type CallScript, type KnowledgeBase } from "../../../tavus-avatar/src/lib/call-content.ts";
import type { Db } from "../../control-plane/src/db.ts";
import { loadLiveConfig, type LiveDealershipConfig } from "../../control-plane/src/live-config.ts";

import { isValidLadder } from "../../../tavus-avatar/src/lib/price-ladder.ts";

import { asService } from "../../control-plane/src/db.ts";

import { type ConfigSource, type Deal, type DealSource, type DealershipConfig } from "./tenants.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deals from the intake API: only unexpired ones (row-level security), only the asked dealership's */
export class PostgresDealSource implements DealSource {
  constructor(private readonly db: Db) {}

  async get(dealershipId: string, dealId: string): Promise<Deal | null> {
    if (!UUID.test(dealId)) return null;
    return asService(this.db, "brain_service", async (tx) => {
      const r = await tx.query<any>("select id, vehicle, customer_first_name from deal where id = $1 and dealership_id = $2", [dealId, dealershipId]);
      return r.rows[0] ? { id: r.rows[0].id, vehicle: r.rows[0].vehicle ?? {}, customer_first_name: r.rows[0].customer_first_name } : null;
    });
  }
}

/**
 * Dealership config from the control plane (Postgres), read as brain_service: the database only ever
 * shows it LIVE, approved versions.
 *
 * Everything a call says comes from these versions: the price ladder, the script (beats, disclosure,
 * fixed lines, recaps) and the knowledge base with the platform's shared facts. A live version the
 * controller cannot run (a script whose flow differs from the controller's, an invalid ladder) refuses
 * new calls for that dealership, loudly, instead of running something nobody approved.
 */
export class PostgresConfigSource implements ConfigSource {
  readonly kind = "postgres" as const;
  private readonly cache = new Map<string, { at: number; value: DealershipConfig | undefined }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  async get(id: string): Promise<DealershipConfig | undefined> {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const live = await loadLiveConfig(this.db, id);
    let value: DealershipConfig | undefined;
    if (live) {
      const problem = unsupported(live);
      if (problem) {
        console.error(JSON.stringify({ event: "dealership_refused", dealership: id, reason: problem }));
      } else value = toDealershipConfig(live);
    }
    this.cache.set(id, { at: this.now(), value });
    return value;
  }
}

/** Why the brain cannot run this live config today, or null if it can. */
export function unsupported(live: LiveDealershipConfig): string | null {
  if (!live.script || !live.price || !live.kb) return "no live script, price ladder or knowledge base";
  const steps: unknown = live.price.steps;
  if (!isValidLadder(steps)) return `live price ladder ${JSON.stringify(steps)} is invalid`;
  const scriptProblem = validateScript(scriptOf(live), RECAP_BEATS);
  if (scriptProblem) return `live script: ${scriptProblem}`;
  const kbProblem = validateKnowledge(knowledgeOf(live));
  if (kbProblem) return `live knowledge base: ${kbProblem}`;
  return null;
}

function scriptOf(live: LiveDealershipConfig): CallScript {
  const s = live.script!;
  return { beats: s.beats as CallScript["beats"], disclosure: s.disclosure, fixed_lines: s.fixed_lines, recaps: s.recaps };
}

/** The dealership's facts plus the platform's shared facts (approved, answerable by keyword) */
function knowledgeOf(live: LiveDealershipConfig): KnowledgeBase {
  const shared = live.facts
    .filter((f) => f.shared)
    .map((f, i) => ({ id: `shared-${i + 1}`, topic: f.topic, answer: f.answer, keywords: f.keywords, status: "approved" }));
  return { facts: [...((live.kb?.facts ?? []) as KnowledgeBase["facts"]), ...shared] };
}

function toDealershipConfig(live: LiveDealershipConfig): DealershipConfig {
  const v = live.default_vehicle;
  return {
    id: live.id,
    name: live.name,
    max_display_name: live.max_display_name || "Max",
    default_vehicle: { year: v.year ?? "", make: v.make ?? "", model: v.model ?? "" },
    price_ladder: live.price!.steps,
    speech_keyterms: live.speech_keyterms,
    versions: live.versions,
    script: scriptOf(live),
    knowledge: knowledgeOf(live),
    ...(live.script?.free_prompt ? { free_prompt: live.script.free_prompt } : {}),
  };
}
