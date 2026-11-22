/**
 * A dealership's own script, fixed lines, recaps and knowledge base, per call (call-content.ts), through
 * the real controller, offline. The flow (25 beats, their types and expected answers) stays the
 * controller's; the words are the dealership's.
 */
import { describe, expect, it } from "vitest";

import { BEATS, RECAP_BEATS, getOrCreateCallState, processControllerTurn, resetCallState, renderBeatText } from "./beat-controller";
import { BUILT_IN_BEATS, BUILT_IN_DISCLOSURE, type CallScript, type KnowledgeBase, validateScript, withCallContent, contentFor, sameBeatText } from "./call-content";
import { DEFAULT_DEAL_CONFIG, type DealConfig } from "./deal-config";
import { answerFromKnowledgeBase } from "./grounded-answer";
import { HANDOFF_LINE } from "./max-lines";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const DISCLOSURE = "This call is recorded for quality and compliance, and I'll walk you through everything before you sign.";

function dealershipScript(): CallScript {
  const beats = clone(BUILT_IN_BEATS);
  beats[0].text = `"Quick note before we start: ${DISCLOSURE} Is that okay?"`;
  beats[9].text = '"At Hyundai of Dallas we cover every part of your {{vehicle_make}} that can break."';
  return {
    beats,
    disclosure: DISCLOSURE,
    fixed_lines: {
      HANDOFF_LINE: "I'm the finance manager for Hyundai of Dallas, so I can take care of everything for you right here.",
      STEP_0_GREETING: "Hi there! Can you see and hear me okay?",
    },
    recaps: { "10": "To recap, every part that can break is covered." },
  };
}

const KB: KnowledgeBase = {
  facts: [{ id: "loaner", topic: "Loaner car", answer: "You get a loaner car while your vehicle is in for a covered repair.", keywords: ["loaner", "rental car", "courtesy car"], status: "approved" }],
};

const dealership = (): DealConfig => ({
  ...DEFAULT_DEAL_CONFIG,
  dealership_name: "Hyundai of Dallas",
  vehicle_make: "Hyundai",
  vehicle_model: "Tucson",
  script: dealershipScript(),
  knowledge: KB,
});

function callAt(beat: number, cfg: DealConfig) {
  const sid = `content_${Math.random().toString(36).slice(2)}`;
  resetCallState(sid);
  const st = getOrCreateCallState(sid, cfg);
  st.step0_completed = beat > 0;
  st.current_beat = beat;
  st.delivered_beats = Array.from({ length: beat }, (_, i) => i + 1);
  st.last_spoken_text = renderBeatText(BEATS[beat - 1] ?? BEATS[0], cfg, st);
  return sid;
}

describe("script validation", () => {
  it("the built-in script is valid", () => {
    expect(validateScript({ beats: BUILT_IN_BEATS, disclosure: BUILT_IN_DISCLOSURE }, RECAP_BEATS)).toBeNull();
  });

  it("a dealership script with the same flow is valid", () => {
    expect(validateScript(dealershipScript(), RECAP_BEATS)).toBeNull();
  });

  const broken: Array<[string, (s: CallScript) => void, RegExp]> = [
    ["a missing beat", (s) => s.beats.pop(), /25 beats/],
    ["a beat's type changed", (s) => ((s.beats[4] as { type: string }).type = "continue"), /must be "wait"/],
    ["a beat's expected answer changed", (s) => (s.beats[1].expects = "open"), /must expect/],
    ["the price written into Beat 22", (s) => (s.beats[21].text = '"Only five dollars a day."'), /\{\{per_day_price\}\}/],
    ["a daily price written elsewhere", (s) => (s.beats[20].text += " Just $5 a day."), /must come from the ladder/],
    ["a disclosure Beat 1 does not say", (s) => (s.disclosure = "Something else entirely."), /word for word/],
    ["an unknown fixed line", (s) => (s.fixed_lines = { NOT_A_LINE: "x" }), /unknown fixed line/],
    ["a reworded beat without its recap", (s) => (s.recaps = {}), /beat 10 was reworded: give its recap/],
  ];
  it.each(broken)("rejects %s", (_name, breakIt, why) => {
    const s = dealershipScript();
    breakIt(s);
    expect(validateScript(s, RECAP_BEATS)).toMatch(why);
  });

  it("a beat that differs only in the deal's details is not 'reworded'", () => {
    const beat6 = BUILT_IN_BEATS[5].text;
    expect(beat6).toContain("{{vehicle_make}} is like any other manufacturer");
    // the demo's earlier wording, still live on the first database version
    expect(sameBeatText(beat6.replace("{{vehicle_make}}", "Mazda"), beat6)).toBe(true);
    expect(sameBeatText(beat6, beat6)).toBe(true);
    expect(sameBeatText(beat6.replace("five", "three"), beat6)).toBe(false);
    expect(sameBeatText('"Something else entirely."', beat6)).toBe(false);
    const s = dealershipScript();
    s.beats[5].text = beat6.replace("{{vehicle_make}}", "Mazda");
    expect(validateScript(s, RECAP_BEATS)).toBeNull();
  });

  it("an invalid script fails the call at the start, before a word is said", () => {
    const bad = dealershipScript();
    bad.beats.pop();
    expect(() => getOrCreateCallState(`bad_${Date.now()}`, { ...dealership(), script: bad })).toThrow(/invalid script/);
  });
});

