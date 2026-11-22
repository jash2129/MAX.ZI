import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { asUser, type Db } from "./db.ts";

/**
 * Seeds the two demo dealerships with the demo's CURRENT content as approved version 1: the 25 beats,
 * the recording disclosure, the knowledge base and the $4 -> $3.50 -> $3.25 -> $3 ladder.
 *
 * The gate result is computed from a real simulator batch report (testing-skill/reports), and the
 * report file and its mode are stored with it, so nothing claims a test that did not happen.
 */

const LIB = resolve(import.meta.dirname, "../../../tavus-avatar/src/lib");
export const DEMO_LADDER = [4, 3.5, 3.25, 3];

export function demoContent() {
  const beats = JSON.parse(readFileSync(resolve(LIB, "beats.json"), "utf8")) as Array<{ id: number; text: string }>;
  const kb = JSON.parse(readFileSync(resolve(LIB, "max-knowledge-base.json"), "utf8")) as { facts: unknown[] };
  const disclosure = beats.find((b) => b.id === 1)!.text.replace(/^"|"$/g, "");
  return { beats, facts: kb.facts, disclosure, steps: DEMO_LADDER };
}

/** The release-gate summary of a simulator batch report (16+ calls, hard failures, completion). */
export function gateResultFromReport(reportPath: string) {
  const calls = JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
    persona: string;
    scorecard: { checks: Array<{ severity: string; pass: boolean }>; completed: boolean; reachedPrice: boolean };
  }>;
  const hard = calls.filter((c) => c.scorecard.checks.some((k) => k.severity === "hard" && !k.pass)).length;
  const md = (() => {
    try {
      return readFileSync(reportPath.replace(/\.json$/, ".md"), "utf8");
    } catch {
      return "";
    }
  })();
  const mode = /\| Free AI \|/.test(md) ? "free" : /\| Speech \| approved lines word for word/.test(md) ? "scripted" : "unknown";
  const pct = (n: number) => Math.round((n / calls.length) * 1000) / 10;
  return {
    calls: calls.length,
    hard_failures: hard,
    completion_rate: pct(calls.filter((c) => c.scorecard.completed).length),
    price_reached_rate: pct(calls.filter((c) => c.scorecard.reachedPrice).length),
    source: `simulator batch ${basename(reportPath)}`,
    mode,
  };
}

const DEALERSHIPS = [
  { id: "demo-mazda", name: "Mazda Dealership", vehicle: { year: "2026", make: "Mazda", model: "CX five" }, keyterms: ["Mazda", "CX-5", "CX-50", "CX-90", "GAP", "powertrain", "bumper to bumper"] },
  { id: "demo-hyundai", name: "Hyundai of Dallas", vehicle: { year: "2026", make: "Hyundai", model: "Tucson" }, keyterms: ["Hyundai", "Tucson", "Santa Fe", "Palisade", "GAP", "powertrain", "Dallas"] },
];

export async function seedDemo(db: Db, opts: { ownerEmail: string; reportPath: string }) {
  const result = gateResultFromReport(opts.reportPath);
  const owner = (
    await db.query<{ id: string }>(
      "insert into app_user (email, display_name, is_platform_owner) values ($1, 'Platform owner', true) on conflict (email) do update set is_platform_owner = true returning id",
      [opts.ownerEmail.toLowerCase()]
    )
  ).rows[0].id;
  const content = demoContent();

  for (const d of DEALERSHIPS) {
    await db.query(
      "insert into dealership (id, name, default_vehicle, speech_keyterms) values ($1, $2, $3, $4) on conflict (id) do nothing",
      [d.id, d.name, JSON.stringify(d.vehicle), d.keyterms]
    );
    await asUser(db, owner, async (tx) => {
      const ship = async (kind: "script" | "price" | "kb", insert: string, params: unknown[]) => {
        const t = { script: "script_version", price: "price_ladder_version", kb: "kb_version" }[kind];
        const live = await tx.query(`select 1 from ${t} where dealership_id = $1 and status = 'live'`, [d.id]);
        if (live.rows.length) return; // already seeded
        const v = (await tx.query<{ id: string }>(insert, params)).rows[0];
        await tx.query(`update ${t} set status = 'in_test' where id = $1`, [v.id]);
        await tx.query("select app.record_test_result($1, $2, $3)", [kind, v.id, JSON.stringify(result)]);
        await tx.query("select app.approve_version($1, $2)", [kind, v.id]);
      };
      await ship("script", "insert into script_version (dealership_id, beats, disclosure, notes) values ($1, $2, $3, 'Demo baseline (tavus-avatar beats.json)') returning id", [
        d.id,
        JSON.stringify(content.beats),
        content.disclosure,
      ]);
      await ship("price", "insert into price_ladder_version (dealership_id, steps, notes) values ($1, $2, 'Demo baseline ladder') returning id", [d.id, content.steps]);
      await ship("kb", "insert into kb_version (dealership_id, facts, notes) values ($1, $2, 'Demo baseline (max-knowledge-base.json)') returning id", [d.id, JSON.stringify(content.facts)]);
    });
  }
  return { owner, result, dealerships: DEALERSHIPS.map((d) => d.id) };
}
