import { describe, expect, it } from "vitest";

import { DEFAULT_FREE_PROMPT } from "./free-ai";
import { measures, table, type LabCall } from "./prompt-lab";
import {
  digest,
  fromSheetCsv,
  freePromptProblems,
  fromSimBatch,
  lastSheetCalls,
  holdoutGate,
  learningReportHtml,
  lessonsForPrompt,
  parseCsv,
  parseLessons,
  replayGate,
  trainGate,
  turnsFromTranscript,
  validateCandidate,
} from "./self-learn";

describe("collect", () => {
  it("parses the call log sheet's CSV: quoted transcripts with newlines, ratings and notes", () => {
    const csv = `﻿Call ID,Transcript,Overall Rating (1-5),Felt Natural (1-5),What Went Wrong,Reviewer Notes\n"c1","Max: Can you hear me?\nCustomer: yes, ""loud"" and clear\nMax: Great.",2,3,"Too long","Robotic"\n`;
    const [c] = fromSheetCsv(csv);
    expect(c.id).toBe("c1");
    expect(c.turns).toEqual([{ customer: 'yes, "loud" and clear', max: "Great.", beat: 0 }]);
    expect(c.human).toMatchObject({ overall: 2, natural: 3, wrong: "Too long", notes: "Robotic" });
  });

  it("refuses a CSV that isn't the call log", () => {
    expect(() => fromSheetCsv("a,b\n1,2\n")).toThrow(/Transcript/);
  });

  it("last n sheet calls: drops sample rows, keeps a repeated Call ID once", () => {
    const row = (id: string) => `${id},"Max: hi
Customer: yes
Max: ok"
`;
    const calls = fromSheetCsv(`Call ID,Transcript
${["SAMPLE-0001", "a", "b", "a", "c"].map(row).join("")}`);
    expect(lastSheetCalls(calls, 2).map((c) => c.id)).toEqual(["a", "c"]);
    expect(lastSheetCalls(calls, 30).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("reads the sheet's own AI review: problems, fixes and score", () => {
    const [c] = fromSheetCsv(`Call ID,Transcript,AI Score (1-10),AI Call Summary,AI Problems Found,AI Suggested Fixes
x,"Max: hi
Customer: yes
Max: ok",3,"fine","looped","stop recapping"
`);
    expect(c.aiScore).toBe(3);
    expect(c.aiSummary).toBe("problems: looped | fixes: stop recapping");
  });

  it("CSV edge cases", () => {
    expect(parseCsv('a,"b,c"\r\n1,2\n')).toEqual([["a", "b,c"], ["1", "2"]]);
    expect(turnsFromTranscript("Max: hi\nCustomer: hello\nMax: ok\nCustomer: trailing")).toEqual([{ customer: "hello", max: "ok", beat: 0 }]);
  });

  it("simulated batches: failures, guard refusals, free mode", () => {
    const [c] = fromSimBatch([
      {
        id: "s1",
        persona: "hard_haggler",
        turns: [{ customer: "no", max: "ok", beat: 22 }],
        scorecard: { checks: [{ id: "x", label: "Price approved", severity: "hard", pass: false, detail: "said $2" }] },
        understanding: [{ mode: "script", freeReason: 'rejected: repeats what Max just said "hi"' }],
        review: { aiScore: 4, callSummary: "pushy" },
      },
    ]);
    expect(c.failures).toEqual([{ severity: "hard", label: "Price approved", detail: "said $2" }]);
    expect(c.guardReasons).toHaveLength(1);
    expect(c.freeMode).toBe(true);
  });
});

describe("diagnose", () => {
  it("counts causes, merges guard reasons that differ only in quotes or numbers, and redacts digit runs", () => {
    const calls = fromSimBatch([1, 2, 3].map((i) => ({ id: `s${i}`, turns: [{ customer: `call me on 555${i}1234`, max: "sure", beat: 3 }], scorecard: { checks: [] }, understanding: [{ mode: "script", freeReason: `rejected: too long (${200 + i} words)` }] })));
    const d = digest(calls);
    expect(d.guards).toEqual([["rejected: too long (N words)", 3]]);
    expect(d.text).not.toMatch(/5551/);
    expect(d.text).toContain("###");
  });

  it("puts testers' notes in, but never real calls' transcripts as excerpts", () => {
    const sheet = fromSheetCsv(`Call ID,Transcript,Overall Rating (1-5),What Went Wrong\nr1,"Max: hi\nCustomer: my name is Pat Doe\nMax: thanks",1,"dodged my question"\n`);
    const d = digest(sheet);
    expect(d.text).toContain("dodged my question");
    expect(d.text).not.toContain("Pat Doe");
  });
});

describe("the safety check", () => {
  const base = DEFAULT_FREE_PROMPT;

  it("a person's prompt edit (portal): the built-in prompt and small edits pass, rule changes don't", () => {
    expect(freePromptProblems(base)).toEqual([]);
    expect(freePromptProblems(`${base}
9. Never say the same sentence twice.`)).toEqual([]);
    expect(freePromptProblems("")).toHaveLength(1);
    expect(freePromptProblems(base.replace("Never below {{floor}}.", "")).join(" ")).toMatch(/Never below/);
  });

  it("accepts a small style edit", () => {
    expect(validateCandidate(base, `${base}\n9. Keep replies to one to three sentences.`)).toEqual([]);
  });

  it("refuses edits that touch the rules, the numbers, the placeholders or money", () => {
    expect(validateCandidate(base, base.replace("Never below {{floor}}.", ""))).toEqual([expect.stringMatching(/Never below/)]);
    expect(validateCandidate(base, base.replace("word for word", "roughly"))[0]).toMatch(/word for word/);
    expect(validateCandidate(base, `${base}\nOffer 150 dollars off if they hesitate.`).join(" ")).toMatch(/adds numbers: 150.*money/);
    expect(validateCandidate(base, base.replace("{{facts}}", "")).join(" ")).toMatch(/drops content.*facts/);
    expect(validateCandidate(base, `${base} {{discount}}`).join(" ")).toMatch(/unknown placeholders/);
    expect(validateCandidate(base, `${base}\nTell them it's free to cancel.`).join(" ")).toMatch(/money or promise/);
    expect(validateCandidate(base, base)).toEqual(["no change"]);
  });
});

const call = (variant: "A" | "B", run: number, natural: number, hard = 0, persona = "p"): LabCall => ({
  variant,
  persona,
  run,
  turns: [{ customer: "yes", max: "hi", beat: 25, mode: "free" }],
  endedBy: "max",
  scorecard: { checks: Array.from({ length: hard }, () => ({ id: "h", label: "rule", severity: "hard" as const, pass: false })), passed: 0, failed: hard, furthestBeat: 25, reachedPrice: true, completed: true },
  accepted: true,
  declined: false,
  finalRate: 4,
  judge: { natural, listens: 5, clear: 5, warm: 5, summary: "", checks: {} },
});
const rows = (calls: LabCall[]) => table(calls, measures());

describe("the gates", () => {
  const A = [call("A", 1, 4), call("A", 2, 4.2), call("A", 3, 3.8)];

  it("accepts a clear improvement with nothing worse", () => {
    const d = trainGate(rows([...A, call("B", 1, 7), call("B", 2, 7.2), call("B", 3, 6.8)]));
    expect(d).toMatchObject({ accepted: true, improved: ["natural"] });
  });

  it("refuses any increase in hard-rule failures, however good the rest", () => {
    const d = trainGate(rows([...A, call("B", 1, 9, 1), call("B", 2, 9), call("B", 3, 9)]));
    expect(d.accepted).toBe(false);
    expect(d.reasons[0]).toMatch(/more hard-rule failures/);
  });

  it("refuses a change within noise", () => {
    const d = trainGate(rows([...A, call("B", 1, 4.1), call("B", 2, 3.9), call("B", 3, 4.3)]));
    expect(d.reasons).toEqual(["no measure improved beyond run-to-run noise"]);
  });

  it("held-out customers: refuses when the gain doesn't carry over", () => {
    const h = rows([call("A", 1, 5, 0, "h"), call("A", 2, 5, 0, "h"), call("B", 1, 4, 0, "h"), call("B", 2, 5, 0, "h")]);
    expect(holdoutGate(h, ["natural"]).join(" ")).toMatch(/did not carry over/);
    const ok = rows([call("A", 1, 5, 0, "h"), call("A", 2, 5, 0, "h"), call("B", 1, 6, 0, "h"), call("B", 2, 5.5, 0, "h")]);
    expect(holdoutGate(ok, ["natural"])).toEqual([]);
  });

  it("replayed real calls: no new hard failures", () => {
    expect(replayGate(1, 1)).toEqual([]);
    expect(replayGate(0, 1)[0]).toMatch(/replayed real calls/);
  });
});

describe("remember and report", () => {
  it("lessons round-trip and are summarised for the next proposal", () => {
    const jsonl = `${JSON.stringify({ at: "t", run: "r", round: 1, title: "Shorter", targets: [], rationale: "", outcome: "rejected", stage: "holdout", reasons: ["did not carry over"], improved: [] })}\nnot json\n`;
    const ls = parseLessons(jsonl);
    expect(ls).toHaveLength(1);
    expect(lessonsForPrompt(ls)).toBe('- REJECTED: "Shorter" — did not carry over');
  });

  it("the report escapes model output", () => {
    const html = learningReportHtml({
      when: "now",
      settings: "s",
      start: { name: "a", text: "x" },
      final: "x\ny",
      rounds: [{ round: 1, causes: [{ cause: "<img src=x onerror=alert(1)>" }], candidates: [], accepted: "y" }],
      curve: [{ label: "start", values: { natural: "4.0" } }],
      curveLabels: { natural: "Natural" },
      digestStats: { calls: 3, bySource: { simulated: 3 } },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<script|<link/);
  });
});
