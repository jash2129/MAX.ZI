/**
 * Free AI, "Option D" (switch: MAX_MODE=free). The AI runs the whole call.
 *
 * The AI gets the full approved script (all 25 beats, rendered for this deal), the approved knowledge
 * base, and the price rules, plus the conversation so far, and decides on its own what Max says next
 * and where the call is. There is no beat state machine choosing lines. Each reply comes back as JSON:
 * what Max says, the furthest script beat now delivered, and whether the call ends or the package was
 * declined.
 *
 * What is still enforced in code, because one wrong sentence here is a legal or money problem:
 *  - prices: only the dealership's ladder (the demo's is $4 / $3.50 / $3.25 / $3 a day), never under its
 *    floor, only from the price beats on, and never more than one step below the lowest already offered;
 *  - no number, make, or risky claim (free, guarantee, refund, insurance ...) the script and the
 *    knowledge base do not contain, and never claims to be human;
 *  - the recording disclosure: the call cannot pass Beat 1 until it has been said, and it is added
 *    word for word if the AI moves past it without it (done by the caller, see beat-controller.ts).
 * A rejected reply gets one retry with the reason; a second rejection, a timeout or an error hands
 * this one turn to the scripted beat controller, so the customer always hears an approved line.
 *
 * Pure apart from the fetch: the caller (processControllerTurn in beat-controller.ts) passes the
 * script, the facts and the call so far.
 */
import { addedRisk, numberTokens } from "./ai-speech";
import { llmTarget, partialJsonString, streamChat, takeLeadSentences } from "./llm-stream";
import { DEFAULT_LADDER, floorOf, spokenDailyRates, spokenPrice, stageOfPrice } from "./price-ladder";

export const FREE_AI_TIMEOUT_MS = Number(process.env.FREE_AI_TIMEOUT_MS) || 4000;
/** The demo ladder; a call's own ladder comes from its dealConfig (price-ladder.ts) */
export const PRICE_LADDER = DEFAULT_LADDER;
export const PRICE_BEAT = 22;
export const LAST_BEAT = 25;
const MAX_WORDS = 220;
const HISTORY_MESSAGES = 40;

/**
 * Free mode only with MAX_MODE=free. (MAX.ZI's default is the prompt-native engine, native-engine.ts;
 * MAX_MODE=script runs the scripted controller.) Without an AI key every turn falls to the script.
 */
