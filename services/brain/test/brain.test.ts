/**
 * The brain service, offline: real controller, rule-based understanding (AI keys removed), in-memory
 * state (no Redis). Each test uses fresh call ids.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createBrain, FALLBACK_LINE } from "../src/app.ts";
import { toPanelEvents } from "../src/panels.ts";
import { DealershipRegistry, validateDealership } from "../src/tenants.ts";

beforeAll(() => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING", "MAX_STREAM", "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]) delete process.env[k];
});

const registry = DealershipRegistry.fromDirectory();
const TOKEN = "test-token";
const brain = createBrain({ registry, token: TOKEN });

let n = 0;
const newCallId = () => `call-${Date.now().toString(36)}-${++n}`;

async function post(path: string, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return brain(new Request(`http://brain${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function lines(res: Response): Promise<any[]> {
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function turn(dealership_id: string, call_id: string, turn_id: number, transcript: string) {
  const out = await lines(await post("/turn", { dealership_id, call_id, turn_id, transcript }));
  const final = out.find((l) => l.type === "final");
  expect(final, JSON.stringify(out)).toBeTruthy();
  return final;
}

/** Plays agreeable answers until Max reaches Beat 2 (the line that names the vehicle). */
async function driveToVehicleLine(dealership_id: string, call_id: string) {
  const answers = ["Yes, I can hear and see you.", "It has been great, thanks.", "Yes, that's fine.", "Okay.", "Yes."];
  let last: any = null;
  for (let i = 0; i < 8; i++) {
    last = await turn(dealership_id, call_id, i + 1, answers[Math.min(i, answers.length - 1)]);
    await post("/commit", { dealership_id, call_id, turn_id: i + 1, heard: true, fraction_heard: 1 });
    if (last.beat >= 2) return last;
  }
  return last;
}

