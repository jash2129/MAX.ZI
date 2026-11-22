import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "@/app/actions";
import type { Person } from "@/server/session";

/** Page frame for signed-in pages */
export function Shell({ person, children }: { person: Person; children: ReactNode }) {
  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          Max portal
        </Link>
        <div className="row">
          <span className="muted">
            {person.email}
            {person.is_platform_owner ? " · platform owner" : ""}
          </span>
          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}

type Search = Record<string, string | string[] | undefined>;

/** ?error= and success flags from server actions */
export function Notices({ search, ok }: { search: Search; ok?: Record<string, string> }) {
  const error = typeof search.error === "string" ? search.error : undefined;
  const oks = Object.entries(ok ?? {}).filter(([k]) => search[k] !== undefined);
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {oks.map(([k, text]) => (
        <p key={k} className="notice ok" role="status">
          {text.replace("{v}", String(search[k]))}
        </p>
      ))}
    </>
  );
}

export function Status({ status }: { status: string }) {
  const labels: Record<string, string> = { draft: "Draft", in_test: "In test", approved: "Approved", live: "Live", retired: "Retired" };
  return <span className={`badge ${status}`}>{labels[status] ?? status}</span>;
}

export const KIND_LABEL = { script: "Script", price: "Price ladder", kb: "Knowledge base" } as const;
