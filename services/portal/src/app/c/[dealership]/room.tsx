"use client";

import Daily, { type DailyCall, type DailyEventObjectAppMessage, type DailyEventObjectTrack } from "@daily-co/daily-js";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Product } from "@/server/callpage";

/**
 * The customer's side of the call. Joins the Daily room the voice worker made, plays Max (video and
 * voice), and shows what the worker sends over the data channel (PRD "Data channel events"):
 *   panel.show {panel, data} / panel.hide / caption {text, final} / call.state {beat} /
 *   call.ended {reason} / avatar.state {state}
 * It makes no turn-taking decisions: all of that is on the server.
 */

type Panel = { panel: "warranty_terms" | "repair_costs" | "coverage_grid" | "price" | "deal_summary"; data: Record<string, unknown> } | null;
type Phase = "ready" | "starting" | "live" | "ended" | "error";

const LAST_BEAT = 25;
const DEFAULT_TITLES: Record<string, string> = {
  vsc: "Bumper-to-bumper coverage",
  tire_wheel: "Tire and wheel coverage",
  maintenance: "Maintenance plan",
  gap: "GAP protection",
  warranty_terms: "Your factory warranty",
  repair_costs: "What repairs cost without coverage",
};
const COVERAGE_KEYS = ["vsc", "tire_wheel", "maintenance", "gap"];

function money(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : "";
}

