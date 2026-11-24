/**
 * The prompt-native engine (switch: MAX_MODE=native, the default in MAX.ZI). One prompt runs the call.
 *
 * The difference from free mode (free-ai.ts): free mode hands the AI the 25-beat script as a plan it
 * must walk through in order, reports which beat it reached, and gives every failed turn to the
 * scripted controller. Here there are no beats at all:
 *  - the PROMPT (persona, goal, guidelines, tone; editable as plain text) decides how the call goes;
 *  - the dealership's approved content is handed over as DATA, appended by code so an edited prompt can
 *    never drop it: talking points (the approved pitch material, in no required order), the approved
 *    facts, the price ladder, and the recording disclosure;
 *  - the AI decides what to cover, in what order, when to talk price, and when to accept a no.
 *
 * Code keeps only the guardrails that are legal or money problems if the AI gets them wrong:
 *  1. the recording disclosure, word for word, before any price (added by code if the AI skips it);
 *  2. prices only from the ladder, the first offer at the top, at most one step down at a time, and
 *     only when the customer pushed back on that turn;
 *  3. no number, figure, make or risky claim (free, guarantee, refund, insurance ...) the approved
 *     content does not contain; never claims to be human;
 *  4. a no is never a yes: no confirmation wording right after a refusal, and "accepted" needs a price
 *     on the table and a customer who did not just refuse;
 *  5. never the same longer sentence twice in one call.
 * A rejected reply gets one retry with the reason. A second rejection, a timeout or an error gets a
 * neutral line (never the script): the disclosure if it is still owed, else a short "tell me more".
 *
 * Pure apart from the fetch: the caller (processNativeTurn in beat-controller.ts) owns the call state.
 */
import { addedRisk, numberTokens } from "./ai-speech";
import { guardFreeText, lowestAllowedPrice, type ChatMessage, type GuardContext, type GuardResult } from "./free-ai";
import { llmTarget, partialJsonString, streamChat, takeLeadSentences } from "./llm-stream";
import { DEFAULT_LADDER, floorOf, spokenDailyRates, spokenPrice } from "./price-ladder";

export const NATIVE_AI_TIMEOUT_MS = Number(process.env.NATIVE_AI_TIMEOUT_MS) || 5000;
const HISTORY_MESSAGES = 40;

/** MAX_MODE=native, or no MAX_MODE at all outside tests (native is MAX.ZI's default engine) */
export function isNativeEnabled(): boolean {
  const mode = (process.env.MAX_MODE ?? "").trim().toLowerCase();
  if (mode) return mode === "native";
  return process.env.NODE_ENV !== "test";
}

// -----------------------------------------------------------------------------
// The prompt (behavior only) and the data (appended by code)
// -----------------------------------------------------------------------------
export const DEFAULT_NATIVE_PROMPT = `# Persona
You are Max, the finance manager at the dealership. You're on a video call with a customer who has just agreed to buy their vehicle. You're warm, relaxed and genuinely curious about them: an experienced F&I manager who has done this a thousand times and never sounds like it.

# Goal
Help the customer decide, with full understanding, whether the dealership's protection package is right for them. A clear, informed "no" is a good outcome too. You are not here to win an argument.

# How a good call goes
- Start human. You already asked "Can you hear and see me alright?". React to their answer, ask how the buying experience has been, and listen.
- Then give the recording disclosure (in the data below) and get their okay before anything about coverage or price.
- Find out what matters to them before you pitch: how long they'll keep the car, how much they drive, what they already know about the factory warranty, whether surprise repair bills worry them.
- Explain only the parts of the package that fit what they told you, one idea at a time, using the talking points and facts. Skip what they already know or don't care about. Never recite a list.
- Bring up the price when they understand the value, or sooner if they ask for it.
- If they push back on the price, you may come down to the next step of the price ladder, one step at a time. If they firmly say no, or no twice, respect it: don't re-pitch, offer the lowest step once at most, then let them keep the factory warranty and wrap up warmly.
- If they say yes, confirm the coverage and the daily price in one sentence, then ask for their full legal name and mailing address for the paperwork.
- End the call when they're done: after the paperwork details, after a final no, if they object to the recording, or if they say goodbye.

# Guidelines
- Answer every question they ask before you go on. If the facts don't cover it, say you don't want to guess and the contract paperwork spells it out.
- Use only the talking points and facts below. Never invent a number, a coverage detail, a refund, cancellation, transfer, insurance, legal or tax answer.
- Never say the same thing twice. If you already explained something, refer back to it in a few words.
- There's no human team to hand off to: you are the finance manager and you take care of everything here.
- If asked, say honestly that you're an AI finance assistant. Never claim to be a person.

# Tone
Conversational and spoken: short sentences, contractions, usually one to three sentences, and end most replies with a question. Calm and confident, never pushy, never salesy filler like "great question" every turn. No lists, markdown, emojis or stage directions. English only.`;

