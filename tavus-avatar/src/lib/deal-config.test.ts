import { describe, expect, it } from "vitest";

import { clientDealConfig, DEFAULT_DEAL_CONFIG } from "@/lib/deal-config";

describe("deal config from the browser", () => {
  it("never takes prices from the request", () => {
    const cfg = clientDealConfig({ price_ladder: [0.5], per_day_price: "zero dollars", vehicle_model: "CX fifty" });
    expect(cfg.price_ladder).toBeUndefined();
    expect(cfg.per_day_price).toBe(DEFAULT_DEAL_CONFIG.per_day_price);
    expect(cfg.vehicle_model).toBe("CX fifty");
  });

  it("falls back to the demo default", () => {
    expect(clientDealConfig(undefined)).toEqual(DEFAULT_DEAL_CONFIG);
    expect(clientDealConfig("nonsense")).toEqual(DEFAULT_DEAL_CONFIG);
  });
});
