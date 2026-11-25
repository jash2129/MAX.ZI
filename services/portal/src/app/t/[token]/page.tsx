import type { Metadata } from "next";

import { AgentChat } from "@/components/agent-chat";
import { portalDb } from "@/server/db";
import { useTestLink } from "@/server/portal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Test call with Max", robots: { index: false, follow: false } };

/**
 * A client test link (made on a version's test panel): the test panel alone, no account, no sign-in.
 * Shows the dealership's name and nothing else of the portal; the link decides the version.
 */
export default async function TestLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const use = await useTestLink(portalDb(), token, "open");

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="top">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          {"refused" in use ? "Max" : use.dealershipName}
        </span>
        <span className="muted" style={{ fontSize: 14 }}>
          Test call
        </span>
      </header>
      <main style={{ maxWidth: 760 }}>
        {"refused" in use ? (
          <div className="panel" style={{ marginTop: 24 }}>
            <h1 style={{ fontSize: 22 }}>This link isn&apos;t working</h1>
            <p className="muted" style={{ margin: 0 }}>
              {use.refused}
            </p>
          </div>
        ) : (
          <>
            <h1 style={{ marginTop: 8 }}>Talk to Max</h1>
            <p className="muted" style={{ marginTop: 0 }}>
              Max is {use.dealershipName}&apos;s AI finance assistant. Play a customer who has just bought a car: ask questions, push back on the price, or say
              no. Choose <b>Type</b>, <b>Voice</b> or <b>Video</b>, then start the call. Voice and video work best in Chrome or Edge; allow the microphone
              when asked.
            </p>
            <AgentChat versionId="" label="call" link={token} />
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              This is a test: nothing you say here is a real purchase. This link works until{" "}
              {new Date(use.expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
