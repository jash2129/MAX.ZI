import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { callPageInfo } from "@/server/callpage";
import { portalDb } from "@/server/db";

import { CallRoom } from "./room";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your finance walkthrough", robots: { index: false, follow: false } };

/**
 * The customer's call page: /c/<dealership>?deal=<deal_id> (the link or QR code the dealership sends).
 * No account. Loading the page uses nothing up; only "Start" uses one of the link's starts.
 */
export default async function CustomerCall({ params, searchParams }: { params: Promise<{ dealership: string }>; searchParams: Promise<Record<string, string>> }) {
  const { dealership } = await params;
  const { deal } = await searchParams;
  const info = await callPageInfo(portalDb(), dealership);
  if (!info) notFound();
  return (
    <div className="call-page">
      <header className="call-top">
        <div>
          <strong>{info.name}</strong>
          <div className="muted">Finance walkthrough with {info.max_display_name}</div>
        </div>
        <div className="call-ai">
          {info.max_display_name} is an AI finance assistant, not a person.
        </div>
      </header>
      {!info.ready ? (
        <main className="narrow">
          <p className="notice warn">{info.name} is not taking calls right now. Please check with your dealership.</p>
        </main>
      ) : !deal ? (
        <main className="narrow">
          <p className="notice warn">This link is not complete. Please use the link or QR code your dealership gave you.</p>
        </main>
      ) : (
        <CallRoom dealership={info.id} dealId={deal} maxName={info.max_display_name} dealershipName={info.name} products={info.products} />
      )}
    </div>
  );
}
