import type { CallScript, KnowledgeBase } from "./call-content";

import type { AgentConfig } from "./native-engine";

export interface DealConfig {
  dealership_name?: string;
  vehicle_year: string;
  vehicle_make: string;
  vehicle_model: string;
  /** The daily rate Max is currently offering, in words ("four dollars") */
  per_day_price: string;
  /**
   * The dealership's approved daily-rate ladder, highest first; the last step is the floor.
   * Unset = the demo ladder ($4 -> $3.50 -> $3.25 -> $3). See price-ladder.ts.
   */
  price_ladder?: number[];
  /** The dealership's approved script (beats, disclosure, fixed lines, recaps). Unset = the demo's. */
  script?: CallScript;
  /** The dealership's approved knowledge base, with the platform's shared facts. Unset = the demo's. */
  knowledge?: KnowledgeBase;
  /**
   * Free mode only (MAX_MODE=free): the prompt TEMPLATE Max runs the call from (free-ai.ts,
   * DEFAULT_FREE_PROMPT). Unset = the built-in one. Server-side only, never sent to the browser.
   */
  free_prompt?: string;
  /**
   * The prompt-native engine (MAX_MODE=native, native-engine.ts): the prompt Max runs the call from,
   * behavior only (the approved content is appended by code). Unset = DEFAULT_NATIVE_PROMPT.
   */
  native_prompt?: string;
  /**
   * The agent (portal Agent page, native engine only): context, greeting, knowledge documents and the
   * guardrail switches. Unset = the built-in behavior. Server-side only, never from the browser.
   */
  agent?: AgentConfig;
  /**
   * Which engine runs this call, overriding MAX_MODE (server-side only; clientDealConfig never copies
   * it from the browser). Used by the prompt lab to run two engines side by side.
   */
  engine?: "native" | "free" | "script";
}

export const HYUNDAI_DEAL_CONFIG: DealConfig = {
  dealership_name: "Hyundai of Dallas",
  vehicle_year: "2026",
  vehicle_make: "Hyundai",
  vehicle_model: "Tucson",
  per_day_price: "four dollars",
};

export const DEFAULT_DEAL_CONFIG: DealConfig = {
  dealership_name: "Mazda Dealership",
  vehicle_year: "2026",
  vehicle_make: "Mazda",
  vehicle_model: "CX five",
  per_day_price: "four dollars",
};

/** The demo default, with only the client-safe fields taken from the request */
export function clientDealConfig(raw: unknown): DealConfig {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, fallback: string | undefined) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : fallback);
  return {
    ...DEFAULT_DEAL_CONFIG,
    dealership_name: text(d.dealership_name, DEFAULT_DEAL_CONFIG.dealership_name),
    vehicle_year: text(d.vehicle_year, DEFAULT_DEAL_CONFIG.vehicle_year)!,
    vehicle_make: text(d.vehicle_make, DEFAULT_DEAL_CONFIG.vehicle_make)!,
    vehicle_model: text(d.vehicle_model, DEFAULT_DEAL_CONFIG.vehicle_model)!,
  };
}
