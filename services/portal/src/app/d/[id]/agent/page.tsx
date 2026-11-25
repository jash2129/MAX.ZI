import Link from "next/link";

import { newAgentDraftAction, saveAgentAction, statusAction } from "@/app/actions";
import { AgentChat } from "@/components/agent-chat";
import { ShareLinks } from "@/components/share-links";
import { DealershipNav, Notices, Shell, Status } from "@/components/chrome";
import { StudioTabs } from "@/components/studio-tabs";
import { portalDb } from "@/server/db";
import { BUILT_IN_NATIVE_PROMPT, KINDS, getDealership, getVersion, listVersions, permissions } from "@/server/portal";
import { requirePerson } from "@/server/session";
import { AGENT_LIMITS, agentSettings } from "../../../../../../../tavus-avatar/src/lib/native-engine";

export const dynamic = "force-dynamic";

/**
 * The Agent studio: everything that shapes how Max talks, in four plain sections, with a test panel
 * beside them. The settings live on the script version, so they follow the same draft -> automatic
 * test -> approver review -> live path, with rollback.
 */
export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const person = await requirePerson();
  const { id } = await params;
  const search = await searchParams;
  const db = portalDb();
  const [dealership, can, all] = await Promise.all([
    getDealership(db, person.id, id),
    permissions(db, person.id, id),
    Promise.all(KINDS.map((k) => listVersions(db, person.id, id, k))),
  ]);
  const versions = all[0];
  const reviews = all.flat().filter((x) => x.status === "in_test").length;

  const pick =
    versions.find((v) => v.id === search.v) ??
    versions.find((v) => v.status === "draft") ??
    versions.find((v) => v.status === "in_test") ??
    versions.find((v) => v.status === "live") ??
    versions[0];
  const draft = versions.find((v) => v.status === "draft");
  const liveV = versions.find((v) => v.status === "live");
  const v = pick ? await getVersion(db, person.id, "script", pick.id) : null;
  const editable = Boolean(v && v.status === "draft" && can.edit);
  const a = agentSettings(v?.agent);
  const ro = !editable;
  const name = dealership.max_display_name;
  const guardsOn = [a.priceLadder, a.disclosure, a.scriptTalkingPoints].filter(Boolean).length;

  return (
    <Shell person={person} sub={<DealershipNav id={id} name={dealership.name} current="agent" reviews={reviews} />}>
      <Notices
        search={search}
        ok={{ saved: "Saved to the draft. Test it on the right; customers get it only after approval.", created: "New draft started from the live version." }}
      />

      <div className="studio-bar">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 style={{ margin: 0 }}>Agent studio</h1>
          <span className="muted" style={{ fontSize: 14 }}>
            {v ? (
              <>
                Version v{v.version} <Status status={v.status} />
                {liveV && liveV.id !== v.id ? ` · customers hear v${liveV.version}` : v.status === "live" ? " · customers hear this version" : ""}
              </>
            ) : (
              "No version yet"
            )}
          </span>
        </div>
        {v && (
          <div className="row">
            {editable && (
              <button className="button" type="submit" form="agent-form">
                Save draft
              </button>
            )}
            {editable && (
              <form action={statusAction}>
                <input type="hidden" name="dealership" value={id} />
                <input type="hidden" name="kind" value="script" />
                <input type="hidden" name="version" value={v.id} />
                <input type="hidden" name="to" value="in_test" />
                <button className="primary" type="submit" title="Save first: this sends what is saved">
                  Send for review
                </button>
              </form>
            )}
            {!editable && v.status === "in_test" && (
              <Link className="button primary" href={`/d/${id}/script/${v.id}`}>
                Open the review
              </Link>
            )}
          </div>
        )}
      </div>

      {v && versions.length > 1 && (
        <div className="row" style={{ marginBottom: 16, fontSize: 14 }}>
          <span className="muted">Versions:</span>
          {versions.map((x) => (
            <Link key={x.id} href={`/d/${id}/agent?v=${x.id}`} aria-current={x.id === v.id ? "page" : undefined} style={{ fontWeight: x.id === v.id ? 700 : 500 }}>
              v{x.version} ({x.status === "in_test" ? "in review" : x.status})
            </Link>
          ))}
        </div>
      )}

      {v && !editable && can.edit && (
        <div className="notice warn">
          {draft ? (
            <>
              v{v.version} is {v.status === "in_test" ? "in review" : v.status} and can&apos;t be edited.{" "}
              <Link href={`/d/${id}/agent?v=${draft.id}`}>Open the draft v{draft.version}</Link> to make changes.
            </>
          ) : (
            <form action={newAgentDraftAction} className="row">
              <input type="hidden" name="dealership" value={id} />
              <span>
                v{v.version} is {v.status === "in_test" ? "in review" : v.status} and can&apos;t be edited. Start a draft from the live version to make changes.
              </span>
              <button className="primary" type="submit">
                Start a draft
              </button>
            </form>
          )}
        </div>
      )}

      {!v && <p className="notice warn">This dealership has no script version yet.</p>}

      {v && (
        <div className="studio">
          <StudioTabs
            tabs={[
              { id: "prompt", label: "Personality & rules", hint: "The prompt" },
              { id: "context", label: "Greeting & context", hint: "First line, background" },
              { id: "docs", label: "Knowledge documents", hint: `${a.docs.length} document${a.docs.length === 1 ? "" : "s"}` },
              { id: "guard", label: "Safety switches", hint: `${guardsOn} of 3 on · 4 always on` },
            ]}
            note={
              liveV && liveV.id !== v.id
                ? `Changes stay in this draft. Customers keep hearing v${liveV.version} until an approver approves.`
                : "Customers hear only approved versions."
            }
          >
            <form id="agent-form" action={saveAgentAction}>
              <input type="hidden" name="dealership" value={id} />
              <input type="hidden" name="version" value={v.id} />

              <section className="panel" data-tab="prompt" id="tab-prompt">
                <h2>Personality &amp; rules</h2>
                <p className="lead">Describe how {name} behaves, in plain words. No prices or numbers here: those come from the price ladder and knowledge base.</p>
                <div className="chips" aria-hidden="true">
                  <span>Persona</span>
                  <span>Goal</span>
                  <span>How a good call goes</span>
                  <span>Guidelines</span>
                  <span>Tone</span>
                </div>
                <label htmlFor="native_prompt">{name}&apos;s prompt</label>
                <textarea id="native_prompt" name="native_prompt" rows={24} defaultValue={v.native_prompt ?? BUILT_IN_NATIVE_PROMPT} readOnly={ro} />
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Checked when you save: no prices, no new numbers, no promises like &quot;refundable&quot;. {v.native_prompt ? "" : "Now: the built-in prompt."}
                </p>
              </section>

              <section className="panel" data-tab="context" id="tab-context">
                <h2>Greeting &amp; context</h2>
                <p className="lead">The first thing customers hear, and the background {name} should know.</p>
                <label htmlFor="greeting">Greeting (said word for word)</label>
                <input id="greeting" name="greeting" defaultValue={a.greeting} readOnly={ro} maxLength={AGENT_LIMITS.greeting} placeholder="Can you hear and see me alright?" />
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Empty = &quot;Can you hear and see me alright?&quot;. Up to {AGENT_LIMITS.greeting} characters, no prices.
                </p>
                <label htmlFor="context">Context</label>
                <textarea
                  id="context"
                  name="context"
                  rows={10}
                  defaultValue={a.context}
                  readOnly={ro}
                  maxLength={AGENT_LIMITS.context}
                  placeholder="The dealership, this month's offer, who the customers are…"
                />
              </section>

              <section className="panel" data-tab="docs" id="tab-docs">
                <h2>Knowledge documents</h2>
                <p className="lead">
                  {name} may use anything written here, numbers included, once this version is approved. Up to {AGENT_LIMITS.docs} documents,{" "}
                  {AGENT_LIMITS.docsTotal.toLocaleString("en-US")} characters in all.
                </p>
                {a.docs.map((d, i) => (
                  <div key={i} className="doc">
                    <label htmlFor={`doc_title_${i}`}>Title</label>
                    <input id={`doc_title_${i}`} name={`doc_title_${i}`} defaultValue={d.title} readOnly={ro} maxLength={AGENT_LIMITS.docTitle} />
                    <label htmlFor={`doc_text_${i}`}>Text ({d.text.length.toLocaleString("en-US")} characters)</label>
                    <textarea id={`doc_text_${i}`} name={`doc_text_${i}`} rows={6} defaultValue={d.text} readOnly={ro} />
                    {editable && (
                      <label className="check">
                        <input type="checkbox" name={`doc_remove_${i}`} /> Remove this document when saving
                      </label>
                    )}
                  </div>
                ))}
                {!a.docs.length && <p className="muted">No documents yet.</p>}
                {editable && (
                  <div className="doc" style={{ borderStyle: "dashed", borderWidth: 2 }}>
                    <strong>Add documents</strong>
                    <label htmlFor="new_doc_files">Upload text files (.txt, .md, .csv, .json, .html; up to 1 MB each)</label>
                    <input id="new_doc_files" name="new_doc_files" type="file" multiple accept=".txt,.md,.markdown,.csv,.json,.tsv,.html,.htm,text/*,application/json" />
                    <label htmlFor="new_doc_title">Or paste one: title</label>
                    <input id="new_doc_title" name="new_doc_title" maxLength={AGENT_LIMITS.docTitle} />
                    <label htmlFor="new_doc_text">Text (for a PDF or Word file, copy its text here)</label>
                    <textarea id="new_doc_text" name="new_doc_text" rows={6} />
                  </div>
                )}
              </section>

              <section className="panel" data-tab="guard" id="tab-guard">
                <h2>Safety switches</h2>
                <p className="lead">What the code enforces on every reply, whatever the prompt says.</p>
                <label className="check doc">
                  <input type="checkbox" name="guard_price_ladder" defaultChecked={a.priceLadder} disabled={ro} />
                  <span>
                    <b>Price ladder</b>: prices only from the approved ladder, the first offer at the top, one step down only when the customer pushes back. Off:{" "}
                    {name} may say only amounts written in your context, documents or facts.
                  </span>
                </label>
                <label className="check doc">
                  <input type="checkbox" name="guard_disclosure" defaultChecked={a.disclosure} disabled={ro} />
                  <span>
                    <b>Recording disclosure</b>: said word for word before any price. {name} adds it if the AI forgets.
                  </span>
                </label>
                <label className="check doc">
                  <input type="checkbox" name="guard_script_talking_points" defaultChecked={a.scriptTalkingPoints} disabled={ro} />
                  <span>
                    <b>Script as talking points</b>: give {name} the approved script as material. Off: {name} uses your context and documents only.
                  </span>
                </label>
                <div className="always">
                  <strong>Always on</strong>
                  <ul>
                    <li>No number or claim that isn&apos;t in your approved content</li>
                    <li>Never claims to be a person</li>
                    <li>A no is never treated as a yes</li>
                    <li>Never says the same sentence twice</li>
                  </ul>
                </div>
              </section>

              {editable && (
                <div className="panel" style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <div style={{ flex: "1 1 280px" }}>
                    <label htmlFor="notes" style={{ marginTop: 0 }}>
                      Note for the approver (optional)
                    </label>
                    <input id="notes" name="notes" maxLength={500} />
                  </div>
                  <button className="primary" type="submit">
                    Save draft
                  </button>
                </div>
              )}
            </form>
          </StudioTabs>

          <aside className="studio-side sticky" aria-label="Test this version">
            <AgentChat versionId={v.id} label={`v${v.version}`} dealershipName={dealership.name} />
            {editable && (
              <p className="muted" style={{ fontSize: 13 }}>
                Tests what is saved: save the draft first.
              </p>
            )}
            {can.edit && <ShareLinks personId={person.id} dealershipId={id} kind="script" versionId={v.id} back={`/d/${id}/agent?v=${v.id}`} />}
          </aside>
        </div>
      )}
    </Shell>
  );
}
