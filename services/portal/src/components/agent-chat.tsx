"use client";

import { useEffect, useRef, useState } from "react";

import { endOfTurnWaitMs } from "../../../../tavus-avatar/src/lib/turn-taking";

type Line = { who: "max" | "customer"; text: string; mode?: string; reason?: string; ms?: number };
type Tracked = { disclosureGiven: boolean; lowestOffered: number | null; outcome: "open" | "accepted" | "declined" };
type Phase = "idle" | "listening" | "thinking" | "speaking";

// The browser's speech recognizer (Chrome, Edge, Safari); not in TypeScript's DOM types
type Recognizer = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
const recognizerClass = (): (new () => Recognizer) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/**
 * "Test this draft" on the Agent page: a conversation with Max on one script version. Type, or turn on
 * voice and talk: the mic hears you, your turn ends the way it does on a live call (the call app's
 * end-of-sentence wait), and Max answers out loud. Every reply is a real turn of the prompt-native
 * engine with every check on. Voice here uses the browser's own speech recognition and voice, not
 * Deepgram or the avatar: it tests what Max says and when, not the call app's audio.
 */
export function AgentChat({ versionId, label }: { versionId: string; label: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<string | null>(null);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [ended, setEnded] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(false);
  const [heard, setHeard] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  // Refs the speech callbacks read (they outlive renders)
  const stateRef = useRef<string | null>(null);
  const voiceRef = useRef(false);
  const endedRef = useRef(false);
  const recRef = useRef<Recognizer | null>(null);
  const turnRef = useRef({ final: "", timer: 0 as unknown as ReturnType<typeof setTimeout> | 0, endedAt: 0 });

  useEffect(() => {
    setVoiceSupported(Boolean(recognizerClass()) && typeof window !== "undefined" && "speechSynthesis" in window);
    return () => stopVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, phase, heard]);

  const busy = phase === "thinking";

  async function call(message?: string): Promise<{ reply: string; ended: boolean } | null> {
    setPhase("thinking");
    setError(null);
    try {
      const res = await fetch("/api/agent-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: versionId, state: message === undefined ? undefined : stateRef.current, message }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r?.error || "The test turn failed.");
      const waited = message !== undefined && turnRef.current.endedAt ? Date.now() - turnRef.current.endedAt : undefined;
      setLines((l) => [...l, { who: "max", text: r.reply, mode: r.mode, reason: r.reason, ms: waited ?? r.ms }]);
      stateRef.current = r.state;
      setState(r.state);
      setTracked(r.tracked);
      endedRef.current = Boolean(r.ended);
      setEnded(Boolean(r.ended));
      return { reply: r.reply, ended: Boolean(r.ended) };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPhase((p) => (p === "thinking" ? "idle" : p));
    }
  }

  // ------------------------------ voice ------------------------------
  function speak(reply: string, then: () => void) {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(reply);
    u.lang = "en-US";
    const en = synth.getVoices().filter((v) => v.lang?.startsWith("en"));
    u.voice = en.find((v) => /natural|google us|aria|guy|samantha/i.test(v.name)) ?? en[0] ?? null;
    u.rate = 1.02;
    setPhase("speaking");
    u.onend = u.onerror = () => {
      setPhase("idle");
      then();
    };
    synth.speak(u);
  }

  function listen() {
    if (!voiceRef.current || endedRef.current) return;
    const Rec = recognizerClass();
    if (!Rec) return;
    recRef.current?.abort();
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    turnRef.current.final = "";
    setHeard("");
    rec.onresult = (e) => {
      let interim = "";
      let gotFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          turnRef.current.final = `${turnRef.current.final} ${r[0].transcript}`.trim();
          gotFinal = true;
        } else interim += r[0].transcript;
      }
      const spoken = `${turnRef.current.final} ${interim}`.trim();
      setHeard(spoken);
      // Still talking: wait. A final: send after the same silence the live call waits for.
      if (turnRef.current.timer) clearTimeout(turnRef.current.timer);
      turnRef.current.timer = 0;
      if (gotFinal && !interim.trim()) {
        const wait = endOfTurnWaitMs(turnRef.current.final, { final: true, incomplete: false, recentBargeIn: false });
        turnRef.current.timer = setTimeout(() => void sendSpoken(), wait);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("The browser blocked the microphone. Allow it for this site, then turn voice on again.");
        voiceRef.current = false;
        setVoice(false);
        setPhase("idle");
      }
    };
    // Recognizers stop on their own after a while: keep listening while it's the customer's turn
    rec.onend = () => {
      if (recRef.current === rec && voiceRef.current && !endedRef.current && phaseRef.current === "listening") {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };
    recRef.current = rec;
    setPhase("listening");
    phaseRef.current = "listening";
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  async function sendSpoken() {
    const said = turnRef.current.final.trim();
    turnRef.current.final = "";
    turnRef.current.timer = 0;
    if (!said || !stateRef.current) return;
    turnRef.current.endedAt = Date.now();
    phaseRef.current = "thinking";
    recRef.current?.abort();
    recRef.current = null;
    setHeard("");
    setLines((l) => [...l, { who: "customer", text: said }]);
    const r = await call(said);
    if (!r) {
      listen();
      return;
    }
    if (voiceRef.current) speak(r.reply, () => (r.ended ? setPhase("idle") : listen()));
  }

  function stopVoice() {
    voiceRef.current = false;
    if (turnRef.current.timer) clearTimeout(turnRef.current.timer);
    recRef.current?.abort();
    recRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setHeard("");
    setPhase((p) => (p === "thinking" ? p : "idle"));
  }

  function toggleVoice() {
    if (voice) {
      setVoice(false);
      stopVoice();
      return;
    }
    setVoice(true);
    voiceRef.current = true;
    // Mid-call: Max's last line was already shown; just start listening
    if (stateRef.current && !endedRef.current) listen();
  }

  // ------------------------------ start / type ------------------------------
  async function start() {
    stopVoice();
    voiceRef.current = voice;
    setLines([]);
    stateRef.current = null;
    setState(null);
    setTracked(null);
    endedRef.current = false;
    setEnded(false);
    turnRef.current.endedAt = 0;
    const r = await call();
    if (r && voice) speak(r.reply, listen);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy || !state) return;
    stopVoice();
    voiceRef.current = voice;
    setLines((l) => [...l, { who: "customer", text: t }]);
    setText("");
    turnRef.current.endedAt = Date.now();
    const r = await call(t);
    if (r && voice) speak(r.reply, () => (r.ended ? undefined : listen()));
  }

  const status: Record<Phase, string> = {
    idle: "",
    listening: "Listening… talk as the customer",
    thinking: "Max is thinking…",
    speaking: "Max is speaking (wait until he finishes)",
  };

  return (
    <div className="panel agent-chat">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Test {label}</strong>
        <div className="row">
          <button type="button" onClick={toggleVoice} disabled={!voiceSupported} aria-pressed={voice} title={voiceSupported ? "" : "This browser has no speech recognition: use Chrome or Edge"}>
            {voice ? "🎙 Voice on" : "Voice off"}
          </button>
          <button type="button" className="primary" onClick={() => void start()} disabled={busy}>
            {lines.length ? "Start over" : "Start a test call"}
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        You play the customer: type, or turn voice on and talk. Max runs on this version with every check on. Nothing reaches a customer, and testing approves
        nothing.
        {!voiceSupported && " Voice needs Chrome or Edge."}
      </p>
      <div className="chat-log" ref={logRef} aria-live="polite">
        {!lines.length && phase === "idle" && <p className="muted">Start a test call to hear Max&apos;s greeting.</p>}
        {lines.map((l, i) => (
          <div key={i} className={`chat-line ${l.who}`}>
            <div className="chat-who">{l.who === "max" ? "Max" : "Customer (you)"}</div>
            <div className="chat-text">{l.text}</div>
            {l.who === "max" && l.mode === "neutral" && (
              <div className="chat-tag warn">A check refused the AI&apos;s reply twice, so Max said a neutral line{l.reason ? `: ${l.reason}` : ""}</div>
            )}
            {l.who === "max" && l.mode === "native" && typeof l.ms === "number" && <div className="chat-tag">replied after {(l.ms / 1000).toFixed(1)} s</div>}
          </div>
        ))}
        {heard && (
          <div className="chat-line customer">
            <div className="chat-who">Customer (you, hearing…)</div>
            <div className="chat-text" style={{ opacity: 0.7 }}>
              {heard}
            </div>
          </div>
        )}
        {busy && (
          <div className="chat-line max">
            <div className="chat-who">Max</div>
            <div className="chat-text muted">…</div>
          </div>
        )}
      </div>
      {status[phase] && <p className={`chat-status ${phase}`}>{status[phase]}</p>}
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
      {voice && (
        <p className="muted" style={{ fontSize: 13 }}>
          Voice uses your browser&apos;s speech recognition and voice, not the call app&apos;s Deepgram and avatar. Your turn ends after the same pause a live call
          waits for. You can&apos;t interrupt Max here: wait until he finishes.
        </p>
      )}
    </div>
  );
}
