/**
 * The prompt lab: what a prompt change does to Max, measured (scripts/prompt-lab.ts runs it).
 *
 * The same AI customers call Max twice, once on prompt A and once on prompt B. Every call is scored
 * the same way, and each measure is compared A against B with its run-to-run noise: the AI never
 * answers exactly the same way twice, so a difference only counts when it is larger than that noise.
 *
 * This file is pure (no AI, no files): measures, statistics, the prompt diff and the HTML report.
 */
import type { Scorecard, ScoredTurn } from "./call-scorecard";

export type Variant = "A" | "B";

export interface LabTurn extends ScoredTurn {
  /** free = the AI's reply was used; script = a guard refused it and the approved script answered */
  mode?: "free" | "script";
  /** why the script took over, when it did */
  reason?: string;
  /** when Max could start speaking, and the whole reply, in ms */
  firstMs?: number;
  totalMs?: number;
}

export interface JudgeResult {
  /** 1-10 */
  natural: number;
  listens: number;
  clear: number;
  warm: number;
  summary: string;
  /** the custom checks, by their text */
  checks: Record<string, { pass: boolean; why: string }>;
}

export interface LabCall {
  variant: Variant;
  persona: string;
  run: number;
  turns: LabTurn[];
  endedBy: "customer" | "max" | "turn limit";
  scorecard: Scorecard;
  accepted: boolean;
  declined: boolean;
  /** the daily rate agreed, when accepted */
  finalRate: number | null;
  judge?: JudgeResult;
  error?: string;
}

/** A measure: higher is better, lower is better, or neither (shown, never judged) */
export interface Measure {
  id: string;
  label: string;
  better: "higher" | "lower" | "neither";
  /** formats a mean for display */
  format: (v: number) => string;
  /** one number per call; null = not applicable to this call */
  of: (c: LabCall) => number | null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const num1 = (v: number) => v.toFixed(1);
const ms = (v: number) => `${Math.round(v)} ms`;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function measures(checkTexts: string[] = []): Measure[] {
  const base: Measure[] = [
    { id: "hard", label: "Hard rule failures per call", better: "lower", format: num1, of: (c) => c.scorecard.checks.filter((k) => k.severity === "hard" && !k.pass).length },
    { id: "flags", label: "Soft flags per call", better: "lower", format: num1, of: (c) => c.scorecard.checks.filter((k) => k.severity !== "hard" && !k.pass).length },
    {
      id: "takeover",
      label: "Turns where a guard refused the AI (script answered)",
      better: "lower",
      format: pct,
      of: (c) => {
        const tried = c.turns.filter((t) => t.mode);
        return tried.length ? tried.filter((t) => t.mode === "script").length / tried.length : null;
      },
    },
    { id: "price", label: "Reached the price (Beat 22+)", better: "higher", format: pct, of: (c) => (c.scorecard.reachedPrice ? 1 : 0) },
    { id: "completed", label: "Finished the script (Beat 25)", better: "higher", format: pct, of: (c) => (c.scorecard.completed ? 1 : 0) },
    { id: "accepted", label: "Customer took the package", better: "higher", format: pct, of: (c) => (c.accepted ? 1 : 0) },
    { id: "rate", label: "Agreed daily rate (accepted calls)", better: "higher", format: (v) => `$${v.toFixed(2)}`, of: (c) => c.finalRate },
    { id: "beat", label: "Furthest beat", better: "higher", format: num1, of: (c) => c.scorecard.furthestBeat },
    { id: "turns", label: "Turns per call", better: "neither", format: num1, of: (c) => c.turns.length },
    { id: "words", label: "Words per Max reply", better: "neither", format: num1, of: (c) => (c.turns.length ? c.turns.reduce((a, t) => a + words(t.max), 0) / c.turns.length : null) },
    {
      id: "first_ms",
      label: "Max starts speaking after (median per call)",
      better: "lower",
      format: ms,
      of: (c) => {
        const v = c.turns.map((t) => t.firstMs ?? t.totalMs).filter((x): x is number => typeof x === "number");
        return v.length ? median(v) : null;
      },
    },
    { id: "natural", label: "Sounds natural (AI judge, 1-10)", better: "higher", format: num1, of: (c) => c.judge?.natural ?? null },
    { id: "listens", label: "Listens and responds to the customer (1-10)", better: "higher", format: num1, of: (c) => c.judge?.listens ?? null },
    { id: "clear", label: "Clear and easy to follow (1-10)", better: "higher", format: num1, of: (c) => c.judge?.clear ?? null },
    { id: "warm", label: "Warm, not pushy (1-10)", better: "higher", format: num1, of: (c) => c.judge?.warm ?? null },
  ];
  const custom: Measure[] = checkTexts.map((text, i) => ({
    id: `check_${i + 1}`,
    label: `Your check: ${text}`,
    better: "higher",
    format: pct,
    of: (c) => {
      const r = c.judge?.checks?.[text];
      return r ? (r.pass ? 1 : 0) : null;
    },
  }));
  return [...custom, ...base];
}

export interface Stat {
  n: number;
  mean: number;
  /** standard error of the mean */
  se: number;
}

export function stat(values: number[]): Stat {
  const n = values.length;
  if (!n) return { n: 0, mean: NaN, se: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, se: NaN };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { n, mean, se: Math.sqrt(variance / n) };
}

export type Verdict = "better" | "worse" | "changed" | "same" | "noise" | "too few calls";

/**
 * B against A. A difference counts when it is more than twice its standard error (about 95%
 * confidence for large samples; a rough guide for small ones). With no spread on either side, any
 * difference counts.
 */
export function compare(a: Stat, b: Stat, better: Measure["better"]): { delta: number; verdict: Verdict } {
  if (a.n < 2 || b.n < 2 || Number.isNaN(a.mean) || Number.isNaN(b.mean)) return { delta: b.mean - a.mean, verdict: "too few calls" };
  const delta = b.mean - a.mean;
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  if (Math.abs(delta) < 1e-9) return { delta, verdict: "same" };
  if (se > 0 && Math.abs(delta) <= 2 * se) return { delta, verdict: "noise" };
  if (better === "neither") return { delta, verdict: "changed" };
  const up = delta > 0;
  return { delta, verdict: (better === "higher") === up ? "better" : "worse" };
}

export interface Row {
  measure: Measure;
  a: Stat;
  b: Stat;
  delta: number;
  verdict: Verdict;
}

export function table(calls: LabCall[], ms_: Measure[], persona?: string): Row[] {
  const ok = calls.filter((c) => !c.error && (!persona || c.persona === persona));
  return ms_.map((m) => {
    const vals = (v: Variant) => ok.filter((c) => c.variant === v).map(m.of).filter((x): x is number => x !== null && Number.isFinite(x));
    const a = stat(vals("A"));
    const b = stat(vals("B"));
    return { measure: m, a, b, ...compare(a, b, m.better) };
  });
}

/** Line diff of two prompts (longest common subsequence) */
export type DiffLine = { op: " " | "-" | "+"; text: string };
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}