export interface NativeData {
  vehicle: string;
  /** the approved pitch material, each item one talking point (no order is required) */
  talkingPoints: string[];
  /** the approved facts, as plain sentences */
  facts: string;
  /** the recording disclosure, word for word */
  disclosure: string;
  ladder?: readonly number[];
}

export function nativeDataBlock(d: NativeData): string {
  const ladder = d.ladder ?? DEFAULT_LADDER;
  return `# Call data (approved by the dealership; code checks every reply against it)
Vehicle: ${d.vehicle}

Recording disclosure (say it word for word, once, before any coverage or price talk):
"${d.disclosure}"

Price ladder (a daily rate; the first offer is ${spokenPrice(ladder[0])} a day; then, only when they push back, one step at a time: ${ladder.map(spokenPrice).join(", then ")}; never below ${spokenPrice(floorOf(ladder))} a day). Always say a price in words with "a day".

Talking points (approved material; use what fits this customer, in any order, in your own words):
${d.talkingPoints.map((t) => `- ${t}`).join("\n")}

Facts (the only other facts you may use):
${d.facts}`;
}

export const NATIVE_REPLY_FORMAT = `Reply with ONLY JSON:
{"say": "<what Max says now>", "outcome": "open" | "accepted" | "declined", "end_call": false}
"outcome" is "accepted" only once the customer has clearly said yes to a price you offered, "declined" once they have finally turned the package down, else "open".`;

/**
 * Why an edited prompt can't be saved (the portal checks this; empty = fine). The prompt is behavior
 * only: prices, figures and promises come from the approved data, never from the prompt text.
 */
export function nativePromptProblems(prompt: string): string[] {
  const p = prompt.trim();
  const problems: string[] = [];
  if (!p) return ["it is empty"];
  if (p.length > 20000) problems.push("it is longer than 20,000 characters");
  if (/\$\s*\d|\bdollars?\b|\bcents?\b/i.test(p)) problems.push("it names a price (prices come from the price ladder only)");
  // Only the lines written or changed by hand are checked: the built-in prompt itself names risky
  // words in its "never invent a refund, insurance ..." rules
  const builtIn = new Set(DEFAULT_NATIVE_PROMPT.split("\n").map((l) => l.trim()));
  const added = p.split("\n").map((l) => l.trim()).filter((l) => l && !builtIn.has(l)).join("\n");
  const known = new Set(numberTokens(DEFAULT_NATIVE_PROMPT));
  const newNumbers = numberTokens(added).filter((n) => !known.has(n));
  if (newNumbers.length) problems.push(`it adds numbers (${[...new Set(newNumbers)].slice(0, 5).join(", ")}); figures come from the facts and talking points`);
  const risk = added ? addedRisk(added, "") : null;
  if (risk) problems.push(`it ${risk.replace(/^adds /, "adds the claim: ")}; promises come from the approved facts only`);
  return problems;
}

export function buildNativeSystemPrompt(data: NativeData, prompt: string = DEFAULT_NATIVE_PROMPT): string {
  return `${prompt.trim()}\n\n${nativeDataBlock(data)}\n\n${NATIVE_REPLY_FORMAT}`;
}

