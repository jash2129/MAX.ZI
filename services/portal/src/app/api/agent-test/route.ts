import { NextResponse } from "next/server";

import { agentTestTurn } from "@/server/agent-test";
import { portalDb } from "@/server/db";
import { PortalError, useTestLink } from "@/server/portal";
import { currentPerson } from "@/server/session";

/**
 * The Agent page's test chat: POST {version, state?, message?}. No message = start (Max's greeting).
 * Signed-in people only (admins with two-factor), on versions they may read; every turn is an AI call,
 * so each person gets at most 150 turns per 10 minutes.
 */
const turns = new Map<string, number[]>();
function limited(who: string): boolean {
  const now = Date.now();
  const hits = (turns.get(who) ?? []).filter((t) => now - t < 10 * 60_000);
  hits.push(now);
  turns.set(who, hits);
  if (turns.size > 5000) turns.clear();
  return hits.length > 150;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const noStore = { "Cache-Control": "no-store" };
  let body: { version?: unknown; state?: unknown; message?: unknown; kind?: unknown; link?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400, headers: noStore });
  }
  const db = portalDb();
  const message = typeof body.message === "string" ? body.message : undefined;
  // A client test link (/t/<token>): no account; the link decides the version and runs as its maker
  let who: string;
  let version: string;
  let kind: "script" | "price" | "kb";
  const viaLink = typeof body.link === "string";
  if (viaLink) {
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    if (limited(`link:${ip}`)) return NextResponse.json({ error: "Too many messages. Wait a few minutes." }, { status: 429, headers: noStore });
    const use = await useTestLink(db, body.link as string, message === undefined ? "open" : "turn");
    if ("refused" in use) return NextResponse.json({ error: use.refused }, { status: 410, headers: noStore });
    who = use.createdBy;
    version = use.versionId;
    kind = use.kind;
  } else {
    const person = await currentPerson();
    if (!person) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: noStore });
    if (person.needsTwoFactor && !person.twoFactorEnabled) return NextResponse.json({ error: "Set up two-factor first." }, { status: 403, headers: noStore });
    if (limited(person.id)) return NextResponse.json({ error: "Too many test turns. Wait a few minutes." }, { status: 429, headers: noStore });
    version = String(body.version ?? "");
    if (!UUID.test(version)) return NextResponse.json({ error: "Unknown version." }, { status: 400, headers: noStore });
    const k = body.kind === undefined ? "script" : body.kind;
    if (k !== "script" && k !== "price" && k !== "kb") return NextResponse.json({ error: "Unknown kind." }, { status: 400, headers: noStore });
    kind = k;
    who = person.id;
  }
  try {
    const r = await agentTestTurn(db, who, version, { state: typeof body.state === "string" ? body.state : undefined, message, kind });
    return NextResponse.json(r, { headers: noStore });
  } catch (err) {
    let text = err instanceof PortalError ? err.message : "The test turn failed. Try again.";
    // A client never sees setup details
    if (viaLink && /OPENAI_API_KEY|AI key|permission|No such version/i.test(text)) text = "Max isn't available on this link right now. Please let the dealership know.";
    if (!(err instanceof PortalError)) console.error(JSON.stringify({ event: "agent_test_failed", viaLink, error: String((err as Error)?.message ?? err) }));
    return NextResponse.json({ error: text }, { status: err instanceof PortalError ? 400 : 500, headers: noStore });
  }
}
