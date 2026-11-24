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
import { guardFreeText, lowestAllowedPrice, numberWithUnit, type ChatMessage, type GuardContext, type GuardResult } from "./free-ai";
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
- Start human. You already greeted them (the first line of the conversation). React to their answer, ask how the buying experience has been, and listen.
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


// -----------------------------------------------------------------------------
// The agent: what a dealership configures on the portal's Agent page (stored with the script version)
// -----------------------------------------------------------------------------
export interface AgentDoc {
  title: string;
  text: string;
}
export interface AgentConfig {
  /** free-form background Max should know (the dealership, the offer, the situation) */
  context?: string;
  /** Max's first line, spoken word for word (empty = "Can you hear and see me alright?") */
  greeting?: string;
  /** knowledge documents, pasted or uploaded as text */
  docs?: AgentDoc[];
  guardrails?: {
    /** prices only from the price ladder, one step at a time after pushback (default on) */
    price_ladder?: boolean;
    /** the recording disclosure, word for word, before any price (default on) */
    disclosure?: boolean;
    /** the script's beats 2-21 as talking points (default on) */
    script_talking_points?: boolean;
  };
}

export const AGENT_LIMITS = { greeting: 300, context: 50_000, docs: 30, docTitle: 120, docText: 100_000, docsTotal: 300_000 } as const;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");

/** The agent settings in a stored or submitted shape, tidied: trimmed text, empty documents dropped */
export function normalizeAgent(raw: unknown): AgentConfig {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const g = (a.guardrails && typeof a.guardrails === "object" ? a.guardrails : {}) as Record<string, unknown>;
  const docs = (Array.isArray(a.docs) ? a.docs : [])
    .map((d) => ({ title: clean((d as AgentDoc)?.title), text: clean((d as AgentDoc)?.text) }))
    .filter((d) => d.title || d.text);
  const out: AgentConfig = {};
  if (clean(a.context)) out.context = clean(a.context);
  if (clean(a.greeting)) out.greeting = clean(a.greeting);
  if (docs.length) out.docs = docs;
  const guardrails: NonNullable<AgentConfig["guardrails"]> = {};
  for (const k of ["price_ladder", "disclosure", "script_talking_points"] as const) if (typeof g[k] === "boolean") guardrails[k] = g[k] as boolean;
  if (Object.keys(guardrails).length) out.guardrails = guardrails;
  return out;
}

/** The settings a call runs with (defaults filled in) */
export function agentSettings(raw: unknown) {
  const a = normalizeAgent(raw);
  return {
    context: a.context ?? "",
    greeting: a.greeting ?? "",
    docs: a.docs ?? [],
    priceLadder: a.guardrails?.price_ladder !== false,
    disclosure: a.guardrails?.disclosure !== false,
    scriptTalkingPoints: a.guardrails?.script_talking_points !== false,
  };
}

/** Why agent settings can't be saved (empty = fine). Context and documents are approved content. */
export function agentProblems(raw: unknown): string[] {
  const a = normalizeAgent(raw);
  const problems: string[] = [];
  const greeting = a.greeting ?? "";
  if (greeting.length > AGENT_LIMITS.greeting) problems.push(`the greeting is longer than ${AGENT_LIMITS.greeting} characters`);
  if (/\$\s*\d|\bdollars?\b|\bcents?\b/i.test(greeting)) problems.push("the greeting names a price (it is said word for word, before any check)");
  // Risky claims only: naming the dealership's own brand in a greeting is normal
  const risk = greeting ? addedRisk(greeting, "") : null;
  if (risk && !/^names /.test(risk)) problems.push(`the greeting ${risk.replace(/^adds /, "adds the claim: ")}`);
  if ((a.context ?? "").length > AGENT_LIMITS.context) problems.push(`the context is longer than ${AGENT_LIMITS.context.toLocaleString("en-US")} characters`);
  const docs = a.docs ?? [];
  if (docs.length > AGENT_LIMITS.docs) problems.push(`more than ${AGENT_LIMITS.docs} documents`);
  docs.forEach((d, i) => {
    const name = d.title || `document ${i + 1}`;
    if (!d.title) problems.push(`${name} needs a title`);
    else if (d.title.length > AGENT_LIMITS.docTitle) problems.push(`the title of "${name.slice(0, 40)}" is longer than ${AGENT_LIMITS.docTitle} characters`);
    if (!d.text) problems.push(`"${name}" is empty`);
    else if (d.text.length > AGENT_LIMITS.docText) problems.push(`"${name}" is longer than ${AGENT_LIMITS.docText.toLocaleString("en-US")} characters`);
  });
  const total = docs.reduce((n, d) => n + d.text.length, 0);
  if (total > AGENT_LIMITS.docsTotal) problems.push(`the documents add up to more than ${AGENT_LIMITS.docsTotal.toLocaleString("en-US")} characters`);
  return problems;
}