describe("auth and validation", () => {
  it("health is open and reports the dealerships", async () => {
    const res = await brain(new Request("http://brain/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).dealerships).toBe(2);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await post("/calls", { dealership_id: "demo-mazda", call_id: newCallId() }, null)).status).toBe(401);
    expect((await post("/calls", { dealership_id: "demo-mazda", call_id: newCallId() }, "nope")).status).toBe(401);
  });

  it("fails closed in production without a token", async () => {
    const open = createBrain({ registry, production: true });
    const res = await open(new Request("http://brain/calls", { method: "POST", body: "{}" }));
    expect(res.status).toBe(503);
  });

  it("rejects unknown dealerships and bad call ids", async () => {
    expect((await post("/calls", { dealership_id: "nobody", call_id: newCallId() })).status).toBe(404);
    expect((await post("/calls", { dealership_id: "demo-mazda", call_id: "../etc" })).status).toBe(400);
  });

  it("a turn on a call that was never started is an error, not a new call", async () => {
    const out = await lines(await post("/turn", { dealership_id: "demo-mazda", call_id: newCallId(), turn_id: 1, transcript: "hi" }));
    expect(out).toEqual([{ type: "error", status: 409, error: expect.any(String) }]);
  });

  it("refuses a dealership whose price ladder the code does not enforce", () => {
    const base = { id: "x", name: "X", default_vehicle: { year: "2026", make: "Kia", model: "Soul" } };
    expect(() => validateDealership({ ...base, price_ladder: [5, 4, 3.5, 3] }, "x.json")).toThrow(/price_ladder/);
    expect(validateDealership({ ...base, price_ladder: [4, 3.5, 3.25, 3] }, "x.json").max_display_name).toBe("Max");
  });
});

describe("a call", () => {
  it("opens with the greeting and is idempotent on rejoin", async () => {
    const call_id = newCallId();
    const first = await (await post("/calls", { dealership_id: "demo-mazda", call_id })).json();
    expect(first.text).toBe("Can you hear and see me alright?");
    expect(first.resumed).toBe(false);
    expect(first.speech_keyterms).toContain("Mazda");
    const again = await (await post("/calls", { dealership_id: "demo-mazda", call_id })).json();
    expect(again.resumed).toBe(true);
  });

  it("speaks every turn and moves through the script", async () => {
    const call_id = newCallId();
    await post("/calls", { dealership_id: "demo-mazda", call_id, deal: { vehicle_model: "CX fifty" } });
    const final = await driveToVehicleLine("demo-mazda", call_id);
    expect(final.text).not.toBe(FALLBACK_LINE);
    expect(final.beat).toBeGreaterThanOrEqual(2);
    expect(final.text).toMatch(/Mazda CX fifty/);
  });

  it("keeps tenants apart even with the same call id", async () => {
    const call_id = newCallId();
    await post("/calls", { dealership_id: "demo-mazda", call_id });
    await post("/calls", { dealership_id: "demo-hyundai", call_id });
    const mazda = await driveToVehicleLine("demo-mazda", call_id);
    expect(mazda.text).toMatch(/Mazda/);
    // Hyundai's call with the same id has not moved
    const hyundaiRejoin = await (await post("/calls", { dealership_id: "demo-hyundai", call_id })).json();
    expect(hyundaiRejoin.beat).toBe(0);
    const hyundai = await driveToVehicleLine("demo-hyundai", call_id);
    expect(hyundai.text).toMatch(/Hyundai Tucson/);
    expect(hyundai.text).not.toMatch(/Mazda/);
  });

  it("rolls back a reply that was not heard, and resumes it on 'go on'", async () => {
    const call_id = newCallId();
    await post("/calls", { dealership_id: "demo-mazda", call_id });
    const t1 = await turn("demo-mazda", call_id, 1, "Yes, I can hear and see you.");
    const commit = await (await post("/commit", { dealership_id: "demo-mazda", call_id, turn_id: 1, heard: false, fraction_heard: 0 })).json();
    expect(commit.rolled_back).toBe(true);
    const t2 = await turn("demo-mazda", call_id, 2, "yeah");
    expect(t2.intent).toBe("resume_interrupted");
    expect(t1.text.startsWith(t2.text) || t1.text.includes(t2.text)).toBe(true);
  });

  it("a stale commit is ignored", async () => {
    const call_id = newCallId();
    await post("/calls", { dealership_id: "demo-mazda", call_id });
    await turn("demo-mazda", call_id, 1, "Yes, I can hear and see you.");
    const res = await (await post("/commit", { dealership_id: "demo-mazda", call_id, turn_id: 7, heard: false })).json();
    expect(res).toEqual({ rolled_back: false, reason: "not_the_latest_turn" });
  });

  it("concurrent requests for one call are processed one at a time", async () => {
    const call_id = newCallId();
    await post("/calls", { dealership_id: "demo-mazda", call_id });
    const [a, b] = await Promise.all([
      turn("demo-mazda", call_id, 1, "Yes, I can hear and see you."),
      post("/commit", { dealership_id: "demo-mazda", call_id, turn_id: 1, heard: false, fraction_heard: 0 }).then((r) => r.json()),
    ]);
    expect(a.text.length).toBeGreaterThan(0);
    // The commit queued behind the turn, so it found turn 1 pending and rolled it back
    expect(b.rolled_back).toBe(true);
  });

  it("reprompt re-asks without moving the call", async () => {
    const call_id = newCallId();
    await post("/calls", { dealership_id: "demo-mazda", call_id });
    const r = await (await post("/reprompt", { dealership_id: "demo-mazda", call_id, kind: "still_with_me" })).json();
    expect(r.text).toMatch(/hear and see me/);
  });
});

describe("panels", () => {
  it("maps controller tool calls to panel events and drops unknown ones", () => {
    expect(
      toPanelEvents([
        { name: "show_content", args: { item: "warranty_terms" } },
        { name: "show_content", args: { item: "cost_breakdown" } },
        { name: "show_pricing", args: { product: "gap" } },
        { name: "show_payment_breakdown", args: { daily_rate: 3.5 } },
        { name: "dismiss_content", args: {} },
        { name: "escalate_to_human", args: {} },
      ])
    ).toEqual([
      { event: "panel.show", panel: "warranty_terms", data: {} },
      { event: "panel.show", panel: "repair_costs", data: {} },
      { event: "panel.show", panel: "coverage_grid", data: { product: "gap" } },
      { event: "panel.show", panel: "price", data: { daily_rate: 3.5 } },
      { event: "panel.hide" },
    ]);
  });
});
