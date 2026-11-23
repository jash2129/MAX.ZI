/**
 * Max learning from calls (scripts/prompt-improve.ts runs the loop). Pure: no AI, no files.
 *
 *   COLLECT   calls: simulated batches, prompt-lab runs, the call log sheet (testers' ratings and notes)
 *   DIAGNOSE  what goes wrong, counted: failed checks, guard refusals, judge and tester notes
 *   PROPOSE   an AI writes small prompt edits aimed at the top causes, told what was tried before
 *   CHECK     a candidate may change how Max talks, never the rules: protected sentences, placeholders,
 *             no new numbers or money words (validateCandidate)
 *   EVALUATE  prompt lab against the current prompt, then the gates (decide):
 *               1. no more hard-rule failures, ever
 *               2. nothing significantly worse (reliability, experience, business)
 *               3. at least one measure significantly better
 *               4. held-out customers (never tuned on): no hard failures added, nothing worse, and the
 *                  improvement points the same way, or it only memorised the training customers
 *               5. replayed real calls: no hard failures added
 *   REMEMBER  every candidate and why it was kept or refused (the lessons log), so the loop never
 *             retries a refused idea
 *   APPROVE   a person approves the result; nothing here changes what live calls use
 */
import { checkFreePromptTemplate, DEFAULT_FREE_PROMPT } from "./free-ai";
import { esc, lineDiff, REPORT_CSS, type LabCall, type Row } from "./prompt-lab";
import { scoreCall, type ScoredTurn } from "./call-scorecard";

// ---------------------------------------------------------------------------------------------------
// The corpus: calls from every source, in one shape
// ---------------------------------------------------------------------------------------------------

export interface HumanFeedback {
  overall?: number;
  natural?: number;
  understood?: number;
  trust?: string;
  wrong?: string;
  well?: string;
  notes?: string;
}

export interface CorpusCall {
  id: string;
  source: "simulated" | "prompt-lab" | "sheet";
  persona?: string;
  turns: ScoredTurn[];
  /** failed scorecard checks: "hard: <label> — <detail>" */
  failures: Array<{ severity: string; label: string; detail: string }>;
  /** why a guard refused the AI's reply, per refused turn */
  guardReasons: string[];
  /** an AI review or judge's one-line summary, and its score */
  aiSummary?: string;
  aiScore?: number;
  human?: HumanFeedback;
  /** the call ran in free mode (the AI ran it from a prompt): what prompt changes can affect */
  freeMode?: boolean;
}

const failuresOf = (checks: Array<{ pass: boolean; severity: string; label: string; detail?: string }>) =>
  checks.filter((c) => !c.pass).map((c) => ({ severity: c.severity, label: c.label, detail: String(c.detail ?? "") }));

/** testing-skill/reports/sim-batch-*.json (scripts/sim-batch.ts) */
export function fromSimBatch(calls: any[]): CorpusCall[] {
  return (Array.isArray(calls) ? calls : []).filter((c) => Array.isArray(c?.turns)).map((c) => ({
    id: String(c.id),
    source: "simulated" as const,
    persona: c.persona,
    turns: c.turns,
    failures: failuresOf(c.scorecard?.checks ?? []),
    guardReasons: (c.understanding ?? []).filter((u: any) => u?.mode === "script" && u.freeReason).map((u: any) => String(u.freeReason)),
    aiSummary: c.review?.callSummary || undefined,
    aiScore: typeof c.review?.aiScore === "number" ? c.review.aiScore : undefined,
    freeMode: (c.understanding ?? []).some((u: any) => u?.mode === "free" || u?.mode === "script"),
  }));
}

