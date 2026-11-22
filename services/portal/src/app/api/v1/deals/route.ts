import { NextResponse } from "next/server";

import { portalDb } from "@/server/db";
import { PortalError, intakeDeal } from "@/server/portal";

/**
 * Deal intake API (PRD: "deal data intake from a dealership system by API").
 *
 *   POST /api/v1/deals
 *   Authorization: Bearer mxk_...            (a dealership API key, created in the portal)
 *   { "external_ref": "DEAL-1001", "vehicle": { "year": "2026", "make": "Mazda", "model": "CX-50" },
 *     "customer_first_name": "Sam" }
 *   -> 201 { "deal_id": "...", "dealership_id": "...", "expires_at": "..." }
 *
 * The key decides the dealership. The deal expires after 2 hours; start the call with its deal_id
 * (voice worker POST /calls). No other customer data is accepted.
 */

// Per key, per instance: 60 deals a minute (a dealership system, not a person, is calling)
const hits = new Map<string, { at: number; n: number }>();
function limited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.at > 60_000) {
    hits.set(key, { at: now, n: 1 });
    return false;
  }
  h.n++;
  return h.n > 60;
}

const error = (status: number, message: string) => NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return error(401, "missing API key");
  if (limited(key.slice(0, 16))) return error(429, "too many requests");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "body must be JSON");
  }
  if (!body || typeof body !== "object") return error(400, "body must be a JSON object");
  try {
    const deal = await intakeDeal(portalDb(), key, body as Record<string, unknown>);
    if (!deal) return error(401, "invalid API key");
    return NextResponse.json(deal, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof PortalError) return error(400, err.message);
    console.error(JSON.stringify({ event: "intake_failed", error: String((err as Error)?.message ?? err) }));
    return error(500, "intake failed");
  }
}
