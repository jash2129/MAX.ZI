import Link from "next/link";
import { notFound } from "next/navigation";

import {
  approveAction,
  deleteDraftAction,
  rollbackAction,
  runGateAction,
  saveDraftAction,
  statusAction,
} from "@/app/actions";
import { AgentChat } from "@/components/agent-chat";
import { ShareLinks } from "@/components/share-links";
import { DealershipNav, KIND_LABEL, Notices, Shell, Status } from "@/components/chrome";
import { portalDb } from "@/server/db";
import {
  BUILT_IN_FREE_PROMPT,
  BUILT_IN_NATIVE_PROMPT,
  KINDS,
  diffAgainstLive,
  getDealership,
  getVersion,
  permissions,
  type Kind,
} from "@/server/portal";
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
  const [dealership, can, v] = await Promise.all([
    getDealership(db, person.id, id),
    permissions(db, person.id, id),
    getVersion(db, person.id, kind, versionId),
  ]);
  if (v.dealership_id !== id) notFound();
  const editable = v.status === "draft" && can.edit;
  const diff =
    v.status === "in_test" || v.status === "draft"
      ? await diffAgainstLive(db, person.id, kind, versionId)
      : null;
  const result = v.test_result as null | {
    calls: number;
    hard_failures: number;
    completion_rate: number;
    price_reached_rate?: number;
    source?: string;
    mode?: string;
    details?: Array<{
      journey: string;
      completed: boolean;
      furthest_beat: number;
      hard_failed: string[];
    }>;
  };

  const passed = Boolean(result && result.hard_failures === 0);
  const stateLine: Record<string, string> = {
    draft: can.edit ? "Draft: edit it below and test it on the right, then send it for review. Nothing reaches a call until an approver approves it." : "Draft: only a manager can edit it.",
    in_test: "In review: locked, so what the approver sees is exactly what goes live. Run the automatic test, then an approver decides.",
    approved: "Approved.",
    live: "Live: new calls use this version.",
    retired: can.approve ? "Retired: you can make it live again (one-step rollback)." : "Retired: an earlier version.",
  };

  return (
    <Shell person={person} sub={<DealershipNav id={id} name={dealership.name} current={v.status === "in_test" ? "reviews" : undefined} />}>
      <p style={{ margin: "0 0 8px" }}>
        <Link href={`/d/${id}`}>← {dealership.name}</Link>
      </p>
      <div className="studio-bar">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 480px" }}>
          <span>
            <Status status={v.status} />
          </span>
          <h1 style={{ margin: 0 }}>
            {KIND_LABEL[kind]} v{v.version}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {stateLine[v.status] ?? v.status}
            {v.notes ? ` · Note: "${v.notes}"` : ""}
          </p>
        </div>
        <div className="row">
          {editable && (
            <form action={statusAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <input type="hidden" name="to" value="in_test" />
              <button className="primary" type="submit">
                Send for review
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
          {v.status === "retired" && can.approve && (
            <form action={rollbackAction}>
              <Hidden d={id} kind={kind} v={versionId} />
              <button type="submit">Make this version live again</button>
            </form>
          )}
        </div>
      </div>
      <Notices search={search} ok={{ saved: "Draft saved.", gate: "Automatic test run: {v}." }} />

      {v.status === "in_test" && (
        <>
          <div className="checks">
            <div className="check-card">
              <span className={`icon ${!result ? "wait" : passed ? "ok" : "bad"}`} aria-hidden="true">
                {!result ? "…" : passed ? "✓" : "!"}
              </span>
              <div>
                <strong>{!result ? "Automatic test not run yet" : passed ? "Automatic test passed" : "Automatic test failed"}</strong>
                <span className="small">
                  {result ? `${result.calls} simulated calls · ${result.hard_failures} broke a safety rule` : "Simulated customers call Max on this version."}
                </span>
              </div>
            </div>
            <div className="check-card">
              <span className="icon info" aria-hidden="true">
                ⏸
              </span>
              <div>
                <strong>Locked while in review</strong>
                <span className="small">What you see is exactly what goes live</span>
              </div>
            </div>
            <div className="check-card">
              <span className={`icon ${can.approve ? "ok" : "info"}`} aria-hidden="true">
                {can.approve ? "✓" : "i"}
              </span>
              <div>
                <strong>{can.approve ? "You can approve this" : "An approver decides"}</strong>
                <span className="small">New calls switch right away; calls in progress keep theirs</span>
              </div>
            </div>
          </div>
          <section className="panel" aria-labelledby="decide-h" style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 8 }}>
            <h2 id="decide-h" style={{ margin: 0, fontSize: 18 }}>
              {can.approve ? "Your decision" : "Next step"}
            </h2>
            <div className="row">
              {can.edit && (
                <form action={runGateAction}>
                  <Hidden d={id} kind={kind} v={versionId} />
                  <button type="submit" className={result ? "" : "primary"}>
                    {result ? "Run the automatic test again" : "Run the automatic test (16 simulated calls)"}
                  </button>
                </form>
              )}
              {can.approve && (
                <form action={approveAction}>
                  <Hidden d={id} kind={kind} v={versionId} />
                  <button className="go" type="submit" disabled={!passed} title={passed ? "" : "The automatic test must pass first"}>
                    Approve and go live
                  </button>
                </form>
              )}
              {can.edit && (
                <form action={statusAction}>
                  <Hidden d={id} kind={kind} v={versionId} />
                  <input type="hidden" name="to" value="draft" />
                  <button type="submit">Send back for changes</button>
                </form>
              )}
            </div>
            <span className="muted" style={{ fontSize: 14 }}>
              Talk to Max on this version first with the test panel below. After it goes live, the previous version can be restored in one click.
            </span>
          </section>
        </>
      )}

      {/* -------- release gate result -------- */}
      {result && (
        <>
          <h2>Automatic test result</h2>
          <p
            className={`notice ${result.hard_failures === 0 ? "ok" : "error"}`}
          >
            {result.hard_failures === 0 ? "Passed" : "Failed"}: {result.calls}{" "}
            simulated calls, {result.hard_failures} broke a safety rule,{" "}
            {result.completion_rate}% completed
            {result.price_reached_rate !== undefined
              ? `, ${result.price_reached_rate}% reached the price`
              : ""}
            . Source: {result.source ?? "unknown"}
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
                    <th>Safety rules broken</th>
                  </tr>
                </thead>
                <tbody>
                  {result.details.map((d) => (
                    <tr key={d.journey}>
                      <td>{d.journey}</td>
                      <td>{d.completed ? "yes" : "no"}</td>
                      <td>{d.furthest_beat}</td>
                      <td>
                        {d.hard_failed.length
                          ? d.hard_failed.join(", ")
                          : "none"}
                      </td>
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
          <h2>
            What changes for customers
            {diff.liveVersion ? ` (against live v${diff.liveVersion})` : ""}
          </h2>
          <p className="muted" style={{ marginTop: -6 }}>Only these lines change. Everything else stays as it is in the live version.</p>
          {diff.rows.length === 0 ? (
            <p className="muted">No changes.</p>
          ) : (
            <div className="scroll">
              <table className="diff">
                <thead>
                  <tr>
                    <th>What</th>
                    <th>Now (live)</th>
                    <th>After approval</th>
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
      <div className="agent-layout">
        <form action={saveDraftAction} className="panel">
          <Hidden d={id} kind={kind} v={versionId} />
          <fieldset
            disabled={!editable}
            style={{ border: "none", padding: 0, margin: 0 }}
          >
            <label htmlFor="notes">Notes for the approver</label>
            <input id="notes" name="notes" defaultValue={v.notes} />

            {kind === "price" && (
              <>
                <label htmlFor="steps">
                  Daily rates, highest first; the last one is the floor
                </label>
                <input
                  id="steps"
                  name="steps"
                  defaultValue={(v.steps as number[]).join(", ")}
                />
                <p className="muted">
                  Max opens at the first rate, comes down one step each time the
                  customer pushes back, and never goes below the last.
                </p>
              </>
            )}

            {kind === "kb" && (
              <>
                <label htmlFor="facts">
                  Facts (JSON). Max answers questions only from facts with
                  status &quot;script&quot; or &quot;approved&quot;.
                </label>
                <textarea
                  id="facts"
                  name="facts"
                  rows={24}
                  defaultValue={JSON.stringify(v.facts, null, 2)}
                />
              </>
            )}

            {kind === "script" && (
              <>
                <label htmlFor="disclosure">
                  Recording disclosure (said word for word; Beat 1 must contain
                  it)
                </label>
                <textarea
                  id="disclosure"
                  name="disclosure"
                  rows={3}
                  defaultValue={v.disclosure}
                />
                {(
                  v.beats as Array<{
                    id: number;
                    type: string;
                    expects?: string;
                    text: string;
                  }>
                ).map((b) => (
                  <div key={b.id}>
                    <label htmlFor={`beat_${b.id}`}>
                      Beat {b.id} ({b.type}
                      {b.expects ? `, expects ${b.expects}` : ""})
                      {b.id === 22 ? ": must say {{per_day_price}}" : ""}
                    </label>
                    <textarea
                      id={`beat_${b.id}`}
                      name={`beat_${b.id}`}
                      rows={3}
                      defaultValue={b.text}
                    />
                  </div>
                ))}
                <label htmlFor="fixed_lines">
                  Fixed lines to override (JSON, e.g.{" "}
                  {`{"HANDOFF_LINE": "..."}`})
                </label>
                <textarea
                  id="fixed_lines"
                  name="fixed_lines"
                  rows={6}
                  defaultValue={JSON.stringify(v.fixed_lines ?? {}, null, 2)}
                />
                <label htmlFor="recaps">
                  Recaps for beats you reworded (JSON, by beat number)
                </label>
                <textarea
                  id="recaps"
                  name="recaps"
                  rows={4}
                  defaultValue={JSON.stringify(v.recaps ?? {}, null, 2)}
                />
                <p className="muted">
                  Placeholders:{" "}
                  {
                    "{{vehicle_year}} {{vehicle_make}} {{vehicle_model}} {{per_day_price}}"
                  }
                  . Prices come from the price ladder only.
                </p>
                <label htmlFor="native_prompt">
                  <b>Max&apos;s prompt</b>: persona, goal, guidelines and tone.
                  This runs the call (MAX.ZI&apos;s engine)
                  {v.native_prompt ? "" : " (now: the built-in prompt)"}
                </label>
                <textarea
                  id="native_prompt"
                  name="native_prompt"
                  rows={30}
                  defaultValue={v.native_prompt ?? BUILT_IN_NATIVE_PROMPT}
                />
                <p className="muted">
                  Write how Max should behave, in plain words. No beats: the
                  talking points (the beats above), the facts, the price ladder
                  and the recording disclosure are added to the prompt
                  automatically, so don&apos;t paste them here and don&apos;t
                  write numbers or prices. Whatever the prompt says, the code
                  still enforces the disclosure word for word, prices only from
                  the ladder (one step at a time, only after pushback), no
                  invented figures, and never treating a no as a yes.
                </p>
                <label htmlFor="free_prompt">
                  Free-mode prompt: how the AI runs the call when the AI runs it
                  from a prompt
                  {v.free_prompt ? "" : " (now: the built-in prompt)"}
                </label>
                <textarea
                  id="free_prompt"
                  name="free_prompt"
                  rows={22}
                  defaultValue={v.free_prompt ?? BUILT_IN_FREE_PROMPT}
                />
                <p className="muted">
                  Keep every placeholder (
                  {
                    "{{vehicle}} {{script}} {{facts}} {{disclosure}} {{first_price}} {{price_steps}} {{floor}}"
                  }
                  ) and every rule sentence (the disclosure word for word, the
                  price rules, never invent, never claim to be human). No new
                  numbers, prices or promise words: the price ladder and facts
                  come from their own versions. Saving checks this. Whatever the
                  prompt says, the code still enforces the price ladder, the
                  disclosure and no invented figures.
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
        {/* -------- test this version right here, as the dealership's own call would run it -------- */}
        <div className="sticky">
          <AgentChat
            versionId={versionId}
            kind={kind}
            label={`${KIND_LABEL[kind]} v${v.version} (${v.status})`}
            dealershipName={dealership.name}
          />
          {editable && (
            <p className="muted">
              Save the draft first: the test runs on what is saved.
            </p>
          )}
          {can.edit && (
            <ShareLinks
              personId={person.id}
              dealershipId={id}
              kind={kind}
              versionId={versionId}
              back={`/d/${id}/${kind}/${versionId}`}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}
