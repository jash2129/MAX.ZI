import Link from "next/link";

import { DealershipNav, Shell } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { getDealership, listCalls } from "@/server/portal";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

const fmt = (t: string | null) => (t ? new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
const minutes = (a: string, b: string | null) => (b ? `${Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000))} min` : "in progress");

export default async function Calls({ params }: { params: Promise<{ id: string }> }) {
  const person = await requirePerson();
  const { id } = await params;
  const db = portalDb();
  const [dealership, calls] = await Promise.all([getDealership(db, person.id, id), listCalls(db, person.id, id, 100)]);
  return (
    <Shell person={person} sub={<DealershipNav id={id} name={dealership.name} current="calls" />}>
      <p>
        <Link href="/">Dealerships</Link> / <Link href={`/d/${id}`}>{dealership.name}</Link>
      </p>
      <h1>Calls</h1>
      <p className="muted">The latest 100. Each call keeps its transcript, what the customer heard, the timings and the after-call review.</p>
      {calls.length === 0 ? (
        <p className="panel">No calls yet.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Length</th>
                <th>Outcome</th>
                <th>Reached</th>
                <th>Checks</th>
                <th>Score</th>
                <th>Webhook</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/d/${id}/calls/${encodeURIComponent(c.id)}`}>{fmt(c.started_at)}</Link>
                  </td>
                  <td>{minutes(c.started_at, c.ended_at)}</td>
                  <td>{c.declined ? "Declined" : c.final_rate !== null ? `Accepted, $${Number(c.final_rate).toFixed(2)}/day` : c.ended_at ? "No decision" : ""}</td>
                  <td>
                    Beat {c.furthest_beat ?? 0}
                    {c.end_reason && <div className="muted">{c.end_reason.replace(/_/g, " ")}</div>}
                  </td>
                  <td>{c.compliance_ok === null ? "" : c.compliance_ok ? <span className="badge live">passed</span> : <span className="notice error">failed</span>}</td>
                  <td>{c.score === null ? "" : `${Number(c.score).toFixed(1)} / 10`}</td>
                  <td>{c.webhook === "none" ? "" : c.webhook}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