export function isFreeAIEnabled(): boolean {
  const mode = (process.env.MAX_MODE ?? "").trim().toLowerCase();
  // MAX.ZI: the prompt-native engine is the default (native-engine.ts); free mode only when asked for
  return mode === "free";
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface FreeReply {
  say: string;
  beat: number;
  endCall: boolean;
  declined: boolean;
}

// -----------------------------------------------------------------------------
// The prompt
// -----------------------------------------------------------------------------
export interface FreeScript {
  /** "Beat N: <text>" for every beat, rendered for this deal */
  beats: Array<{ id: number; text: string }>;
  /** the approved facts, as plain sentences */
  facts: string;
  vehicle: string;
  /** the recording disclosure, word for word (Beat 1) */
  disclosure: string;
  /** the dealership's daily-rate ladder, highest first (default: the demo's) */
  ladder?: readonly number[];
}

/**
 * The prompt is a TEMPLATE, editable as text (the prompt lab, scripts/prompt-lab.ts; later per dealership).
 * Placeholders, filled from the call's approved content:
 *   {{vehicle}} {{script}} {{facts}} {{disclosure}} {{first_price}} {{price_steps}} {{floor}}
 * The reply format (JSON) is NOT part of the template: it is always appended by code, so editing the
 * prompt can change how Max behaves but never break how the reply is read. The guards below apply
 * whatever the prompt says.
 */
export const FREE_PROMPT_PLACEHOLDERS = ["vehicle", "script", "facts", "disclosure", "first_price", "price_steps", "floor"] as const;

export const DEFAULT_FREE_PROMPT = `You are Max, a warm, friendly finance manager at the dealership, on a video call with a customer who just bought a {{vehicle}}. You run this whole call yourself, in your own words, like a real person who listens.

THE SCRIPT (approved by the dealership; this is your plan and your facts, in order):
{{script}}

APPROVED FACTS (the only other facts you may use):
{{facts}}

HOW TO RUN THE CALL
1. You already said "Can you hear and see me alright?". Have a short, friendly chat (ask how their experience has been), then give the recording disclosure. Say this sentence word for word: "{{disclosure}}" and get their okay before anything else. If they object to being recorded, thank them and end the call.
2. Go through the script beats in order. Cover every point, in your own natural words, a beat or two per reply. React to what the customer actually says. Skip a question they already answered. Answer their questions, then come back to where you were.
3. PRICE: never talk about price or cost before Beat 22, even if asked ("I'll get to that in just a moment"). At Beat 22 the price is {{first_price}} a day. Lower it only when the customer pushes back, one step at a time: {{price_steps}} a day. Never below {{floor}}. Always say prices in words with "a day". At {{floor}}, give them the choice: go ahead at {{floor}} a day, or keep just the factory warranty. A refusal is never a yes; only confirm the package when they clearly say yes.
4. FACTS: only from THE SCRIPT and APPROVED FACTS. Never invent a number, coverage detail, refund, cancellation, transfer, insurance, legal or tax answer. If you don't know, say you don't want to guess and the contract paperwork spells it out, then carry on.
5. There is no human team to hand off to. If they ask for a person or a manager, you are the finance manager and you'll take care of everything right here. Never stop the call because of a question.
6. If asked whether you are an AI, say honestly you're an AI finance assistant. Never claim to be human.
7. End the call only if they object to the recording, say goodbye or want to hang up, or after Beat 25 is done.
8. Speak naturally: short sentences, contractions, usually 1 to 4 sentences; longer only when explaining a beat. No lists, markdown, emojis or stage directions. English only.`;

export const FREE_REPLY_FORMAT = `Reply with ONLY JSON:
{"say": "<what Max says now>", "beat": <the furthest script beat you have now delivered, 0 before the disclosure>, "end_call": false, "declined": false}
"declined" is true only when the customer has finally turned the package down.`;

/** Placeholders in a template that are not known (typos), and known ones it leaves out */
export function checkFreePromptTemplate(template: string): { unknown: string[]; missing: string[] } {
  const used = [...template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
  const known = new Set<string>(FREE_PROMPT_PLACEHOLDERS);
  return {
    unknown: [...new Set(used.filter((u) => !known.has(u)))],
    missing: FREE_PROMPT_PLACEHOLDERS.filter((k) => !used.includes(k)),
  };
}

export function buildFreeSystemPrompt(script: FreeScript, template: string = DEFAULT_FREE_PROMPT): string {
  const ladder = script.ladder ?? DEFAULT_LADDER;
  const values: Record<string, string> = {
    vehicle: script.vehicle,
    script: script.beats.map((b) => `Beat ${b.id}: ${b.text}`).join("\n"),
    facts: script.facts,
    disclosure: script.disclosure,
    first_price: spokenPrice(ladder[0]),
    price_steps: ladder.map(spokenPrice).join(", then "),
    floor: spokenPrice(floorOf(ladder)),
  };
  const body = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, k: string) => values[k] ?? all);
  return `${body.trim()}\n\n${FREE_REPLY_FORMAT}`;
}

/** Where the call is, from the app's own records (the AI does not have to work it out from the chat) */
export function callStateNote(s: { beat: number; disclosureGiven: boolean; lowestOffered: number | null | undefined }): string {
  const price = s.lowestOffered === null || s.lowestOffered === undefined ? "none yet" : `$${s.lowestOffered} a day`;
  return `CALL STATE (from the app, not said by anyone): furthest script beat delivered: ${s.beat}${s.beat < LAST_BEAT ? ` (next: Beat ${s.beat + 1})` : " (script done)"}. Recording disclosure already given: ${s.disclosureGiven ? "yes, never repeat it" : "no"}. Lowest price offered so far: ${price}.`;
}

export function buildFreeMessages(system: string, history: ChatMessage[], customer: string, note?: string, where?: string): ChatMessage[] {
  return [
    { role: "system", content: system },
    ...history.slice(-HISTORY_MESSAGES),
    // After the history, so the unchanging system prompt and history stay a cacheable prefix
    ...(where ? [{ role: "system" as const, content: where }] : []),
    { role: "user", content: customer },
    ...(note ? [{ role: "user" as const, content: `[Note to Max, not said by the customer: ${note}]` }] : []),
  ];
}

