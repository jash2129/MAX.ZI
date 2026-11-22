/**
 * Per-dealership price ladders, through the real controller (rule-based, offline). PRD hard rules,
 * checked on every turn of every negotiation:
 *  - only the dealership's own prices are ever said or shown;
 *  - never below its floor; one step down per push, never skipping a step;
 *  - a refusal is never a yes.
 */
import { describe, expect, it } from "vitest";

import { BEATS, getOrCreateCallState, processControllerTurn, renderBeatText, resetCallState, formatSpeechText, type ControllerDecision } from "./beat-controller";
import { DEFAULT_DEAL_CONFIG, type DealConfig } from "./deal-config";
import { guardFreeText } from "./free-ai";
import { floorDecisionLine, floorPriceLine, unitPriceLine } from "./max-lines";
import { floorOf, spokenDailyRates, spokenPrice, stageOfPrice } from "./price-ladder";

const LADDERS: number[][] = [
  [5, 4.5, 4],
  [6, 5],
  [7],
  [9.99, 8.49, 7.25, 6, 5.5],
  [4, 3.5, 3.25, 3], // the demo's, given explicitly
];

const config = (ladder: number[]): DealConfig => ({ ...DEFAULT_DEAL_CONFIG, price_ladder: ladder });

function atPrice(ladder: number[]) {
  const sid = `ladder_${Math.random().toString(36).slice(2)}`;
  resetCallState(sid);
  const st = getOrCreateCallState(sid, config(ladder));
  st.step0_completed = true;
  st.current_beat = 22;
  st.delivered_beats = Array.from({ length: 22 }, (_, i) => i + 1);
  st.last_spoken_text = renderBeatText(BEATS.find((b) => b.id === 22)!, st.dealConfig, st);
  return sid;
}

/**
 * The hard rules, on one turn. `lowest` is the lowest price offered before it.
 * `lowballToFloor`: a customer offer under the floor gets the floor at once. That is the demo's existing
 * TXM-approved behavior (client-scenarios.test.ts "$2 push"), and the only exception to one step at a time.
 */
function checkTurn(ladder: number[], d: ControllerDecision, lowest: number, lowballToFloor = false): number {
  const said = spokenDailyRates(d.textToSpeak);
  const shown = d.toolCalls.filter((c) => c.name === "show_payment_breakdown").map((c) => Number(c.args.daily_rate));
  for (const p of [...said, ...shown]) {
    expect(stageOfPrice(ladder, p), `price ${p} not on ladder ${ladder} in: ${d.textToSpeak}`).toBeGreaterThan(0);
    expect(p, `under the floor: ${d.textToSpeak}`).toBeGreaterThanOrEqual(floorOf(ladder));
  }
  const newLowest = Math.min(lowest, ...said, ...shown);
  if (newLowest < lowest && !(lowballToFloor && newLowest === floorOf(ladder))) {
    // one step at a time
    expect(stageOfPrice(ladder, newLowest) - stageOfPrice(ladder, lowest), `skipped a step: ${lowest} -> ${newLowest}`).toBeLessThanOrEqual(1);
  }
  // the panel and the voice never disagree
  if (shown.length && said.length) expect(said).toContain(shown[shown.length - 1]);
  return newLowest;
}

async function play(ladder: number[], lines: string[], lowballToFloor = false) {
  const sid = atPrice(ladder);
  let lowest = ladder[0];
  const out: ControllerDecision[] = [];
  for (const line of lines) {
    const d = await processControllerTurn(sid, line, config(ladder));
    lowest = checkTurn(ladder, d, lowest, lowballToFloor);
    out.push({ ...d, state: { ...d.state, dealConfig: { ...d.state.dealConfig } } });
  }
  return out;
}

