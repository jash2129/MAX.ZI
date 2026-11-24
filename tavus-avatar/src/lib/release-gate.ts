/**
 * Release gate, scripted suite (PRD "Release gate"): before a draft script, price ladder or knowledge
 * base can be approved, 16 simulated calls run through the REAL controller on the draft's content and
 * are scored by the same scorecard as the AI-persona simulator (call-scorecard.ts, hard checks: never
 * loops, never restarts, fragments are not answers, only approved prices and never under the floor, a
 * no gets a lower price, never confirms after a refusal).
 *
 * The customers are scripted journeys, not an AI: deterministic, about a second, no keys or cost. That
 * makes it a gate on the controller's rules applied to this dealership's content; it does not judge how
 * natural the AI wording sounds (the AI-persona simulator, scripts/sim-batch.ts, does that).
 *
 * Run it with Max's AI switches off (MAX_SPEECH / MAX_UNDERSTANDING / MAX_MODE unset): the result
 * records the mode it ran in.
 */
import { getOrCreateCallState, processControllerTurn, resetCallState } from "./beat-controller";
import { scoreCall, type ScoredTurn } from "./call-scorecard";
import type { DealConfig } from "./deal-config";
import { isFreeAIEnabled } from "./free-ai";
import { isNativeEnabled } from "./native-engine";
import { ladderOf, spokenPrice } from "./price-ladder";

export const SUITE_VERSION = "scripted suite v1";
const MAX_TURNS = 90;

interface Ctx {
  beat: number;
  turn: number;
  /** what Max just said */
  max: string;
  ladder: readonly number[];
  /** how many times this journey has pushed back at the price */
  pushes: number;
}

type Journey = { name: string; say: (c: Ctx) => string };

const cooperative = (c: Ctx): string => {
  if (c.beat === 0) return "Yes, I can hear and see you. It's been great so far.";
  if (c.beat === 23) return "The bumper to bumper warranty and the tire and wheel.";
  if (c.beat >= 25) return "John Smith, 12 Main Street, Dallas, Texas.";
  return "Yes, that makes sense.";
};

/** cooperative, except at the price where `atPrice` decides */
const priceJourney = (name: string, atPrice: (c: Ctx) => string): Journey => ({
  name,
  say: (c) => (c.beat >= 22 && c.beat <= 23 ? atPrice(c) : cooperative(c)),
});

/** cooperative, but at `beat` (once) says `line` first */
const interject = (name: string, beat: number, line: string): Journey => {
  let done = false;
  return {
    name,
    say: (c) => {
      if (!done && c.beat === beat) {
        done = true;
        return line;
      }
      return cooperative(c);
    },
  };
};

export function journeys(): Journey[] {
  return [
    { name: "cooperative", say: cooperative },
    { name: "terse", say: (c) => (c.beat === 0 ? "Yes." : c.beat === 23 ? "Warranty and tires." : c.beat >= 25 ? "John Smith, 12 Main Street, Dallas." : ["Yes.", "Okay.", "Sure."][c.turn % 3]) },
    priceJourney("haggles once, then takes the offer", (c) => (c.pushes === 0 ? "That's too much for me." : "Okay, that works for me.")),
    priceJourney("haggles to the floor, then accepts", (c) => (c.pushes < c.ladder.length - 1 ? "That's still too much." : "Okay, let's do it.")),
    priceJourney("refuses the package", () => "No, I'm not interested in any of it."),
    priceJourney("lowballs, then accepts", (c) => (c.pushes === 0 ? "Can you do one dollar a day?" : "Okay, let's do it.")),
    priceJourney("lowballs, then refuses", (c) => (c.pushes === 0 ? "Can you do one dollar a day?" : "No, I'll keep just the factory warranty.")),
    priceJourney("names the next price", (c) => (c.pushes === 0 && c.ladder.length > 1 ? `How about ${spokenPrice(c.ladder[1])}?` : "Okay, that works.")),
    interject("asks for a human", 5, "Can I talk to a real person?"),
    interject("asks a question", 8, "What does the warranty actually cover?"),
    interject("asks if Max is an AI", 3, "Wait, are you a robot?"),
    interject("asks the price early", 4, "How much is all this going to cost me?"),
    interject("is confused", 12, "I don't understand what you mean."),
    interject("is impatient", 10, "Can we hurry this up please?"),
    interject("says no to a question", 2, "No, I didn't get to drive it."),
    {
      name: "mumbles fragments",
      say: (c) => (c.turn % 4 === 3 && c.beat >= 1 ? ["Oh", "I", "Um"][c.turn % 3] : cooperative(c)),
    },
  ];
}

export interface GateResult {
  calls: number;
  hard_failures: number;
  completion_rate: number;
  price_reached_rate: number;
  source: string;
  mode: string;
  /** per call: name, completed, furthest beat, failed hard checks */
  details: Array<{ journey: string; completed: boolean; furthest_beat: number; hard_failed: string[] }>;
}

function aiMode(): string {
  const on = (k: string) => (process.env[k] ?? "").trim().toLowerCase();
  if (isNativeEnabled()) return "native";
  if (isFreeAIEnabled()) return "free";
  const parts = [on("MAX_UNDERSTANDING") === "ai" ? "ai-understanding" : "", on("MAX_SPEECH") === "ai" ? "ai-speech" : ""].filter(Boolean);
  return parts.length ? parts.join("+") : "scripted";
}

/** Runs the suite on a call config (the draft's content in dealConfig: script, knowledge, price_ladder). */
export async function runReleaseGate(dealConfig: DealConfig): Promise<GateResult> {
  const ladder = ladderOf(dealConfig);
  const details: GateResult["details"] = [];
  let hard = 0;
  let completed = 0;
  let priced = 0;

  for (const [i, j] of journeys().entries()) {
    const sid = `gate_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
    resetCallState(sid);
    const state = getOrCreateCallState(sid, dealConfig);
    const turns: ScoredTurn[] = [];
    let pushes = 0;
    let done = false;
    try {
      for (let t = 0; t < MAX_TURNS && !done; t++) {
        const beat = state.current_beat;
        const said = j.say({ beat, turn: t, max: state.last_spoken_text, ladder, pushes });
        if (beat >= 22 && beat <= 23) pushes++;
        const d = await processControllerTurn(sid, said, dealConfig);
        turns.push({ customer: said, max: d.textToSpeak, beat: d.beatId });
        done = Boolean(d.isScriptComplete || d.state.is_stopped);
      }
    } finally {
      resetCallState(sid);
    }
    const card = scoreCall(turns, ladder);
    const hardFailed = card.checks.filter((c) => c.severity === "hard" && !c.pass).map((c) => c.id);
    if (hardFailed.length) hard++;
    if (card.completed) completed++;
    if (card.reachedPrice) priced++;
    details.push({ journey: j.name, completed: card.completed, furthest_beat: card.furthestBeat, hard_failed: hardFailed });
  }

  const n = details.length;
  const pct = (k: number) => Math.round((k / n) * 1000) / 10;
  return { calls: n, hard_failures: hard, completion_rate: pct(completed), price_reached_rate: pct(priced), source: SUITE_VERSION, mode: aiMode(), details };
}
