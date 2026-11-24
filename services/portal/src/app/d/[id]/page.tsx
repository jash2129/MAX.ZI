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
import { DealershipNav, KIND_LABEL, Notices, Shell, Status } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { KINDS, auditLog, dashboard, getDealership, getVersion, getWebhook, listApiKeys, listPeople, listVersions, permissions, type Kind } from "@/server/portal";
import { agentSettings } from "../../../../../../tavus-avatar/src/lib/native-engine";
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

  // What Max runs on now, for the cards
  const liveOf = (i: number) => versions[i].find((x) => x.status === "live") ?? null;
  const [liveScript, livePrice, liveKb] = await Promise.all(
    KINDS.map((k, i) => (liveOf(i) ? getVersion(db, person.id, k, liveOf(i)!.id) : Promise.resolve(null)))
  );
  const agent = agentSettings(liveScript?.agent);
  const guardsOn = [agent.priceLadder, agent.disclosure, agent.scriptTalkingPoints].filter(Boolean).length;
  const pending = (i: number) => versions[i].filter((x) => x.status === "draft" || x.status === "in_test");
  const reviews = versions.flat().filter((x) => x.status === "in_test").length;
  const editHref = (kind: Kind, vid: string) => (kind === "script" ? `/d/${id}/agent?v=${vid}` : `/d/${id}/${kind}/${vid}`);
  const todos = KINDS.flatMap((kind, i) =>
    pending(i).map((v) => {
      const r = v.test_result;
      if (v.status === "draft") return { key: v.id, badge: "draft", title: `${KIND_LABEL[kind]} v${v.version} is a draft`, text: "Test it, then send it for review.", href: editHref(kind, v.id), link: "Continue editing →" };
      const text = !r ? "Run the automatic test, then an approver reviews it." : r.hard_failures > 0 ? `The automatic test failed: ${r.hard_failures} of ${r.calls} calls broke a safety rule.` : "Automatic test passed. An approver needs to look at the changes.";
      return { key: v.id, badge: "in_test", title: `${KIND_LABEL[kind]} v${v.version} is waiting for review`, text, href: `/d/${id}/${kind}/${v.id}`, link: "Review changes →" };
    })
  );
  const steps = (liveScript?.beats as unknown[] | undefined)?.length ?? 0;
  const ladder = ((livePrice?.steps as number[] | undefined) ?? []).map(Number);
  const facts = ((liveKb?.facts as unknown[] | undefined) ?? []).length;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const tag = (i: number) => {
    const l = liveOf(i);
    return l ? <span className="badge live">v{l.version} live</span> : <span className="badge in_test">not live</span>;
  };
  const extra = (i: number) => {
    const p = pending(i)[0];
    return p ? <span className="muted" style={{ fontSize: 13 }}>v{p.version} {p.status === "draft" ? "draft" : "in review"}</span> : null;
  };

  return (
    <Shell person={person} sub={<DealershipNav id={id} name={dealership.name} current="home" reviews={reviews} />}>
      <Notices
        search={search}
        ok={{
          approved: "Approved: the new version is live for new calls. Calls in progress keep theirs.",
          rolledback: "Rolled back: the earlier version is live for new calls.",
          created: "Dealership created with draft versions copied from the template.",
        }}
      />

      <section className="hero" aria-labelledby="status-h">
        <div>
          <span className={`live-flag ${live ? "on" : "off"}`}>
            <span className="dot" aria-hidden="true" />
            {live ? "Live · taking calls" : "Not taking calls yet"}
          </span>
          <h1 id="status-h">{live ? `${dealership.max_display_name} is answering calls for ${dealership.name}` : `${dealership.max_display_name} isn't live for ${dealership.name} yet`}</h1>
          <p>
            {live
              ? `New calls use: Script v${liveOf(0)!.version} · Price ladder v${liveOf(1)!.version} · Knowledge base v${liveOf(2)!.version}. Calls in progress keep the version they started with.`
              : "The script, price ladder and knowledge base each need an approved, live version. Finish each draft below and send it for review."}
          </p>
          <p style={{ fontSize: 13 }}>
            {can.approve ? "You can edit and approve." : can.edit ? "You can edit; an approver makes changes live." : "You can view."} · {dealership.id}
          </p>
        </div>
        <div className="row">
          <Link className="button primary" href={`/d/${id}/agent`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <path d="M12 19v3" />
            </svg>
            Test Max now
          </Link>
          <Link className="button" href={`/d/${id}/agent`}>
            Open Agent studio
          </Link>
        </div>
      </section>

      <h2 id="reviews">Needs your attention</h2>
      {todos.length ? (
        <div className="tiles">
          {todos.map((t) => (
            <div key={t.key} className="todo">
              <span className={`badge ${t.badge}`} style={{ flex: "none" }}>
                {t.badge === "draft" ? "Draft" : "In review"}
              </span>
              <div>
                <strong>{t.title}</strong>
                <span className="small">{t.text}</span>
                <Link href={t.href} style={{ fontWeight: 600, fontSize: 14 }}>
                  {t.link}
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="panel muted" style={{ margin: 0 }}>
          Nothing waiting. Everything customers hear is approved.
        </p>
      )}

      <section className="panel" aria-labelledby="how-h" style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 id="how-h" style={{ margin: 0, fontSize: 17 }}>
            How a change reaches customers
          </h2>
          <span className="muted" style={{ fontSize: 14 }}>
            Nothing you edit reaches a call until step 4.
          </span>
        </div>
        <ol className="steps">
          <li>
            <b>
              <span className="n" style={{ background: "var(--draft)" }}>1</span>Draft
            </b>
            <span className="small">Edit freely and test it yourself.</span>
          </li>
          <li>
            <b>
              <span className="n" style={{ background: "var(--warn)" }}>2</span>Automatic test
            </b>
            <span className="small">Locked. Simulated customers call Max and every safety rule is checked.</span>
          </li>
          <li>
            <b>
              <span className="n" style={{ background: "var(--accent)" }}>3</span>Approver review
            </b>
            <span className="small">An approver sees exactly what changed and says yes.</span>
          </li>
          <li className="last">
            <b>
              <span className="n" style={{ background: "var(--ok)" }}>4</span>Live
            </b>
            <span className="small">New calls use it. One click rolls back to the previous version.</span>
          </li>
        </ol>
      </section>

      <h2>What {dealership.max_display_name} is made of</h2>
      <div className="tiles">
        <article className="tile">
          <div className="tile-head">
            <h3>Agent</h3>
            {tag(0)}
          </div>
          <p>How {dealership.max_display_name} talks: personality, context, greeting, documents and safety switches.</p>
          <dl>
            <dt>Prompt</dt>
            <dd>{liveScript?.native_prompt ? "Your own" : "Built-in"}</dd>
            <dt>Documents</dt>
            <dd>{agent.docs.length}</dd>
            <dt>Safety switches</dt>
            <dd>{guardsOn === 3 ? "All on" : `${guardsOn} of 3 on`}</dd>
          </dl>
          {extra(0)}
          <div className="actions">
            <Link className="button soft" href={`/d/${id}/agent`}>
              Edit &amp; test
            </Link>
          </div>
        </article>
        <article className="tile">
          <div className="tile-head">
            <h3>Talking points</h3>
            {tag(0)}
          </div>
          <p>The approved script {dealership.max_display_name} draws from, plus the recording disclosure.</p>
          <dl>
            <dt>Script</dt>
            <dd>{steps ? `${steps} beats` : "none live"}</dd>
            <dt>Disclosure</dt>
            <dd>Word for word</dd>
          </dl>
          {extra(0)}
          <div className="actions">
            <Link className="button soft" href={liveOf(0) ? `/d/${id}/script/${(pending(0)[0] ?? liveOf(0))!.id}` : `/d/${id}#versions`}>
              Edit &amp; test
            </Link>
          </div>
        </article>
        <article className="tile">
          <div className="tile-head">
            <h3>Price ladder</h3>
            {tag(1)}
          </div>
          <p>The only daily prices {dealership.max_display_name} may say, highest first.</p>
          {ladder.length ? (
            <div className="ladder" aria-label="Daily prices, highest first">
              {ladder.map((n, i) => (
                <span key={i} style={{ display: "contents" }}>
                  <span className={i === ladder.length - 1 ? "floor" : undefined}>
                    {money(n)}
                    {i === ladder.length - 1 ? " floor" : ""}
                  </span>
                  {i < ladder.length - 1 && <i aria-hidden="true">→</i>}
                </span>
              ))}
            </div>
          ) : (
            <p>No live price ladder.</p>
          )}
          {extra(1)}
          <div className="actions">
            <Link className="button soft" href={`/d/${id}/price/${(pending(1)[0] ?? liveOf(1) ?? versions[1][0])?.id ?? ""}`}>
              Edit &amp; test
            </Link>
          </div>
        </article>
        <article className="tile">
          <div className="tile-head">
            <h3>Knowledge base</h3>
            {tag(2)}
          </div>
          <p>Approved answers to customer questions. {dealership.max_display_name} can&apos;t state facts outside it.</p>
          <dl>
            <dt>Facts</dt>
            <dd>{facts}</dd>
            <dt>Shared facts</dt>
            <dd>Included</dd>
          </dl>
          {extra(2)}
          <div className="actions">
            <Link className="button soft" href={`/d/${id}/kb/${(pending(2)[0] ?? liveOf(2) ?? versions[2][0])?.id ?? ""}`}>
              Edit &amp; test
            </Link>
          </div>
        </article>
      </div>

      <div className="section-head">
        <h2>Calls, last 30 days</h2>
        <Link href={`/d/${id}/calls`} style={{ fontWeight: 600 }}>
          All calls →
        </Link>
      </div>
      <div className="tiles">
        <div className="tile stat">
          <span className="small">Calls</span>
          <span className="big">{stats.calls}</span>
          <span className="small">{stats.calls ? "in the last 30 days" : "No customer calls yet"}</span>
        </div>
        <div className="tile stat">
          <span className="small">Reached the price · finished</span>
          <span className="big">{show(stats.price_reached_rate)}</span>
          <span className="small">Finished the call: {show(stats.completed_rate)} · targets 90% and 80%</span>
        </div>
        <div className="tile stat">
          <span className="small">Took the package</span>
          <span className="big">{show(stats.take_rate)}</span>
          <span className="small">Average daily rate {stats.avg_final_rate === null ? "n/a" : `$${stats.avg_final_rate.toFixed(2)}`}</span>
        </div>
        <div className="tile stat">
          <span className="small">{dealership.max_display_name} starts speaking after</span>
          <span className="big">{show(stats.first_audio_ms.median, " ms")}</span>
          <span className="small">90th percentile {show(stats.first_audio_ms.p90, " ms")}, over {stats.first_audio_ms.turns} turns</span>
        </div>
        <div className={`tile stat`} style={stats.compliance_failures ? { borderColor: "var(--bad)", background: "var(--bad-bg)" } : undefined}>
          <span className="small">Calls breaking a safety rule</span>
          <span className="big" style={stats.compliance_failures ? { color: "var(--bad)" } : undefined}>
            {stats.compliance_failures}
          </span>
          <span className="small">{stats.compliance_failures ? "Open the calls list to see which" : "None"}</span>
        </div>
      </div>

      <h2 id="versions">Version history</h2>
      {KINDS.map((kind, i) => (
        <section key={kind} style={{ marginBottom: 20 }}>
          <h3 style={{ margin: "0 0 8px" }}>{KIND_LABEL[kind]}</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Automatic test</th>
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
                        ? `${v.test_result.hard_failures === 0 ? "Passed" : "Failed"}: ${v.test_result.calls} calls, ${v.test_result.hard_failures} broke a safety rule`
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
