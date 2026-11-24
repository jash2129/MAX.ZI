"use client";

import { useEffect, useRef, useState } from "react";

type Line = { who: "max" | "customer"; text: string; mode?: string; reason?: string; ms?: number };
type Tracked = { disclosureGiven: boolean; lowestOffered: number | null; outcome: "open" | "accepted" | "declined" };

/**
 * "Test this draft": a text conversation with Max on one script version (the Agent page). You type
 * what the customer says; every reply is a real turn of the prompt-native engine with every check on.
 */
export function AgentChat({ versionId, label }: { versionId: string; label: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<string | null>(null);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, busy]);

  async function call(message?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: versionId, state: message === undefined ? undefined : state, message }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r?.error || "The test turn failed.");
      setLines((l) => [...l, { who: "max", text: r.reply, mode: r.mode, reason: r.reason, ms: r.ms }]);
      setState(r.state);
      setTracked(r.tracked);
      setEnded(Boolean(r.ended));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function start() {
    setLines([]);
    setState(null);
    setTracked(null);
    setEnded(false);
    void call();
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy || !state) return;
    setLines((l) => [...l, { who: "customer", text: t }]);
    setText("");
    void call(t);
  }

  return (
    <div className="panel agent-chat">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Test {label}</strong>
        <button type="button" onClick={start} disabled={busy}>
          {lines.length ? "Start over" : "Start a test call"}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        You play the customer. Max runs on this version with every check on. Nothing reaches a customer, and testing approves nothing.
      </p>
      <div className="chat-log" ref={logRef} aria-live="polite">
        {!lines.length && !busy && <p className="muted">Start a test call to hear Max&apos;s greeting.</p>}
        {lines.map((l, i) => (
          <div key={i} className={`chat-line ${l.who}`}>
            <div className="chat-who">{l.who === "max" ? "Max" : "Customer (you)"}</div>
            <div className="chat-text">{l.text}</div>
            {l.who === "max" && l.mode === "neutral" && (
              <div className="chat-tag warn">A check refused the AI&apos;s reply twice, so Max said a neutral line{l.reason ? `: ${l.reason}` : ""}</div>
            )}
            {l.who === "max" && l.mode === "native" && typeof l.ms === "number" && <div className="chat-tag">{(l.ms / 1000).toFixed(1)} s</div>}
          </div>
        ))}
        {busy && <div className="chat-line max"><div className="chat-who">Max</div><div className="chat-text muted">…</div></div>}
      </div>
      {error && <p className="notice error">{error}</p>}
      {tracked && (
        <p className="muted chat-tracked">
          Disclosure {tracked.disclosureGiven ? "given" : "not yet given"} · lowest price offered {tracked.lowestOffered === null ? "none" : `$${tracked.lowestOffered.toFixed(2)} a day`} ·
          outcome {tracked.outcome}
          {ended ? " · call ended" : ""}
        </p>
      )}
      <form onSubmit={send} className="row chat-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={state ? (ended ? "The call has ended. Start over to test again." : "What the customer says…") : "Start a test call first"}
          disabled={!state || busy || ended}
          maxLength={1000}
          aria-label="What the customer says"
        />
        <button className="primary" type="submit" disabled={!state || busy || ended || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
