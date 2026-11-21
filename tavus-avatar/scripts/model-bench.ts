/**
 * Which model should run Max? Plays the same call moments through Max's real free-mode turn
 * (MAX_MODE=free: full script prompt, the guards, the retry) on each model and reports the time per
 * reply, how often the guards rejected a reply, and one sample answer each.
 *
 *   npx tsx --conditions=react-server scripts/model-bench.ts [--models a,b,c] [--rounds 3]
 *
 * Needs XAI_API_KEY in .env.local. Costs a few cents of API credit.
 */
import { existsSync, readFileSync } from "fs";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// Call moments: where the call is, and what the customer says
const MOMENTS: Array<{ label: string; beat: number; disclosed: boolean; lowest?: number; customer: string }> = [
  { label: "opening chat", beat: 0, disclosed: false, customer: "Yeah I can hear you fine. Honestly it's been a long day but the salesman was great." },
  { label: "question mid-script", beat: 6, disclosed: true, customer: "Wait, what does powertrain actually mean? Is that the engine?" },
  { label: "story", beat: 9, disclosed: true, customer: "Oh man, my last car blew a transmission two months after the warranty ended. Cost me a fortune." },
  { label: "pushback at the price", beat: 22, disclosed: true, lowest: 4, customer: "Four dollars a day? No, that's too much for me." },
  { label: "asks for a human", beat: 12, disclosed: true, customer: "Can I just talk to a real person instead?" },
];

async function main() {
  loadEnvLocal();
  process.env.MAX_MODE = "free";
  delete process.env.MAX_SPEECH;
  delete process.env.MAX_UNDERSTANDING;
  const bc = await import("../src/lib/beat-controller");
  const { DEFAULT_DEAL_CONFIG } = await import("../src/lib/deal-config");
  const models = (arg("--models") ?? "grok-4.20-0309-non-reasoning,grok-4.3,grok-4.5,grok-4.6,grok-4.7").split(",").map((s) => s.trim());
  const rounds = Number(arg("--rounds") ?? 3);

  const summary: string[] = [];
  for (const model of models) {
    process.env.FREE_AI_MODEL = model;
    const ms: number[] = [];
    let free = 0;
    let retries = 0;
    let fallbacks = 0;
    const reasons: string[] = [];
    const retryReasons: string[] = [];
    const samples: string[] = [];
    for (let r = 0; r < rounds; r++) {
      for (const m of MOMENTS) {
        const sid = `bench_${model}_${r}_${m.beat}_${Math.random().toString(36).slice(2, 6)}`;
        bc.resetCallState(sid);
        const st = bc.getOrCreateCallState(sid);
        if (m.beat >= 1) {
          st.step0_completed = true;
          st.current_beat = m.beat;
          st.delivered_beats = Array.from({ length: m.beat }, (_, i) => i + 1);
          st.free_disclosure_given = m.disclosed;
          st.free_history = [
            { role: "assistant", content: "Can you hear and see me alright?" },
            { role: "user", content: "Yes, and it's been good." },
            { role: "assistant", content: bc.FREE_DISCLOSURE + " Is that okay?" },
            { role: "user", content: "Sure." },
            { role: "assistant", content: bc.BEATS.find((b) => b.id === m.beat)?.text ?? "" },
          ];
        }
        if (m.lowest !== undefined) st.free_lowest_offer = m.lowest;
        const t0 = Date.now();
        const d = await bc.processControllerTurn(sid, m.customer, DEFAULT_DEAL_CONFIG);
        const elapsed = Date.now() - t0;
        if (d.metrics?.mode === "free") {
          free++;
          ms.push(d.metrics.freeMs ?? elapsed);
          if ((d.metrics.freeAttempts ?? 1) > 1) {
            retries++;
            retryReasons.push(d.metrics.freeReason ?? "?");
          }
        } else {
          fallbacks++;
          reasons.push(d.metrics?.freeReason ?? "?");
        }
        if (r === 0) samples.push(`  [${m.label}] ${d.metrics?.mode === "free" ? "" : "(SCRIPT) "}${d.textToSpeak}`);
      }
    }
    const sorted = [...ms].sort((a, b) => a - b);
    const avg = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
    const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;
    const total = rounds * MOMENTS.length;
    const line = `${model.padEnd(30)} free ${free}/${total}  retries ${retries}  script took over ${fallbacks}  avg ${avg} ms  p90 ${p90} ms`;
    summary.push(
      line +
        (reasons.length ? `\n${" ".repeat(32)}took over because: ${[...new Set(reasons)].join(" | ")}` : "") +
        (retryReasons.length ? `\n${" ".repeat(32)}retried because: ${retryReasons.join(" | ")}` : "")
    );
    console.log(`\n=== ${model} ===\n${line}\n${samples.join("\n")}`);
  }
  console.log(`\n=== SUMMARY ===\n${summary.join("\n")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