// -----------------------------------------------------------------------------
// Parsing and the guards
// -----------------------------------------------------------------------------
export function parseFreeReply(raw: string): FreeReply | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const p = JSON.parse(json) as { say?: unknown; beat?: unknown; end_call?: unknown; declined?: unknown };
    if (typeof p.say !== "string" || !p.say.trim()) return null;
    const beat = typeof p.beat === "number" && Number.isFinite(p.beat) ? Math.max(0, Math.min(LAST_BEAT, Math.round(p.beat))) : NaN;
    if (Number.isNaN(beat)) return null;
    return { say: p.say.trim().replace(/\s+/g, " "), beat, endCall: p.end_call === true, declined: p.declined === true };
  } catch {
    return null;
  }
}

/**
 * The reply, or, when the AI answered in plain sentences instead of JSON (it copies the plain lines
 * in the history), those sentences as Max's words with the call staying where it is. Never JSON-ish
 * fragments or empty text.
 */
export function parseFreeReplyOrText(raw: string, beatBefore: number): FreeReply | null {
  const parsed = parseFreeReply(raw);
  if (parsed) return parsed;
  const text = raw.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/\s+/g, " ");
  if (!text || /[{}]|"say"\s*:/.test(text)) return null;
  return { say: text, beat: beatBefore, endCall: false, declined: false };
}

/** Every daily price said ("three dollars and fifty cents a day", "$3.25 per day"), in order */
export function dailyPrices(text: string): number[] {
  return spokenDailyRates(text);
}

/** The lowest price the AI may say now: the opening price first, then one step below the lowest offered */
export function lowestAllowedPrice(lowestOffered: number | null | undefined, ladder: readonly number[] = DEFAULT_LADDER): number {
  if (lowestOffered === null || lowestOffered === undefined) return ladder[0];
  const i = stageOfPrice(ladder, lowestOffered) - 1;
  return ladder[Math.min(ladder.length - 1, (i < 0 ? 0 : i) + 1)];
}

const UNIT = /^(years?|months?|miles?|days?|hours?|percent|degrees?|dollars?|cents?|times?)$/;
const NUM_WORD = /^(\d[\d.,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)$/;
/** "<number> <unit>" pairs, singular units ("ten years" -> "ten year", "100,000 miles" -> "100000 mile") */
export function numberWithUnit(text: string): string[] {
  const w = text.toLowerCase().replace(/[^a-z0-9.,% ]/g, " ").replace(/%/g, " percent").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < w.length - 1; i++) {
    const n = w[i].replace(/[.,]+$/, "");
    const u = w[i + 1].replace(/[.,]+$/, "");
    if (NUM_WORD.test(n) && UNIT.test(u)) out.push(`${n.replace(/,/g, "")} ${u.replace(/s$/, "")}`);
  }
  return out;
}

export interface GuardContext {
  /** everything Max may draw on: the script and the facts */
  corpus: string;
  /** the furthest beat delivered before this turn */
  beatBefore: number;
  lowestOffered: number | null | undefined;
  /** the customer just refused or pushed back on the price (at the price beats) */
  refusedPrice?: boolean;
  /** what the customer has said this call: their own numbers (an address, a year) are not invented */
  customerSaid?: string;
  /** Max's last two lines: saying one of them again word for word is a loop */
  recentMax?: string[];
  /** every line Max has said this call: repeating any longer sentence from them is a loop */
  earlierMax?: string[];
  /** the customer just said a plain no ("no", "not interested"), at any beat */
  customerRefused?: boolean;
  /** sentences that may be said again word for word (the recording disclosure) */
  repeatable?: string[];
  /** the dealership's ladder (default: the demo's) */
  ladder?: readonly number[];
  /** no price ladder (the native engine with that guardrail off): amounts are checked as numbers only */
  noLadder?: boolean;
}

