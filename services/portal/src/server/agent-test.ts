/**
 * "Test this draft" on the Agent page: a text conversation with Max on any script version the person
 * can read (draft, in test, or live), with the dealership's live price ladder and knowledge base, on the
 * prompt-native engine. Nothing reaches a customer and nothing is approved by testing.
 *
 * Stateless on the server (works on serverless hosts): the browser keeps the call's state between
 * turns. The state it sends back never carries content: the config (prompt, context, documents,
 * prices) is always loaded again from the database as the signed-in person, so a test can only ever
 * run on approved-or-draft content that person may read.
 */
import { randomUUID } from "node:crypto";

import { activeStates, getOrCreateCallState, greetingOf, processControllerTurn, resetCallState, type CallState } from "../../../../tavus-avatar/src/lib/beat-controller";
import { llmTarget } from "../../../../tavus-avatar/src/lib/llm-stream";
import type { Db } from "../../../control-plane/src/db";
import { PortalError, agentTestConfig, type Kind } from "./portal";

export const MAX_STATE_BYTES = 200_000;
export const MAX_MESSAGE_CHARS = 1_000;

export interface AgentTestReply {
  /** Max's line (the greeting on start) */
  reply: string;
  /** opaque: send it back with the next message */
  state: string;
  ended: boolean;
  /** "native" = the AI's reply passed every check; "neutral" = a check refused it twice (why: reason) */
  mode: string;
  reason?: string;
  /** the AI's first reply was stopped by a check (why), and the retry passed */
  retried?: string;
  ms?: number;
  /** the dealership this test runs for (the version's own) */
  dealership: string;
  /** what the app tracked after this turn */
  tracked: { disclosureGiven: boolean; lowestOffered: number | null; outcome: "open" | "accepted" | "declined" };
}

function tracked(s: CallState): AgentTestReply["tracked"] {
  return {
    disclosureGiven: Boolean(s.free_disclosure_given),
    lowestOffered: s.free_lowest_offer ?? null,
    outcome: s.finalize_confirmed ? "accepted" : s.package_declined ? "declined" : "open",
  };
}

const pack = (s: CallState) => {
  const { dealConfig: _content, ...rest } = s;
  return JSON.stringify(rest);
};

/** Starts a test call (message undefined) or runs one customer turn of it */
export async function agentTestTurn(db: Db, userId: string, versionId: string, input: { state?: string; message?: string; kind?: Kind }): Promise<AgentTestReply> {
  const { testDealership: dealership, ...config } = await agentTestConfig(db, userId, versionId, input.kind ?? "script");
  const id = `agent-test-${randomUUID()}`;
  try {
    if (input.message === undefined) {
      const st = getOrCreateCallState(id, config);
      const greeting = greetingOf(config);
      st.last_spoken_text = greeting;
      return { reply: greeting, state: pack(st), ended: false, mode: "greeting", dealership, tracked: tracked(st) };
    }
    const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!message) throw new PortalError("Type what the customer says.");
    if (!llmTarget()) throw new PortalError("The portal has no AI key: set OPENAI_API_KEY (and AI_PROVIDER=openai) on the portal's Vercel project, then redeploy.");
    if (!input.state || input.state.length > MAX_STATE_BYTES) throw new PortalError("This test call has expired. Start a new one.");
    let restored: Record<string, unknown>;
    try {
      restored = JSON.parse(input.state);
    } catch {
      throw new PortalError("This test call has expired. Start a new one.");
    }
    if (!restored || typeof restored !== "object" || Array.isArray(restored)) throw new PortalError("This test call has expired. Start a new one.");
    // The content always comes from the database, never from the browser
    delete restored.dealConfig;
    activeStates.set(id, { ...(restored as unknown as CallState), dealConfig: config });
    const d = await processControllerTurn(id, message, config);
    return {
      reply: d.textToSpeak,
      state: pack(d.state),
      ended: Boolean(d.isScriptComplete),
      mode: d.metrics?.mode ?? "native",
      reason: d.metrics?.mode === "neutral" ? d.metrics?.freeReason : undefined,
      retried:
        d.metrics?.mode === "native" && /^ok on retry/.test(d.metrics?.freeReason ?? "")
          ? (d.metrics?.freeReason ?? "").replace(/^ok on retry \(first try (rejected: )?/, "").replace(/\)$/, "")
          : undefined,
      ms: d.metrics?.freeMs,
      dealership,
      tracked: tracked(d.state),
    };
  } finally {
    resetCallState(id);
  }
}
