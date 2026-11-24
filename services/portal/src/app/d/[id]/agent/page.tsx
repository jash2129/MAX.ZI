import Link from "next/link";

import { newAgentDraftAction, saveAgentAction } from "@/app/actions";
import { AgentChat } from "@/components/agent-chat";
import { Notices, Shell, Status } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { BUILT_IN_NATIVE_PROMPT, getDealership, getVersion, listVersions, permissions } from "@/server/portal";
import { requirePerson } from "@/server/session";
import { AGENT_LIMITS, agentSettings } from "../../../../../../../tavus-avatar/src/lib/native-engine";

export const dynamic = "force-dynamic";

/**
 * The Agent page: everything that shapes how Max talks, in one place, plus a test chat. The settings
 * live on the script version, so they follow the same draft -> test -> approve -> rollback path.
 */
export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const person = await requirePerson();
  const { id } = await params;
  const search = await searchParams;
  const db = portalDb();
  const [dealership, can, versions] = await Promise.all([getDealership(db, person.id, id), permissions(db, person.id, id), listVersions(db, person.id, id, "script")]);

  const pick =
    versions.find((v) => v.id === search.v) ??
    versions.find((v) => v.status === "draft") ??
    versions.find((v) => v.status === "in_test") ??
    versions.find((v) => v.status === "live") ??
    versions[0];
  const draft = versions.find((v) => v.status === "draft");
  const v = pick ? await getVersion(db, person.id, "script", pick.id) : null;
  const editable = Boolean(v && v.status === "draft" && can.edit);
  const a = agentSettings(v?.agent);
  const ro = !editable;

  return (
    <Shell person={person}>
      <p>
        <Link href="/">Dealerships</Link> / <Link href={`/d/${id}`}>{dealership.name}</Link>
      </p>
      <h1>
        Agent {v && <>v{v.version} <Status status={v.status} /></>}
      </h1>
      <p className="muted">
        How {dealership.max_display_name} talks: the prompt, context, greeting, knowledge documents and guardrails. These are saved with the script version, so
        they go live the same way: submit the draft for testing, run the release gate, and an approver approves it.
      </p>
      <Notices
        search={search}
        ok={{ saved: "Agent saved to the draft. Test it on the right; it reaches calls only after approval.", created: "New draft created from the live version." }}
      />

      {!v && <p className="notice warn">This dealership has no script version yet.</p>}

      {v && (
        <div className="row" style={{ margin: "8px 0 16px" }}>
          <span className="muted">Version:</span>
          {versions.map((x) => (
            <Link key={x.id} href={`/d/${id}/agent?v=${x.id}`} className="button" aria-current={x.id === v.id ? "page" : undefined} style={x.id === v.id ? { borderColor: "var(--accent)" } : undefined}>
              v{x.version} · {x.status}
            </Link>
          ))}
          <Link href={`/d/${id}/script/${v.id}`}>Submit, test and approve this version →</Link>
        </div>
      )}

      {v && !editable && can.edit && (
        <div className="notice warn">
          {draft ? (
            <>
              v{v.version} is {v.status}, so it can&apos;t be edited. <Link href={`/d/${id}/agent?v=${draft.id}`}>Open the draft v{draft.version}</Link> to make changes.
            </>
          ) : (
            <form action={newAgentDraftAction} className="row">
              <input type="hidden" name="dealership" value={id} />
              <span>v{v.version} is {v.status}, so it can&apos;t be edited. Start a draft from the live version to make changes.</span>
              <button className="primary" type="submit">
                Start a draft
              </button>
            </form>
          )}
        </div>
      )}

      {v && (
        <div className="agent-layout">
          <form action={saveAgentAction} className="panel">
            <input type="hidden" name="dealership" value={id} />
            <input type="hidden" name="version" value={v.id} />

            <h2 style={{ marginTop: 0 }}>Prompt</h2>
            <label htmlFor="native_prompt">Persona, goal, how a good call goes, guidelines and tone, in plain words</label>
            <textarea id="native_prompt" name="native_prompt" rows={22} defaultValue={v.native_prompt ?? BUILT_IN_NATIVE_PROMPT} readOnly={ro} />
            <p className="muted">
              Behavior only: no prices or figures here. Those come from the context, documents, facts and price ladder, which are added to the prompt automatically.
            </p>

            <h2>Context</h2>
            <label htmlFor="context">Background Max should know: the dealership, the offer, who the customers are, what matters this month</label>
            <textarea id="context" name="context" rows={8} defaultValue={a.context} readOnly={ro} maxLength={AGENT_LIMITS.context} />

            <h2>Greeting</h2>
            <label htmlFor="greeting">Max&apos;s first line, said word for word (empty = &quot;Can you hear and see me alright?&quot;)</label>
            <input id="greeting" name="greeting" defaultValue={a.greeting} readOnly={ro} maxLength={AGENT_LIMITS.greeting} />

            <h2>Knowledge documents</h2>
            <p className="muted">
              Max may use anything written here, numbers included, once this version is approved. Up to {AGENT_LIMITS.docs} documents and{" "}
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
              <div className="doc">
                <strong>Add documents</strong>
                <label htmlFor="new_doc_files">Upload text files (.txt, .md, .csv, .json, .html; up to 1 MB each)</label>
                <input id="new_doc_files" name="new_doc_files" type="file" multiple accept=".txt,.md,.markdown,.csv,.json,.tsv,.html,.htm,text/*,application/json" />
                <label htmlFor="new_doc_title">Or paste one: title</label>
                <input id="new_doc_title" name="new_doc_title" maxLength={AGENT_LIMITS.docTitle} />
                <label htmlFor="new_doc_text">Text (for a PDF or Word file, copy its text here)</label>
                <textarea id="new_doc_text" name="new_doc_text" rows={6} />
              </div>
            )}

            <h2>Guardrails</h2>
            <label className="check">
              <input type="checkbox" name="guard_price_ladder" defaultChecked={a.priceLadder} disabled={ro} />
              <span>
                <b>Price ladder</b>: prices only from the approved ladder, the first offer at the top, one step down at a time, and only when the customer pushes
                back. Off: Max may say only amounts written in the context, documents or facts.
              </span>
            </label>
            <label className="check">
              <input type="checkbox" name="guard_disclosure" defaultChecked={a.disclosure} disabled={ro} />
              <span>
                <b>Recording disclosure</b>: said word for word before any price (Max adds it on his second reply if the AI hasn&apos;t).
              </span>
            </label>
            <label className="check">
              <input type="checkbox" name="guard_script_talking_points" defaultChecked={a.scriptTalkingPoints} disabled={ro} />
              <span>
                <b>Script as talking points</b>: the script&apos;s beats 2-21 are given to Max as approved material. Off: Max works from the context and
                documents only.
              </span>
            </label>
            <p className="muted">
              Always on, whatever the switches say: no number or claim that isn&apos;t in the approved content, never claims to be human, a no is never a yes,
              never the same sentence twice. A reply that fails a check is retried once, then Max says a short neutral line.
            </p>

            {editable && (
              <>
                <label htmlFor="notes">Note for the approver (optional)</label>
                <input id="notes" name="notes" maxLength={500} />
                <p>
                  <button className="primary" type="submit">
                    Save draft
                  </button>
                </p>
              </>
            )}
          </form>

          <div className="sticky">
            <AgentChat versionId={v.id} label={`v${v.version} (${v.status})`} />
            {editable && <p className="muted">Save the draft first: the test runs on what is saved.</p>}
          </div>
        </div>
      )}
    </Shell>
  );
}
