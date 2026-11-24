import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "@/app/actions";
import type { Person } from "@/server/session";

/** Page frame for signed-in pages */
export function Shell({ person, children, sub }: { person: Person; children: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          MAX.ZI
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
      {sub}
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
  const labels: Record<string, string> = { draft: "Draft", in_test: "In review", approved: "Approved", live: "Live", retired: "Retired" };
  return <span className={`badge ${status}`}>{labels[status] ?? status}</span>;
}

export const KIND_LABEL = { script: "Script & talking points", price: "Price ladder", kb: "Knowledge base" } as const;

export type DealershipTab = "home" | "agent" | "calls" | "reviews" | "people";

/** The menu on every dealership page: where you are, and how many versions wait for review */
export function DealershipNav({ id, name, current, reviews = 0 }: { id: string; name: string; current?: DealershipTab; reviews?: number }) {
  const tabs: Array<[DealershipTab, string, string]> = [
    ["home", "Home", `/d/${id}`],
    ["agent", "Agent studio", `/d/${id}/agent`],
    ["calls", "Calls", `/d/${id}/calls`],
    ["reviews", "Reviews", `/d/${id}#reviews`],
    ["people", "People", `/d/${id}#people`],
  ];
  return (
    <div className="subnav">
      <div className="subnav-inner">
        <span className="subnav-name">{name}</span>
        <nav aria-label={`${name} sections`}>
          {tabs.map(([key, label, href]) => (
            <Link key={key} href={href} aria-current={current === key ? "page" : undefined}>
              {label}
              {key === "reviews" && reviews > 0 && <span className="count">{reviews}</span>}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