const REPEAT_MIN_WORDS = 8;
const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
/** Wording that confirms the package or treats the customer as having agreed */
const CONFIRMS = /\b(moving forward with|so to confirm|to confirm,? we|let'?s get (you|that|it|this) (set up|added|started|signed|going)|glad (you'?re|to have you) on board|welcome aboard|(great|smart|good|excellent|wise) (choice|decision)|i'?ll (go ahead and )?(add|get|set up|include) (that|it|the package|the coverage|this)|we'?ll get (that|it|you|this) (added|set up|started)|go ahead and (add|include|set up|lock in)|you'?re all set with|you'?re covered now)\b/i;

const loopKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

export interface GuardResult {
  ok: boolean;
  reason?: string;
  prices: number[];
}

export function guardFreeReply(reply: FreeReply, ctx: GuardContext): GuardResult {
  return guardFreeText(reply.say, ctx, Math.max(ctx.beatBefore, reply.beat), true);
}

/**
 * The guards on Max's words. `whole` = the complete reply; without it (the first sentences, while the
 * rest is still being written) only the "says nothing it must not" checks run: the checks that need the
 * whole reply (length, repeats, "a no gets the next lower price") wait for it.
 */
export function guardFreeText(t: string, ctx: GuardContext, beat: number, whole: boolean): GuardResult {
  const prices = dailyPrices(t);
  const ladder = ctx.ladder ?? DEFAULT_LADDER;
  const fail = (reason: string): GuardResult => ({ ok: false, reason, prices });
  if (/[*#_`{}<>\[\]]|\n\s*[-•]/.test(t)) return fail("formatting");
  const words = t.split(/\s+/).filter(Boolean).length;
  if (whole && words > MAX_WORDS) return fail(`too long (${words} words)`);
  if (/\b(json|system prompt|my instructions|the script says|as an ai language model)\b/i.test(t)) return fail("talks about its instructions");

  // Prices: approved steps only, only from the price beats, one step at a time
  if (prices.length && !ctx.noLadder) {
    if (beat < PRICE_BEAT - 1) return fail(`price before Beat ${PRICE_BEAT}`);
    const floor = lowestAllowedPrice(ctx.lowestOffered, ladder);
    for (const p of prices) {
      if (stageOfPrice(ladder, p) === 0) return fail(`unapproved price $${p}`);
      if (p < floor) return fail(`skipped down to $${p} (lowest allowed now $${floor})`);
    }
  }

  // A no is never a yes, at any beat (simulated batch 2026-11-21: "No" at Beat 23 got "so to confirm,
  // we're moving forward with ..."; prompt lab 2026-11-23: 10 of 24 calls treated a no as a yes)
  if ((ctx.refusedPrice || ctx.customerRefused) && CONFIRMS.test(t)) return fail("confirmed the package right after a refusal");
  // ... and above the floor a no at the price gets the next lower price
  if (ctx.refusedPrice) {
    const current = ctx.lowestOffered ?? ladder[0];
    if (whole && current > floorOf(ladder) && !prices.some((p) => p < current)) {
      return fail(`a no at $${current} a day must get the next lower price, $${lowestAllowedPrice(current, ladder)} a day`);
    }
  }

  // Never the same line again word for word (simulated batch 2026-11-21: three loops)
  const key = loopKey(t);
  if (whole && key.length > 20 && (ctx.recentMax ?? []).some((m) => loopKey(m) === key)) return fail("repeats what Max just said");
  // ... nor any longer sentence already said this call (prompt lab 2026-11-23: one line said five times)
  if (whole && ctx.earlierMax?.length) {
    const longKey = (x: string) => {
      const k = loopKey(x);
      return k.split(" ").length >= REPEAT_MIN_WORDS ? k : "";
    };
    const said = new Set(ctx.earlierMax.flatMap(sentencesOf).map(longKey).filter(Boolean));
    const allowed = new Set((ctx.repeatable ?? []).flatMap(sentencesOf).map(loopKey));
    const again = sentencesOf(t).find((x) => said.has(longKey(x)) && !allowed.has(loopKey(x)));
    if (again) return fail(`repeats a sentence Max already said: "${again.slice(0, 60)}"`);
  }

  // Numbers and claims the script and facts do not make (the customer's own numbers are fine)
  const allowed = new Set(numberTokens(`${ctx.corpus} ${ctx.customerSaid ?? ""} ${ladder.map(spokenPrice).join(" ")}`));
  for (const n of numberTokens(t)) if (!allowed.has(n)) return fail(`new number "${n}"`);
  // A number with its unit must appear with that unit somewhere approved: "twelve" may be in the
  // script, "twelve years" is not
  const corpusUnits = new Set(numberWithUnit(`${ctx.corpus} ${ctx.customerSaid ?? ""}`));
  for (const p of numberWithUnit(t)) if (!corpusUnits.has(p) && !/ (dollar|cent)$/.test(p)) return fail(`new figure "${p}"`);
  // The ladder's prices are approved text too ("four dollars and fifty cents" may not be in the script)
  const risk = addedRisk(t, `${ctx.corpus} ${ctx.customerSaid ?? ""} ${ladder.map(spokenPrice).join(" ")}`);
  if (risk) return fail(risk);
  return { ok: true, prices };
}

// -----------------------------------------------------------------------------
// The call
// -----------------------------------------------------------------------------
export type FreeOutcome =
  | { ok: true; reply: FreeReply; prices: number[]; attempts: number; ms: number; retryReason?: string; early?: string }
  | { ok: false; reason: string; attempts: number; ms: number; early?: string };

/**
 * Ask the AI for Max's next reply; one retry with the reason if a guard rejects it. Streams: `onEarly`
 * gets the first sentences of "say" once they pass the guards that can run on part of a reply. Once
 * something was spoken there is no retry: a rejected whole reply goes to the script, after that part.
 */
export async function runFreeTurn(
  args: { system: string; history: ChatMessage[]; customer: string; guard: GuardContext; where?: string },
  onEarly?: (text: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<FreeOutcome> {
  const t0 = Date.now();
  const target = llmTarget(process.env.FREE_AI_MODEL);
  if (!target) return { ok: false, reason: "no AI key", attempts: 0, ms: 0 };

  let note: string | undefined;
  let lastReason = "";
  let early: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = FREE_AI_TIMEOUT_MS - (Date.now() - t0);
    if (remaining < 300) return { ok: false, reason: lastReason ? `${lastReason}; no time to retry` : `timeout ${FREE_AI_TIMEOUT_MS}ms`, attempts: attempt - 1, ms: Date.now() - t0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let raw = "";
    try {
      const stream = streamChat(
        {
          target,
          temperature: 0.6,
          maxTokens: 450,
          // JSON mode: the reply is the JSON object, not sentences copied from the history's style
          json: true,
          messages: buildFreeMessages(args.system, args.history, args.customer, note, args.where),
          signal: controller.signal,
        },
        fetchImpl
      );
      for await (const delta of stream) {
        raw += delta;
        if (onEarly && !early) {
          const say = partialJsonString(raw);
          const lead = say ? takeLeadSentences(say.text) : null;
          if (lead && guardFreeText(lead.lead, args.guard, args.guard.beatBefore, false).ok) {
            early = lead.lead;
            onEarly(early);
          }
        }
      }
    } catch (err) {
      const reason = controller.signal.aborted ? `timeout ${FREE_AI_TIMEOUT_MS}ms` : /^http \d+/.test(String((err as Error)?.message)) ? (err as Error).message : "error";
      return { ok: false, reason, attempts: attempt, ms: Date.now() - t0, early };
    } finally {
      clearTimeout(timer);
    }
    const reply = parseFreeReplyOrText(raw, args.guard.beatBefore);
    if (!reply) {
      lastReason = "not valid JSON";
    } else {
      const g = guardFreeReply(reply, args.guard);
      if (g.ok && (!early || reply.say.startsWith(early))) {
        return { ok: true, reply, prices: g.prices, attempts: attempt, ms: Date.now() - t0, early, ...(lastReason ? { retryReason: lastReason } : {}) };
      }
      lastReason = `rejected: ${g.ok ? "early part changed" : g.reason}`;
    }
    // Part of this reply was already spoken: no second attempt, the script carries on after it
    if (early) return { ok: false, reason: lastReason, attempts: attempt, ms: Date.now() - t0, early };
    note = `your last reply was not used (${lastReason}). Reply again, following the rules, as JSON only.`;
  }
  return { ok: false, reason: lastReason, attempts: 2, ms: Date.now() - t0 };
}
