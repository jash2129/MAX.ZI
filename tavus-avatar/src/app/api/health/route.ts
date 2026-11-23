import { NextResponse } from "next/server";
import { storeStatus } from "@/lib/call-log-store";
import { storeBackend, upstashEnvNames } from "@/lib/upstash";
import { isAIFirstEnabled } from "@/lib/ai-understanding";
import { isAISpeechEnabled } from "@/lib/ai-speech";
import { isFreeAIEnabled } from "@/lib/free-ai";
import { aiProvider, llmTarget } from "@/lib/llm-stream";
import { liveConfigStatus } from "@/lib/live-config";
import { defaultSttEngine } from "@/lib/deepgram-stt";
import { mintDeepgramToken } from "@/lib/deepgram-token";

// What this deployment can reach, for setup checks: open /api/health in a signed-in browser, or
// /api/health?session=<call id> to check one call's log. Yes/no answers and variable NAMES only,
// never secret values. Behind the DEMO_API_TOKEN gate like every /api route.
export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("session") ?? undefined;
  const set = (name: string) => Boolean(process.env[name]?.trim());
  return NextResponse.json({
    host: process.env.VERCEL ? "vercel" : process.env.RENDER ? "render" : "local",
    deployment: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    upstash: { ...(await storeStatus(sessionId)), ...storeBackend(), envNames: upstashEnvNames() },
    deepgramKey: set("DEEPGRAM_API_KEY"),
    // The engine a call uses with no ?stt= in its URL, and whether this deployment can mint a
    // Deepgram token right now (false: every call falls back to the browser recognizer)
    sttDefault: defaultSttEngine(process.env.NEXT_PUBLIC_STT_ENGINE),
    sttToken: await mintDeepgramToken().then((r) => (r.ok ? { mintable: true } : { mintable: false, reason: r.error })),
    callLogWebhook: set("CALL_LOG_WEBHOOK_URL"),
    callLogSecret: set("CALL_LOG_SECRET"),
    heygenKey: set("HEYGEN_API_KEY"),
    aiKey: set("XAI_API_KEY") || set("OPENAI_API_KEY"),
    // Which AI Max uses: AI_PROVIDER ("openai" / "xai"), else xAI if its key is set, else OpenAI
    ai: (() => {
      const t = llmTarget();
      return t ? { provider: aiProvider(), model: t.model } : null;
    })(),
    // "free": the AI runs the whole call (MAX_MODE=free); "script": the beat controller does
    mode: isFreeAIEnabled() ? (set("XAI_API_KEY") || set("OPENAI_API_KEY") ? "free" : "free (no key: script only)") : "script",
    // Calls' content: "portal" (the dealership's live versions, with their numbers, and whether free
    // mode's prompt is the portal's) or "built-in"; "error" says why the portal's wasn't used
    content: await liveConfigStatus(),
    // "ai": Max's replies in Beats 2-21 are worded by the AI and checked (MAX_SPEECH=ai)
    speech: isAISpeechEnabled() ? (set("XAI_API_KEY") || set("OPENAI_API_KEY") ? "ai" : "ai (no key: script only)") : "script",
    // "ai" only when MAX_UNDERSTANDING=ai AND an AI key is set; otherwise every turn uses the rules
    understanding: isAIFirstEnabled() ? (set("XAI_API_KEY") || set("OPENAI_API_KEY") ? "ai" : "ai (no key: rules only)") : "rules",
    eventConfig: process.env.EVENT_CONFIG || null,
  });
}
