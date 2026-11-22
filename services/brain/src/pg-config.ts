import { isDeepStrictEqual } from "node:util";

import beatsData from "../../../tavus-avatar/src/lib/beats.json" with { type: "json" };
import kbData from "../../../tavus-avatar/src/lib/max-knowledge-base.json" with { type: "json" };
import type { Db } from "../../control-plane/src/db.ts";
import { loadLiveConfig, type LiveDealershipConfig } from "../../control-plane/src/live-config.ts";

import { ENFORCED_LADDER, type ConfigSource, type DealershipConfig } from "./tenants.ts";

/**
 * Dealership config from the control plane (Postgres), read as brain_service: the database only ever
 * shows it LIVE, approved versions.
 *
 * Until the controller reads beats, knowledge base and ladder per call (the next step of this phase),
 * it speaks its built-in ones. So a live version is accepted only if its content IS the built-in
 * content; anything else is refused loudly. Otherwise an approver could approve script v2 while
 * customers still heard v1, and the approval would mean nothing.
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
  if (!isDeepStrictEqual(live.price.steps, [...ENFORCED_LADDER])) return `live price ladder [${live.price.steps.join(", ")}] is not the one the controller enforces`;
  if (!isDeepStrictEqual(live.script.beats, beatsData)) return "live script differs from the script the controller runs";
  if (!isDeepStrictEqual(live.kb.facts, (kbData as { facts: unknown[] }).facts)) return "live knowledge base differs from the one the controller runs";
  if (live.facts.some((f) => f.shared)) return "shared platform facts are not used by the controller yet; deactivate them or wait for per-call knowledge";
  return null;
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
  };
}
