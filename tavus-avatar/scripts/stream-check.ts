/**
 * Checks streaming on a deployed site without a voice call: signs in, plays a short text conversation
 * through /api/chat/grok with stream:true, and reports for each turn whether Max's first sentences
 * arrived early ({"type":"early"}) and how long until they did, against the whole reply.
 *
 *   npx tsx scripts/stream-check.ts --site https://digital-fm.vercel.app
 *
 * Needs DEMO_API_TOKEN (environment or .env.local). Uses its own test session ("stream-check-..."),
 * never ends a call, so nothing is sent to the call log sheet. Each turn costs one or two AI calls.
 */
import { existsSync, readFileSync } from "fs";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};

function envValue(name: string): string | undefined {
  if (process.env[name]?.trim()) return process.env[name]!.trim();
  if (!existsSync(".env.local")) return undefined;
  const m = readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
}

// A cooperative customer with some longer replies, so the AI has something to word
const TURNS = [
  "Yes, I can hear and see you fine. Honestly it's been a great experience so far.",
  "Sure, that's fine with me, go ahead.",
  "Yes I did, I took it out on the highway yesterday and it drove really smoothly.",
  "Yeah, the salesman showed me everything, the screen, the safety features, all of it.",
  "I think the factory warranty covers the engine and stuff for a few years, right?",
  "Oh man, my last car blew a transmission two months after the warranty ended. Cost me a fortune.",
];

async function main() {
  const site = (arg("--site") ?? "https://digital-fm.vercel.app").replace(/\/$/, "");
  const token = envValue("DEMO_API_TOKEN");
  if (!token) throw new Error("needs DEMO_API_TOKEN in the environment or .env.local");
  const auth = await fetch(`${site}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (!auth.ok) throw new Error(`sign-in answered ${auth.status}`);
  const cookie = auth.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const headers = { "Content-Type": "application/json", cookie };

  const warm = await fetch(`${site}/api/chat/grok`, { method: "POST", headers, body: JSON.stringify({ action: "warmup" }) }).then((r) => r.json());
  console.log(`MAX_STREAM on the site: ${warm.streaming ? "on" : "OFF (set MAX_STREAM=on and redeploy)"}`);
  const health: Record<string, string | undefined> = await fetch(`${site}/api/health`, { headers }).then((r) => (r.ok ? r.json() : {}));
  console.log(`deployment ${health.deployment ?? "?"} · mode ${health.mode ?? "?"} · speech ${health.speech ?? "?"} · understanding ${health.understanding ?? "?"}\n`);

  const sessionId = `stream-check-${Date.now()}`;
  const messages: Array<{ role: string; content: string }> = [{ role: "assistant", content: "Can you hear and see me alright?" }];
  const firsts: number[] = [];
  const wholes: number[] = [];
  for (const [i, said] of TURNS.entries()) {
    messages.push({ role: "user", content: said });
    const t0 = Date.now();
    const res = await fetch(`${site}/api/chat/grok`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, turnId: i + 1, stream: true, messages }),
    });
    const ctype = res.headers.get("content-type") ?? "";
    let earlyAt: number | undefined;
    let early = "";
    let final: any = null;
    if (ctype.includes("ndjson") && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === "early") {
            earlyAt = Date.now() - t0;
            early = msg.text;
          } else if (msg.type === "final") final = msg;
        }
      }
    } else final = await res.json();
    const whole = Date.now() - t0;
    wholes.push(whole);
    firsts.push(earlyAt ?? whole);
    const m = final?.metrics ?? {};
    const who = m.mode === "free" ? "free AI" : m.combined ? "one-call Option C" : m.speech === "ai" ? "Option C wording" : "script";
    console.log(`Turn ${i + 1} (Beat ${m.beatBefore ?? "?"} -> ${final?.currentBeatId ?? "?"}, ${who})`);
    console.log(`  customer: ${said}`);
    console.log(earlyAt !== undefined ? `  EARLY after ${earlyAt} ms: ${early}` : `  no early part (${ctype.includes("ndjson") ? "nothing to stream this turn" : "server answered plain JSON"})`);
    console.log(`  whole reply after ${whole} ms: ${final?.text ?? "(none)"}`);
    // As the call screen does: the reply was heard
    await fetch(`${site}/api/chat/grok`, { method: "POST", headers, body: JSON.stringify({ action: "commit", sessionId, turnId: i + 1, delivered: true, spokenFraction: 1 }) });
    messages.push({ role: "assistant", content: final?.text ?? "" });
  }
  const avg = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  console.log(`\nMax could start speaking after avg ${avg(firsts)} ms (whole reply avg ${avg(wholes)} ms), early part on ${firsts.filter((f, i) => f < wholes[i]).length} of ${TURNS.length} turns.`);
  console.log("These times include the network from this machine to the site; HeyGen's own start-up is not included.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
