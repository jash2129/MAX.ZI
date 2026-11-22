/**
 * The daily-rate price ladder, per dealership (PRD rule 2: one step down per refusal, never below the
 * floor, no price before the price beat). Every place that says, shows, parses or checks a price goes
 * through here, so a dealership's approved ladder is the only one a call can use.
 *
 * The default is the demo's TXM-approved ladder. A call gets its dealership's ladder from
 * dealConfig.price_ladder (set by the brain service from the control plane's live price version).
 */

export const DEFAULT_LADDER: readonly number[] = [4, 3.5, 3.25, 3];

/** Same rules as the control plane's app.valid_ladder: 1-8 steps, strictly decreasing, 0 < price <= 100, cents. */
export function isValidLadder(ladder: unknown): ladder is number[] {
  if (!Array.isArray(ladder) || ladder.length < 1 || ladder.length > 8) return false;
  return ladder.every(
    (p, i) =>
      typeof p === "number" &&
      Number.isFinite(p) &&
      p > 0 &&
      p <= 100 &&
      Math.abs(Math.round(p * 100) - p * 100) < 1e-9 &&
      (i === 0 || p < ladder[i - 1])
  );
}

/** The call's ladder. An invalid ladder is a configuration bug: fail loudly rather than quote it. */
export function ladderOf(dealConfig?: { price_ladder?: number[] } | null): readonly number[] {
  const l = dealConfig?.price_ladder;
  if (l === undefined || l === null) return DEFAULT_LADDER;
  if (!isValidLadder(l)) throw new Error(`invalid price ladder: ${JSON.stringify(l)}`);
  return l;
}

export const floorOf = (ladder: readonly number[]) => ladder[ladder.length - 1];

/** Price offered at a 1-based concession stage (stage 1 = the opening price), clamped to the floor. */
export function priceAtStage(ladder: readonly number[], stage: number | undefined): number {
  const i = Math.min(ladder.length - 1, Math.max(0, (stage ?? 1) - 1));
  return ladder[i];
}

/** 1-based stage of a price on the ladder, or 0 if it is not on it. */
export function stageOfPrice(ladder: readonly number[], price: number): number {
  return ladder.findIndex((p) => samePrice(p, price)) + 1;
}

export const samePrice = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ---------------------------------------------------------------------------------------------------
// Numbers in words
// ---------------------------------------------------------------------------------------------------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0-999 in words: 25 -> "twenty-five", 120 -> "one hundred and twenty" */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error(`numberWords: ${n} out of range`);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` and ${numberWords(rest)}` : ""}`;
}

