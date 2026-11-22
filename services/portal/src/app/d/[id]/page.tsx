import { cookies } from "next/headers";
import Link from "next/link";

import { addPersonAction, newDraftAction, reinviteAction, removePersonAction } from "@/app/actions";
import { KIND_LABEL, Notices, Shell, Status } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { KINDS, auditLog, getDealership, listPeople, listVersions, permissions } from "@/server/portal";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

const fmt = (t: string | null) => (t ? new Date(t).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");

export default async function DealershipPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const person = await requirePerson();
  const { id } = await params;
  const search = await searchParams;
  const db = portalDb();
  const [dealership, can] = await Promise.all([getDealership(db, person.id, id), permissions(db, person.id, id)]);
  const versions = await Promise.all(KINDS.map((k) => listVersions(db, person.id, id, k)));
  const [people, audit] = await Promise.all([listPeople(db, person.id, id), auditLog(db, person.id, id, 30)]);

  // A just-created invite link, shown once (set by addPersonAction, never in the URL)
  const jar = await cookies();
  const flash = jar.get("flash_invite")?.value;
  const invite = flash ? (JSON.parse(flash) as { email: string; link: string }) : null;

  return (
    <Shell person={person}>
      <p>
        <Link href="/">Dealerships</Link>
      </p>
      <h1>{dealership.name}</h1>
      <p className="muted">
        {dealership.id} · Max is called {dealership.max_display_name} · {can.approve ? "you can approve" : can.edit ? "you can edit" : "view only"}
      </p>
      <Notices search={search} ok={{ approved: "Approved: the new version is live for new calls. Calls in progress keep theirs.", rolledback: "Rolled back: the earlier version is live for new calls." }} />

      {KINDS.map((kind, i) => (
        <section key={kind}>
          <h2>{KIND_LABEL[kind]}</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Test gate</th>
                  <th>Approved</th>
                </tr>
              </thead>
              <tbody>
                {versions[i].map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link href={`/d/${id}/${kind}/${v.id}`}>v{v.version}</Link>
                      {v.notes && <div className="muted">{v.notes}</div>}
                    </td>
                    <td>
                      <Status status={v.status} />
                    </td>
                    <td>
                      {fmt(v.created_at)}
                      {v.created_by && <div className="muted">{v.created_by}</div>}
                    </td>
                    <td>
                      {v.test_result
                        ? `${v.test_result.hard_failures === 0 ? "passed" : "failed"}: ${v.test_result.calls} calls, ${v.test_result.hard_failures} hard failures, ${v.test_result.completion_rate}% completed`
                        : "not run"}
                    </td>
                    <td>
                      {fmt(v.approved_at)}
                      {v.approved_by && <div className="muted">{v.approved_by}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can.edit && (
            <form action={newDraftAction} style={{ marginTop: 8 }}>
              <input type="hidden" name="dealership" value={id} />
              <input type="hidden" name="kind" value={kind} />
              <button type="submit">New draft from the live version</button>
            </form>
          )}
        </section>
      ))}

      <h2 id="people">People</h2>
      {invite && (
        <div className="notice ok" role="status">
          Invite link for {invite.email} (works once, for 7 days; copy it now, it is not shown again):
          <div className="mono" style={{ wordBreak: "break-all", marginTop: 6 }}>
            {invite.link}
          </div>
        </div>
      )}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Added</th>
              {can.edit && <th />}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={`${p.id}-${p.role}`}>
                <td>{p.email}</td>
                <td>{p.role}</td>
                <td>{fmt(p.created_at)}</td>
                {can.edit && (
                  <td>
                    <div className="row">
                      <form action={reinviteAction}>
                        <input type="hidden" name="dealership" value={id} />
                        <input type="hidden" name="person" value={p.id} />
                        <input type="hidden" name="email" value={p.email} />
                        <button type="submit">New invite link</button>
                      </form>
                      <form action={removePersonAction}>
                        <input type="hidden" name="dealership" value={id} />
                        <input type="hidden" name="person" value={p.id} />
                        <input type="hidden" name="role" value={p.role} />
                        <button className="danger" type="submit">
                          Remove
                        </button>
                      </form>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can.edit && (
        <form action={addPersonAction} className="panel" style={{ marginTop: 12 }}>
          <input type="hidden" name="dealership" value={id} />
          <div className="grid2">
            <div>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required />
            </div>
            <div>
              <label htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue="viewer">
                <option value="viewer">Viewer: reads calls and dashboards</option>
                <option value="manager">Manager: edits drafts, adds people</option>
                <option value="approver">Approver: approves and rolls back (agency admin or platform owner only)</option>
              </select>
            </div>
          </div>
          <p>
            <button className="primary" type="submit">
              Add person and create invite link
            </button>
          </p>
        </form>
      )}

      <h2>Recent changes</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a, i) => (
              <tr key={i}>
                <td>{fmt(a.at)}</td>
                <td>{a.actor ?? "system (test gate, seed)"}</td>
                <td>
                  {a.table_name.replace("_version", "").replace("price_ladder", "price ladder").replace("kb", "knowledge base")} {a.version ? `v${a.version}` : ""}: {a.action}
                  {a.status_before !== a.status_after && a.status_after ? ` (${a.status_before ?? "new"} to ${a.status_after})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