/** All the agent's own approved text: Max may use its numbers and wording */
export function agentText(a: ReturnType<typeof agentSettings>): string {
  return [a.context, a.greeting, ...a.docs.map((d) => `${d.title} ${d.text}`)].filter(Boolean).join(" ");
}

export interface NativeData {
  vehicle: string;
  /** the approved pitch material, each item one talking point (no order is required) */
  talkingPoints: string[];
  /** the approved facts, as plain sentences */
  facts: string;
  /** the recording disclosure, word for word */
  disclosure: string;
  ladder?: readonly number[];
  /** the agent's context and documents (portal Agent page) */
  context?: string;
  docs?: AgentDoc[];
  /** guardrail switches (default on) */
  priceLadder?: boolean;
  disclosureOn?: boolean;
}

export function nativeDataBlock(d: NativeData): string {
  const ladder = d.ladder ?? DEFAULT_LADDER;
  const parts = [`# Call data (approved by the dealership; code checks every reply against it)\nVehicle: ${d.vehicle}`];
  if (d.context) parts.push(`Context:\n${d.context}`);
  if (d.disclosureOn !== false) parts.push(`Recording disclosure (say it word for word, once, before any coverage or price talk):\n"${d.disclosure}"`);
  if (d.priceLadder !== false && ladder.length) {
    parts.push(
      `Price ladder (a daily rate; the first offer is ${spokenPrice(ladder[0])} a day; then, only when they push back, one step at a time: ${ladder.map(spokenPrice).join(", then ")}; never below ${spokenPrice(floorOf(ladder))} a day). Always say a price in words with "a day".`
    );
  } else parts.push("Prices: say only prices and amounts written in the context, documents or facts, exactly as written.");
  if (d.talkingPoints.length) parts.push(`Talking points (approved material; use what fits this customer, in any order, in your own words):\n${d.talkingPoints.map((t) => `- ${t}`).join("\n")}`);
  for (const doc of d.docs ?? []) parts.push(`Document: ${doc.title}\n${doc.text}`);
  parts.push(`Facts (the only other facts you may use):\n${d.facts}`);
  return parts.join("\n\n");
}

export const NATIVE_REPLY_FORMAT = `Reply with ONLY JSON:
{"say": "<what Max says now>", "outcome": "open" | "accepted" | "declined", "end_call": false}
"outcome" is "accepted" only once the customer has clearly said yes to your offer, "declined" once they have finally turned it down, else "open".`;

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
  // Line by line: a prompt TALKS about prices, refunds or its own instructions ("give the price when
  // asked", "never promise a refund"); only a line telling Max to MAKE a risky claim is refused
  // ("say it is fully refundable"). Prices themselves are caught above ($, dollars, cents).
  const NEGATED = /\b(never|don'?t|do not|no|not|avoid|without|won'?t|unless)\b/i;
  for (const line of added.split("\n")) {
    const risk = addedRisk(line, "");
    if (!risk || /^adds (price|instructions|money)$/.test(risk) || /^names /.test(risk) || NEGATED.test(line)) continue;
    problems.push(`it ${risk.replace(/^adds /, "adds the claim: ")} ("${line.slice(0, 60)}"); promises come from the approved facts only`);
    break;
  }
  return problems;
}

export function buildNativeSystemPrompt(data: NativeData, prompt: string = DEFAULT_NATIVE_PROMPT): string {
  return `${prompt.trim()}\n\n${nativeDataBlock(data)}\n\n${NATIVE_REPLY_FORMAT}`;
}

/** What the app knows about the call, said to the AI after the history (keeps the prefix cacheable) */
export function nativeStateNote(s: { disclosureGiven: boolean; lowestOffered: number | null | undefined; ladder?: readonly number[]; refusals: number; priceLadder?: boolean; disclosureOn?: boolean }): string {
  const ladder = s.ladder ?? DEFAULT_LADDER;
  if (s.priceLadder === false || s.disclosureOn === false) {
    const disclosure = s.disclosureOn === false ? "" : ` Recording disclosure ${s.disclosureGiven ? "given, never repeat it" : "NOT given yet: say it word for word before any coverage or price talk (a short friendly opening first is fine)"}.`;
    const price = s.priceLadder === false ? "" : ` Lowest price offered so far: ${s.lowestOffered === null || s.lowestOffered === undefined ? "none" : `${spokenPrice(s.lowestOffered)} a day`}.`;
    return `CALL STATE (from the app, not said by anyone):${disclosure}${price} The customer has refused ${s.refusals} time${s.refusals === 1 ? "" : "s"} so far.`;
  }
  const offered = s.lowestOffered ?? null;
  const price =
    offered === null
      ? `no price offered yet (the first offer is ${spokenPrice(ladder[0])} a day)`
      : offered <= floorOf(ladder)
        ? `lowest offered ${spokenPrice(offered)} a day, the floor: no lower price exists`
        : `lowest offered ${spokenPrice(offered)} a day (the next step, only if they push back: ${spokenPrice(lowestAllowedPrice(offered, ladder))} a day)`;
  return `CALL STATE (from the app, not said by anyone): recording disclosure ${s.disclosureGiven ? "given, never repeat it" : "NOT given yet: say it word for word before any coverage or price talk (a short friendly opening first is fine)"}. Price: ${price}. The customer has refused ${s.refusals} time${s.refusals === 1 ? "" : "s"} so far.`;
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
  /** guardrail switches (default on) */
  ladderOn?: boolean;
  disclosureOn?: boolean;
}

