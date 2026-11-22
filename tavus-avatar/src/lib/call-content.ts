/**
 * What a call says: its script (the 25 beats), recording disclosure, fixed lines, recaps and knowledge
 * base. The demo's built-in content is the default; a dealership's approved versions replace it per
 * call (dealConfig.script / dealConfig.knowledge, set by the brain service).
 *
 * The FLOW is fixed in code (beat ids, order, types and expected answers: the controller's logic is
 * keyed to them, e.g. Beat 22 is the price). The CONTENT varies: a dealership script must have the same
 * structure (validateScript), its wording is free. Content is pinned to the call when it starts, so a call
 * in progress keeps it even if a new version goes live.
 *
 * During a turn the content is held in an AsyncLocalStorage, so the controller reads it with
 * scriptBeats() / L.NAME / kbData() wherever it is, without threading it through every function.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import beatsData from "./beats.json" with { type: "json" };
import kbJson from "./max-knowledge-base.json" with { type: "json" };
import * as Lines from "./max-lines";
import { spokenDailyRates } from "./price-ladder";

export interface Beat {
  id: number;
  type: "wait" | "continue";
  text: string;
  check_in: string | null;
  expects?: "consent" | "yes_no" | "open" | "statement";
}

export interface KnowledgeBase {
  facts: Array<Record<string, unknown>>;
  needs_txm?: Array<Record<string, unknown>>;
}

/** A dealership's script version, as stored on the call */
export interface CallScript {
  beats: Beat[];
  disclosure: string;
  /** overrides for named fixed lines (max-lines.ts constants), e.g. { CLOSING_LINE: "..." } */
  fixed_lines?: Record<string, string>;
  /** recap lines by beat id, for beats whose coverage text the dealership changed */
  recaps?: Record<string, string>;
}

export const BUILT_IN_BEATS = beatsData as Beat[];
export const BUILT_IN_KB = kbJson as unknown as KnowledgeBase;
/** The demo's disclosure (Beat 1, without its quotes) */
export const BUILT_IN_DISCLOSURE = BUILT_IN_BEATS[0].text.replace(/^"|"$/g, "");

type LineName = { [K in keyof typeof Lines]: (typeof Lines)[K] extends string ? K : never }[keyof typeof Lines];
/** Every fixed line a dealership may override */
export const LINE_NAMES = Object.keys(Lines).filter((k) => typeof (Lines as Record<string, unknown>)[k] === "string") as LineName[];

export interface CallContent {
  beats: Beat[];
  disclosure: string;
  lines: Partial<Record<LineName, string>>;
  recaps: Record<string, string>;
  kb: KnowledgeBase;
  /** true for the demo's own content (some checks keep their original, tested form) */
  builtIn: boolean;
}

const BUILT_IN: CallContent = { beats: BUILT_IN_BEATS, disclosure: BUILT_IN_DISCLOSURE, lines: {}, recaps: {}, kb: BUILT_IN_KB, builtIn: true };

const store = new AsyncLocalStorage<CallContent>();

/** Runs fn (sync or async) with this call's content in scope. */
export function withCallContent<T>(content: CallContent, fn: () => T): T {
  return store.run(content, fn);
}

export const currentContent = (): CallContent => store.getStore() ?? BUILT_IN;
export const scriptBeats = (): Beat[] => currentContent().beats;
export const callDisclosure = (): string => currentContent().disclosure;
export const kbData = (): KnowledgeBase => currentContent().kb;

/** Fixed lines for this call: L.CLOSING_LINE is the dealership's override or the built-in line. */
export const L = new Proxy({} as { readonly [K in LineName]: string }, {
  get(_t, name: string) {
    const own = currentContent().lines[name as LineName];
    return own ?? (Lines as Record<string, unknown>)[name];
  },
});

// ---------------------------------------------------------------------------------------------------
// Building and checking a call's content
// ---------------------------------------------------------------------------------------------------

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The same text as the built-in beat, apart from the deal's details: a placeholder in the built-in text
 * ({{vehicle_make}}) matches whatever words stand there ("Mazda is like ..." = "{{vehicle_make}} is like ...").
 */
