import { NextResponse } from "next/server";

import { agentTestTurn } from "@/server/agent-test";
import { portalDb } from "@/server/db";
import { PortalError } from "@/server/portal";
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
  const person = await currentPerson();
  if (!person) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: noStore });
  if (person.needsTwoFactor && !person.twoFactorEnabled) return NextResponse.json({ error: "Set up two-factor first." }, { status: 403, headers: noStore });
  if (limited(person.id)) return NextResponse.json({ error: "Too many test turns. Wait a few minutes." }, { status: 429, headers: noStore });
  let body: { version?: unknown; state?: unknown; message?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400, headers: noStore });
  }
  const version = String(body.version ?? "");
  if (!UUID.test(version)) return NextResponse.json({ error: "Unknown version." }, { status: 400, headers: noStore });
  try {
    const r = await agentTestTurn(portalDb(), person.id, version, {
      state: typeof body.state === "string" ? body.state : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
    });
    return NextResponse.json(r, { headers: noStore });
  } catch (err) {
    const message = err instanceof PortalError ? err.message : "The test turn failed. Try again.";
    if (!(err instanceof PortalError)) console.error(JSON.stringify({ event: "agent_test_failed", error: String((err as Error)?.message ?? err) }));
    return NextResponse.json({ error: message }, { status: err instanceof PortalError ? 400 : 500, headers: noStore });
  }
}