describe.each(LADDERS)("ladder %j", (...ladder) => {
  const floor = floorOf(ladder);

  it("Beat 22 opens at the dealership's own price", () => {
    const sid = atPrice(ladder);
    const st = getOrCreateCallState(sid);
    expect(st.dealConfig.per_day_price).toBe(spokenPrice(ladder[0]));
    expect(formatSpeechText(st.last_spoken_text)).toContain(`${spokenPrice(ladder[0])} a day`);
  });

  it("each push is one step down, then the floor choice, then a decline keeps the factory warranty", async () => {
    const pushes = Array(ladder.length + 1).fill("That's still too much for me.");
    const turns = await play(ladder, pushes);
    // steps 2..n, one per push
    for (let i = 1; i < ladder.length; i++) {
      expect(spokenDailyRates(turns[i - 1].textToSpeak), `push ${i}`).toContain(ladder[i]);
    }
    const choice = turns[ladder.length - 1];
    expect(choice.textToSpeak).toBe(floorDecisionLine(floor));
    const last = turns[ladder.length];
    expect(last.state.package_declined).toBe(true);
    expect(last.textToSpeak).not.toMatch(/so to confirm|moving forward with/i);
  });

  it("a lowball under the floor goes to the floor at once, never below it", async () => {
    const [t] = await play(ladder, ["Can you do one dollar a day?"], true);
    if (ladder.length > 1) expect(t.textToSpeak).toBe(floorPriceLine(floor));
    else expect(t.textToSpeak).toBe(floorDecisionLine(floor));
  });

  it("naming the price Max is offering accepts it at that price", async () => {
    if (ladder.length < 2) return;
    const turns = await play(ladder, ["That's too much.", `Okay, ${spokenPrice(ladder[1])} works for me.`]);
    // Beat 24 confirms it; when that step was the floor ("Are you ready to finalize at ...?") the yes
    // already confirmed it and the call moves on to Beat 25
    expect(turns[1].beatId).toBeGreaterThanOrEqual(24);
    expect(turns[1].state.package_declined).toBeFalsy();
    expect(turns[1].state.dealConfig.per_day_price).toBe(spokenPrice(ladder[1]));
    if (turns[1].beatId === 24) expect(turns[1].textToSpeak).toContain(`${spokenPrice(ladder[1])} a day`);
  });

  it("a refusal that names a price is never an acceptance", async () => {
    const turns = await play(ladder, [`No, I'm not paying ${spokenPrice(ladder[0])} a day for any of it.`]);
    expect(turns[0].beatId).not.toBe(24);
    expect(turns[0].textToSpeak).not.toMatch(/so to confirm|moving forward with/i);
  });

  it("'per day or per month?' quotes the current offer", async () => {
    const [t] = await play(ladder, ["Is that per day or per month?"]);
    expect(t.textToSpeak).toBe(unitPriceLine(ladder[0]));
  });
});

describe("free AI guard on a dealership ladder", () => {
  const ladder = [5, 4.5, 4];
  const ctx = (lowestOffered: number | null, refusedPrice = false) => ({ corpus: "", beatBefore: 23, lowestOffered, refusedPrice, ladder });

  it("rejects the demo's prices and anything off the ladder", () => {
    expect(guardFreeText("I can do three dollars a day.", ctx(5), 23, true).ok).toBe(false);
    expect(guardFreeText("How about four dollars and seventy-five cents a day?", ctx(5), 23, true).reason).toMatch(/unapproved price/);
  });

  it("one step at a time, from this ladder", () => {
    expect(guardFreeText("I can bring that down to four dollars and fifty cents a day.", ctx(5, true), 23, true).ok).toBe(true);
    expect(guardFreeText("I can do four dollars a day.", ctx(5, true), 23, true).reason).toMatch(/skipped down/);
  });

  it("a no above the floor must get the next lower price", () => {
    expect(guardFreeText("I understand. Let's talk about the coverage.", ctx(4.5, true), 23, true).reason).toMatch(/next lower price, \$4 a day/);
  });
});

it("an invalid ladder fails the call at the start, before any price is said", () => {
  expect(() => getOrCreateCallState(`bad_${Date.now()}`, config([3, 4]))).toThrow(/invalid price ladder/);
});

it("figures in speech are said in words at any price", () => {
  expect(formatSpeechText("Only $4.50 a day, or $9.99.")).toBe("Only four dollars and fifty cents a day, or nine dollars and ninety-nine cents.");
  expect(formatSpeechText("An engine is $7,000.")).toBe("An engine is $7,000.");
});