function freeGuardCtx(ctx: NativeGuardContext): GuardContext {
  const ladderOn = ctx.ladderOn !== false;
  return {
    corpus: `${ctx.corpus} ${ctx.disclosure}`,
    // No beats here: prices are allowed once the disclosure has been given (or in this same reply)
    beatBefore: 0,
    lowestOffered: ctx.lowestOffered,
    // Ladder off: no ladder rules; every amount must be in the approved text (the number checks)
    ladder: ladderOn ? ctx.ladder : [],
    noLadder: !ladderOn,
    customerSaid: ctx.customerSaid,
    customerRefused: ctx.refused,
    recentMax: ctx.earlierMax.slice(-2),
    earlierMax: ctx.earlierMax,
    repeatable: ctx.disclosureOn === false ? [] : [ctx.disclosure],
    // refusedPrice stays unset: a no does NOT have to get the next lower price here; the prompt decides
  };
}

export function guardNativeText(t: string, ctx: NativeGuardContext, whole: boolean): GuardResult {
  const disclosedNow = ctx.disclosureOn === false || ctx.disclosureGiven || saysDisclosureVerbatim(t, ctx.disclosure);
  // guardFreeText's beat rule: beat 21+ = prices allowed; before the disclosure, never
  // A reply is a sentence: Grok answered "3.25" three times in a row (lab 2026-11-24), which no other
  // check caught (the ladder's text made its digits "approved", no "a day", too short to be a repeat)
  if (whole && (t.match(/[a-z]{2,}/gi) ?? []).length < 2) return { ok: false, reason: "not a sentence: say it in words", prices: [] };
  // With the ladder, a price is always a daily rate in words, never a bare amount
  if (ctx.ladderOn !== false && !spokenDailyRates(t).length) {
    // Amounts like "$4,000" or "4000" are not the four-dollar daily price (lab 2026-11-25: a false alarm)
    const bare = [...t.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}/g, " ").matchAll(/\$?\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
    if (bare.some((n) => ctx.ladder.some((p) => Math.abs(p - n) < 0.001))) return { ok: false, reason: 'a price must be said in words with "a day"', prices: [] };
  }
  const g = guardFreeText(t, freeGuardCtx(ctx), disclosedNow ? 22 : 0, whole);
  const fail = (reason: string): GuardResult => ({ ok: false, reason, prices: g.prices });
  if (!g.ok) return /^price before Beat/.test(g.reason ?? "") ? fail("price before the recording disclosure") : g;
  // A paraphrased disclosure would be said twice once code adds the real one
  if (ctx.disclosureOn !== false && !ctx.disclosureGiven && !saysDisclosureVerbatim(t, ctx.disclosure) && /\brecord(ed|ing)?\b/i.test(t)) {
    return fail("the recording disclosure must be word for word");
  }
  // Price ladder off: every money amount must be written, as money, in the approved text
  if (ctx.ladderOn === false) {
    const approved = moneyMentions(ctx.corpus);
    const said = moneyMentions(t);
    const newKey = [...said.keys].find((k) => !approved.keys.has(k) && !approved.values.has(Number(k.split(" ")[0])));
    if (newKey) return fail(`amount "${newKey}s" is not in the approved content`);
    const newValue = [...said.values].find((v) => !approved.values.has(v));
    if (newValue !== undefined) return fail(`amount $${newValue} is not in the approved content`);
  }
  // The price only comes down when the customer pushed back on this turn
  const current = ctx.lowestOffered;
  if (ctx.ladderOn !== false && current !== null && current !== undefined && !ctx.pushback && g.prices.some((p) => p < current)) {
    return fail(`lowered the price to $${Math.min(...g.prices)} a day without the customer pushing back`);
  }
  return g;
}

/** Money in a text: "<number> dollar/cent" pairs as written, and the values of "$9,500" and daily rates */
export function moneyMentions(text: string): { keys: Set<string>; values: Set<number> } {
  const keys = new Set(numberWithUnit(text).filter((p) => / (dollar|cent)$/.test(p)));
  const values = new Set<number>(spokenDailyRates(text));
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const v = Number(m[1].replace(/,/g, ""));
    values.add(v);
    keys.add(`${v} dollar`);
  }
  for (const k of keys) {
    const n = Number(k.split(" ")[0]);
    if (Number.isFinite(n) && k.endsWith("dollar")) values.add(n);
  }
  return { keys, values };
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
  if (g.ladderOn === false || !/price|skipped down/.test(reason)) return "";
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

