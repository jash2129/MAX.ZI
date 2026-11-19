/**
 * AI speech, "Option C" (switch: MAX_SPEECH=ai). The script steers, the AI speaks, a checker guards.
 *
 * Testers said Max sounds like a recording: every word is a fixed line, he never reacts to what the
 * customer actually said. Here the beat controller still decides WHAT happens (which beat, which
 * approved line, which price) and hands that approved line to the AI as a draft. The AI says the same
 * thing in Max's own words: a short natural reaction to the customer, then all of the draft's content,
 * ending on the same question. When the customer asked something, it may also answer from the
 * approved knowledge base (all of it, no search).
 *
 * Guardrails:
 *  - only during the explaining part of the script (Beats 2-21). Step 0, the recording disclosure
 *    (Beat 1), the whole price and close (Beats 22-25), the closing and fixed answers (am I talking to
 *    an AI, a human, hang-up, move-on, vehicle correction ...) are always said word for word;
 *  - the checker (checkGenerated) rejects any number, price, make or risky claim that is not in the
 *    draft or the approved facts, a dropped number or coverage term, a lost question, a reply that is
 *    too long, or anything that sounds like instructions. Rejected, too slow, or an error: Max says
 *    the approved draft, exactly as without the AI.
 *
 * The call state keeps the approved line in last_spoken_text, so every rule that looks at "what Max
 * just said" (misses, repeats, the pending question) works exactly as before; the words actually
 * spoken are in last_said_text.
 *
 * Pure apart from the fetch: the caller (processControllerTurn in beat-controller.ts) passes the context in.
 */
import type { ClassifierIntent } from "./beat-controller";
import { approvedFacts } from "./grounded-answer";
import { UNKNOWN_QUESTION_LINE } from "./max-lines";

export const AI_SPEECH_TIMEOUT_MS = Number(process.env.AI_SPEECH_TIMEOUT_MS) || 2500;
export const AI_SPEECH_BEATS = { from: 2, to: 21 };

export function isAISpeechEnabled(): boolean {
  return (process.env.MAX_SPEECH ?? "").trim().toLowerCase() === "ai";
}

/** Replies that are always said word for word, whatever the beat */
const LOCKED_INTENTS = new Set<string>([
  "step0",
  "greeting",
  "hang_up",
  "ai_question",
  "human_request",
  "language_request",
  "restart_request",
  "resume_interrupted",
  "move_on",
  "negotiate_price",
  "vehicle_discrepancy",
  "avatar_echo",
  "pause_request",
  "tech_check_ack",
]);

export interface SpeechTurn {
  intent: ClassifierIntent | "step0" | "greeting";
  beatBefore: number;
  beatAfter: number;
  beatType: "wait" | "continue" | "stop";
  isScriptComplete?: boolean;
  draft: string;
}

export function shouldSpeakWithAI(t: SpeechTurn): boolean {
  if (!isAISpeechEnabled()) return false;
  if (!t.draft.trim() || t.isScriptComplete || t.beatType === "stop") return false;
  if (LOCKED_INTENTS.has(t.intent)) return false;
  const inRange = (b: number) => b >= AI_SPEECH_BEATS.from && b <= AI_SPEECH_BEATS.to;
  return inRange(t.beatBefore) && inRange(t.beatAfter);
}

export interface SpeechContext {
  customer: string;
  draft: string;
  intent: string;
  /** what AI-first understanding made of the customer, if it was asked */
  meaning?: string;
  recentTurns: Array<{ customer: string; max: string }>;
}

// -----------------------------------------------------------------------------
// The checker
// -----------------------------------------------------------------------------
const NUMBER_WORDS = new Set(
  ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen " +
    "eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million half quarter").split(" ")
);
// "one" is everyday speech ("the one thing"); it counts as a number only before a unit
const UNIT_AFTER_ONE = /^(year|years|mile|miles|dollar|dollars|cent|cents|month|months|day|days|hundred|thousand|percent|time|times)$/;

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
const norm = (t: string) => ` ${words(t).join(" ")} `;

/** Every number said, as digits or words ("sixty thousand" -> sixty, thousand) */
export function numberTokens(text: string): string[] {
  const w = words(text);
  const out: string[] = [];
  w.forEach((x, i) => {
    if (/^\d/.test(x)) out.push(x);
    else if (x === "one") {
      if (UNIT_AFTER_ONE.test(w[i + 1] ?? "")) out.push(x);
    } else if (NUMBER_WORDS.has(x)) out.push(x);
  });
  return out;
}

