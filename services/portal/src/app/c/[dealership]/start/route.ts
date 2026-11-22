import { NextResponse } from "next/server";

import { startCustomerCall } from "@/server/callpage";
import { portalDb } from "@/server/db";

/** Starts the customer's call (the page's "Start" button). Rate-limited per address. */
const recent = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length > 10;
}

export async function POST(request: Request, { params }: { params: Promise<{ dealership: string }> }) {
  const { dealership } = await params;
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return NextResponse.json({ error: "Too many attempts. Please wait a few minutes." }, { status: 429 });
  let dealId = "";
  try {
    dealId = String(((await request.json()) as { deal?: unknown }).deal ?? "");
  } catch {
    /* empty */
  }
  const r = await startCustomerCall(portalDb(), dealership, dealId);
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    { room_url: r.room_url, token: r.customer_token, vehicle: r.vehicle, first_name: r.first_name },
    { headers: { "Cache-Control": "no-store" } }
  );
}
