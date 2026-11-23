/**
 * Max learns from calls: a loop that diagnoses what goes wrong, proposes prompt edits, tests them
 * against the current prompt, and keeps only what passes every gate (src/lib/self-learn.ts).
 * Nothing it produces is used on live calls until a person approves it.
 *
 *   npm run prompt-improve -- --rounds 2
 *   npm run prompt-improve -- --from ../prompts/lab/baseline.md --sheet "~/Downloads/Max call log - Calls.csv"
 *
 * Options:
 *   --from <file|builtin>  the prompt to improve (default: builtin, what Max runs on today)
 *   --rounds 2             improvement rounds (stops early after 2 rounds with nothing accepted)
 *   --candidates 2         prompt edits proposed per round
 *   --runs 2               calls per training customer per prompt
 *   --holdout-runs 2       calls per held-out customer per prompt (confirmation)
 *   --personas a,b         training customers (default: the 8 tester customers)
 *   --sheet <csv>          the call log sheet, downloaded as CSV: testers' ratings and notes go into
 *                          the diagnosis, and real calls' customer lines are replayed on every
 *                          candidate (--replay, default 6 calls)
 *   --sheet-last <n>       only the sheet's last n calls (sample rows and repeated Call IDs dropped)
 *   --parallel 6           calls at once
 *   --fake                 no AI: a stand-in checks the loop works (the numbers mean nothing)
 *
 * Writes:
 *   prompts/lab/learned/<time>/best.md (+ one file per accepted round)  the candidate to review
 *   prompts/lab/lessons.jsonl                                           every idea tried and its result
 *   testing-skill/reports/improve-<time>.html (+ .json)                  the learning report
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { LabCall, Variant } from "../src/lib/prompt-lab";
import type { CorpusCall, Decision, Lesson, RoundReport } from "../src/lib/self-learn";
import { callLine, chat, holdoutPersonas, installFakeAI, loadEnvLocal, out, parseJsonReply, pool, replay, reportsDir, repoRoot, silenceConsole, simulate, trainingPersonas, userPath, type Persona } from "./lab/sim";

silenceConsole();
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const intArg = (name: string, d: number) => Math.max(1, Math.floor(Number(arg(name) ?? d)) || d);


async function main() {
  const fake = args.includes("--fake");
  if (fake) installFakeAI();
  else loadEnvLocal();
  process.env.MAX_MODE = "free";
  const { DEFAULT_FREE_PROMPT } = await import("../src/lib/free-ai");
  const { measures, stat, table } = await import("../src/lib/prompt-lab");
  const sl = await import("../src/lib/self-learn");

  const rounds = intArg("--rounds", 2);
  const k = intArg("--candidates", 2);
  const runs = intArg("--runs", 2);
  const holdoutRuns = intArg("--holdout-runs", 2);
  const parallel = intArg("--parallel", 6);
  const maxReplay = Number(arg("--replay") ?? 6);
  const from = arg("--from");
  const start = !from || from === "builtin" ? { name: "built-in prompt", text: DEFAULT_FREE_PROMPT } : { name: path.basename(from), text: readFileSync(userPath(from), "utf8").replace(/\r\n/g, "\n").trim() };
  const wanted = arg("--personas")?.split(",").map((s) => s.trim());
  const train: Persona[] = trainingPersonas().filter((p) => !wanted || wanted.includes(p.id));
  const holdout = holdoutPersonas();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `improve-${stamp}`;
  // A stand-in run (--fake) writes its lessons and prompts with the (git-ignored) reports, never into prompts/lab
  const LESSONS = fake ? path.join(reportsDir, "lessons-fake.jsonl") : path.join(repoRoot, "prompts/lab/lessons.jsonl");
  const learnedRoot = fake ? path.join(reportsDir, "learned-fake") : path.join(repoRoot, "prompts/lab/learned");

  // ---- COLLECT ---------------------------------------------------------------------------------
  const fileCorpus: CorpusCall[] = [];
  for (const f of existsSync(reportsDir) ? readdirSync(reportsDir) : []) {
    try {
      if (/^prompt-lab-.*\.json$/.test(f)) fileCorpus.push(...sl.fromLabCalls(JSON.parse(readFileSync(path.join(reportsDir, f), "utf8")).calls ?? []));
      // Simulated batches in free mode only: scripted-mode calls say nothing about the prompt
      else if (/^sim-batch-.*\.json$/.test(f)) fileCorpus.push(...sl.fromSimBatch(JSON.parse(readFileSync(path.join(reportsDir, f), "utf8"))).filter((c) => c.freeMode));
    } catch {
      out(`  (skipped ${f}: not readable)`);
    }
  }
  let sheetCalls: CorpusCall[] = [];
  const sheet = arg("--sheet");
  if (sheet) {
    sheetCalls = sl.fromSheetCsv(readFileSync(userPath(sheet), "utf8"));
    if (arg("--sheet-last")) sheetCalls = sl.lastSheetCalls(sheetCalls, intArg("--sheet-last", sheetCalls.length));
    out(`call log sheet: ${sheetCalls.length} calls, ${sheetCalls.filter((c) => c.human).length} with tester ratings or notes`);
  }
  // Real calls replayed on every candidate: the ones testers rated worst first
  const replaySet = [...sheetCalls]
    // testers' 1-5 rating first; else the sheet's AI score (1-10) halved
    .sort((a, b) => (a.human?.overall ?? (a.aiScore ?? 12) / 2) - (b.human?.overall ?? (b.aiScore ?? 12) / 2))
    .slice(0, maxReplay)
    .map((c) => ({ id: c.id.replace(/[^\w-]/g, "_").slice(0, 40), lines: c.turns.map((t) => t.customer) }));

  const perRound = k * train.length * runs + 2 * holdout.length * holdoutRuns + 2 * replaySet.length;
  out(
    `Max learning loop: up to ${rounds} rounds × ${k} candidates · ${train.length} training customers × ${runs} runs · ${holdout.length} held-out customers × ${holdoutRuns} runs${replaySet.length ? ` · ${replaySet.length} real calls replayed` : ""}\n` +
      `about ${train.length * runs + rounds * perRound} calls in all${fake ? " (STAND-IN AI: --fake)" : ""}. Nothing here changes live calls.`
  );

  const lessons: Lesson[] = existsSync(LESSONS) ? sl.parseLessons(readFileSync(LESSONS, "utf8")) : [];
  const remember = (l: Lesson) => {
    lessons.push(l);
    mkdirSync(path.dirname(LESSONS), { recursive: true });
    appendFileSync(LESSONS, `${JSON.stringify(l)}\n`);
  };

  const runSet = async (personas: Persona[], nRuns: number, variant: Variant, template: string, salt: string) => {
    const jobs: Array<() => Promise<LabCall>> = [];
    for (let run = 1; run <= nRuns; run++) for (const p of personas) jobs.push(() => simulate(p, run, variant, template, { noise: 0, checks: [], judge: true, salt }));
    return pool(jobs, parallel, (c) => out(callLine(c)));
  };
  const replaySetOn = async (variant: Variant, template: string) => pool(replaySet.map((c) => () => replay(c.id, c.lines, variant, template)), parallel);
  const hardOf = (calls: LabCall[]) => calls.reduce((a, c) => a + c.scorecard.checks.filter((x) => x.severity === "hard" && !x.pass).length, 0);

  const allMeasures = measures();
  const curveLabels = Object.fromEntries(allMeasures.map((m) => [m.id, m.label]));
  const curvePoint = (label: string, calls: LabCall[]) => ({
    label,
    values: Object.fromEntries(
      sl.CURVE_IDS.map((id) => {
        const m = allMeasures.find((x) => x.id === id)!;
        const s = stat(calls.filter((c) => !c.error).map(m.of).filter((x): x is number => x !== null && Number.isFinite(x)));
        return [id, s.n ? m.format(s.mean) : "–"];
      })
    ),
  });

  // ---- the current prompt, measured once ------------------------------------------------------
  let current = start.text;
  out(`\nmeasuring the starting prompt on the training customers...`);
  let currentCalls = await runSet(train, runs, "A", current, "");
  const curve = [curvePoint("start", currentCalls)];
  const reports: RoundReport[] = [];
  const outDir = path.join(learnedRoot, stamp);
  let quiet = 0;
  let lastDigest = sl.digest([...fileCorpus, ...sheetCalls, ...sl.fromLabCalls(currentCalls)]);

  for (let round = 1; round <= rounds; round++) {
    out(`\n=== round ${round} ===`);
    // ---- DIAGNOSE ----------------------------------------------------------------------------
    const corpus = [...fileCorpus, ...sheetCalls, ...sl.fromLabCalls(currentCalls)];
    lastDigest = sl.digest(corpus);
    const diag = parseJsonReply<{ causes: Array<{ cause: string; evidence?: string; how_often?: string; severity?: string; fix_idea?: string }> }>(
      await chat(
        [
          {
            role: "system",
            content: `You diagnose why "Max", an AI finance manager on video calls with car buyers, falls short, from call data. Max runs each call from a PROMPT (how he talks, listens, paces and orders things); code separately enforces the prices, the recording disclosure and the facts.

List the most important causes, ranked by how often × how serious (hard rule broken > safety guard refusing his reply > customer experience > sales outcome). Be specific and cite the evidence (counts, quotes). Only list causes a change to Max's prompt could fix; if something needs a different price, rule, fact or code, list it with severity "needs a person".

Reply with ONLY JSON: {"causes": [{"cause": "...", "evidence": "...", "how_often": "...", "severity": "hard|reliability|experience|business|needs a person", "fix_idea": "..."}]} (at most 4)`,
          },
          { role: "user", content: lastDigest.text },
        ],
        { temperature: 0, maxTokens: 1200, json: true }
      )
    );
    const causes = (diag.causes ?? []).slice(0, 4);
    for (const c of causes) out(`  cause: ${c.cause} (${c.severity ?? "?"})`);
    const fixable = causes.filter((c) => c.severity !== "needs a person");

    // ---- PROPOSE -----------------------------------------------------------------------------
    const proposal = parseJsonReply<{ candidates: Array<{ title: string; targets?: string[]; rationale?: string; template: string }> }>(
      await chat(
        [
          {
            role: "system",
            content: `You improve the PROMPT that "Max", an AI finance manager on video calls with car buyers, runs each call from. You get the current prompt, what is going wrong, and what was tried before.

Write ${k} different candidate prompts, each a SMALL, targeted edit of the current prompt aimed at the top causes (change or add a few sentences; do not rewrite everything). Each candidate should try a different idea.

Hard rules for every candidate:
- Keep every {{placeholder}} exactly as it is.
- Keep every rule sentence about the recording disclosure, prices, the price ladder, refusals, facts, honesty about being an AI, and ending the call, word for word. You may add guidance around them, never weaken them.
- Add no numbers, prices, money words, promises, coverage details or facts.
- Do not include the reply format (JSON instructions): the app adds it.
- Do not retry an idea listed as REJECTED below unless you fix the reason it was rejected.

Reply with ONLY JSON: {"candidates": [{"title": "<short name>", "targets": ["<cause>"], "rationale": "<why this should help, one or two sentences>", "template": "<the full new prompt>"}]}`,
          },
          {
            role: "user",
            content: `<<<PROMPT\n${current}\nPROMPT>>>\n\nWHAT IS GOING WRONG (most important first):\n${(fixable.length ? fixable : causes).map((c, i) => `${i + 1}. ${c.cause} — evidence: ${c.evidence ?? "-"} — idea: ${c.fix_idea ?? "-"}`).join("\n")}\n\nTRIED BEFORE:\n${sl.lessonsForPrompt(lessons)}`,
          },
        ],
        { temperature: 0.7, maxTokens: 9000, json: true }
      )
    );
    const candidates = (proposal.candidates ?? []).slice(0, k).filter((c) => typeof c?.template === "string");

    // ---- CHECK + EVALUATE --------------------------------------------------------------------
    const rr: RoundReport = { round, causes, candidates: [] };
    const tested: Array<{ c: (typeof candidates)[number]; calls: LabCall[]; rows: ReturnType<typeof table>; decision: Decision }> = [];
    for (const c of candidates) {
      const template = c.template.replace(/\r\n/g, "\n").trim();
      const problems = sl.validateCandidate(current, template);
      if (problems.length) {
        out(`  ✗ "${c.title}": refused by the safety check: ${problems.join("; ")}`);
        const decision: Decision = { accepted: false, stage: "check", reasons: problems, improved: [] };
        rr.candidates.push({ title: c.title, rationale: c.rationale ?? "", decision });
        remember({ at: new Date().toISOString(), run: runId, round, title: c.title, targets: c.targets ?? [], rationale: c.rationale ?? "", outcome: "rejected", stage: "check", reasons: problems, improved: [] });
        continue;
      }
      out(`  testing "${c.title}" on the training customers...`);
      const calls = await runSet(train, runs, "B", template, "");
      const rows = table([...currentCalls, ...calls], allMeasures);
      tested.push({ c: { ...c, template }, calls, rows, decision: sl.trainGate(rows) });
    }

    // Best training result first; only the best goes on to confirmation (cost)
    const passing = tested.filter((t) => t.decision.accepted).sort((a, b) => sl.score(b.rows, b.decision.improved) - sl.score(a.rows, a.decision.improved));
    let acceptedNow: (typeof tested)[number] | null = null;
    if (passing.length) {
      const best = passing[0];
      out(`  "${best.c.title}" passed training (improved: ${best.decision.improved.join(", ")}); confirming on held-out customers...`);
      const salt = `holdout-${round}`;
      const hA = await runSet(holdout, holdoutRuns, "A", current, salt);
      const hB = await runSet(holdout, holdoutRuns, "B", best.c.template, salt);
      const reasons = sl.holdoutGate(table([...hA, ...hB], allMeasures), best.decision.improved);
      if (!reasons.length && replaySet.length) {
        out(`  replaying ${replaySet.length} real calls...`);
        const [rA, rB] = [await replaySetOn("A", current), await replaySetOn("B", best.c.template)];
        reasons.push(...sl.replayGate(hardOf(rA), hardOf(rB)));
      }
      best.decision = reasons.length ? { ...best.decision, accepted: false, stage: reasons[0].startsWith("replayed") ? "replay" : "holdout", reasons } : best.decision;
      if (best.decision.accepted) acceptedNow = best;
    }
    for (const t of tested) {
      // Passed training but wasn't the best: not confirmed this round (may be proposed again)
      if (t.decision.accepted && t !== acceptedNow) t.decision = { ...t.decision, accepted: false, stage: "train", reasons: ["passed training, but another candidate scored higher this round"] };
      rr.candidates.push({ title: t.c.title, rationale: t.c.rationale ?? "", decision: t.decision, rows: t.rows });
      remember({ at: new Date().toISOString(), run: runId, round, title: t.c.title, targets: t.c.targets ?? [], rationale: t.c.rationale ?? "", outcome: t.decision.accepted ? "accepted" : "rejected", stage: t.decision.stage, reasons: t.decision.reasons, improved: t.decision.improved });
      out(`  ${t.decision.accepted ? "✓ ACCEPTED" : "✗ refused"} "${t.c.title}"${t.decision.reasons.length ? `: ${t.decision.reasons.join("; ")}` : ""}`);
    }

    if (acceptedNow) {
      current = acceptedNow.c.template;
      currentCalls = acceptedNow.calls.map((c) => ({ ...c, variant: "A" as const }));
      rr.accepted = acceptedNow.c.title;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `round-${round}.md`), `${current}\n`);
      quiet = 0;
    } else quiet++;
    curve.push(curvePoint(`round ${round}${acceptedNow ? " ✓" : ""}`, currentCalls));
    reports.push(rr);
    if (quiet >= 2) {
      out(`\nno improvement for 2 rounds in a row: stopping (the prompt has converged for these customers)`);
      break;
    }
  }

  // ---- REPORT --------------------------------------------------------------------------------
  const improved = current.trim() !== start.text.trim();
  if (improved) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "best.md"), `${current}\n`);
  }
  mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `${runId}.html`);
  const settings = `${train.length} training × ${runs} runs, ${holdout.length} held-out × ${holdoutRuns} runs, ${k} candidates per round · ${fake ? "stand-in AI" : `model ${process.env.GROK_MODEL?.trim() || "default"}`}`;
  writeFileSync(file, sl.learningReportHtml({ when: new Date().toLocaleString(), settings, start, final: current, rounds: reports, curve, curveLabels, digestStats: { calls: lastDigest.calls, bySource: lastDigest.bySource } }));
  writeFileSync(file.replace(/\.html$/, ".json"), JSON.stringify({ start, final: current, rounds: reports.map((r) => ({ ...r, candidates: r.candidates.map(({ rows, ...c }) => c) })), curve }, null, 2));
  out(`\n${improved ? `learned prompt (a candidate: review, then test and approve before any live use): ${path.join(outDir, "best.md")}` : "no improvement passed every gate; the prompt is unchanged"}`);
  out(`lessons: ${LESSONS}`);
  out(`report: ${file}`);
}

main().catch((err) => {
  out(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