export function CallRoom(props: { dealership: string; dealId: string; maxName: string; dealershipName: string; products: Product[] }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [caption, setCaption] = useState("");
  const [beat, setBeat] = useState(0);
  const [rate, setRate] = useState<number | null>(null);
  const [vehicle, setVehicle] = useState("");
  const [avatarDown, setAvatarDown] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const callRef = useRef<DailyCall | null>(null);

  const product = (key: string): Product => props.products.find((p) => p.key === key) ?? { key, title: DEFAULT_TITLES[key] ?? key };

  const onMessage = useCallback((e: DailyEventObjectAppMessage) => {
    const m = e.data as { event?: string; panel?: string; data?: Record<string, unknown>; text?: string; beat?: number; state?: string };
    switch (m?.event) {
      case "panel.show":
        setPanel({ panel: m.panel as NonNullable<Panel>["panel"], data: m.data ?? {} });
        if (m.panel === "price" && m.data?.daily_rate !== undefined) setRate(Number(m.data.daily_rate));
        break;
      case "panel.hide":
        setPanel(null);
        break;
      case "caption":
        setCaption(String(m.text ?? ""));
        break;
      case "call.state":
        if (typeof m.beat === "number") setBeat(m.beat);
        break;
      case "avatar.state":
        if (m.state === "unavailable") setAvatarDown(true);
        break;
      case "call.ended":
        setPhase("ended");
        setTimeout(() => void callRef.current?.leave(), 4000);
        break;
    }
  }, []);

  const onTrack = useCallback((e: DailyEventObjectTrack) => {
    if (e.participant?.local) return;
    const stream = new MediaStream([e.track]);
    if (e.track.kind === "video" && videoRef.current) {
      videoRef.current.srcObject = stream;
      setHasVideo(true);
    }
    if (e.track.kind === "audio" && audioRef.current) {
      audioRef.current.srcObject = stream;
      void audioRef.current.play().catch(() => undefined);
    }
  }, []);

  const start = async () => {
    setPhase("starting");
    setError("");
    try {
      const res = await fetch(`/c/${encodeURIComponent(props.dealership)}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal: props.dealId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "We couldn't start the call.");
      const v = body.vehicle ?? {};
      setVehicle([v.year, v.make, v.model].filter(Boolean).join(" "));
      const call = Daily.createCallObject({ audioSource: true, videoSource: false, subscribeToTracksAutomatically: true });
      callRef.current = call;
      call.on("track-started", onTrack);
      call.on("app-message", onMessage);
      call.on("left-meeting", () => setPhase((p) => (p === "error" ? p : "ended")));
      call.on("error", (ev) => {
        setError(ev?.errorMsg || "The call was interrupted.");
        setPhase("error");
      });
      await call.join({ url: body.room_url, token: body.token, startVideoOff: true, startAudioOff: false });
      setPhase("live");
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      setError(/permission|NotAllowed/i.test(msg) ? "Please allow the microphone so Max can hear you, then try again." : msg);
      setPhase("error");
    }
  };

  useEffect(
    () => () => {
      void callRef.current?.leave();
      void callRef.current?.destroy();
    },
    []
  );

  const leave = async () => {
    await callRef.current?.leave();
    setPhase("ended");
  };

  return (
    <main className="call-main">
      <section className="call-stage">
        <div className="call-video">
          <video ref={videoRef} autoPlay playsInline muted style={{ display: hasVideo && !avatarDown ? "block" : "none" }} />
          {(!hasVideo || avatarDown) && <img src="/max-still.jpg" alt={`${props.maxName}, your AI finance assistant`} />}
          {avatarDown && <div className="call-badge">Video unavailable: you can still hear {props.maxName}</div>}
          <audio ref={audioRef} autoPlay />
        </div>
        {phase === "live" && caption && (
          <p className="call-caption" aria-live="polite">
            {caption}
          </p>
        )}
        {phase === "live" && (
          <div className="call-progress" aria-label="Progress">
            <div style={{ width: `${Math.min(100, Math.round((beat / LAST_BEAT) * 100))}%` }} />
          </div>
        )}
      </section>

      <aside className="call-side">
        {phase === "ready" && (
          <div className="panel">
            <h1>Your finance walkthrough</h1>
            <p>
              {props.maxName} will walk you through your new vehicle&apos;s coverage before you sign. It takes about 15 minutes. Speak normally; you can
              interrupt any time.
            </p>
            <p className="muted">
              This call is recorded (audio and video). {props.maxName} is an AI finance assistant. You will need to allow your microphone.
            </p>
            <button className="primary call-start" onClick={() => void start()}>
              Start the call
            </button>
          </div>
        )}
        {phase === "starting" && <p className="panel">Connecting you with {props.maxName}…</p>}
        {phase === "error" && (
          <div className="panel">
            <p className="notice error">{error}</p>
            <button onClick={() => void start()}>Try again</button>
          </div>
        )}
        {phase === "ended" && (
          <div className="panel">
            <h2>Thank you</h2>
            <p>Your call with {props.maxName} has ended. Your finance manager will have your paperwork ready.</p>
          </div>
        )}
        {phase === "live" && (
          <>
            {panel && <PanelView panel={panel} product={product} rate={rate} vehicle={vehicle} dealershipName={props.dealershipName} />}
            <button className="danger call-leave" onClick={() => void leave()}>
              Leave the call
            </button>
          </>
        )}
      </aside>
    </main>
  );
}

export function PanelView({ panel, product, rate, vehicle, dealershipName }: { panel: NonNullable<Panel>; product: (k: string) => Product; rate: number | null; vehicle: string; dealershipName: string }) {
  if (panel.panel === "price") {
    return (
      <div className="panel call-panel">
        <div className="muted">Full vehicle protection</div>
        <div className="call-price">{money(panel.data.daily_rate)}</div>
        <div className="muted">a day</div>
      </div>
    );
  }
  if (panel.panel === "deal_summary") {
    return (
      <div className="panel call-panel">
        <h2>Your summary</h2>
        <p>{vehicle || "Your new vehicle"}</p>
        <ul>
          {COVERAGE_KEYS.map((k) => (
            <li key={k}>{product(k).title}</li>
          ))}
        </ul>
        {rate !== null && <p className="call-price-small">{money(rate)} a day</p>}
        <p className="muted">{dealershipName}</p>
      </div>
    );
  }
  if (panel.panel === "coverage_grid") {
    const active = String(panel.data.product ?? "");
    return (
      <div className="panel call-panel">
        <h2>Your protection package</h2>
        <div className="call-grid">
          {COVERAGE_KEYS.map((k) => {
            const p = product(k);
            return (
              <div key={k} className={`call-tile ${k === active ? "on" : ""}`}>
                <strong>{p.title}</strong>
                {k === active && p.bullets && (
                  <ul>
                    {p.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  const p = product(panel.panel);
  return (
    <div className="panel call-panel">
      <h2>{p.title}</h2>
      {p.bullets && (
        <ul>
          {p.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
