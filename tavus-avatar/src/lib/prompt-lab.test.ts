import { describe, expect, it } from "vitest";

import { buildFreeSystemPrompt, checkFreePromptTemplate, DEFAULT_FREE_PROMPT, FREE_REPLY_FORMAT } from "./free-ai";
import { compare, firstDivergence, lineDiff, measures, reportHtml, stat, table, type LabCall } from "./prompt-lab";

const script = { beats: [{ id: 1, text: "DISCLOSURE" }, { id: 22, text: "Price beat" }], facts: "- a fact", vehicle: "2026 Mazda CX five", disclosure: "DISCLOSURE", ladder: [5, 4, 3] };

describe("the free-mode prompt as a template", () => {
  it("the built-in template uses every placeholder and none unknown", () => {
    expect(checkFreePromptTemplate(DEFAULT_FREE_PROMPT)).toEqual({ unknown: [], missing: [] });
  });

  it("fills placeholders from the call's content and always appends the reply format", () => {
    const p = buildFreeSystemPrompt(script, "Sell the {{vehicle}} at {{first_price}}, then {{price_steps}}, floor {{floor}}.\n{{script}}");
    expect(p).toContain("Sell the 2026 Mazda CX five at five dollars, then five dollars, then four dollars, then three dollars, floor three dollars.");
    expect(p).toContain("Beat 22: Price beat");
    expect(p.endsWith(FREE_REPLY_FORMAT)).toBe(true);
  });

  it("a template without the reply format still gets it (an edit can't break how replies are read)", () => {
    expect(buildFreeSystemPrompt(script, "Be nice.")).toBe(`Be nice.\n\n${FREE_REPLY_FORMAT}`);
  });

  it("typos in placeholders are reported and left visible", () => {
    expect(checkFreePromptTemplate("{{vehicel}} {{floor}}").unknown).toEqual(["vehicel"]);
    expect(buildFreeSystemPrompt(script, "{{vehicel}}")).toContain("{{vehicel}}");
  });
});

const call = (variant: "A" | "B", run: number, o: Partial<LabCall> = {}): LabCall => ({
  variant,
  persona: "p1",
  run,
  turns: [{ customer: "yes", max: "hello there friend", beat: 1, mode: "free", firstMs: 500 }],
  endedBy: "max",
  scorecard: { checks: [], passed: 0, failed: 0, furthestBeat: 25, reachedPrice: true, completed: true },
  accepted: true,
  declined: false,
  finalRate: 4,
  ...o,
});

describe("statistics", () => {
  it("mean and standard error", () => {
    const s = stat([1, 2, 3, 4]);
    expect(s.mean).toBe(2.5);
    expect(s.se).toBeCloseTo(Math.sqrt(1.6667 / 4), 3);
  });

  it("a difference counts only beyond twice its standard error, in the measure's direction", () => {
    expect(compare(stat([1, 2, 3]), stat([1.5, 2.5, 3.5]), "higher").verdict).toBe("noise");
    expect(compare(stat([1, 1.1, 0.9]), stat([5, 5.1, 4.9]), "higher").verdict).toBe("better");
    expect(compare(stat([1, 1.1, 0.9]), stat([5, 5.1, 4.9]), "lower").verdict).toBe("worse");
    expect(compare(stat([1, 1.1, 0.9]), stat([5, 5.1, 4.9]), "neither").verdict).toBe("changed");
    expect(compare(stat([2, 2]), stat([2, 2]), "higher").verdict).toBe("same");
    expect(compare(stat([2]), stat([3]), "higher").verdict).toBe("too few calls");
  });

  it("the table compares A and B per measure; failed calls are left out", () => {
    const calls = [call("A", 1), call("A", 2), call("B", 1, { accepted: false, finalRate: null }), call("B", 2, { accepted: false, finalRate: null }), call("B", 3, { error: "boom" })];
    const row = table(calls, measures()).find((r) => r.measure.id === "accepted")!;
    expect([row.a.mean, row.b.mean, row.b.n, row.verdict]).toEqual([1, 0, 2, "worse"]);
  });

  it("custom checks become measures", () => {
    const c = (v: "A" | "B", run: number, pass: boolean) => call(v, run, { judge: { natural: 5, listens: 5, clear: 5, warm: 5, summary: "", checks: { "mentions roadside": { pass, why: "" } } } });
    const row = table([c("A", 1, false), c("A", 2, false), c("B", 1, true), c("B", 2, true)], measures(["mentions roadside"])).find((r) => r.measure.id === "check_1")!;
    expect(row.verdict).toBe("better");
  });
});

describe("diff and divergence", () => {
  it("line diff marks added and removed lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
  });

  it("the first turn where the calls went differently", () => {
    const t = (max: string) => ({ customer: "yes", max, beat: 1 });
    expect(firstDivergence([t("x"), t("y")], [t("x"), t("z")])).toBe(1);
    expect(firstDivergence([t("x")], [t("x")])).toBe(-1);
    expect(firstDivergence([t("x")], [t("x"), t("y")])).toBe(1);
  });
});

describe("the report", () => {
  it("is one self-contained page that escapes what the AI said", () => {
    const html = reportHtml({
      title: "Prompt Lab",
      when: "now",
      promptA: { name: "a.md", text: "one\ntwo" },
      promptB: { name: "b.md", text: "one\nthree" },
      calls: [call("A", 1, { turns: [{ customer: "<script>alert(1)</script>", max: "hi", beat: 1 }] }), call("B", 1)],
      checks: [],
      settings: "test",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/class="dl ddel">.*two/);
    expect(html).toMatch(/class="dl dadd">.*three/);
    expect(html).not.toMatch(/<script|<link/);
  });
});
