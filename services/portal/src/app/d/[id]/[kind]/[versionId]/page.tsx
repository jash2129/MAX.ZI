import Link from "next/link";
import { notFound } from "next/navigation";

import { approveAction, deleteDraftAction, rollbackAction, runGateAction, saveDraftAction, statusAction } from "@/app/actions";
import { KIND_LABEL, Notices, Shell, Status } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { KINDS, diffAgainstLive, getDealership, getVersion, permissions, type Kind } from "@/server/portal";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

function Hidden({ d, kind, v }: { d: string; kind: Kind; v: string }) {
  return (
    <>
      <input type="hidden" name="dealership" value={d} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="version" value={v} />
    </>
  );
}

export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; kind: string; versionId: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const person = await requirePerson();
  const { id, kind: rawKind, versionId } = await params;
  if (!(KINDS as string[]).includes(rawKind)) notFound();
  const kind = rawKind as Kind;
  const search = await searchParams;
  const db = portalDb();
  const [dealership, can, v] = await Promise.all([getDealership(db, person.id, id), permissions(db, person.id, id), getVersion(db, person.id, kind, versionId)]);
  if (v.dealership_id !== id) notFound();
  const editable = v.status === "draft" && can.edit;
  const diff = v.status === "in_test" || v.status === "draft" ? await diffAgainstLive(db, person.id, kind, versionId) : null;
  const result = v.test_result as null | { calls: number; hard_failures: number; completion_rate: number; price_reached_rate?: number; source?: string; mode?: string; details?: Array<{ journey: string; completed: boolean; furthest_beat: number; hard_failed: string[] }> };

  return (
    <Shell person={person}>
      <p>
        <Link href="/">Dealerships</Link> / <Link href={`/d/${id}`}>{dealership.name}</Link>
      </p>
      <h1>
        {KIND_LABEL[kind]} v{v.version} <Status status={v.status} />
      </h1>
      {v.notes && <p className="muted">{v.notes}</p>}
      <Notices
        search={search}
        ok={{ saved: "Draft saved.", gate: "Release gate run: {v}." }}
      />

      {/* -------- what happens next -------- */}
      <div className="panel">
        {v.status === "draft" && (
          <p>
            Draft. {can.edit ? "Edit it below, then submit it for testing. Nothing reaches a call until an approver approves it." : "Only a manager can edit it."}
          </p>
        )}
        {v.status === "in_test" && (
          <p>In test. Run the release gate, then an approver reviews the changes and the result and approves it. Its content can no longer change.</p>
        )}
        {v.status === "live" && <p>Live: new calls use this version.</p>}
        {v.status === "retired" && <p>Retired. {can.approve ? "You can make it live again (one-step rollback)." : ""}</p>}
        <div className="row">
          {editable && (
            <form action={statusAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <input type="hidden" name="to" value="in_test" />
              <button className="primary" type="submit">
                Submit for testing
              </button>
            </form>
          )}
          {editable && (
            <form action={deleteDraftAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <button className="danger" type="submit">
                Delete draft
              </button>
            </form>
          )}
          {v.status === "in_test" && can.edit && (
            <form action={runGateAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <button type="submit">Run release gate (16 calls)</button>
            </form>
          )}
          {v.status === "in_test" && can.edit && (
            <form action={statusAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <input type="hidden" name="to" value="draft" />
              <button type="submit">Back to draft</button>
            </form>
          )}
          {v.status === "in_test" && can.approve && (
            <form action={approveAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <button className="primary" type="submit" disabled={!result || result.hard_failures > 0}>
                Approve and make live
              </button>
            </form>
          )}
          {v.status === "retired" && can.approve && (
            <form action={rollbackAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <button type="submit">Make this version live again</button>
            </form>
          )}
        </div>
      </div>

      {/* -------- release gate result -------- */}
      {result && (
        <>
          <h2>Release gate</h2>
          <p className={`notice ${result.hard_failures === 0 ? "ok" : "error"}`}>
            {result.hard_failures === 0 ? "Passed" : "Failed"}: {result.calls} simulated calls, {result.hard_failures} with a hard failure, {result.completion_rate}% completed
            {result.price_reached_rate !== undefined ? `, ${result.price_reached_rate}% reached the price` : ""}. Source: {result.source ?? "unknown"}
            {result.mode ? ` (${result.mode})` : ""}.
          </p>
          {result.details && (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Completed</th>
                    <th>Furthest beat</th>
                    <th>Hard failures</th>
                  </tr>
                </thead>
                <tbody>
                  {result.details.map((d) => (
                    <tr key={d.journey}>
                      <td>{d.journey}</td>
                      <td>{d.completed ? "yes" : "no"}</td>
                      <td>{d.furthest_beat}</td>
                      <td>{d.hard_failed.length ? d.hard_failed.join(", ") : "none"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* -------- side-by-side diff -------- */}
      {diff && (
        <>
          <h2>Changes from the live version{diff.liveVersion ? ` (v${diff.liveVersion})` : ""}</h2>
          {diff.rows.length === 0 ? (
            <p className="muted">No changes.</p>
          ) : (
            <div className="scroll">
              <table className="diff">
                <thead>
                  <tr>
                    <th>What</th>
                    <th>Live now</th>
                    <th>This version</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.rows.map((r) => (
                    <tr key={r.label}>
                      <td className="label">{r.label}</td>
                      <td className="before">{r.before}</td>
                      <td className="after">{r.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* -------- content: editor for drafts, read-only otherwise -------- */}
      <h2>{editable ? "Edit" : "Content"}</h2>
      <form action={saveDraftAction} className="panel">
        <Hidden d={id} kind={kind} v={versionId} />
        <fieldset disabled={!editable} style={{ border: "none", padding: 0, margin: 0 }}>
          <label htmlFor="notes">Notes for the approver</label>
          <input id="notes" name="notes" defaultValue={v.notes} />

          {kind === "price" && (
            <>
              <label htmlFor="steps">Daily rates, highest first; the last one is the floor</label>
              <input id="steps" name="steps" defaultValue={(v.steps as number[]).join(", ")} />
              <p className="muted">Max opens at the first rate, comes down one step each time the customer pushes back, and never goes below the last.</p>
            </>
          )}

          {kind === "kb" && (
            <>
              <label htmlFor="facts">Facts (JSON). Max answers questions only from facts with status &quot;script&quot; or &quot;approved&quot;.</label>
              <textarea id="facts" name="facts" rows={24} defaultValue={JSON.stringify(v.facts, null, 2)} />
            </>
          )}

          {kind === "script" && (
            <>
              <label htmlFor="disclosure">Recording disclosure (said word for word; Beat 1 must contain it)</label>
              <textarea id="disclosure" name="disclosure" rows={3} defaultValue={v.disclosure} />
              {(v.beats as Array<{ id: number; type: string; expects?: string; text: string }>).map((b) => (
                <div key={b.id}>
                  <label htmlFor={`beat_${b.id}`}>
                    Beat {b.id} ({b.type}
                    {b.expects ? `, expects ${b.expects}` : ""}){b.id === 22 ? ": must say {{per_day_price}}" : ""}
                  </label>
                  <textarea id={`beat_${b.id}`} name={`beat_${b.id}`} rows={3} defaultValue={b.text} />
                </div>
              ))}
              <label htmlFor="fixed_lines">Fixed lines to override (JSON, e.g. {`{"HANDOFF_LINE": "..."}`})</label>
              <textarea id="fixed_lines" name="fixed_lines" rows={6} defaultValue={JSON.stringify(v.fixed_lines ?? {}, null, 2)} />
              <label htmlFor="recaps">Recaps for beats you reworded (JSON, by beat number)</label>
              <textarea id="recaps" name="recaps" rows={4} defaultValue={JSON.stringify(v.recaps ?? {}, null, 2)} />
              <p className="muted">
                Placeholders: {"{{vehicle_year}} {{vehicle_make}} {{vehicle_model}} {{per_day_price}}"}. Prices come from the price ladder only.
              </p>
            </>
          )}
          {editable && (
            <p>
              <button className="primary" type="submit">
                Save draft
              </button>
            </p>
          )}
        </fieldset>
      </form>
    </Shell>
  );
}