describe("a call on a dealership's content", () => {
  it("opens with the dealership's greeting", () => {
    const sid = `greet_${Date.now()}`;
    resetCallState(sid);
    expect(getOrCreateCallState(sid, dealership()).last_spoken_text).toBe("Hi there! Can you see and hear me okay?");
  });

  it("speaks the dealership's beats, with the deal's vehicle", async () => {
    const d = await processControllerTurn(callAt(9, dealership()), "okay, go on", dealership());
    expect(d.beatId).toBe(10);
    expect(d.textToSpeak).toContain("At Hyundai of Dallas we cover every part of your Hyundai that can break");
  });

  it("uses the dealership's fixed lines", async () => {
    const d = await processControllerTurn(callAt(9, dealership()), "I want to talk to a human", dealership());
    expect(d.textToSpeak).toBe("I'm the finance manager for Hyundai of Dallas, so I can take care of everything for you right here.");
  });

  it("answers from the dealership's knowledge base, and never from the demo's", async () => {
    const cfg = dealership();
    const sid = callAt(12, cfg);
    const r = await withCallContent(contentFor(getOrCreateCallState(sid).dealConfig, RECAP_BEATS), () => answerFromKnowledgeBase("Do I get a loaner car?"));
    expect(r.kind).toBe("answer");
    expect(r.text).toContain("loaner car");
    expect(r.sources).toEqual(["loaner"]);
    const demoFact = await withCallContent(contentFor(cfg, RECAP_BEATS), () => answerFromKnowledgeBase("How much is labor per hour?"));
    expect(demoFact.text).not.toMatch(/130/);
    expect(demoFact.sources).not.toContain("labor");
    // the demo call still knows its own fact
    const demo = await answerFromKnowledgeBase("How much is labor per hour?");
    expect(demo.sources).toContain("labor");
  });

  it("two calls at once each keep their own content", async () => {
    const custom = callAt(9, dealership());
    const demo = callAt(9, { ...DEFAULT_DEAL_CONFIG });
    const [a, b] = await Promise.all([
      processControllerTurn(custom, "I want to talk to a human", dealership()),
      processControllerTurn(demo, "I want to talk to a human", DEFAULT_DEAL_CONFIG),
    ]);
    expect(a.textToSpeak).toContain("Hyundai of Dallas");
    expect(b.textToSpeak).toBe(HANDOFF_LINE);
  });

  it("the demo's Beat 6 and its recap name the deal's make, not always Mazda", () => {
    const cfg = { ...DEFAULT_DEAL_CONFIG, vehicle_make: "Hyundai" };
    expect(renderBeatText(BEATS[5], cfg)).toContain("Hyundai is like any other manufacturer");
    expect(renderBeatText(BEATS[5], DEFAULT_DEAL_CONFIG)).toContain("Mazda is like any other manufacturer");
  });
});
