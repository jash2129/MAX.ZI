import Link from "next/link";

import { createDealershipAction } from "@/app/actions";
import { Notices, Shell } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { creatableAgencies, listDealerships } from "@/server/portal";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const person = await requirePerson();
  const search = await searchParams;
  const [dealerships, creatable] = await Promise.all([listDealerships(portalDb(), person.id), creatableAgencies(portalDb(), person.id)]);
  const canCreate = creatable.owner || creatable.agencies.length > 0;
  return (
    <Shell person={person}>
      <h1>Dealerships</h1>
      <p className="muted">The dealerships you can see. What you can change depends on your role at each.</p>
      <Notices search={search} ok={{ twofactor: "Two-factor sign-in is on." }} />
      {dealerships.length === 0 ? (
        <p className="panel">You don&apos;t have access to any dealership yet. Ask your dealership or agency admin.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Dealership</th>
                <th>Your role</th>
                <th>Live script</th>
                <th>Live price ladder</th>
                <th>Live knowledge base</th>
                <th>Drafts and tests</th>
              </tr>
            </thead>
            <tbody>
              {dealerships.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link href={`/d/${d.id}`}>{d.name}</Link>
                    {d.agency_id && <div className="muted">Agency: {d.agency_id}</div>}
                  </td>
                  <td>{d.roles.map((r) => r.replace("_", " ")).join(", ")}</td>
                  <td>{d.live.script ? `v${d.live.script}` : "none"}</td>
                  <td>{d.live.price ? `v${d.live.price}` : "none"}</td>
                  <td>{d.live.kb ? `v${d.live.kb}` : "none"}</td>
                  <td>{d.pending || "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canCreate && dealerships.length > 0 && (
        <>
          <h2>New dealership</h2>
          <form action={createDealershipAction} className="panel">
            <p className="muted">
              It starts with draft script, price ladder and knowledge base copied from a template dealership. Edit them, run the release gate, and have
              an approver approve each one; until then it takes no calls.
            </p>
            <div className="grid2">
              <div>
                <label htmlFor="name">Name</label>
                <input id="name" name="name" required placeholder="Kia of Austin" />
              </div>
              <div>
                <label htmlFor="id">Id (in call links; lower-case, - and _)</label>
                <input id="id" name="id" required pattern="[a-z0-9][a-z0-9_\-]{1,63}" placeholder="kia-austin" />
              </div>
              <div>
                <label htmlFor="agency">Agency</label>
                <select id="agency" name="agency" defaultValue={creatable.owner ? "" : creatable.agencies[0]?.id}>
                  {creatable.owner && <option value="">None (directly under the platform)</option>}
                  {creatable.agencies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="template">Copy content from</label>
                <select id="template" name="template">
                  {dealerships.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="vehicle_make">Default vehicle: year, make, model</label>
                <div className="row">
                  <input name="vehicle_year" placeholder="2026" style={{ width: 80 }} />
                  <input name="vehicle_make" placeholder="Kia" style={{ flex: 1 }} />
                  <input name="vehicle_model" placeholder="Sportage" style={{ flex: 1 }} />
                </div>
              </div>
              <div>
                <label htmlFor="keyterms">Speech hint words (comma-separated: brands, models, place names)</label>
                <input id="keyterms" name="keyterms" placeholder="Kia, Sportage, Telluride, Austin" />
              </div>
            </div>
            <p>
              <button className="primary" type="submit">
                Create dealership
              </button>
            </p>
          </form>
        </>
      )}
    </Shell>
  );
}
