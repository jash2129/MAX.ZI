/**
 * The prompt lab: change Max's prompt and see, measured, what the change does.
 *
 * The same AI customers (testing-skill/tester-personas.json) call Max on prompt A and on prompt B, in
 * free mode (the AI runs the call from the prompt; the code guards still apply). Every call is scored
 * (rules, how far it got, price, outcome, speed) and judged by an AI (natural, listens, clear, warm, and
 * your own checks). The report compares A and B measure by measure, against run-to-run noise, and shows
 * the conversations side by side.
 *
 *   1. Get the current prompt as a file to edit:
 *        npx tsx --conditions=react-server scripts/prompt-lab.ts --export ../prompts/lab/baseline.md
 *   2. Copy it, change it, then compare:
 *        npx tsx --conditions=react-server scripts/prompt-lab.ts --a builtin --b ../prompts/lab/mine.md
 *
 * Options:
 *   --a <file|builtin>   prompt A (default: builtin, the one Max runs on today)
 *   --b <file|builtin>   prompt B (default: the same as A: measures the noise alone)
 *   --personas a,b       only these customers (default: all 8)
 *   --runs 2             calls per customer per prompt (default 2; more runs = smaller effects visible)
 *   --check "<text>"     something you want Max to do, judged yes/no on every call (repeatable),
 *                        e.g. --check "Max mentions roadside assistance before the price"
 *   --checks <file>      one check per line
 *   --parallel 4         calls at once
 *   --noise 0            share of customer turns turned into speech-recognition glitches (default 0)
 *   --no-judge           skip the AI judge (faster, cheaper; no natural/listens/clear/warm or checks)
 *   --fake               no AI at all: a built-in stand-in plays the customer, Max and the judge.
 *                        Only for checking the lab itself works; the numbers mean nothing.
 *
 * Needs XAI_API_KEY or OPENAI_API_KEY in tavus-avatar/.env.local (GROK_MODEL picks the model; with
 * both keys, xAI is used). Writes testing-skill/reports/prompt-lab-<time>.html and .json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JudgeResult, LabCall, LabTurn, Variant } from "../src/lib/prompt-lab";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const reportsDir = path.resolve(appRoot, "../testing-skill/reports");
const personasFile = path.resolve(appRoot, "../testing-skill/tester-personas.json");

const out = console.log;
// The controller logs every turn; the lab prints only its own progress
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const argAll = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const MAX_TURNS = 45;

interface Persona {
  id: string;
  name: string;
  behaviour: string;
  goal: string;
}

function loadEnvLocal() {
  const file = path.join(appRoot, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---------------------------------------------------------------------------------------------------
// The AI customer and the AI judge
// ---------------------------------------------------------------------------------------------------

function customerPrompt(p: Persona): string {
  return `You are role-playing a customer on a live video call with "Max", an AI finance manager at a car dealership. You just agreed to buy a 2026 Mazda CX-5. Max will go over paperwork, the factory warranty, and offer a vehicle protection package with a daily price.

Who you are: ${p.name}. ${p.behaviour}
Your goal: ${p.goal}

Rules:
- Reply with ONLY what you say out loud, as speech-to-text would write it: no quotes, no stage directions, no emojis.
- Keep it natural and short (1-25 words) unless your character rambles.
- React to what Max actually said. If Max repeats himself or makes no sense, react like a real person would.
- When you want to end the call (you are done, annoyed, or Max said goodbye), reply with exactly: [HANG UP]`;
}

async function chat(messages: Array<{ role: string; content: string }>, opts: { temperature: number; maxTokens: number; seed?: number; json?: boolean }): Promise<string> {
  const xai = process.env.XAI_API_KEY?.trim();
  const key = xai || process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("XAI_API_KEY or OPENAI_API_KEY is needed (tavus-avatar/.env.local), or use --fake");
  const endpoint = xai ? "https://api.x.ai/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
  const model = process.env.GROK_MODEL?.trim() || (xai ? "grok-4.20-0309-non-reasoning" : "gpt-4o-mini");
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        messages,
        // Same customer opening on A and B (OpenAI honours it best-effort; not sent to xAI)
        ...(opts.seed !== undefined && !xai ? { seed: opts.seed } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (res.ok) return ((await res.json()).choices?.[0]?.message?.content ?? "").trim();
    last = `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`the AI did not answer (${last})`);
}

const clamp10 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5;
};

async function judge(turns: LabTurn[], checks: string[]): Promise<JudgeResult> {
  const transcript = turns.map((t) => `Customer: ${t.customer}\nMax: ${t.max}`).join("\n");
  const system = `You are judging a sales call between "Max", an AI finance manager at a car dealership, and a customer. Judge only what is in the transcript. Be strict and consistent: the same transcript must always get the same scores.

Score 1-10 (10 = excellent):
- natural: sounds like a real, skilled person talking, not a script or a robot
- listens: responds to what the customer actually said, answers their questions, does not repeat himself
- clear: easy to follow, not too long, no confusing jumps
- warm: friendly and respectful, never pushy or pressuring

${checks.length ? `Also check each of these, true or false, with a short reason quoting the call:\n${checks.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : ""}

Reply with ONLY JSON:
{"natural": n, "listens": n, "clear": n, "warm": n, "summary": "<one sentence on how Max did>", "checks": [${checks.length ? `{"pass": true|false, "why": "<short>"}, ... one per check, in order` : ""}]}`;
  const raw = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: transcript },
    ],
    { temperature: 0, maxTokens: 500, json: true }
  );
  const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());
  const list = Array.isArray(j.checks) ? j.checks : [];
  return {
    natural: clamp10(j.natural),
    listens: clamp10(j.listens),
    clear: clamp10(j.clear),
    warm: clamp10(j.warm),
    summary: String(j.summary ?? "").slice(0, 300),
    checks: Object.fromEntries(checks.map((c, i) => [c, { pass: Boolean(list[i]?.pass), why: String(list[i]?.why ?? "").slice(0, 200) }])),
  };
}

/** A recognition glitch like the real calls: a cut-off fragment, or Max's own words echoed back */
function glitch(customer: string, lastMax: string, rand: () => number): string {
  if (rand() < 0.5) return (customer.split(/\s+/).filter(Boolean)[0] ?? customer).replace(/[^\w']/g, "");
  const words = lastMax.split(/\s+/).filter(Boolean);
  if (words.length < 4) return customer.split(/\s+/)[0] ?? customer;
  const start = Math.floor(rand() * (words.length - 3));
  return words.slice(start, start + 2 + Math.floor(rand() * 4)).join(" ").replace(/[^\w' ]/g, "");
}

/** Deterministic random numbers, so A and B get the same glitches on the same turns */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------------------------------

async function simulate(persona: Persona, run: number, variant: Variant, template: string, opts: { noise: number; checks: string[]; judge: boolean }): Promise<LabCall> {
  const bc = await import("../src/lib/beat-controller");
  const { DEFAULT_DEAL_CONFIG } = await import("../src/lib/deal-config");
  const { STEP_0_GREETING } = await import("../src/lib/max-lines");
  const { scoreCall } = await import("../src/lib/call-scorecard");
  const { ladderOf, priceAtStage } = await import("../src/lib/price-ladder");

  const dealConfig = { ...DEFAULT_DEAL_CONFIG, free_prompt: template };
  const id = `lab-${variant}-${persona.id}-${run}-${Math.random().toString(36).slice(2, 8)}`;
  const seed = [...`${persona.id}:${run}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = seeded(seed);
  bc.resetCallState(id);
  bc.getOrCreateCallState(id, dealConfig);
  const history = [
    { role: "system", content: customerPrompt(persona) },
    { role: "user", content: STEP_0_GREETING },
  ];
  const turns: LabTurn[] = [];
  let endedBy: LabCall["endedBy"] = "turn limit";
  let lastMax = STEP_0_GREETING;
  try {
    for (let i = 0; i < MAX_TURNS; i++) {
      let said = await chat(history, { temperature: 0.7, maxTokens: 120, seed: seed + i });
      if (!said || said.includes("[HANG UP]")) {
        endedBy = "customer";
        break;
      }
      history.push({ role: "assistant", content: said });
      if (rand() < opts.noise) said = glitch(said, lastMax, rand);
      const t0 = Date.now();
      let firstMs: number | undefined;
      const d = await bc.processControllerTurn(id, said, dealConfig, undefined, {
        onEarly: () => {
          firstMs = Date.now() - t0;
        },
      });
      const totalMs = Date.now() - t0;
      turns.push({ customer: said, max: d.textToSpeak, beat: d.beatId, mode: d.metrics?.mode, reason: d.metrics?.mode === "script" ? d.metrics?.freeReason : undefined, firstMs: firstMs ?? totalMs, totalMs });
      history.push({ role: "user", content: d.textToSpeak });
      lastMax = d.textToSpeak;
      if (d.isScriptComplete) {
        endedBy = "max";
        break;
      }
    }
    const state = bc.activeStates.get(id);
    const scorecard = scoreCall(turns, ladderOf(dealConfig));
    const declined = Boolean(state?.package_declined);
    // Accepted: not declined, and the call moved past the price (Beat 23 on) or was confirmed
    const accepted = !declined && (Boolean(state?.finalize_confirmed) || scorecard.furthestBeat >= 23);
    const finalRate = accepted ? (state?.free_lowest_offer ?? priceAtStage(ladderOf(dealConfig), state?.concession_stage)) : null;
    const call: LabCall = { variant, persona: persona.id, run, turns, endedBy, scorecard, accepted, declined, finalRate };
    if (opts.judge && turns.length) {
      try {
        call.judge = await judge(turns, opts.checks);
      } catch (err) {
        call.error = undefined; // the call still counts; only its judged measures are missing
        out(`    (judge failed for ${persona.id} run ${run} ${variant}: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return call;
  } catch (err) {
    return { variant, persona: persona.id, run, turns, endedBy, scorecard: scoreCall(turns), accepted: false, declined: false, finalRate: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    bc.resetCallState(id);
  }
}

// ---------------------------------------------------------------------------------------------------
// --fake: a stand-in for the AI provider (checks the lab's plumbing without keys or cost)
// ---------------------------------------------------------------------------------------------------

function installFakeAI() {
  process.env.OPENAI_API_KEY = "fake";
  delete process.env.XAI_API_KEY;
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const msgs: Array<{ role: string; content: string }> = body.messages ?? [];
    const system = msgs[0]?.content ?? "";
    if (system.includes("role-playing a customer")) {
      const lastMax = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
      const turn = msgs.filter((m) => m.role === "assistant").length;
      if (/goodbye|have a great/i.test(lastMax) || turn > 40) return reply("[HANG UP]");
      if (/a day/i.test(lastMax) && !msgs.some((m) => m.role === "assistant" && /better price/.test(m.content))) return reply("Can you give me a better price?");
      return reply(turn === 0 ? "Yes, I can hear and see you, it's been great." : "Yes, that makes sense.");
    }
    if (system.includes("You are judging")) {
      const n = (system.match(/^\d+\. /gm) ?? []).length;
      return reply(JSON.stringify({ natural: 6, listens: 7, clear: 8, warm: 7, summary: "Stand-in judge.", checks: Array.from({ length: n }, () => ({ pass: true, why: "stand-in" })) }));
    }
    if (system.includes("Reply with ONLY JSON")) {
      // Free-mode Max: say the next beat of the script, as the prompt's script lists it
      const note = msgs.map((m) => m.content).join("\n");
      const next = Number(/next: Beat (\d+)/.exec(note)?.[1] ?? 1);
      const line = new RegExp(`^Beat ${next}: (.*)$`, "m").exec(system)?.[1] ?? "Let's keep going.";
      // A prompt containing "(fake: brief)" makes the stand-in Max say only the first sentence
      const say = system.includes("(fake: brief)") ? (line.match(/^[^.!?]*[.!?]/)?.[0] ?? line) : line;
      return reply(JSON.stringify({ say, beat: next, end_call: false, declined: false }));
    }
    return reply("ok");
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  const fake = args.includes("--fake");
  if (fake) installFakeAI();
  else loadEnvLocal();
  process.env.MAX_MODE = "free";
  const { DEFAULT_FREE_PROMPT, checkFreePromptTemplate } = await import("../src/lib/free-ai");
  const { reportHtml, table, measures } = await import("../src/lib/prompt-lab");

  const exportTo = arg("--export");
  if (exportTo) {
    const file = path.resolve(process.env.INIT_CWD || process.cwd(), exportTo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${DEFAULT_FREE_PROMPT}\n`);
    out(`the built-in prompt was written to ${file}\nplaceholders, filled from the dealership's approved content: {{vehicle}} {{script}} {{facts}} {{disclosure}} {{first_price}} {{price_steps}} {{floor}}`);
    return;
  }

  const load = (v: string | undefined) => {
    if (!v || v === "builtin") return { name: "built-in prompt", text: DEFAULT_FREE_PROMPT };
    const file = path.resolve(process.env.INIT_CWD || process.cwd(), v);
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

  const all: Persona[] = JSON.parse(readFileSync(personasFile, "utf8")).personas;
  const wanted = arg("--personas")?.split(",").map((s) => s.trim());
  const personas = wanted ? all.filter((p) => wanted.includes(p.id)) : all;
  if (!personas.length) throw new Error(`no matching customers; known: ${all.map((p) => p.id).join(", ")}`);
  const runs = Math.max(1, Number(arg("--runs") ?? 2));
  const parallel = Math.max(1, Number(arg("--parallel") ?? 4));
  const noise = Math.min(1, Math.max(0, Number(arg("--noise") ?? 0)));
  const checksFile = arg("--checks");
  const checks = [...argAll("--check"), ...(checksFile ? readFileSync(path.resolve(process.env.INIT_CWD || process.cwd(), checksFile), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [])];
  const useJudge = !args.includes("--no-judge");

  const jobs: Array<() => Promise<LabCall>> = [];
  for (let run = 1; run <= runs; run++)
    for (const p of personas)
      for (const [v, prompt] of [["A", promptA], ["B", promptB]] as const) jobs.push(() => simulate(p, run, v, prompt.text, { noise, checks, judge: useJudge }));

  out(`prompt lab: ${jobs.length} calls (${personas.length} customers × ${runs} runs × 2 prompts), ${parallel} at a time${fake ? ", STAND-IN AI (--fake)" : ""}${useJudge ? `, AI judge${checks.length ? ` with ${checks.length} check${checks.length === 1 ? "" : "s"}` : ""}` : ""}`);
  const calls: LabCall[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
      while (next < jobs.length) {
        const c = await jobs[next++]();
        calls.push(c);
        const hard = c.scorecard.checks.filter((k) => k.severity === "hard" && !k.pass).length;
        out(`  ${c.variant}  ${c.persona.padEnd(18)} run ${c.run}  ${c.error ? `failed: ${c.error}` : `beat ${String(c.scorecard.furthestBeat).padStart(2)}  ${c.accepted ? `accepted $${c.finalRate}` : c.declined ? "declined" : "no decision"}${hard ? `  ✗ ${hard} hard` : ""}${c.judge ? `  natural ${c.judge.natural}` : ""}`}`);
      }
    })
  );

  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(reportsDir, `prompt-lab-${stamp}.html`);
  const settings = `${personas.length} customers × ${runs} runs · glitches ${Math.round(noise * 100)}% · ${fake ? "stand-in AI" : `model ${process.env.GROK_MODEL?.trim() || (process.env.XAI_API_KEY ? "xAI default" : "OpenAI default")}`}`;
  writeFileSync(file, reportHtml({ title: "Prompt Lab", when: new Date().toLocaleString(), promptA, promptB, calls, checks, settings }));
  writeFileSync(file.replace(/\.html$/, ".json"), JSON.stringify({ promptA, promptB, checks, settings, calls }, null, 2));

  // The headline in the terminal too
  const rows = table(calls, measures(checks));
  const moved = rows.filter((r) => r.verdict === "better" || r.verdict === "worse" || r.verdict === "changed");
  out(moved.length ? `\nchanged beyond noise:\n${moved.map((r) => `  ${r.verdict.padEnd(7)} ${r.measure.label}: ${r.measure.format(r.a.mean)} -> ${r.measure.format(r.b.mean)}`).join("\n")}` : "\nno change beyond run-to-run noise");
  out(`report: ${file}`);
}

main().catch((err) => {
  out(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
