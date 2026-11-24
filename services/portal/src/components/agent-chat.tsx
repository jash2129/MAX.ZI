"use client";

import { useEffect, useRef, useState } from "react";

import { endOfTurnWaitMs } from "../../../../tavus-avatar/src/lib/turn-taking";

type Line = { who: "max" | "customer"; text: string; mode?: string; reason?: string; retried?: string; ms?: number };
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
export function AgentChat({ versionId, label, kind = "script", dealershipName }: { versionId: string; label: string; kind?: "script" | "price" | "kb"; dealershipName?: string }) {
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
  // Video: the HeyGen avatar says Max's lines (the same avatar as the call app)
  const [video, setVideo] = useState(false);
  const [avatarState, setAvatarState] = useState<"off" | "connecting" | "on">("off");
  const logRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const audioBoxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef(false);
  const roomRef = useRef<{ disconnect: () => Promise<void> | void; localParticipant: { publishData: (d: Uint8Array, o: { reliable: boolean; topic: string }) => Promise<void> } } | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const speakDoneRef = useRef<{ then: () => void; timer: ReturnType<typeof setTimeout>; at: number } | null>(null);

  // Refs the speech callbacks read (they outlive renders)
  const stateRef = useRef<string | null>(null);
  const voiceRef = useRef(false);
  const endedRef = useRef(false);
  const recRef = useRef<Recognizer | null>(null);
  const turnRef = useRef({ final: "", timer: 0 as unknown as ReturnType<typeof setTimeout> | 0, endedAt: 0 });

  useEffect(() => {
    setVoiceSupported(Boolean(recognizerClass()) && typeof window !== "undefined" && "speechSynthesis" in window);
    return () => {
      stopVoice();
      void disconnectAvatar();
    };
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
        body: JSON.stringify({ version: versionId, kind, state: message === undefined ? undefined : stateRef.current, message }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r?.error || "The test turn failed.");
      const waited = message !== undefined && turnRef.current.endedAt ? Date.now() - turnRef.current.endedAt : undefined;
      setLines((l) => [...l, { who: "max", text: r.reply, mode: r.mode, reason: r.reason, retried: r.retried, ms: waited ?? r.ms }]);
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

  // ------------------------------ video (HeyGen avatar) ------------------------------
  async function avatarCommand(type: string, textToSay?: string) {
    const room = roomRef.current;
    if (!room) return;
    const name = `avatar.${type}`;
    const body = textToSay
      ? { event_type: name, event: name, text: textToSay, data: { text: textToSay }, payload: { text: textToSay } }
      : { event_type: name, event: name, type: name, action: type };
    await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(body)), { reliable: true, topic: "agent-control" });
  }

  function avatarSpoke() {
    const done = speakDoneRef.current;
    if (!done) return;
    speakDoneRef.current = null;
    clearTimeout(done.timer);
    setPhase("idle");
    void avatarCommand("start_listening").catch(() => {});
    done.then();
  }

  /** Starts a HeyGen session and joins its room; the avatar shows in the panel */
  async function connectAvatar(): Promise<boolean> {
    if (roomRef.current) return true;
    setAvatarState("connecting");
    setError(null);
    try {
      const res = await fetch("/api/agent-test/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: versionId, kind }),
      });
      const s = await res.json();
      if (!res.ok) throw new Error(s?.error || "The avatar could not start.");
      sessionTokenRef.current = s.sessionToken;
      const { Room, RoomEvent, Track } = await import("livekit-client");
      const room = new Room({ adaptiveStream: true, dynacast: true });
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video && videoElRef.current) track.attach(videoElRef.current);
        if (track.kind === Track.Kind.Audio && audioBoxRef.current) audioBoxRef.current.appendChild(track.attach());
      });
      room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const ev = JSON.parse(new TextDecoder().decode(payload));
          const name = String(ev.event_type || ev.event || ev.type || "").toLowerCase();
          const stopped = /stop_talking|stopped_speaking|finished_speaking|speak_ended|talking_stop/.test(name);
          // Ignore a stop that arrives right after the line was sent (the previous line's)
          if (stopped && speakDoneRef.current && Date.now() - speakDoneRef.current.at > 400) avatarSpoke();
        } catch {
          /* not JSON */
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        roomRef.current = null;
        setAvatarState("off");
      });
      await room.connect(s.livekitUrl, s.livekitClientToken);
      await room.startAudio().catch(() => {});
      roomRef.current = room as unknown as typeof roomRef.current;
      // Tracks published before we joined
      room.remoteParticipants.forEach((pt) =>
        pt.trackPublications.forEach((pub) => {
          const t = pub.track;
          if (t?.kind === Track.Kind.Video && videoElRef.current) t.attach(videoElRef.current);
          if (t?.kind === Track.Kind.Audio && audioBoxRef.current) audioBoxRef.current.appendChild(t.attach());
        })
      );
      setAvatarState("on");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAvatarState("off");
      void disconnectAvatar();
      return false;
    }
  }

  async function disconnectAvatar() {
    const room = roomRef.current;
    roomRef.current = null;
    if (speakDoneRef.current) clearTimeout(speakDoneRef.current.timer);
    speakDoneRef.current = null;
    try {
      await room?.disconnect();
    } catch {
      /* already gone */
    }
    if (audioBoxRef.current) audioBoxRef.current.innerHTML = "";
    const token = sessionTokenRef.current;
    sessionTokenRef.current = null;
    if (token) {
      void fetch("/api/agent-test/avatar", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionToken: token }), keepalive: true }).catch(() => {});
    }
    setAvatarState("off");
  }

  // ------------------------------ voice ------------------------------
  function speak(reply: string, then: () => void) {
    if (videoRef.current && roomRef.current) {
      // The avatar says it; its "stopped talking" event (or a time limit by length) ends the turn
      if (speakDoneRef.current) clearTimeout(speakDoneRef.current.timer);
      const words = reply.split(/\s+/).length;
      const timer = setTimeout(avatarSpoke, Math.max(5000, words * 450 + 3000));
      speakDoneRef.current = { then, timer, at: Date.now() };
      setPhase("speaking");
      void avatarCommand("speak_text", reply).catch(() => avatarSpoke());
      return;
    }
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

  function setMode(m: "type" | "voice" | "video") {
    const wantVoice = m !== "type";
    const wantVideo = m === "video";
    videoRef.current = wantVideo;
    setVideo(wantVideo);
    if (!wantVideo) void disconnectAvatar();
    if (wantVoice !== voice) toggleVoice();
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
    if (videoRef.current && !(await connectAvatar())) return;
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
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <strong style={{ fontSize: 16 }}>Test {label}</strong>
          <span className="muted" style={{ fontSize: 13 }}>
            {dealershipName ? `${dealershipName} · ` : ""}nothing reaches customers
          </span>
        </div>
        <div className="seg" role="group" aria-label="How you talk to Max">
          <button type="button" aria-pressed={!voice} onClick={() => setMode("type")}>
            Type
          </button>
          <button type="button" aria-pressed={voice && !video} onClick={() => setMode("voice")} disabled={!voiceSupported} title={voiceSupported ? "" : "Voice needs Chrome or Edge"}>
            Voice
          </button>
          <button type="button" aria-pressed={video} onClick={() => setMode("video")} disabled={!voiceSupported} title={voiceSupported ? "The avatar on video, as on a real call" : "Video needs Chrome or Edge"}>
            Video
          </button>
        </div>
      </div>
      {video && (
        <div className="avatar-box">
          <video ref={videoElRef} autoPlay playsInline muted={false} aria-label="Max, the avatar" />
          {avatarState !== "on" && (
            <div className="avatar-cover">
              {avatarState === "connecting" ? "Connecting the avatar…" : "The avatar appears when you start the call. Each video test uses HeyGen minutes."}
            </div>
          )}
          <div ref={audioBoxRef} hidden />
        </div>
      )}
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <button type="button" className="primary" onClick={() => void start()} disabled={busy || avatarState === "connecting"} style={{ flex: 1 }}>
          {lines.length ? "Start over" : video ? "Start a video call" : "Start a test call"}
        </button>
        {video && avatarState === "on" && (
          <button type="button" className="danger" onClick={() => { stopVoice(); void disconnectAvatar(); }}>
            End video
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        You play the customer: type, or turn voice on and talk. Max runs on this version{dealershipName ? ` of ${dealershipName}` : ""}
        {kind === "script" ? "" : ", with the dealership's live script"}{kind === "kb" ? " and price ladder" : kind === "price" ? " and knowledge base" : ""}, with every check on. Nothing reaches a customer, and testing approves
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
            {l.who === "max" && l.mode === "native" && (
              <div className="chat-tag chat-ok">
                ✓ Passed every check{typeof l.ms === "number" ? ` · replied after ${(l.ms / 1000).toFixed(1)} s` : ""}
              </div>
            )}
            {l.who === "max" && l.retried && <div className="chat-tag chat-retry">First try was stopped ({l.retried}). Fixed on the retry.</div>}
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
        <dl className="tracked-grid" aria-label="What the app tracked">
          <div>
            <dt>Disclosure</dt>
            <dd>{tracked.disclosureGiven ? "Given" : "Not yet"}</dd>
          </div>
          <div>
            <dt>Lowest price</dt>
            <dd>{tracked.lowestOffered === null ? "None yet" : `$${tracked.lowestOffered.toFixed(2)} / day`}</dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>
              {tracked.outcome === "accepted" ? "Accepted" : tracked.outcome === "declined" ? "Declined" : "Open"}
              {ended ? " · ended" : ""}
            </dd>
          </div>
        </dl>
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
          {video
            ? "Max speaks through the real avatar. Your voice is heard by your browser (not Deepgram), and your turn ends after the same pause a live call waits for. You can't interrupt Max here: wait until he finishes."
            : "Voice uses your browser's speech recognition and voice, not the call app's Deepgram and avatar. Your turn ends after the same pause a live call waits for. You can't interrupt Max here: wait until he finishes."}
        </p>
      )}
    </div>
  );
}