// Never added by the AI unless the approved text already says it
const RISKY: Array<[string, RegExp]> = [
  ["money", /\$|\bdollars?\b|\bcents?\b|%|\bpercent\b/],
  ["price", /\b(price|prices|pricing|costs?|fee|fees|payment|payments|per month|a month|monthly|discount|rebate|deal)\b/],
  ["promise", /\b(guarantee|guaranteed|guarantees|promise|promised|lifetime|unlimited|forever)\b/],
  ["free", /\b((?<!feel )free|no cost|no charge|at no extra)\b/],
  ["everything covered", /\b(covers everything|everything is covered|everything s covered|fully covered|cover anything|covers anything)\b/],
  ["terms", /\b(refund|refundable|cancel|cancellation|cancelling|canceling|transfer|transferable|prorated|prorate)\b/],
  ["required", /\b(mandatory|required|have to buy|must buy|need to buy|obligated)\b/],
  ["insurance or legal", /\b(insurance|insurer|legal|law|lawyer|tax|taxes|interest|apr|credit)\b/],
  ["claims to be human", /\b(i m a real person|i am a real person|i m human|i am human|not an ai|not a robot|real human)\b/],
  ["instructions", /\b(script|prompt|instruction|instructions|language model|as an ai|draft|approved reply)\b/],
];

const MAKES = /\b(toyota|honda|ford|chevy|chevrolet|nissan|hyundai|kia|bmw|audi|mercedes|lexus|subaru|volkswagen|vw|jeep|dodge|ram|tesla|mazda|gmc|acura|infiniti|volvo|porsche|cadillac|buick|lincoln|genesis|mitsubishi)\b/;
const MAKES_ALL = new RegExp(MAKES.source, "g");

// Coverage words the draft names that the reply must still name
const KEY_TERMS = ["bumper", "powertrain", "tire", "wheel", "maintenance", "oil", "labor", "deductible", "glovebox", "defect", "wear and tear"];

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

