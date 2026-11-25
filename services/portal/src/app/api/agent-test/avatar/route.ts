import { NextResponse } from "next/server";

import { portalDb } from "@/server/db";
import { PortalError, agentTestConfig, useTestLink } from "@/server/portal";
import { currentPerson } from "@/server/session";
import { createLiveAvatarSession, stopLiveAvatarSession } from "../../../../../../../tavus-avatar/src/lib/liveavatar-api";

/**
 * The test panel's Video mode: a HeyGen LiveAvatar session for a test call (POST starts one, DELETE
 * stops it). The avatar only says what the portal sends it ("speak_text"); Max's words still come
 * from /api/agent-test with every check on. HEYGEN_API_KEY stays on the server.
 *
 * Every session spends HeyGen minutes: signed-in people only (admins with two-factor), on a version
 * they can read, at most 8 sessions per person per hour.
 */
const starts = new Map<string, number[]>();
function limited(who: string): boolean {
  const now = Date.now();
  const hits = (starts.get(who) ?? []).filter((t) => now - t < 60 * 60_000);
  if (hits.length >= 8) return true;
  hits.push(now);
  starts.set(who, hits);
  if (starts.size > 5000) starts.clear();
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" };

async function who() {
  const person = await currentPerson();
  if (!person) return { error: NextResponse.json({ error: "Sign in again." }, { status: 401, headers: noStore }) };
  if (person.needsTwoFactor && !person.twoFactorEnabled) return { error: NextResponse.json({ error: "Set up two-factor first." }, { status: 403, headers: noStore }) };
  return { person };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { version?: unknown; kind?: unknown; link?: unknown };
  let personId: string;
  if (typeof body.link === "string") {
    // A client test link: one video session counted against the link's cap
    if (!process.env.HEYGEN_API_KEY?.trim()) return NextResponse.json({ error: "Video isn't available on this link right now. Try Type or Voice." }, { status: 503, headers: noStore });
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    if (limited(`link:${ip}`)) return NextResponse.json({ error: "Too many video calls this hour. Try Type or Voice, or wait a while." }, { status: 429, headers: noStore });
    const use = await useTestLink(portalDb(), body.link, "video");
    if ("refused" in use) return NextResponse.json({ error: use.refused }, { status: 410, headers: noStore });
    personId = use.createdBy;
  } else {
    const w = await who();
    if (w.error) return w.error;
    personId = w.person.id;
    const version = String(body.version ?? "");
    const kind = body.kind === "price" || body.kind === "kb" ? body.kind : "script";
    if (!UUID.test(version)) return NextResponse.json({ error: "Unknown version." }, { status: 400, headers: noStore });
    if (!process.env.HEYGEN_API_KEY?.trim()) {
      return NextResponse.json({ error: "Video needs HEYGEN_API_KEY on the portal's Vercel project (the same key as the call app), then a redeploy." }, { status: 503, headers: noStore });
    }
    try {
      // Only someone who may read this version gets an avatar for it
      await agentTestConfig(portalDb(), personId, version, kind);
    } catch (err) {
      return NextResponse.json({ error: err instanceof PortalError ? err.message : "Unknown version." }, { status: 400, headers: noStore });
    }
    if (limited(personId)) return NextResponse.json({ error: "Too many video tests this hour (8). Use Type or Voice, or wait a while." }, { status: 429, headers: noStore });
  }
  try {
    const s = await createLiveAvatarSession();
    console.log(JSON.stringify({ event: "agent_test_avatar_started", person: personId, viaLink: typeof body.link === "string", sessionId: s.sessionId }));
    return NextResponse.json(
      { livekitUrl: s.livekitUrl, livekitClientToken: s.livekitClientToken, sessionToken: s.sessionToken, avatarName: s.avatarName, maxSeconds: s.maxSessionDuration },
      { headers: noStore }
    );
  } catch (err) {
    console.error(JSON.stringify({ event: "agent_test_avatar_failed", error: String((err as Error)?.message ?? err) }));
    return NextResponse.json({ error: "The avatar could not start. Check the HeyGen key and credits, then try again." }, { status: 502, headers: noStore });
  }
}

export async function DELETE(request: Request) {
  // Stopping needs the session's own token, which only whoever started it has: no sign-in, so a
  // client's video session also ends when they close it
  const body = (await request.json().catch(() => ({}))) as { sessionToken?: unknown };
  if (typeof body.sessionToken === "string" && body.sessionToken.length < 4000) await stopLiveAvatarSession(body.sessionToken);
  return NextResponse.json({ ok: true }, { headers: noStore });
}
