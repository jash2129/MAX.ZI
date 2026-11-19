import { NextResponse } from "next/server";
import { mintDeepgramToken } from "@/lib/deepgram-token";

// A short-lived Deepgram token for the browser's speech-to-text stream (src/lib/deepgram-stt.ts).
// Behind the DEMO_API_TOKEN gate like every /api route. Without DEEPGRAM_API_KEY it answers 503 and
// the call screen falls back to the browser's speech recognition, loudly (log line, call log, banner).
export async function POST() {
  const r = await mintDeepgramToken();
  if (!r.ok) {
    console.error(JSON.stringify({ event: "stt_token_failed", status: r.status, reason: r.error }));
    return NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ token: r.token, expiresIn: r.expiresIn });
}
