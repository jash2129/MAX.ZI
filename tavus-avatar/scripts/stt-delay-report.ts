/**
 * Speech-recognition delay per engine: the average time from the end of the customer's speech to the
 * recognizer's final result (stages.speechEnd -> stages.sttFinal, the Inspector's "stt" stage),
 * Deepgram vs the browser's recognizer.
 *
 * How to measure: make one 10-turn call with ?stt=deepgram and one with ?stt=webspeech (same room,
 * same mic, headphones), then run
 *
 *   npx tsx scripts/stt-delay-report.ts                 # calls saved locally in logs-heygen/
 *   npx tsx scripts/stt-delay-report.ts --site https://digital-fm.vercel.app
 *
 * --site signs in with DEMO_API_TOKEN (from the environment or .env.local) and reads the call logs the
 * deployment kept. Read only. --last N limits it to the N most recent calls with timing (default 20).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

type Log = {
  sessionId?: string;
  startTime?: string;
  sttEngine?: string;
  sttFallbackReason?: string;
  timingLogs?: Array<{ sttEngine?: string; stages?: { speechEnd?: number; sttFinal?: number }; stageMs?: Record<string, number> }>;
};

function envValue(name: string): string | undefined {
  if (process.env[name]?.trim()) return process.env[name]!.trim();
  if (!existsSync(".env.local")) return undefined;
  const m = readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
}

async function fromSite(base: string): Promise<Log[]> {
  const token = envValue("DEMO_API_TOKEN");
  if (!token) throw new Error("--site needs DEMO_API_TOKEN in the environment or .env.local");
  const auth = await fetch(`${base}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (!auth.ok) throw new Error(`sign-in answered ${auth.status}`);
  const cookie = auth.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const list = await fetch(`${base}/api/heygen/logs`, { headers: { cookie } }).then((r) => r.json());
  const items: Array<{ sessionId?: string; id?: string }> = Array.isArray(list) ? list : list.logs ?? list.sessions ?? [];
  const logs: Log[] = [];
  for (const it of items.slice(0, 80)) {
    const id = it.sessionId ?? it.id;
    if (!id) continue;
    const log = await fetch(`${base}/api/heygen/logs/${id}`, { headers: { cookie } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (log) logs.push(log);
  }
  return logs;
}

function fromDisk(dir = "logs-heygen"): Log[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf8")) as Log];
      } catch {
        return [];
      }
    });
}

const sttMs = (t: NonNullable<Log["timingLogs"]>[number]) =>
  t.stageMs?.stt ?? (t.stages?.speechEnd && t.stages?.sttFinal ? Math.max(0, t.stages.sttFinal - t.stages.speechEnd) : undefined);

async function main() {
  const site = arg("--site");
  const last = Number(arg("--last") ?? 20);
  const logs = (site ? await fromSite(site.replace(/\/$/, "")) : fromDisk())
    .filter((l) => (l.timingLogs ?? []).some((t) => sttMs(t) !== undefined))
    .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
    .slice(0, last);
  if (!logs.length) {
    console.log("No calls with turn timing found.");
    return;
  }

  const byEngine = new Map<string, number[]>();
  console.log("call        started                    engine      turns  avg stt");
  for (const l of logs) {
    const values: number[] = [];
    for (const t of l.timingLogs ?? []) {
      const ms = sttMs(t);
      if (ms === undefined) continue;
      // Per turn: the engine that heard it (a call can fall back mid-way); older logs only say it per call
      const engine = t.sttEngine ?? l.sttEngine ?? "webspeech (assumed: logged before sttEngine)";
      byEngine.set(engine, [...(byEngine.get(engine) ?? []), ms]);
      values.push(ms);
    }
    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    console.log(
      `${String(l.sessionId).slice(0, 10).padEnd(11)} ${String(l.startTime).padEnd(26)} ${String(l.sttEngine ?? "-").padEnd(11)} ${String(values.length).padStart(5)}  ${avg} ms` +
        (l.sttFallbackReason ? `  (fell back: ${l.sttFallbackReason})` : "")
    );
  }
  console.log("");
  for (const [engine, v] of byEngine) {
    const s = [...v].sort((a, b) => a - b);
    const avg = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
    console.log(`${engine}: ${v.length} turns, average ${avg} ms, median ${s[Math.floor(s.length / 2)]} ms, p90 ${s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]} ms`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
