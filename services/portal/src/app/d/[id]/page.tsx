import { cookies } from "next/headers";
import Link from "next/link";

import {
  addPersonAction,
  createApiKeyAction,
  newDraftAction,
  reinviteAction,
  removePersonAction,
  removeWebhookAction,
  revokeApiKeyAction,
  setWebhookAction,
} from "@/app/actions";
import { KIND_LABEL, Notices, Shell, Status } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { KINDS, auditLog, dashboard, getDealership, getWebhook, listApiKeys, listPeople, listVersions, permissions } from "@/server/portal";
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
  const [people, audit, stats, webhook, apiKeys] = await Promise.all([
    listPeople(db, person.id, id),
    auditLog(db, person.id, id, 30),
    dashboard(db, person.id, id, 30),
    can.edit ? getWebhook(db, person.id, id) : Promise.resolve(null),
    can.edit ? listApiKeys(db, person.id, id) : Promise.resolve([]),
  ]);
  const newKey = (await cookies()).get("flash_api_key")?.value ?? null;
  const live = versions.every((v) => v.some((x) => x.status === "live"));

  // A just-created invite link or webhook secret, shown once (set by an action, never in the URL)
  const jar = await cookies();
  const flash = jar.get("flash_invite")?.value;
  const invite = flash ? (JSON.parse(flash) as { email: string; link: string }) : null;
  const newSecret = jar.get("flash_webhook_secret")?.value ?? null;
  const show = (v: number | null, unit = "%") => (v === null ? "n/a" : `${v}${unit}`);

  return (
    <Shell person={person}>
      <p>
        <Link href="/">Dealerships</Link>
      </p>
      <h1>{dealership.name}</h1>
      <p className="muted">
        {dealership.id} · Max is called {dealership.max_display_name} · {can.approve ? "you can approve" : can.edit ? "you can edit" : "view only"}
      </p>
      <Notices
        search={search}
        ok={{
          approved: "Approved: the new version is live for new calls. Calls in progress keep theirs.",
          rolledback: "Rolled back: the earlier version is live for new calls.",
          created: "Dealership created with draft versions copied from the template.",
        }}
      />
      {!live && (
        <p className="notice warn">
          Not taking calls yet: the script, price ladder and knowledge base each need an approved, live version. Open each draft, submit it, run the
          release gate, and have an approver approve it.
        </p>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>Agent</strong>
            <div className="muted">Prompt, context, greeting, knowledge documents and guardrails, with a test chat.</div>
          </div>
          <Link className="button" href={`/d/${id}/agent`}>
            Open the Agent page →
          </Link>
        </div>
      </div>

      <h2>Last 30 days</h2>
      <div className="grid2">
        <div className="panel">
          <div className="muted">Calls</div>
          <div style={{ fontSize: 26, fontWeight: 650 }}>{stats.calls}</div>
          <Link href={`/d/${id}/calls`}>See all calls</Link>
        </div>
        <div className="panel">
          <div className="muted">Completed the script · reached the price</div>
          <div style={{ fontSize: 22, fontWeight: 650 }}>
            {show(stats.completed_rate)} · {show(stats.price_reached_rate)}
          </div>
          <div className="muted">PRD targets: 80% and 90%</div>
        </div>
        <div className="panel">
          <div className="muted">Took the package · average daily rate</div>
          <div style={{ fontSize: 22, fontWeight: 650 }}>
            {show(stats.take_rate)} · {stats.avg_final_rate === null ? "n/a" : `$${stats.avg_final_rate.toFixed(2)}`}
          </div>
        </div>
        <div className="panel">
          <div className="muted">Max starts speaking after (median · 90th percentile)</div>
          <div style={{ fontSize: 22, fontWeight: 650 }}>
            {show(stats.first_audio_ms.median, " ms")} · {show(stats.first_audio_ms.p90, " ms")}
          </div>
          <div className="muted">From the end of the customer&apos;s turn, over {stats.first_audio_ms.turns} turns</div>
        </div>
        <div className={`panel ${stats.compliance_failures ? "notice error" : ""}`}>
          <div className="muted">Calls failing a compliance check</div>
          <div style={{ fontSize: 26, fontWeight: 650 }}>{stats.compliance_failures}</div>
        </div>
      </div>

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

      {can.edit && (
        <>
          <h2 id="webhook">Webhook</h2>
          {newSecret && (
            <div className="notice ok" role="status">
              Signing secret (copy it into your system now, it is not shown again). Each delivery carries{" "}
              <code>X-Max-Signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</code>, where v1 is the HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code> with this secret:
              <div className="mono" style={{ wordBreak: "break-all", marginTop: 6 }}>
                {newSecret}
              </div>
            </div>
          )}
          <div className="panel">
            <p className="muted">
              After every call, a summary (outcome, daily rate, compliance checks, score; no transcript) is sent here.
              {webhook ? ` Now: ${webhook.url}` : " Not set."}
            </p>
            <form action={setWebhookAction} className="row">
              <input type="hidden" name="dealership" value={id} />
              <input name="url" type="url" placeholder="https://your-crm.example.com/max-calls" defaultValue={webhook?.url ?? ""} style={{ flex: "1 1 280px" }} required />
              <button type="submit">{webhook ? "Save and make a new secret" : "Save"}</button>
            </form>
            {webhook && (
              <form action={removeWebhookAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="dealership" value={id} />
                <button className="danger" type="submit">
                  Remove webhook
                </button>
              </form>
            )}
          </div>
        </>
      )}

      {can.edit && (
        <>
          <h2 id="api-keys">Deal intake API keys</h2>
          {newKey && (
            <div className="notice ok" role="status">
              New API key (copy it into your dealership system now, it is not shown again):
              <div className="mono" style={{ wordBreak: "break-all", marginTop: 6 }}>
                {newKey}
              </div>
            </div>
          )}
          <div className="panel">
            <p className="muted">
              Your dealership system sends each deal to <code>POST /api/v1/deals</code> with <code>Authorization: Bearer &lt;key&gt;</code> and{" "}
              <code>{`{"external_ref", "vehicle": {"year", "make", "model"}, "customer_first_name"}`}</code>. It gets back a <code>deal_id</code> (valid 2 hours) to
              start the call with, so Max already knows the vehicle.
            </p>
            {apiKeys.length > 0 && (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Label</th>
                      <th>Created</th>
                      <th>Last used</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map((k) => (
                      <tr key={k.id}>
                        <td className="mono">{k.prefix}…</td>
                        <td>{k.label}</td>
                        <td>
                          {fmt(k.created_at)}
                          {k.created_by && <div className="muted">{k.created_by}</div>}
                        </td>
                        <td>{k.last_used_at ? fmt(k.last_used_at) : "never"}</td>
                        <td>
                          {k.revoked_at ? (
                            <span className="muted">revoked {fmt(k.revoked_at)}</span>
                          ) : (
                            <form action={revokeApiKeyAction}>
                              <input type="hidden" name="dealership" value={id} />
                              <input type="hidden" name="key" value={k.id} />
                              <button className="danger" type="submit">
                                Revoke
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form action={createApiKeyAction} className="row" style={{ marginTop: 8 }}>
              <input type="hidden" name="dealership" value={id} />
              <input name="label" placeholder="What uses it (e.g. DMS)" style={{ flex: "1 1 220px" }} />
              <button type="submit">Create API key</button>
            </form>
          </div>
        </>
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