/** What the app knows about the call, said to the AI after the history (keeps the prefix cacheable) */
export function nativeStateNote(s: { disclosureGiven: boolean; lowestOffered: number | null | undefined; ladder?: readonly number[]; refusals: number }): string {
  const ladder = s.ladder ?? DEFAULT_LADDER;
  const offered = s.lowestOffered ?? null;
  const price =
    offered === null
      ? `no price offered yet (the first offer is ${spokenPrice(ladder[0])} a day)`
      : offered <= floorOf(ladder)
        ? `lowest offered ${spokenPrice(offered)} a day, the floor: no lower price exists`
        : `lowest offered ${spokenPrice(offered)} a day (the next step, only if they push back: ${spokenPrice(lowestAllowedPrice(offered, ladder))} a day)`;
  return `CALL STATE (from the app, not said by anyone): recording disclosure ${s.disclosureGiven ? "given, never repeat it" : "NOT given yet: give it word for word before any coverage or price"}. Price: ${price}. The customer has refused ${s.refusals} time${s.refusals === 1 ? "" : "s"} so far.`;
}

// -----------------------------------------------------------------------------
// Parsing and the guardrails
// -----------------------------------------------------------------------------
export type NativeOutcomeTag = "open" | "accepted" | "declined";
export interface NativeReply {
  say: string;
  outcome: NativeOutcomeTag;
  endCall: boolean;
}

export function parseNativeReply(raw: string): NativeReply | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const p = JSON.parse(json) as { say?: unknown; outcome?: unknown; end_call?: unknown };
      if (typeof p.say !== "string" || !p.say.trim()) return null;
      const outcome: NativeOutcomeTag = p.outcome === "accepted" || p.outcome === "declined" ? p.outcome : "open";
      return { say: p.say.trim().replace(/\s+/g, " "), outcome, endCall: p.end_call === true };
    } catch {
      return null;
    }
  }
  // Plain sentences instead of JSON: Max's words, the call stays open. Never JSON-ish fragments.
  const text = raw.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/\s+/g, " ");
  if (!text || /[{}]|"say"\s*:/.test(text)) return null;
  return { say: text, outcome: "open", endCall: false };
}

const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const saysDisclosureVerbatim = (text: string, disclosure: string) => plain(text).includes(plain(disclosure));

export interface NativeGuardContext {
  /** everything Max may draw on: talking points, facts, vehicle, the greeting */
  corpus: string;
  disclosure: string;
  disclosureGiven: boolean;
  lowestOffered: number | null | undefined;
  ladder: readonly number[];
  /** the customer pushed back on price or refused, this turn */
  pushback: boolean;
  /** the customer refused this turn (a no, "not interested", "keep the factory warranty") */
  refused: boolean;
  /** what the customer has said this call (their own numbers are not invented) */
  customerSaid: string;
  /** every line Max has said this call */
  earlierMax: string[];
}

function freeGuardCtx(ctx: NativeGuardContext): GuardContext {
  return {
    corpus: `${ctx.corpus} ${ctx.disclosure}`,
    // No beats here: prices are allowed once the disclosure has been given (or in this same reply)
    beatBefore: 0,
    lowestOffered: ctx.lowestOffered,
    ladder: ctx.ladder,
    customerSaid: ctx.customerSaid,
    customerRefused: ctx.refused,
    recentMax: ctx.earlierMax.slice(-2),
    earlierMax: ctx.earlierMax,
    repeatable: [ctx.disclosure],
    // refusedPrice stays unset: a no does NOT have to get the next lower price here; the prompt decides
  };
}