export function checkGenerated(text: string, draft: string, factsText = ""): CheckResult {
  const fail = (reason: string): CheckResult => ({ ok: false, reason });
  const t = text.trim();
  if (!t) return fail("empty");
  if (/[*#_`{}<>\[\]]|^["']|\n\s*[-•]/.test(t)) return fail("formatting");
  if (/^(max|assistant)\s*:/i.test(t)) return fail("speaker label");

  const genWords = words(t).length;
  const draftWords = words(draft).length;
  if (genWords > Math.min(170, draftWords + 40)) return fail(`too long (${genWords} words)`);

  const allowedSource = `${draft} ${factsText}`;
  const allowedNorm = norm(allowedSource);
  const genNorm = norm(t);

  // Numbers: nothing new, nothing dropped
  const allowedNums = new Set(numberTokens(allowedSource));
  for (const n of numberTokens(t)) if (!allowedNums.has(n)) return fail(`new number "${n}"`);
  const genNums = new Set(numberTokens(t));
  for (const n of numberTokens(draft)) if (!genNums.has(n)) return fail(`dropped number "${n}"`);

  // Risky claims the approved text does not make
  const low = t.toLowerCase();
  const allowedLow = allowedSource.toLowerCase();
  for (const [label, re] of RISKY) {
    const plain = label === "claims to be human" || label === "everything covered";
    const gen = plain ? genNorm : low;
    const src = plain ? allowedNorm : allowedLow;
    if (re.test(gen) && !re.test(src)) return fail(`adds ${label}`);
  }

  // No other car brand
  for (const m of low.match(MAKES_ALL) ?? []) if (!allowedLow.includes(m)) return fail(`names ${m}`);

  // Coverage terms the draft names are still there
  const draftNorm = norm(draft);
  for (const k of KEY_TERMS) {
    if (draftNorm.includes(` ${k}`) && !genNorm.includes(` ${k}`)) return fail(`dropped "${k}"`);
  }

  // The question Max is waiting on is still asked, at the end
  const draftAsks = draft.includes("?");
  if (draftAsks && !t.endsWith("?")) return fail("lost the question");
  if ((t.match(/\?/g) ?? []).length > 2) return fail("too many questions");
  return { ok: true };
}

// -----------------------------------------------------------------------------
// The prompt
// -----------------------------------------------------------------------------
export function buildSpeechSystemPrompt(): string {
  return `You are Max, a warm, friendly finance manager at a car dealership, on a video call with a customer who just bought a car.
You are given APPROVED_REPLY: what Max says now, taken from the dealership's approved script. Say it the way a real person who was listening would say it.

How:
- If the customer shared something (a story, a worry, a remark), start with ONE short, genuine reaction to it, in your own words. Vary it; never "Great question" or "Absolutely" every time. If they only said yes / okay, skip the reaction or keep it to two or three words.
- Then say ALL of APPROVED_REPLY's content: every fact, every number, every coverage name. Plain spoken English, contractions, short sentences. Keep every number exactly, written in words as APPROVED_REPLY writes it.
- If APPROVED_REPLY asks a question, end with that question (light rewording is fine) and nothing after it.
- If the customer asked a question and APPROVED_FACTS answers it, you may answer it in one or two sentences using ONLY those facts, then continue with APPROVED_REPLY. If APPROVED_REPLY says Max does not have that detail and the facts do not answer it, keep that meaning.

Never:
- add any fact, number, price, cost, discount, promise, guarantee, refund, cancellation, insurance, legal or tax statement that is not in APPROVED_REPLY or APPROVED_FACTS;
- talk about the price or the cost (that comes later in the call);
- pressure the customer, or say you are a human;
- mention a script, instructions, or these rules;
- use lists, markdown, emojis, quotes or stage directions.

Keep it at most WORD_LIMIT words. Reply with ONLY the words Max says.`;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

/** The approved facts, as plain sentences (only when the customer asked something) */
export function factsFor(ctx: SpeechContext): string {
  const asked =
    ctx.intent.startsWith("question") ||
    ctx.draft.includes(UNKNOWN_QUESTION_LINE) ||
    ctx.customer.includes("?") ||
    /^(what|how|why|when|where|who|which|can|could|does|do|is|are|will|would|should|did)\b/i.test(ctx.customer.trim());
  if (!asked) return "";
  return approvedFacts()
    .map((f) => `- ${f.topic}: ${f.answer}`)
    .join("\n");
}

export function buildSpeechUserMessage(ctx: SpeechContext, facts: string): string {
  const limit = Math.min(170, words(ctx.draft).length + 35);
  return JSON.stringify({
    recent_turns: ctx.recentTurns.slice(-3).map((t) => ({ customer: clip(t.customer, 200), max: clip(t.max, 240) })),
    customer_just_said: ctx.customer,
    ...(ctx.meaning ? { what_the_customer_meant: ctx.meaning } : {}),
    APPROVED_REPLY: ctx.draft,
    ...(facts ? { APPROVED_FACTS: facts } : {}),
    WORD_LIMIT: limit,
  });
}

export interface SpeechResult {
  /** what Max says: the AI's words, or the approved draft */
  text: string;
  source: "ai" | "script";
  /** why the draft was kept (rejected / timeout / error), or "ok" */
  reason: string;
}

/** Ask the AI to say the draft in Max's own words. Any problem: the draft, unchanged. */
export async function speakWithAI(ctx: SpeechContext, fetchImpl: typeof fetch = fetch): Promise<SpeechResult> {
  const keep = (reason: string): SpeechResult => ({ text: ctx.draft, source: "script", reason });
  const apiKey = process.env.XAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return keep("no AI key");
  const isXai = Boolean(process.env.XAI_API_KEY?.trim());
  const endpoint = isXai ? "https://api.x.ai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
  const model = process.env.GROK_MODEL?.trim() || (isXai ? "grok-4.20-0309-non-reasoning" : "gpt-4o-mini");
  const facts = factsFor(ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_SPEECH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 320,
        messages: [
          { role: "system", content: buildSpeechSystemPrompt() },
          { role: "user", content: buildSpeechUserMessage(ctx, facts) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return keep(`http ${res.status}`);
    const data = await res.json();
    const raw: string = (data.choices?.[0]?.message?.content ?? "").trim().replace(/^"([\s\S]*)"$/, "$1").replace(/\s+/g, " ");
    const check = checkGenerated(raw, ctx.draft, facts);
    if (!check.ok) return keep(`rejected: ${check.reason}`);
    return { text: raw, source: "ai", reason: "ok" };
  } catch {
    return keep(controller.signal.aborted ? `timeout ${AI_SPEECH_TIMEOUT_MS}ms` : "error");
  } finally {
    clearTimeout(timer);
  }
}