export function sameBeatText(text: string, builtIn: string): boolean {
  const SLOT = "zzslotzz";
  const pattern = norm(builtIn.replace(/\{\{\w+\}\}/g, ` ${SLOT} `))
    .split(SLOT)
    .map((part) => part.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(" ?[a-z0-9 ]*? ?")
    .replace(/ +/g, " ");
  const t = norm(text.replace(/\{\{\w+\}\}/g, ` ${SLOT} `)).replace(new RegExp(SLOT, "g"), "");
  return new RegExp(`^${pattern}$`).test(t.replace(/ +/g, " ").trim());
}

/** Why this script cannot run on the controller, or null. */
export function validateScript(s: unknown, recapBeats: number[] = []): string | null {
  const script = s as Partial<CallScript> | null;
  if (!script || typeof script !== "object") return "no script";
  const beats = script.beats;
  if (!Array.isArray(beats) || beats.length !== BUILT_IN_BEATS.length) return `the script must have ${BUILT_IN_BEATS.length} beats`;
  for (let i = 0; i < BUILT_IN_BEATS.length; i++) {
    const want = BUILT_IN_BEATS[i];
    const got = beats[i] as Partial<Beat>;
    if (!got || got.id !== want.id) return `beat ${i + 1} must have id ${want.id}`;
    if (got.type !== want.type) return `beat ${want.id} must be "${want.type}"`;
    if ((got.expects ?? null) !== (want.expects ?? null)) return `beat ${want.id} must expect "${want.expects}"`;
    if (typeof got.text !== "string" || !got.text.trim()) return `beat ${want.id} has no text`;
    if (got.check_in !== null && got.check_in !== undefined && typeof got.check_in !== "string") return `beat ${want.id}: check_in must be text or null`;
  }
  if (!beats[21].text.includes("{{per_day_price}}")) return "beat 22 must say the price with {{per_day_price}} (it comes from the price ladder)";
  if (/\$\s?\d|\b\d+(?:\.\d+)? ?(?:dollars?|bucks) (?:a|per) day\b/i.test(beats.map((b) => b.text).join(" ").replace(/\{\{per_day_price\}\}/g, ""))) {
    return "daily prices in the script must come from the ladder ({{per_day_price}}), not be written in";
  }
  if (typeof script.disclosure !== "string" || !script.disclosure.trim()) return "no recording disclosure";
  if (!norm(beats[0].text).includes(norm(script.disclosure))) return "beat 1 must say the recording disclosure word for word";
  const lines = script.fixed_lines ?? {};
  if (typeof lines !== "object") return "fixed_lines must be an object";
  for (const [k, v] of Object.entries(lines)) {
    if (!(LINE_NAMES as string[]).includes(k)) return `unknown fixed line ${k}`;
    if (typeof v !== "string" || !v.trim()) return `fixed line ${k} is empty`;
    if (spokenDailyRates(v).length) return `fixed line ${k} states a daily price: prices come from the ladder only`;
  }
  for (const [id, v] of Object.entries(script.recaps ?? {})) {
    if (typeof v !== "string") return `recap ${id} must be text`;
    if (spokenDailyRates(v).length) return `recap ${id} states a daily price: prices come from the ladder only`;
  }
  // A beat whose coverage text changed must bring its own recap: the built-in recap would recite the
  // demo's coverage terms
  const recaps = script.recaps ?? {};
  for (const id of recapBeats) {
    const changed = !sameBeatText(beats[id - 1].text, BUILT_IN_BEATS[id - 1].text);
    if (changed && !(typeof recaps[String(id)] === "string" && recaps[String(id)].trim())) {
      return `beat ${id} was reworded: give its recap too (recaps["${id}"])`;
    }
  }
  return null;
}

export function validateKnowledge(k: unknown): string | null {
  const kb = k as Partial<KnowledgeBase> | null;
  if (!kb || !Array.isArray(kb.facts)) return "no knowledge base facts";
  for (const f of kb.facts) {
    if (!f || typeof f !== "object") return "a fact is not an object";
    for (const key of ["id", "topic", "answer", "status"]) {
      if (typeof (f as Record<string, unknown>)[key] !== "string") return `a fact has no ${key}`;
    }
  }
  return null;
}

/** The call's content from its deal config (pinned when the call starts). Throws on invalid content. */
export function contentFor(dealConfig: { script?: CallScript; knowledge?: KnowledgeBase } | undefined, recapBeats: number[] = []): CallContent {
  if (!dealConfig?.script && !dealConfig?.knowledge) return BUILT_IN;
  const script = dealConfig.script;
  if (script) {
    const problem = validateScript(script, recapBeats);
    if (problem) throw new Error(`invalid script: ${problem}`);
  }
  if (dealConfig.knowledge) {
    const problem = validateKnowledge(dealConfig.knowledge);
    if (problem) throw new Error(`invalid knowledge base: ${problem}`);
  }
  return {
    beats: script?.beats ?? BUILT_IN_BEATS,
    disclosure: script?.disclosure ?? BUILT_IN_DISCLOSURE,
    lines: (script?.fixed_lines ?? {}) as CallContent["lines"],
    recaps: script?.recaps ?? {},
    kb: dealConfig.knowledge ?? BUILT_IN_KB,
    builtIn: false,
  };
}
