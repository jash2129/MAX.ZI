import Link from "next/link";

import { forgetCallAction } from "@/app/actions";
import { DealershipNav, Notices, Shell } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { getCall, getDealership, permissions } from "@/server/portal";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

const fmt = (t: string | null) => (t ? new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" }) : "");
const CHECK_LABEL: Record<string, string> = {
  disclosure_said: "Recording disclosure said word for word",
  consent_before_beat_2: "Consent before Beat 2",
  prices_approved: "Only approved prices, never under the floor",
  no_confirmed_refusal: "Never confirmed after a refusal",
};

/** The call inspector (PRD): transcript, what was heard, who understood and worded each turn, timings, panels, review */
export default async function CallDetail({ params, searchParams }: { params: Promise<{ id: string; callId: string }>; searchParams: Promise<Record<string, string>> }) {
  const person = await requirePerson();
  const { id, callId } = await params;
  const search = await searchParams;
  const db = portalDb();
  const [dealership, { call, turns, review, recording }, can] = await Promise.all([
    getDealership(db, person.id, id),
    getCall(db, person.id, id, decodeURIComponent(callId)),
    permissions(db, person.id, id),
  ]);
  const checks = (review?.compliance_checks ?? {}) as Record<string, boolean>;
  return (
    <Shell person={person} sub={<DealershipNav id={id} name={dealership.name} current="calls" />}>
      <p>
        <Link href="/">Dealerships</Link> / <Link href={`/d/${id}`}>{dealership.name}</Link> / <Link href={`/d/${id}/calls`}>Calls</Link>
      </p>
      <h1>Call {fmt(call.started_at)}</h1>
      <p className="muted">
        {call.id} · ended {call.ended_at ? fmt(call.ended_at) : "(still in progress)"} {call.end_reason ? `· ${call.end_reason.replace(/_/g, " ")}` : ""} · consent{" "}
        {call.consent_at ? fmt(call.consent_at) : "not recorded"}
      </p>

      {review && (
        <>
          <h2>Review</h2>
          <div className="panel">
            <p>
              <strong>{review.summary}</strong> Score {Number(review.score).toFixed(1)} / 10.
            </p>
            <ul>
              {Object.entries(checks).map(([k, ok]) => (
                <li key={k} style={{ color: ok ? "var(--ok)" : "var(--bad)" }}>
                  {ok ? "Passed" : "FAILED"}: {CHECK_LABEL[k] ?? k}
                </li>
              ))}
            </ul>
            {(review.problems as Array<{ id: string; severity: string; detail: string | null }>).length > 0 && (
              <>
                <p className="muted">Problems found:</p>
                <ul>
                  {(review.problems as Array<{ id: string; severity: string; detail: string | null }>).map((pr, i) => (
                    <li key={i}>
                      {pr.severity}: {pr.id.replace(/_/g, " ")}
                      {pr.detail ? `: ${pr.detail}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}

      <h2>Recording</h2>
      {recording ? (
        <div className="panel">
          <audio controls preload="none" src={`/d/${id}/calls/${encodeURIComponent(call.id)}/recording`} style={{ width: "100%" }} />
          <p className="muted">
            {recording.duration_s ? `${Math.round(Number(recording.duration_s))} s · ` : ""}customer on the left, Max on the right · kept until{" "}
            {fmt(recording.retention_until)} · every playback is in the audit log
          </p>
        </div>
      ) : (
        <p className="muted">
          {call.consent_at ? "No recording for this call (recordings not set up, or the upload failed)." : "Not recorded: the customer did not consent to recording."}
        </p>
      )}

      <h2>Transcript</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Customer</th>
              <th>Max</th>
              <th>Beat</th>
              <th>Understood / worded by</th>
              <th>Heard</th>
              <th>Max started after</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t: any) => (
              <tr key={t.idx}>
                <td>{t.idx}</td>
                <td>{t.customer_text}</td>
                <td>
                  {t.max_text}
                  {(t.panels as Array<{ panel?: string }>).length > 0 && (
                    <div className="muted">Shown: {(t.panels as Array<{ panel?: string; event: string }>).map((p) => p.panel ?? "hide").join(", ")}</div>
                  )}
                </td>
                <td>
                  {t.beat_before} to {t.beat_after}
                </td>
                <td>
                  {t.understanding}
                  <div className="muted">{t.wording_source}</div>
                </td>
                <td>{t.heard === null ? "" : t.heard ? "yes" : `cut at ${Math.round(Number(t.fraction_heard) * 100)}%`}</td>
                <td>{t.timings?.first_audio_ms != null ? `${t.timings.first_audio_ms} ms` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Recordings are not stored yet (see the platform roadmap).</p>
      <Notices search={search} ok={{ forgotten: "The call's transcript, review text and recording were deleted. Its outcome stays for counts and billing." }} />

      {can.edit && turns.length > 0 && (
        <>
          <h2>Delete this call&apos;s content</h2>
          <form action={forgetCallAction} className="panel">
            <input type="hidden" name="dealership" value={id} />
            <input type="hidden" name="call" value={call.id} />
            <p className="muted">
              For a customer&apos;s deletion request: the transcript, the review text and any recording are deleted for good. The outcome (date, length,
              accepted or declined, rate) stays for counts and billing. This is recorded in the change history.
            </p>
            <label htmlFor="confirm">Type DELETE to confirm</label>
            <input id="confirm" name="confirm" autoComplete="off" />
            <p>
              <button className="danger" type="submit">
                Delete the content
              </button>
            </p>
          </form>
        </>
      )}
    </Shell>
  );
}
