/**
 * The prompt lab: change Max's prompt and see, measured, what the change does.
 *
 * The same AI customers (testing-skill/tester-personas.json) call Max on prompt A and on prompt B, in
 * free mode (the AI runs the call from the prompt; the code guards still apply). Every call is scored
 * (rules, how far it got, price, outcome, speed) and judged by an AI (natural, listens, clear, warm, and
 * your own checks). The report compares A and B measure by measure, against run-to-run noise, and shows
 * the conversations side by side. How to use it: prompts/lab/README.md.
 *
 *   npm run prompt-lab -- --export ../prompts/lab/baseline.md
 *   npm run prompt-lab -- --a ../prompts/lab/baseline.md --b ../prompts/lab/mine.md
 *
 * Options: --a / --b <file|builtin>, --personas a,b, --runs 2, --check "<text>" (repeatable),
 * --checks <file>, --parallel 4, --noise 0, --no-judge, --fake (no AI: checks the plumbing only).
 * Writes testing-skill/reports/prompt-lab-<time>.html and .json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { LabCall } from "../src/lib/prompt-lab";
import { callLine, installFakeAI, loadEnvLocal, out, pool, reportsDir, silenceConsole, simulate, trainingPersonas, userPath } from "./lab/sim";

silenceConsole();
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const argAll = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));

async function main() {
  const fake = args.includes("--fake");
  if (fake) installFakeAI();
  else loadEnvLocal();
  process.env.MAX_MODE = "free";
  const { DEFAULT_FREE_PROMPT, checkFreePromptTemplate } = await import("../src/lib/free-ai");
  const { reportHtml, table, measures } = await import("../src/lib/prompt-lab");

  const exportTo = arg("--export");
  if (exportTo) {
    const file = userPath(exportTo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${DEFAULT_FREE_PROMPT}\n`);
    out(`the built-in prompt was written to ${file}\nplaceholders, filled from the dealership's approved content: {{vehicle}} {{script}} {{facts}} {{disclosure}} {{first_price}} {{price_steps}} {{floor}}`);
    return;
  }

  const load = (v: string | undefined) => {
    if (!v || v === "builtin") return { name: "built-in prompt", text: DEFAULT_FREE_PROMPT };
    const file = userPath(v);
    if (!existsSync(file)) throw new Error(`no such prompt file: ${file}`);
    return { name: path.basename(file), text: readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim() };
  };
  const promptA = load(arg("--a"));
  const promptB = arg("--b") ? load(arg("--b")) : { ...promptA, name: `${promptA.name} (again)` };
  for (const [label, p] of [["A", promptA], ["B", promptB]] as const) {
    const { unknown, missing } = checkFreePromptTemplate(p.text);
    if (unknown.length) throw new Error(`prompt ${label} has unknown placeholders: ${unknown.map((u) => `{{${u}}}`).join(", ")}`);
    if (missing.length) out(`note: prompt ${label} does not use ${missing.map((m) => `{{${m}}}`).join(", ")} (Max won't see that content)`);
  }

  const all = trainingPersonas();
  const wanted = arg("--personas")?.split(",").map((s) => s.trim());
  const personas = wanted ? all.filter((p) => wanted.includes(p.id)) : all;
  if (!personas.length) throw new Error(`no matching customers; known: ${all.map((p) => p.id).join(", ")}`);
  const runs = Math.max(1, Number(arg("--runs") ?? 2));
  const parallel = Math.max(1, Number(arg("--parallel") ?? 4));
  const noise = Math.min(1, Math.max(0, Number(arg("--noise") ?? 0)));
  const checksFile = arg("--checks");
  const checks = [...argAll("--check"), ...(checksFile ? readFileSync(userPath(checksFile), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [])];
  const useJudge = !args.includes("--no-judge");

  const jobs: Array<() => Promise<LabCall>> = [];
  for (let run = 1; run <= runs; run++)
    for (const p of personas)
      for (const [v, prompt] of [["A", promptA], ["B", promptB]] as const) jobs.push(() => simulate(p, run, v, prompt.text, { noise, checks, judge: useJudge }));

  out(`prompt lab: ${jobs.length} calls (${personas.length} customers × ${runs} runs × 2 prompts), ${parallel} at a time${fake ? ", STAND-IN AI (--fake)" : ""}${useJudge ? `, AI judge${checks.length ? ` with ${checks.length} check${checks.length === 1 ? "" : "s"}` : ""}` : ""}`);
  const calls = await pool(jobs, parallel, (c) => out(callLine(c)));

  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(reportsDir, `prompt-lab-${stamp}.html`);
  const settings = `${personas.length} customers × ${runs} runs · glitches ${Math.round(noise * 100)}% · ${fake ? "stand-in AI" : `model ${process.env.GROK_MODEL?.trim() || (process.env.XAI_API_KEY ? "xAI default" : "OpenAI default")}`}`;
  writeFileSync(file, reportHtml({ title: "Prompt Lab", when: new Date().toLocaleString(), promptA, promptB, calls, checks, settings }));
  writeFileSync(file.replace(/\.html$/, ".json"), JSON.stringify({ promptA, promptB, checks, settings, calls }, null, 2));

  const rows = table(calls, measures(checks));
  const moved = rows.filter((r) => r.verdict === "better" || r.verdict === "worse" || r.verdict === "changed");
  out(moved.length ? `\nchanged beyond noise:\n${moved.map((r) => `  ${r.verdict.padEnd(7)} ${r.measure.label}: ${r.measure.format(r.a.mean)} -> ${r.measure.format(r.b.mean)}`).join("\n")}` : "\nno change beyond run-to-run noise");
  out(`report: ${file}`);
}

main().catch((err) => {
  out(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
