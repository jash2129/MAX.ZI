/**
 * Shared by the prompt lab (scripts/prompt-lab.ts) and the improver (scripts/prompt-improve.ts):
 * AI customers calling Max in free mode on a given prompt template, the AI judge, replays of recorded
 * customer lines, and a stand-in for the AI provider (--fake).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JudgeResult, LabCall, LabTurn, Variant } from "../../src/lib/prompt-lab";

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, "../..");
export const repoRoot = path.resolve(appRoot, "..");
export const reportsDir = path.resolve(repoRoot, "testing-skill/reports");

/** The real console.log; the controller's own logging is silenced (it logs every turn) */
export const out = console.log;
export function silenceConsole() {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

export function loadEnvLocal() {
  const file = path.join(appRoot, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/** Paths the user typed are relative to where they ran npm, not to the package */
export const userPath = (p: string) => path.resolve(process.env.INIT_CWD || process.cwd(), p);

export interface Persona {
  id: string;
  name: string;
  behaviour: string;
  goal: string;
}

/** The 8 tester customers: what prompts are tuned on */
export function trainingPersonas(): Persona[] {
  return JSON.parse(readFileSync(path.join(repoRoot, "testing-skill/tester-personas.json"), "utf8")).personas;
}

/**
 * Customers the improver never tunes on (testing-skill/personas.json, a separate set written for the
 * older test harness): a change must also help them, or it only memorised the training customers.
 */
export const DEFAULT_HOLDOUT = ["cancellation_inquisitive_buyer", "ai_inquisitive_buyer", "anxious_doubtful_customer", "partial_answer_buyer"];
export function holdoutPersonas(ids: string[] = DEFAULT_HOLDOUT): Persona[] {
  const raw = JSON.parse(readFileSync(path.join(repoRoot, "testing-skill/personas.json"), "utf8"));
  const list: any[] = Array.isArray(raw) ? raw : raw.personas;
  return ids.map((id) => {
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error(`no held-out customer "${id}" in testing-skill/personas.json`);
    return {
      id: p.id,
      name: p.name,
      behaviour: `${p.system_prompt ?? ""} ${p.description ?? ""} Personality: ${p.personality ?? ""}. You talk like this: ${p.dialogue_style ?? ""}`.trim(),
      goal: "Get your concerns answered the way your character would, then decide.",
    };
  });
}

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

export async function chat(messages: Array<{ role: string; content: string }>, opts: { temperature: number; maxTokens: number; seed?: number; json?: boolean }): Promise<string> {
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

/** JSON from a model reply that may be wrapped in a code fence */
export function parseJsonReply<T = any>(raw: string): T {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? t.slice(start, end + 1) : t);
}

const clamp10 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5;
};

export async function judge(turns: LabTurn[], checks: string[]): Promise<JudgeResult> {
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
  const j = parseJsonReply(raw);
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

const MAX_TURNS = 45;

export interface SimOptions {
  noise: number;
  checks: string[];
  judge: boolean;
  /** different salts give different customer draws (a fresh sample for confirmation runs) */
  salt?: string;
}

/** Turns, score and outcome of a call that has run on `id` (shared by AI customers and replays) */
async function finish(id: string, dealConfig: any, base: Omit<LabCall, "scorecard" | "accepted" | "declined" | "finalRate">, opts: { checks: string[]; judge: boolean }): Promise<LabCall> {
  const bc = await import("../../src/lib/beat-controller");
  const { scoreCall } = await import("../../src/lib/call-scorecard");
  const { ladderOf, priceAtStage } = await import("../../src/lib/price-ladder");
  const state = bc.activeStates.get(id);
  const scorecard = scoreCall(base.turns, ladderOf(dealConfig));
  const declined = Boolean(state?.package_declined);
  // Accepted: not declined, and the call moved past the price (Beat 23 on) or was confirmed
  const accepted = !declined && (Boolean(state?.finalize_confirmed) || scorecard.furthestBeat >= 23);
  const finalRate = accepted ? (state?.free_lowest_offer ?? priceAtStage(ladderOf(dealConfig), state?.concession_stage)) : null;
  const call: LabCall = { ...base, scorecard, accepted, declined, finalRate };
  if (opts.judge && base.turns.length) {
    try {
      call.judge = await judge(base.turns, opts.checks);
    } catch (err) {
      out(`    (judge failed for ${base.persona} run ${base.run} ${base.variant}: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return call;
}

/** One call: an AI customer against Max on `template` */
export async function simulate(persona: Persona, run: number, variant: Variant, template: string, opts: SimOptions): Promise<LabCall> {
  const bc = await import("../../src/lib/beat-controller");
  const { DEFAULT_DEAL_CONFIG } = await import("../../src/lib/deal-config");
  const { STEP_0_GREETING } = await import("../../src/lib/max-lines");
  const { scoreCall } = await import("../../src/lib/call-scorecard");

  const dealConfig = { ...DEFAULT_DEAL_CONFIG, free_prompt: template };
  const id = `lab-${variant}-${persona.id}-${run}-${Math.random().toString(36).slice(2, 8)}`;
  const seed = [...`${persona.id}:${run}:${opts.salt ?? ""}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
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
    return await finish(id, dealConfig, { variant, persona: persona.id, run, turns, endedBy }, opts);
  } catch (err) {
    return { variant, persona: persona.id, run, turns, endedBy, scorecard: scoreCall(turns), accepted: false, declined: false, finalRate: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    bc.resetCallState(id);
  }
}

/**
 * A recorded call's customer lines, in order, against Max on `template` (no AI customer: the same
 * words every time). Real calls from the call log sheet become a regression suite for prompts.
 */
export async function replay(callId: string, lines: string[], variant: Variant, template: string): Promise<LabCall> {
  const bc = await import("../../src/lib/beat-controller");
  const { DEFAULT_DEAL_CONFIG } = await import("../../src/lib/deal-config");
  const { scoreCall } = await import("../../src/lib/call-scorecard");
  const dealConfig = { ...DEFAULT_DEAL_CONFIG, free_prompt: template };
  const id = `replay-${variant}-${callId}-${Math.random().toString(36).slice(2, 8)}`;
  bc.resetCallState(id);
  bc.getOrCreateCallState(id, dealConfig);
  const turns: LabTurn[] = [];
  let endedBy: LabCall["endedBy"] = "customer";
  try {
    for (const said of lines.slice(0, MAX_TURNS)) {
      const d = await bc.processControllerTurn(id, said, dealConfig);
      turns.push({ customer: said, max: d.textToSpeak, beat: d.beatId, mode: d.metrics?.mode, reason: d.metrics?.mode === "script" ? d.metrics?.freeReason : undefined });
      if (d.isScriptComplete) {
        endedBy = "max";
        break;
      }
    }
    return await finish(id, dealConfig, { variant, persona: `replay:${callId}`, run: 1, turns, endedBy }, { checks: [], judge: false });
  } catch (err) {
    return { variant, persona: `replay:${callId}`, run: 1, turns, endedBy, scorecard: scoreCall(turns), accepted: false, declined: false, finalRate: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    bc.resetCallState(id);
  }
}

/** Runs jobs `parallel` at a time, calling onDone after each */
export async function pool<T>(jobs: Array<() => Promise<T>>, parallel: number, onDone?: (r: T) => void): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, parallel), jobs.length) }, async () => {
      while (next < jobs.length) {
        const r = await jobs[next++]();
        results.push(r);
        onDone?.(r);
      }
    })
  );
  return results;
}

/** One progress line per call */
export function callLine(c: LabCall): string {
  const hard = c.scorecard.checks.filter((k) => k.severity === "hard" && !k.pass).length;
  return `  ${c.variant}  ${c.persona.padEnd(30).slice(0, 30)} run ${c.run}  ${c.error ? `failed: ${c.error}` : `beat ${String(c.scorecard.furthestBeat).padStart(2)}  ${c.accepted ? `accepted $${c.finalRate}` : c.declined ? "declined" : "no decision"}${hard ? `  ✗ ${hard} hard` : ""}${c.judge ? `  natural ${c.judge.natural}` : ""}`}`;
}

// ---------------------------------------------------------------------------------------------------
// --fake: a stand-in for the AI provider (checks the plumbing without keys or cost; numbers mean nothing)
// ---------------------------------------------------------------------------------------------------

export function installFakeAI() {
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
      // The stand-in judge prefers shorter replies, so a "brief" prompt can win in tests
      const maxWords = msgs[1]?.content.split("\n").filter((l) => l.startsWith("Max:")).map((l) => l.split(/\s+/).length) ?? [];
      const avg = maxWords.length ? maxWords.reduce((a, b) => a + b, 0) / maxWords.length : 30;
      const natural = Math.max(1, Math.min(10, Math.round(10 - avg / 10)));
      return reply(JSON.stringify({ natural, listens: natural, clear: natural, warm: 7, summary: "Stand-in judge.", checks: Array.from({ length: n }, () => ({ pass: true, why: "stand-in" })) }));
    }
    if (system.includes("You diagnose")) {
      return reply(JSON.stringify({ causes: [{ cause: "Replies are too long", evidence: "stand-in", how_often: "most calls", severity: "experience", fix_idea: "Keep replies brief" }] }));
    }
    if (system.includes("You improve")) {
      const template = /<<<PROMPT\n([\s\S]*?)\nPROMPT>>>/.exec(msgs[1]?.content ?? "")?.[1] ?? "";
      return reply(
        JSON.stringify({
          candidates: [
            { title: "Keep replies brief", targets: ["Replies are too long"], rationale: "stand-in", template: `${template}\n9. Keep every reply brief. (fake: brief)` },
            { title: "Remove the floor rule (must be refused)", targets: ["x"], rationale: "stand-in: tests the safety check", template: template.replace(/Never below \{\{floor\}\}\./, "") },
          ],
        })
      );
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