export function guardNativeText(t: string, ctx: NativeGuardContext, whole: boolean): GuardResult {
  const disclosedNow = ctx.disclosureGiven || saysDisclosureVerbatim(t, ctx.disclosure);
  // guardFreeText's beat rule: beat 21+ = prices allowed; before the disclosure, never
  const g = guardFreeText(t, freeGuardCtx(ctx), disclosedNow ? 22 : 0, whole);
  const fail = (reason: string): GuardResult => ({ ok: false, reason, prices: g.prices });
  if (!g.ok) return /^price before Beat/.test(g.reason ?? "") ? fail("price before the recording disclosure") : g;
  // A paraphrased disclosure would be said twice once code adds the real one
  if (!ctx.disclosureGiven && !saysDisclosureVerbatim(t, ctx.disclosure) && /\brecord(ed|ing)?\b/i.test(t)) {
    return fail("the recording disclosure must be word for word");
  }
  // The price only comes down when the customer pushed back on this turn
  const current = ctx.lowestOffered;
  if (current !== null && current !== undefined && !ctx.pushback && g.prices.some((p) => p < current)) {
    return fail(`lowered the price to $${Math.min(...g.prices)} a day without the customer pushing back`);
  }
  return g;
}

/**
 * The customer pushed back on the price this turn: a refusal, "too high", "can you do better", or a
 * counter-offer below the lowest price offered (lab 2026-11-23: "That's still high. I'll give you two
 * dollars a day" did not count, and Max was blocked from coming down exactly when he should).
 */
export function isNativePushback(transcript: string, lowestOffered: number | null | undefined, basic: boolean): boolean {
  if (basic) return true;
  const n = transcript.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
  if (/\b(high|higher|steep|pricey|a lot|too much|expensive|better (deal|price|offer)|do better|any better|more reasonable|not reasonable|fairer|more fair|not fair|work with|budget|afford|less|cheaper|lower|discount|best you can|best price|come down|bring it down|out of my range|stretch)\b/.test(n)) return true;
  const named = spokenDailyRates(transcript);
  const current = lowestOffered ?? Infinity;
  return named.some((p) => p < current);
}

/** The AI's outcome, kept honest: "accepted" needs a price offered and no refusal this turn */
export function settleOutcome(reply: NativeReply, ctx: { refused: boolean; priceOffered: boolean }): NativeOutcomeTag {
  if (reply.outcome === "accepted" && (ctx.refused || !ctx.priceOffered)) return "open";
  return reply.outcome;
}

// -----------------------------------------------------------------------------
// Neutral lines: what Max says when the AI could not give a safe reply (never the script)
// -----------------------------------------------------------------------------
export const NEUTRAL_LINES = [
  "Sorry, I want to make sure I get this right for you. Could you tell me a bit more about what you're thinking?",
  "Let me make sure I understood you. What matters most to you here?",
  "Sorry, could you say that one more time for me?",
  "Fair enough. Where are you leaning right now?",
  "I hear you. What would make this feel right for you?",
  "Got it. Tell me what's on your mind and we'll go from there.",
] as const;

export function neutralLine(ctx: { disclosureGiven: boolean; disclosure: string; earlierMax: string[] }): { text: string; isDisclosure: boolean } {
  if (!ctx.disclosureGiven) return { text: `Before we go any further, I want to let you know: ${ctx.disclosure} Is that okay with you?`, isDisclosure: true };
  // The least used this call (a neutral line said again and again is a loop)
  const used = (l: string) => ctx.earlierMax.filter((m) => m.includes(l)).length;
  const text = [...NEUTRAL_LINES].sort((a, b) => used(a) - used(b))[0];
  return { text, isDisclosure: false };
}

// -----------------------------------------------------------------------------
// The call
// -----------------------------------------------------------------------------
export function buildNativeMessages(system: string, history: ChatMessage[], customer: string, note?: string, where?: string): ChatMessage[] {
  return [
    { role: "system", content: system },
    ...history.slice(-HISTORY_MESSAGES),
    ...(where ? [{ role: "system" as const, content: where }] : []),
    { role: "user", content: customer },
    ...(note ? [{ role: "user" as const, content: `[Note to Max, not said by the customer: ${note}]` }] : []),
  ];
}

