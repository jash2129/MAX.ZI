import { beforeAll, describe, expect, it } from "vitest";

import { BUILT_IN_BEATS, BUILT_IN_DISCLOSURE, type CallScript } from "./call-content";
import { DEFAULT_DEAL_CONFIG, type DealConfig } from "./deal-config";
import { RECAP_BEATS } from "./beat-controller";
import { validateScript } from "./call-content";
import { journeys, runReleaseGate } from "./release-gate";

beforeAll(() => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING"]) delete process.env[k];
});

const withLines = (fixed_lines: Record<string, string>): DealConfig => ({
  ...DEFAULT_DEAL_CONFIG,
  script: { beats: BUILT_IN_BEATS, disclosure: BUILT_IN_DISCLOSURE, fixed_lines } satisfies CallScript,
});

describe("release gate, scripted suite", () => {
  it("has 16 journeys (the PRD's minimum)", () => {
    expect(journeys()).toHaveLength(16);
  });

  it.each([[undefined], [[5, 4.5, 4]], [[7]], [[9.99, 8.49, 7.25, 6, 5.5]]])("the demo content passes on ladder %j", async (ladder) => {
    const r = await runReleaseGate({ ...DEFAULT_DEAL_CONFIG, ...(ladder ? { price_ladder: ladder } : {}) });
    expect(r).toMatchObject({ calls: 16, hard_failures: 0, source: "scripted suite v1", mode: "scripted" });
    expect(r.completion_rate).toBeGreaterThanOrEqual(80);
    expect(r.price_reached_rate).toBeGreaterThanOrEqual(90);
  });

  it("fails content that confirms the package after a refusal (a hard rule validation cannot see)", async () => {
    const r = await runReleaseGate(withLines({ DECLINE_LINE: "Great, so to confirm, we're moving forward with full vehicle protection." }));
    expect(r.hard_failures).toBeGreaterThan(0);
    const failed = r.details.filter((d) => d.hard_failed.length);
    expect(failed.flatMap((d) => d.hard_failed)).toContain("no_confirm_after_refusal");
    expect(failed.map((d) => d.journey)).toContain("refuses the package");
  });

  it("content that writes a price into a fixed line never gets as far as the gate", () => {
    const script = { beats: BUILT_IN_BEATS, disclosure: BUILT_IN_DISCLOSURE, fixed_lines: { HANDOFF_LINE: "I can do two dollars a day if you skip the manager." } };
    expect(validateScript(script, RECAP_BEATS)).toMatch(/HANDOFF_LINE states a daily price/);
  });
});