/** testing-skill/reports/prompt-lab-*.json and the improver's own runs */
export function fromLabCalls(calls: LabCall[]): CorpusCall[] {
  return calls.filter((c) => !c.error).map((c, i) => ({
    id: `${c.variant}-${c.persona}-${c.run}-${i}`,
    source: "prompt-lab" as const,
    persona: c.persona,
    turns: c.turns,
    failures: failuresOf(c.scorecard.checks),
    guardReasons: c.turns.filter((t) => t.mode === "script" && t.reason).map((t) => String(t.reason)),
    aiSummary: c.judge?.summary,
    aiScore: c.judge ? (c.judge.natural + c.judge.listens + c.judge.clear + c.judge.warm) / 4 : undefined,
    freeMode: true,
  }));
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** "Max: …\nCustomer: …" (the sheet's Transcript column) into turns: each customer line and Max's reply */
export function turnsFromTranscript(transcript: string): ScoredTurn[] {
  const turns: ScoredTurn[] = [];
  let pending: string | null = null;
  for (const raw of transcript.split(/\r?\n/)) {
    const c = /^Customer:\s*(.*)$/.exec(raw);
    const m = /^Max:\s*(.*)$/.exec(raw);
    if (c) pending = c[1].trim();
    else if (m && pending !== null) {
      turns.push({ customer: pending, max: m[1].trim(), beat: 0 });
      pending = null;
    }
  }
  return turns;
}

/**
 * The call log sheet, downloaded as CSV (File → Download → CSV). Columns by header name
 * (scripts/google-sheets/CallLog.gs). Testers' ratings and notes are the most valuable signal here.
 */
export function fromSheetCsv(text: string): CorpusCall[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) return [];
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const at = (r: string[], name: string) => {
    const i = col(name);
    return i >= 0 ? (r[i] ?? "").trim() : "";
  };
  const num = (v: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (col("Transcript") < 0) throw new Error('the CSV has no "Transcript" column: is it the call log sheet\'s Calls tab?');
  return rows
    .map((r) => {
      const turns = turnsFromTranscript(at(r, "Transcript"));
      const card = scoreCall(turns);
      const human: HumanFeedback = {
        overall: num(at(r, "Overall Rating (1-5)")),
        natural: num(at(r, "Felt Natural (1-5)")),
        understood: num(at(r, "Max Understood Me (1-5)")),
        trust: at(r, "Would Trust for Real Purchase (Y/N)") || undefined,
        wrong: at(r, "What Went Wrong") || undefined,
        well: at(r, "What Went Well") || undefined,
        notes: at(r, "Reviewer Notes") || undefined,
      };
      return {
        id: at(r, "Call ID") || `row-${Math.random().toString(36).slice(2, 8)}`,
        source: "sheet" as const,
        persona: at(r, "Environment") || undefined,
        turns,
        // Beats aren't in the sheet, so only the checks that don't need them are meaningful here
        failures: failuresOf(card.checks).filter((f) => /loop|word for word|repeat/i.test(f.label)),
        guardReasons: [],
        // The sheet's own AI review of the call: its problems and fixes say most about what to change
        aiSummary: [at(r, "AI Problems Found") && `problems: ${at(r, "AI Problems Found")}`, at(r, "AI Suggested Fixes") && `fixes: ${at(r, "AI Suggested Fixes")}`].filter(Boolean).join(" | ") || at(r, "AI Call Summary") || undefined,
        aiScore: num(at(r, "AI Score (1-10)")),
        human: Object.values(human).some((v) => v !== undefined) ? human : undefined,
      };
    })
    .filter((c) => c.turns.length > 0);
}

/** The last `n` real calls in sheet order: sample rows dropped, a repeated Call ID kept once (its last row). */
export function lastSheetCalls(calls: CorpusCall[], n: number): CorpusCall[] {
  const real = calls.filter((c) => !/^sample/i.test(c.id));
  const unique = real.filter((c, i) => !real.slice(i + 1).some((d) => d.id === c.id));
  return unique.slice(-n);
}

// ---------------------------------------------------------------------------------------------------
// Diagnose: what goes wrong, counted, as a digest for the AI
// ---------------------------------------------------------------------------------------------------

/** Quoted text and numbers vary per call; the cause doesn't */
export const normaliseReason = (r: string) =>
  r.replace(/"[^"]*"/g, "…").replace(/\$[\d.]+/g, "$…").replace(/\(\d+ words\)/, "(N words)").replace(/\s+/g, " ").trim();

/** Long digit runs (phone numbers, addresses) out of anything sent to the AI */
export const redact = (t: string) => t.replace(/\d{3,}/g, "###");

function topCounts(values: string[], n: number): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export interface Digest {
  text: string;
  calls: number;
  bySource: Record<string, number>;
  failures: Array<[string, number]>;
  guards: Array<[string, number]>;
}

export function digest(corpus: CorpusCall[], opts: { maxChars?: number } = {}): Digest {
  const maxChars = opts.maxChars ?? 14_000;
  const bySource: Record<string, number> = {};
  for (const c of corpus) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  const failures = topCounts(corpus.flatMap((c) => c.failures.map((f) => `${f.severity}: ${f.label}`)), 12);
  const guards = topCounts(corpus.flatMap((c) => c.guardReasons.map(normaliseReason)), 12);
  const totalTurns = corpus.reduce((a, c) => a + c.turns.length, 0);

  const parts: string[] = [];
  parts.push(`CALLS: ${corpus.length} (${Object.entries(bySource).map(([k, v]) => `${v} ${k}`).join(", ")}), ${totalTurns} turns.`);
  parts.push(`\nFAILED CHECKS (how many calls; hard = a rule broken):\n${failures.map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- none"}`);
  for (const [label] of failures.slice(0, 6)) {
    const ex = corpus.flatMap((c) => c.failures.filter((f) => `${f.severity}: ${f.label}` === label).map((f) => f.detail)).filter(Boolean).slice(0, 2);
    if (ex.length) parts.push(`  examples for "${label}": ${ex.map((e) => `"${redact(e).slice(0, 160)}"`).join("; ")}`);
  }
  parts.push(`\nWHY THE SAFETY GUARDS REFUSED MAX'S AI REPLY (the script answered instead), per turn:\n${guards.map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- none recorded"}`);

  const human = corpus.filter((c) => c.human && (c.human.wrong || c.human.notes || c.human.overall !== undefined));
  if (human.length) {
    const avg = (k: keyof HumanFeedback) => {
      const v = human.map((c) => c.human![k]).filter((x): x is number => typeof x === "number");
      return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "-";
    };
    parts.push(`\nHUMAN TESTERS (${human.length} rated calls): overall ${avg("overall")}/5, felt natural ${avg("natural")}/5, Max understood me ${avg("understood")}/5.`);
    for (const c of human.slice(0, 30)) {
      const h = c.human!;
      const bits = [h.wrong && `wrong: ${h.wrong}`, h.well && `well: ${h.well}`, h.notes && `reviewer: ${h.notes}`].filter(Boolean).join(" | ");
      if (bits) parts.push(`- [${h.overall ?? "?"}/5] ${redact(bits).slice(0, 300)}`);
    }
  }

  const reviewed = corpus.filter((c) => c.aiSummary).sort((a, b) => (a.aiScore ?? 10) - (b.aiScore ?? 10));
  if (reviewed.length) parts.push(`\nAI REVIEWS OF THE WORST CALLS:\n${reviewed.slice(0, 12).map((c) => `- (${c.persona ?? c.source}, ${c.aiScore?.toFixed(1) ?? "?"}) ${redact(c.aiSummary!).slice(0, 400)}`).join("\n")}`);

  // A few excerpts, simulated calls only (no real customer's words leave the machine as examples)
  const worst = corpus.filter((c) => c.source !== "sheet" && (c.failures.length || c.guardReasons.length)).sort((a, b) => b.failures.length + b.guardReasons.length - (a.failures.length + a.guardReasons.length));
  for (const c of worst.slice(0, 3)) {
    const lines = c.turns.slice(-6).map((t) => `  Customer: ${redact(t.customer).slice(0, 160)}\n  Max: ${redact(t.max).slice(0, 260)}`);
    parts.push(`\nEXCERPT (${c.persona ?? c.source}, last turns):\n${lines.join("\n")}`);
  }

  let text = parts.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(cut)`;
  return { text, calls: corpus.length, bySource, failures, guards };
}

// ---------------------------------------------------------------------------------------------------
// Check: what a candidate may never change
// ---------------------------------------------------------------------------------------------------

/**
 * Sentences that carry a rule (legal, money, honesty). If the starting prompt has one, every candidate
 * must keep it. Changing these is a business decision for a person, not something the loop learns.
 */
export const PROTECTED_PHRASES = [
  "{{disclosure}}",
  "word for word",
  "never talk about price or cost before Beat 22",
  "one step at a time",
  "Never below {{floor}}",
  "A refusal is never a yes",
  "only confirm the package when they clearly say yes",
  "Never invent",
  "Never claim to be human",
  "If they object to being recorded",
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
const MONEY_WORDS = /\b(dollars?|cents?|percent|free|refund|guarantee[ds]?|discount)\b/gi;

/**
 * The check on a free-mode prompt a person edits (the portal): against the built-in prompt, the same
 * rules as the learning loop's edits. Every rule sentence and placeholder stays; no new numbers, money
 * or promise words; not much longer. Empty = fine.
 */
export function freePromptProblems(prompt: string): string[] {
  const t = prompt.replace(/\r\n/g, "\n").trim();
  if (!t) return ["the prompt is empty (leave it out to use the built-in prompt)"];
  return validateCandidate(DEFAULT_FREE_PROMPT, t).filter((p) => p !== "no change");
}

export function validateCandidate(base: string, candidate: string): string[] {
  const problems: string[] = [];
  const { unknown, missing } = checkFreePromptTemplate(candidate);
  const baseMissing = new Set(checkFreePromptTemplate(base).missing);
  if (unknown.length) problems.push(`unknown placeholders: ${unknown.join(", ")}`);
  const dropped = missing.filter((m) => !baseMissing.has(m));
  if (dropped.length) problems.push(`drops content Max needs: ${dropped.map((m) => `{{${m}}}`).join(", ")}`);
  for (const p of PROTECTED_PHRASES) if (norm(base).includes(norm(p)) && !norm(candidate).includes(norm(p))) problems.push(`removes or rewords a rule: "${p}"`);
  const baseDigits = new Set(base.match(/\d+(\.\d+)?/g) ?? []);
  const newDigits = [...new Set((candidate.match(/\d+(\.\d+)?/g) ?? []).filter((d) => !baseDigits.has(d)))];
  // Small list numbering ("9.") is fine; anything else may become a figure Max says
  const risky = newDigits.filter((d) => !/^\d{1,2}$/.test(d) || Number(d) > 20);
  if (risky.length) problems.push(`adds numbers: ${risky.join(", ")}`);
  const money = (t: string) => (t.match(MONEY_WORDS) ?? []).length;
  if (money(candidate) > money(base)) problems.push("adds money or promise words (dollars, free, refund, guarantee, discount...)");
  if (candidate.length > base.length * 1.6 + 800) problems.push(`too long: ${candidate.length} characters (start: ${base.length})`);
  if (candidate.trim() === base.trim()) problems.push("no change");
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// Evaluate: the gates
// ---------------------------------------------------------------------------------------------------

/** The measures the loop tries to improve (experience and reliability) */
export const TARGET_IDS = ["natural", "listens", "clear", "warm", "takeover", "flags"];

export interface Decision {
  accepted: boolean;
  /** where it stopped: train, holdout, replay, or passed */
  stage: "check" | "train" | "holdout" | "replay" | "passed";
  reasons: string[];
  /** the measures that got better beyond noise on the training customers */
  improved: string[];
}

const hardTotal = (rows: Row[]) => rows.find((r) => r.measure.id === "hard");

export function trainGate(rows: Row[]): Decision {
  const reasons: string[] = [];
  const hard = hardTotal(rows);
  if (hard && hard.b.n && hard.b.mean > hard.a.mean + 1e-9) reasons.push(`more hard-rule failures (${hard.a.mean.toFixed(2)} → ${hard.b.mean.toFixed(2)} per call)`);
  for (const r of rows) if (r.verdict === "worse") reasons.push(`worse: ${r.measure.label} (${r.measure.format(r.a.mean)} → ${r.measure.format(r.b.mean)})`);
  const improved = rows.filter((r) => r.verdict === "better" && TARGET_IDS.includes(r.measure.id)).map((r) => r.measure.id);
  if (!improved.length && !reasons.length) reasons.push("no measure improved beyond run-to-run noise");
  return { accepted: reasons.length === 0, stage: reasons.length ? "train" : "passed", reasons, improved };
}

export function holdoutGate(rows: Row[], improved: string[]): string[] {
  const reasons: string[] = [];
  const hard = hardTotal(rows);
  if (hard && hard.b.n && hard.b.mean > hard.a.mean + 1e-9) reasons.push(`held-out customers: more hard-rule failures (${hard.a.mean.toFixed(2)} → ${hard.b.mean.toFixed(2)})`);
  for (const r of rows) if (r.verdict === "worse") reasons.push(`held-out customers: worse ${r.measure.label}`);
  const carried = improved.filter((id) => {
    const r = rows.find((x) => x.measure.id === id);
    if (!r || Number.isNaN(r.delta)) return false;
    return r.measure.better === "lower" ? r.delta < 0 : r.delta > 0;
  });
  if (improved.length && !carried.length) reasons.push(`did not carry over to held-out customers (${improved.join(", ")} not better there): it fits the training customers only`);
  return reasons;
}

export function replayGate(hardA: number, hardB: number): string[] {
  return hardB > hardA ? [`replayed real calls: more hard-rule failures (${hardA} → ${hardB})`] : [];
}

/** Ranks candidates that passed the training gate: more measures improved, then larger gains */
export function score(rows: Row[], improved: string[]): number {
  const gain = improved.reduce((a, id) => {
    const r = rows.find((x) => x.measure.id === id)!;
    const se = Math.sqrt(r.a.se ** 2 + r.b.se ** 2) || 1;
    return a + Math.abs(r.delta) / se;
  }, 0);
  return improved.length * 100 + gain;
}

// ---------------------------------------------------------------------------------------------------
// Remember: the lessons log (prompts/lab/lessons.jsonl)
// ---------------------------------------------------------------------------------------------------

export interface Lesson {
  at: string;
  run: string;
  round: number;
  title: string;
  targets: string[];
  rationale: string;
  outcome: "accepted" | "rejected";
  stage: Decision["stage"];
  reasons: string[];
  improved: string[];
}

export function lessonsForPrompt(lessons: Lesson[], max = 25): string {
  if (!lessons.length) return "(nothing tried yet)";
  return lessons
    .slice(-max)
    .map((l) => `- ${l.outcome.toUpperCase()}: "${l.title}"${l.outcome === "accepted" ? ` (improved: ${l.improved.join(", ")})` : ` — ${l.reasons.slice(0, 2).join("; ")}`}`)
    .join("\n");
}

export function parseLessons(jsonl: string): Lesson[] {
  return jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Lesson];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------

export interface RoundReport {
  round: number;
  causes: Array<{ cause: string; evidence?: string; severity?: string }>;
  candidates: Array<{ title: string; rationale: string; decision: Decision; rows?: Row[] }>;
  accepted?: string;
}

/** Measures shown in the learning curve */
export const CURVE_IDS = ["hard", "takeover", "natural", "listens", "clear", "warm", "words", "price", "accepted"];

export function learningReportHtml(r: {
  when: string;
  settings: string;
  start: { name: string; text: string };
  final: string;
  rounds: RoundReport[];
  curve: Array<{ label: string; values: Record<string, string> }>;
  curveLabels: Record<string, string>;
  digestStats: { calls: number; bySource: Record<string, number> };
}): string {
  const changed = r.final.trim() !== r.start.text.trim();
  const diff = lineDiff(r.start.text, r.final)
    .map((d) => `<div class="dl d${d.op === "+" ? "add" : d.op === "-" ? "del" : "ctx"}"><span class="op">${d.op === " " ? "&nbsp;" : d.op}</span>${esc(d.text) || "&nbsp;"}</div>`)
    .join("");
  const verdict = (d: Decision) => (d.accepted ? `<span class="v v-better">accepted</span>` : `<span class="v v-worse">refused at ${esc(d.stage)}</span>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Max Learning Report</title><style>${REPORT_CSS}</style></head><body><main>
<h1>Max learning report</h1>
<p class="muted">${esc(r.when)} · started from <b>${esc(r.start.name)}</b> · learned from ${r.digestStats.calls} calls (${esc(Object.entries(r.digestStats.bySource).map(([k, v]) => `${v} ${k}`).join(", "))}) · ${esc(r.settings)}</p>
<div class="card"><b>Result:</b> ${
    changed
      ? `${r.rounds.filter((x) => x.accepted).length} improvement${r.rounds.filter((x) => x.accepted).length === 1 ? "" : "s"} passed every gate. The new prompt is a <b>candidate</b>: it changes nothing live until a person approves it.`
      : "no candidate passed every gate; the prompt is unchanged."
  }</div>

<h2>Learning curve</h2>
<p class="muted">The current best prompt after each round, on the training customers (mean per call).</p>
<div class="scroll"><table><thead><tr><th>Measure</th>${r.curve.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
${CURVE_IDS.filter((id) => r.curveLabels[id]).map((id) => `<tr><td>${esc(r.curveLabels[id])}</td>${r.curve.map((c) => `<td class="num">${esc(c.values[id] ?? "–")}</td>`).join("")}</tr>`).join("\n")}
</tbody></table></div>

${r.rounds
  .map(
    (rd) => `<h2>Round ${rd.round}</h2>
<h3>What was going wrong</h3>
<ul>${rd.causes.map((c) => `<li><b>${esc(c.cause)}</b>${c.severity ? ` <span class="muted">(${esc(c.severity)})</span>` : ""}${c.evidence ? ` — ${esc(c.evidence)}` : ""}</li>`).join("")}</ul>
<h3>Candidates</h3>
${rd.candidates
  .map(
    (c) => `<div class="card" style="margin:8px 0"><b>${esc(c.title)}</b> ${verdict(c.decision)}<div class="muted">${esc(c.rationale)}</div>
${c.decision.improved.length ? `<div class="ok">Improved: ${esc(c.decision.improved.join(", "))}</div>` : ""}
${c.decision.reasons.map((x) => `<div class="bad">${esc(x)}</div>`).join("")}</div>`
  )
  .join("\n")}`
  )
  .join("\n")}

<h2>The learned prompt against the starting prompt</h2>
<div class="card diff">${changed ? diff : `<span class="muted">Unchanged.</span>`}</div>
</main></body></html>`;
}
