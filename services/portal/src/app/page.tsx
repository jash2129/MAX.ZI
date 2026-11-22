import Link from "next/link";

import { Notices, Shell } from "@/components/chrome";
import { portalDb } from "@/server/db";
import { listDealerships } from "@/server/portal";
import { requirePerson } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const person = await requirePerson();
  const search = await searchParams;
  const dealerships = await listDealerships(portalDb(), person.id);
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
    </Shell>
  );
}
