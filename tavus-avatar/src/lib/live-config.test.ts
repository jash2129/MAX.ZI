import { describe, expect, it } from "vitest";

import { BUILT_IN_BEATS, BUILT_IN_DISCLOSURE, BUILT_IN_KB } from "./call-content";
import { toLiveOverrides, type LiveRows } from "./live-config";

const rows = (over: Partial<LiveRows> = {}): LiveRows => ({
  script: { version: 3, beats: BUILT_IN_BEATS, disclosure: BUILT_IN_DISCLOSURE, fixed_lines: {}, recaps: {}, free_prompt: null },
  price: { version: 2, steps: ["5.00", "4.50", "4.00"] },
  kb: { version: 1, facts: BUILT_IN_KB.facts },
  shared: [{ topic: "Cancellation", answer: "The contract paperwork spells it out.", keywords: ["cancel"] }],
  ...over,
});

describe("the portal's live content on a call", () => {
  it("sets the script, the ladder (as numbers), the facts plus the shared facts, and the prompt", () => {
    const r = toLiveOverrides(rows({ script: { ...rows().script!, free_prompt: "PROMPT" } }));
    if (!("overrides" in r)) throw new Error(r.problem);
    expect(r.overrides.price_ladder).toEqual([5, 4.5, 4]);
    expect(r.overrides.script?.beats).toHaveLength(BUILT_IN_BEATS.length);
    expect(r.overrides.knowledge?.facts.at(-1)).toMatchObject({ id: "shared-1", topic: "Cancellation", status: "approved" });
    expect(r.overrides.free_prompt).toBe("PROMPT");
  });

  it("no prompt on the live script: the built-in prompt (nothing set)", () => {
    const r = toLiveOverrides(rows());
    expect("overrides" in r && "free_prompt" in r.overrides).toBe(false);
  });

  it("all or nothing: a missing version, a bad ladder or a script the controller can't run uses the built-in content", () => {
    expect(toLiveOverrides(rows({ kb: undefined }))).toEqual({ problem: "no live script, price ladder or knowledge base" });
    expect(toLiveOverrides(rows({ price: { version: 2, steps: [3, 4] } }))).toMatchObject({ problem: expect.stringMatching(/ladder/) });
    expect(toLiveOverrides(rows({ script: { ...rows().script!, beats: BUILT_IN_BEATS.slice(0, 10) } }))).toMatchObject({ problem: expect.stringMatching(/^live script/) });
    expect(toLiveOverrides(rows({ kb: { version: 1, facts: [{ topic: "x" }] } }))).toMatchObject({ problem: expect.stringMatching(/^live knowledge base/) });
  });
});