/** After a price rejection: the one lower price allowed now, or that none is */
function priceHint(reason: string, g: NativeGuardContext): string {
  if (!/price|skipped down/.test(reason)) return "";
  if (g.lowestOffered === null || g.lowestOffered === undefined) return ` The first price you may say is ${spokenPrice(g.ladder[0])} a day.`;
  if (!g.pushback) return ` The customer did not push back on the price: keep ${spokenPrice(g.lowestOffered)} a day.`;
  if (g.lowestOffered <= floorOf(g.ladder)) return ` ${spokenPrice(g.lowestOffered)} a day is the lowest price there is.`;
  return ` If you lower the price now, the ONLY price you may say is ${spokenPrice(lowestAllowedPrice(g.lowestOffered, g.ladder))} a day.`;
}

export type NativeTurnOutcome =
  | { ok: true; reply: NativeReply; prices: number[]; attempts: number; ms: number; retryReason?: string; early?: string }
  | { ok: false; reason: string; attempts: number; ms: number; early?: string };

/** One reply from the AI, guarded; one retry with the reason. Streams the first sentences to `onEarly`. */
export async function runNativeTurn(
  args: { system: string; history: ChatMessage[]; customer: string; guard: NativeGuardContext; where?: string },
  onEarly?: (text: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<NativeTurnOutcome> {
  const t0 = Date.now();
  const target = llmTarget(process.env.NATIVE_AI_MODEL);
  if (!target) return { ok: false, reason: "no AI key", attempts: 0, ms: 0 };
  let note: string | undefined;
  let lastReason = "";
  let early: string | undefined;
  let continuing = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = NATIVE_AI_TIMEOUT_MS - (Date.now() - t0);
    if (remaining < 300) return { ok: false, reason: lastReason ? `${lastReason}; no time to retry` : `timeout ${NATIVE_AI_TIMEOUT_MS}ms`, attempts: attempt - 1, ms: Date.now() - t0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let raw = "";
    try {
      const stream = streamChat(
        { target, temperature: 0.7, maxTokens: 400, json: true, messages: buildNativeMessages(args.system, args.history, args.customer, note, args.where), signal: controller.signal },
        fetchImpl
      );
      for await (const delta of stream) {
        raw += delta;
        if (onEarly && !early) {
          const say = partialJsonString(raw);
          const lead = say ? takeLeadSentences(say.text) : null;
          if (lead && guardNativeText(lead.lead, args.guard, false).ok && !/\brecord/i.test(lead.lead)) {
            early = lead.lead;
            onEarly(early);
          }
        }
      }
    } catch (err) {
      const reason = controller.signal.aborted ? `timeout ${NATIVE_AI_TIMEOUT_MS}ms` : /^http \d+/.test(String((err as Error)?.message)) ? (err as Error).message : "error";
      return { ok: false, reason, attempts: attempt, ms: Date.now() - t0, early };
    } finally {
      clearTimeout(timer);
    }
    let reply = parseNativeReply(raw);
    // A continuation (the retry after a streamed first part): the words already spoken come first
    if (reply && early && continuing && !reply.say.startsWith(early)) reply = { ...reply, say: `${early} ${reply.say}` };
    if (!reply) lastReason = "not valid JSON";
    else {
      const g = guardNativeText(reply.say, args.guard, true);
      if (g.ok && (!early || reply.say.startsWith(early))) {
        return { ok: true, reply, prices: g.prices, attempts: attempt, ms: Date.now() - t0, early, ...(lastReason ? { retryReason: lastReason } : {}) };
      }
      lastReason = `rejected: ${g.ok ? "early part changed" : g.reason}`;
    }
    if (early) {
      // The customer is already hearing the first part: the retry continues right after it
      continuing = true;
      note = `you already said out loud: "${early}". The rest of that reply was not used (${lastReason}). Continue right after those words, following the rules: JSON only, "say" holding only what comes next.${priceHint(lastReason, args.guard)}`;
      continue;
    }
    note = `your last reply was not used (${lastReason}). Reply again, following the rules, as JSON only.${priceHint(lastReason, args.guard)}`;
  }
  return { ok: false, reason: lastReason, attempts: 2, ms: Date.now() - t0, early };
}