/** The first turn where Max said something different in A and in B (-1: never) */
export function firstDivergence(a: LabTurn[], b: LabTurn[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i]?.max !== b[i]?.max || a[i]?.customer !== b[i]?.customer) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const VERDICT_TEXT: Record<Verdict, string> = {
  better: "B better",
  worse: "B worse",
  changed: "changed",
  same: "same",
  noise: "within noise",
  "too few calls": "too few calls",
};

function cell(s: Stat, m: Measure): string {
  if (!s.n || Number.isNaN(s.mean)) return `<td class="num muted">–</td>`;
  return `<td class="num">${esc(m.format(s.mean))}${Number.isNaN(s.se) ? "" : `<span class="se"> ±${esc(m.format(2 * s.se).replace(/^\$/, "$"))}</span>`}</td>`;
}

function deltaText(r: Row): string {
  if (Number.isNaN(r.delta)) return "–";
  const sign = r.delta > 0 ? "+" : r.delta < 0 ? "−" : "";
  return `${sign}${r.measure.format(Math.abs(r.delta))}`;
}

function rowsHtml(rows: Row[]): string {
  return rows
    .map(
      (r) =>
        `<tr><td>${esc(r.measure.label)}</td>${cell(r.a, r.measure)}${cell(r.b, r.measure)}<td class="num">${esc(deltaText(r))}</td><td><span class="v v-${r.verdict.replace(/ /g, "-")}">${esc(VERDICT_TEXT[r.verdict])}</span></td></tr>`
    )
    .join("\n");
}

