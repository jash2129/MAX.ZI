import type { Db } from "../../../control-plane/src/db";

/**
 * The customer call page's server side. No account: a valid deal link (intake API, 2 hours, at most 3
 * starts) is the ticket, because every call costs money. The voice worker's token never leaves the
 * server; the browser only gets the room link and its own room token.
 */

export interface Product {
  key: string;
  title: string;
  bullets?: string[];
}

export interface CallPageInfo {
  id: string;
  name: string;
  max_display_name: string;
  branding: { logo_url?: string; color?: string };
  products: Product[];
  ready: boolean;
}

/** What the customer's page may show about a dealership (public details only), or null */
export async function callPageInfo(db: Db, dealershipId: string): Promise<CallPageInfo | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(dealershipId)) return null;
  const p = (await db.query<{ p: any }>("select app.call_page($1) as p", [dealershipId])).rows[0]?.p;
  if (!p) return null;
  const products = Array.isArray(p.products)
    ? (p.products as any[])
        .filter((x) => x && typeof x.key === "string" && typeof x.title === "string")
        .map((x) => ({ key: x.key, title: x.title, bullets: Array.isArray(x.bullets) ? x.bullets.map(String).slice(0, 8) : undefined }))
    : [];
  return { id: p.id, name: p.name, max_display_name: p.max_display_name || "Max", branding: p.branding ?? {}, products, ready: Boolean(p.ready) };
}

export type StartResult =
  | { ok: true; room_url: string; customer_token: string; call_id: string; vehicle: { year?: string; make?: string; model?: string }; first_name: string | null }
  | { ok: false; status: number; message: string };

/** WORKER_URL, or WORKER_HOSTPORT (Render: the worker's internal host:port) over http */
export function workerUrl(): string | null {
  const url = process.env.WORKER_URL?.trim();
  if (url) return url.replace(/\/+$/, "");
  const hp = process.env.WORKER_HOSTPORT?.trim();
  if (hp && /^[A-Za-z0-9.-]+:\d{2,5}$/.test(hp)) return `http://${hp}`;
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uses one start of the deal link and asks the voice worker for a room */
export async function startCustomerCall(db: Db, dealershipId: string, dealId: string, fetchImpl: typeof fetch = fetch): Promise<StartResult> {
  if (!UUID.test(dealId)) return { ok: false, status: 400, message: "This link is not complete. Use the link your dealership sent you." };
  const worker = workerUrl();
  const token = process.env.WORKER_TOKEN?.trim();
  if (!worker || !token) return { ok: false, status: 503, message: "Calls are not available right now. Please try again shortly." };
  const claim = (await db.query<{ vehicle: any; customer_first_name: string | null }>("select * from app.claim_deal($1, $2)", [dealId, dealershipId])).rows[0];
  if (!claim) return { ok: false, status: 410, message: "This link has expired or was already used. Ask your dealership for a new one." };
  let res: Response;
  try {
    res = await fetchImpl(`${worker}/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ dealership_id: dealershipId, deal_id: dealId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, status: 503, message: "We couldn't start the call. Please try again in a moment." };
  }
  if (res.status === 503) return { ok: false, status: 503, message: "All lines are busy. Please try again in a minute." };
  if (res.status === 404) return { ok: false, status: 404, message: "This dealership is not taking calls right now." };
  if (!res.ok) return { ok: false, status: 502, message: "We couldn't start the call. Please try again in a moment." };
  const body = (await res.json()) as { call_id: string; room_url: string; customer_token: string };
  return { ok: true, room_url: body.room_url, customer_token: body.customer_token, call_id: body.call_id, vehicle: claim.vehicle ?? {}, first_name: claim.customer_first_name };
}
