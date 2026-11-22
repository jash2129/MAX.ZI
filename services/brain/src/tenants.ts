import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Dealership configuration (Phase 1: JSON files under config/dealerships; Phase 3 moves this to the
 * control plane's Postgres tables with versions and approval).
 *
 * Only what the controller can honour per dealership today is accepted. The price ladder is still
 * enforced in beat-controller.ts as $4 -> $3.50 -> $3.25 -> $3, so a dealership whose ladder differs is
 * REFUSED at load time instead of being quietly quoted another dealership's prices.
 */
export interface DealershipConfig {
  id: string;
  name: string;
  max_display_name: string;
  default_vehicle: { year: string; make: string; model: string };
  price_ladder: number[];
  speech_keyterms: string[];
  /** The control plane's live version ids this call runs on (null with file config) */
  versions?: { script: string | null; price: string | null; kb: string | null };
}

/** Where dealership config comes from: JSON files (dev) or the control plane's Postgres. */
export interface ConfigSource {
  readonly kind: "files" | "postgres";
  get(id: string): Promise<DealershipConfig | undefined>;
  ids?(): string[];
}

/** The ladder the controller enforces in code today (beat-controller.ts CONCESSION_LADDER). */
export const ENFORCED_LADDER = [4, 3.5, 3.25, 3] as const;

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateDealership(raw: unknown, source: string): DealershipConfig {
  const c = raw as Partial<DealershipConfig>;
  const fail = (why: string): never => {
    throw new Error(`dealership config ${source}: ${why}`);
  };
  if (!c || typeof c !== "object") fail("not an object");
  if (typeof c.id !== "string" || !ID_PATTERN.test(c.id)) fail("id must match " + ID_PATTERN);
  if (typeof c.name !== "string" || !c.name.trim()) fail("name is required");
  const v = c.default_vehicle;
  if (!v || [v.year, v.make, v.model].some((x) => typeof x !== "string" || !x.trim())) fail("default_vehicle needs year, make, model");
  const ladder = c.price_ladder;
  if (!Array.isArray(ladder) || ladder.length !== ENFORCED_LADDER.length || ladder.some((p, i) => p !== ENFORCED_LADDER[i])) {
    fail(`price_ladder must be [${ENFORCED_LADDER.join(", ")}] until per-dealership ladders land (Phase 3)`);
  }
  return {
    id: c.id!,
    name: c.name!.trim(),
    max_display_name: (c.max_display_name ?? "Max").trim() || "Max",
    default_vehicle: { year: v!.year, make: v!.make, model: v!.model },
    price_ladder: [...ladder!],
    speech_keyterms: Array.isArray(c.speech_keyterms) ? c.speech_keyterms.filter((k) => typeof k === "string") : [],
  };
}

export class DealershipRegistry implements ConfigSource {
  readonly kind = "files" as const;
  private readonly byId = new Map<string, DealershipConfig>();

  constructor(configs: DealershipConfig[]) {
    for (const c of configs) {
      if (this.byId.has(c.id)) throw new Error(`duplicate dealership id ${c.id}`);
      this.byId.set(c.id, c);
    }
  }

  /** Loads every *.json in the directory; any invalid file stops start-up (fail loudly, not per call). */
  static fromDirectory(dir = resolve(import.meta.dirname, "../config/dealerships")): DealershipRegistry {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return new DealershipRegistry(files.map((f) => validateDealership(JSON.parse(readFileSync(join(dir, f), "utf8")), f)));
  }

  async get(id: string): Promise<DealershipConfig | undefined> {
    return this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }
}