/** The report pages' styles (light and dark), shared with the improver's report */
export const REPORT_CSS = `:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--card:#fff;--ok:#1f7a3d;--bad:#b42318;--warn:#9a6700;--add:#e7f5ec;--del:#fde8e6;--hl:#fff4cc;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161615;--fg:#ececea;--muted:#9a9a94;--line:#2e2e2b;--card:#1e1e1c;--ok:#5cc785;--bad:#ff7b6e;--warn:#e0b341;--add:#173323;--del:#3a1d1a;--hl:#3a3315;--accent:#8aa8ff}}
:root[data-theme="dark"]{--bg:#161615;--fg:#ececea;--muted:#9a9a94;--line:#2e2e2b;--card:#1e1e1c;--ok:#5cc785;--bad:#ff7b6e;--warn:#e0b341;--add:#173323;--del:#3a1d1a;--hl:#3a3315;--accent:#8aa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}h3{font-size:15px;margin:20px 0 6px}
.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;font-size:13px;color:var(--muted)}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}.se{color:var(--muted);font-size:12px}
.v{font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap;border:1px solid var(--line)}
.v-better{color:var(--ok);border-color:var(--ok)}.v-worse{color:var(--bad);border-color:var(--bad)}.v-changed{color:var(--accent);border-color:var(--accent)}.v-within-noise,.v-same,.v-too-few-calls{color:var(--muted)}
.diff{font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-x:auto}.dl{white-space:pre-wrap;padding:0 8px}.dadd{background:var(--add)}.ddel{background:var(--del)}.op{display:inline-block;width:16px;color:var(--muted)}.fold{color:var(--muted);padding:2px 8px;font-style:italic}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:760px){.pair{grid-template-columns:1fr}}
.col{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}.col .meta{font-weight:600;margin-bottom:4px}.sum{color:var(--muted);margin:4px 0}
.tx{padding-left:22px;margin:8px 0 0}.tx li{margin:0 0 8px}.tx .cu{color:var(--muted)}.tx .mx{overflow-wrap:anywhere}.tx li.div{background:var(--hl);border-radius:6px;padding:4px}.tag{font-size:12px;color:var(--warn)}
details>summary{cursor:pointer;font-weight:600;margin:10px 0}.pills span{display:inline-block;margin:2px 6px 2px 0}
`;

export interface ReportInput {
  title: string;
  when: string;
  promptA: { name: string; text: string };
  promptB: { name: string; text: string };
  calls: LabCall[];
  checks: string[];
  settings: string;
}