/** A daily rate as Max says it: 4 -> "four dollars", 3.25 -> "three dollars and twenty-five cents" */
export function spokenPrice(price: number): string {
  const cents = Math.round(price * 100);
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  const d = dollars === 0 ? "" : `${numberWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
  const ct = c === 0 ? "" : `${numberWords(c)} ${c === 1 ? "cent" : "cents"}`;
  if (d && ct) return `${d} and ${ct}`;
  return d || ct || "zero dollars";
}

/** A monthly figure, rounded to whole dollars: 120 -> "one hundred and twenty dollars" */
export function spokenWholeDollars(amount: number): string {
  const n = Math.round(amount);
  return `${numberWords(n)} ${n === 1 ? "dollar" : "dollars"}`;
}

// ---------------------------------------------------------------------------------------------------
// Prices in speech
// ---------------------------------------------------------------------------------------------------

const WORD_VALUES: Record<string, number> = Object.fromEntries([
  ...ONES.map((w, i) => [w, i] as const),
  ...TENS.slice(2).map((w, i) => [w, (i + 2) * 10] as const),
]);
const isNumWord = (w: string) => w in WORD_VALUES || w === "hundred";

/** Reads a spoken whole number starting at tokens[i]: "twenty five" -> 25, "one hundred twenty" -> 120. */
function readNumber(tokens: string[], i: number): { value: number; next: number } | null {
  let j = i;
  let current = 0;
  let any = false;
  while (j < tokens.length) {
    const w = tokens[j];
    if (/^\d+$/.test(w) && !any) {
      return { value: Number(w), next: j + 1 };
    }
    if (w === "hundred" && any) {
      current = (current || 1) * 100;
      j++;
      continue;
    }
    if (w === "and" && any && current >= 100 && j + 1 < tokens.length && isNumWord(tokens[j + 1])) {
      j++;
      continue;
    }
    if (!(w in WORD_VALUES)) break;
    const v = WORD_VALUES[w];
    // "twenty five" combines; "five twenty" does not (that is a price: five dollars twenty)
    if (any && !(current % 100 >= 20 && current % 10 === 0 && v < 10) && !(current >= 100 && current % 100 === 0)) break;
    current += v;
    any = true;
    j++;
  }
  if (!any) return null;
  return { value: current, next: j };
}

export interface PriceMention {
  amount: number;
  /** character offset in the text, so mentions come back in the order they were said */
  at: number;
  /** "a day" / "a month" said after it, or none */
  per: "day" | "month" | null;
}

/**
 * Every money amount said: "$3.50", "3.25", "three fifty", "three dollars and fifty cents", "three and a
 * half", "four bucks", "twenty dollars a month". Bare numbers ("three", "2026") are not prices.
 */
export function priceMentions(text: string): PriceMention[] {
  const lower = text.toLowerCase();
  const out: PriceMention[] = [];
  const perAfter = (s: string): PriceMention["per"] =>
    /^\s*(?:a|per|each|every|\/)\s*(?:day|daily)\b/.test(s) || /^\s*daily\b/.test(s)
      ? "day"
      : /^\s*(?:a|per|each|every|\/)\s*(?:month|mo)\b/.test(s) || /^\s*monthly\b/.test(s)
        ? "month"
        : null;

  // Digits: $3.50, 3.50, $4, 4 dollars, 20 a month
  for (const m of lower.matchAll(/(\$\s?)?\b(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\b(\s*(?:dollars?|bucks?))?/g)) {
    const hasDollar = Boolean(m[1]);
    const hasUnit = Boolean(m[3]);
    const raw = m[2].replace(/,/g, "");
    const isDecimal = raw.includes(".");
    const after = lower.slice((m.index ?? 0) + m[0].length);
    const per = perAfter(after);
    if (!hasDollar && !hasUnit && !isDecimal && !per) continue;
    out.push({ amount: Number(raw), per, at: m.index ?? 0 });
  }

  // Words (the normalization keeps every character's position, so token offsets point into the text)
  const norm = lower.replace(/[^a-z0-9$]/g, " ");
  const found = [...norm.matchAll(/\S+/g)];
  const tokens = found.map((m) => m[0]);
  const offsets = found.map((m) => m.index ?? 0);
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d/.test(tokens[i])) continue; // digits handled above
    const n = readNumber(tokens, i);
    if (!n) continue;
    let j = n.next;
    let amount: number | null = null;
    if (tokens[j] === "dollar" || tokens[j] === "dollars" || tokens[j] === "bucks" || tokens[j] === "buck") {
      amount = n.value;
      j++;
      // "... and fifty cents" / "... fifty" / "... and twenty-five"
      let k = tokens[j] === "and" ? j + 1 : j;
      const c = readNumber(tokens, k);
      if (c && c.value > 0 && c.value < 100 && (tokens[c.next] === "cents" || tokens[c.next] === "cent" || k > j || c.value >= 10)) {
        amount += c.value / 100;
        j = c.next + (tokens[c.next] === "cents" || tokens[c.next] === "cent" ? 1 : 0);
      }
    } else if (tokens[j] === "and" && tokens[j + 1] === "a" && tokens[j + 2] === "half") {
      amount = n.value + 0.5;
      j += 3;
      if (tokens[j] === "dollars" || tokens[j] === "bucks") j++;
    } else if (n.value >= 1 && n.value <= 9) {
      // "three fifty", "three twenty five": dollars then cents (a cents number of 10-99)
      const c = readNumber(tokens, j);
      if (c && c.value >= 10 && c.value < 100 && !(tokens[c.next] === "years" || tokens[c.next] === "year" || tokens[c.next] === "months" || tokens[c.next] === "miles" || tokens[c.next] === "percent")) {
        amount = n.value + c.value / 100;
        j = c.next;
        if (tokens[j] === "cents") j++;
      }
    } else if (n.value >= 10 && /^(a|per)$/.test(tokens[j] ?? "") && /^(day|month)$/.test(tokens[j + 1] ?? "")) {
      // "twenty a month": a number with a period but no "dollars"
      amount = n.value;
    }
    if (amount === null) continue;
    const rest = tokens.slice(j).join(" ");
    out.push({ amount: Math.round(amount * 100) / 100, per: perAfter(` ${rest}`), at: offsets[i] });
    i = j - 1;
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The daily rate a customer names ("how about three fifty", "$3.25", "I'd do twenty a month"), or null.
 * Monthly amounts are turned into a daily rate (30 days); an amount with no unit that is far above the
 * opening daily price (more than 3x) is taken as monthly, the way customers compare prices.
 */
export function namedDailyPrice(text: string, ladder: readonly number[] = DEFAULT_LADDER): number | null {
  // Several prices ("four dollars is too much, can you do two?"): the customer's offer is the lowest
  // one, often after repeating Max's price back
  const daily = priceMentions(text).map((m) =>
    m.per === "month" || (m.per === null && m.amount > ladder[0] * 3) ? Math.round((m.amount / 30) * 100) / 100 : m.amount
  );
  if (daily.length) return Math.min(...daily);
  // "how about 3" at the price: a bare small number is a counter-offer (kept from the demo)
  const bare = text.match(/\$?\b(\d+(?:\.\d{1,2})?)\b/);
  if (bare) {
    const n = Number(bare[1]);
    if (n > 0 && n < 10) return n;
  }
  return null;
}

/** Every daily rate Max says in a line ("three dollars and fifty cents a day", "$3.25 per day"). */
export function spokenDailyRates(text: string): number[] {
  return priceMentions(text)
    .filter((m) => m.per === "day")
    .map((m) => m.amount);
}