export function reportHtml(r: ReportInput): string {
  const ms_ = measures(r.checks);
  const overall = table(r.calls, ms_);
  const personas = [...new Set(r.calls.map((c) => c.persona))];
  const diff = lineDiff(r.promptA.text, r.promptB.text);
  const changed = diff.some((d) => d.op !== " ");
  const counts = (v: Variant) => r.calls.filter((c) => c.variant === v && !c.error).length;
  const errors = r.calls.filter((c) => c.error);
  const headline = overall.filter((x) => x.verdict === "better" || x.verdict === "worse");

  // Diff: changed lines with 2 lines of context; long unchanged runs folded
  const keep = diff.map((d, i) => d.op !== " " || diff.slice(Math.max(0, i - 2), i + 3).some((e) => e.op !== " "));
  let diffHtml = "";
  let folded = 0;
  diff.forEach((d, i) => {
    if (!keep[i]) {
      folded++;
      return;
    }
    if (folded) diffHtml += `<div class="fold">… ${folded} unchanged line${folded === 1 ? "" : "s"} …</div>`;
    folded = 0;
    diffHtml += `<div class="dl d${d.op === "+" ? "add" : d.op === "-" ? "del" : "ctx"}"><span class="op">${d.op === " " ? "&nbsp;" : d.op}</span>${esc(d.text) || "&nbsp;"}</div>`;
  });
  if (folded) diffHtml += `<div class="fold">… ${folded} unchanged line${folded === 1 ? "" : "s"} …</div>`;

  const pairs = personas.flatMap((p) => {
    const runs = [...new Set(r.calls.filter((c) => c.persona === p).map((c) => c.run))].sort((x, y) => x - y);
    return runs.map((run) => ({ p, run, a: r.calls.find((c) => c.persona === p && c.run === run && c.variant === "A"), b: r.calls.find((c) => c.persona === p && c.run === run && c.variant === "B") }));
  });

  const side = (c: LabCall | undefined, other: LabCall | undefined, at: number) => {
    if (!c) return `<div class="col muted">(no call)</div>`;
    if (c.error) return `<div class="col bad">Call failed: ${esc(c.error)}</div>`;
    const hard = c.scorecard.checks.filter((k) => !k.pass);
    const outcome = c.accepted ? `accepted at $${c.finalRate}` : c.declined ? "declined" : "no decision";
    return `<div class="col">
      <div class="meta">Beat ${c.scorecard.furthestBeat} · ${esc(outcome)} · ${c.turns.length} turns · ended by ${esc(c.endedBy)}${c.judge ? ` · natural ${c.judge.natural}/10` : ""}</div>
      ${hard.map((k) => `<div class="${k.severity === "hard" ? "bad" : "warn"}">${k.severity === "hard" ? "FAIL" : "flag"}: ${esc(k.label)}${k.detail ? ` — ${esc(k.detail)}` : ""}</div>`).join("")}
      ${c.judge?.summary ? `<div class="sum">${esc(c.judge.summary)}</div>` : ""}
      ${Object.entries(c.judge?.checks ?? {}).map(([t, v]) => `<div class="${v.pass ? "ok" : "bad"}">${v.pass ? "✓" : "✗"} ${esc(t)}${v.why ? ` — ${esc(v.why)}` : ""}</div>`).join("")}
      <ol class="tx">${c.turns
        .map((t, i) => {
          const tag = t.mode === "script" ? ` <span class="tag">script took over${t.reason ? `: ${esc(t.reason)}` : ""}</span>` : "";
          return `<li class="${i === at ? "div" : ""}${i > at && at >= 0 ? " after" : ""}"><div class="cu">${esc(t.customer)}</div><div class="mx"><b>Max</b> · beat ${t.beat}${tag}<br>${esc(t.max)}</div></li>`;
        })
        .join("")}</ol>
    </div>`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prompt Lab Report</title>
<style>
${REPORT_CSS}</style></head><body><main>
<h1>${esc(r.title)}</h1>
<p class="muted">${esc(r.when)} · A: <b>${esc(r.promptA.name)}</b> (${counts("A")} calls) · B: <b>${esc(r.promptB.name)}</b> (${counts("B")} calls) · ${esc(r.settings)}</p>
${errors.length ? `<p class="bad">${errors.length} call${errors.length === 1 ? "" : "s"} failed to run (left out of the numbers).</p>` : ""}

<div class="card"><b>What changed:</b> ${
    headline.length
      ? `<span class="pills">${headline.map((h) => `<span class="v v-${h.verdict}">${esc(h.verdict === "better" ? "▲" : "▼")} ${esc(h.measure.label)} ${esc(deltaText(h))}</span>`).join("")}</span>`
      : `nothing beyond run-to-run noise${overall.some((x) => x.verdict === "too few calls") ? " (some measures had too few calls; use more --runs)" : ""}.`
  }</div>

<h2>The prompt change</h2>
<div class="card diff">${changed ? diffHtml : `<span class="muted">A and B are the same prompt: this run measures the noise alone.</span>`}</div>

<h2>Results, A against B</h2>
<p class="muted">Each value is the mean per call, ± two standard errors. "Within noise": the difference is no larger than the run-to-run spread, so it may be chance. Run more calls (--runs) to see smaller effects.</p>
<div class="scroll"><table><thead><tr><th>Measure</th><th>A</th><th>B</th><th>B − A</th><th></th></tr></thead><tbody>
${rowsHtml(overall)}
</tbody></table></div>

<h2>By customer</h2>
${personas
  .map((p) => {
    const rows = table(r.calls, ms_, p).filter((x) => ["hard", "takeover", "price", "accepted", "rate", "natural", "listens"].includes(x.measure.id) || x.measure.id.startsWith("check_"));
    return `<details><summary>${esc(p)}</summary><div class="scroll"><table><thead><tr><th>Measure</th><th>A</th><th>B</th><th>B − A</th><th></th></tr></thead><tbody>${rowsHtml(rows)}</tbody></table></div></details>`;
  })
  .join("\n")}

<h2>Conversations side by side</h2>
<p class="muted">Same customer, same run number. The highlighted turn is where the two calls first went differently.</p>
${pairs
  .map(({ p, run, a, b }) => {
    const at = a && b && !a.error && !b.error ? firstDivergence(a.turns, b.turns) : -1;
    return `<details><summary>${esc(p)} · run ${run}${at >= 0 ? ` · first difference at turn ${at + 1}` : ""}</summary><div class="pair">${side(a, b, at)}${side(b, a, at)}</div></details>`;
  })
  .join("\n")}
</main></body></html>`;
}
