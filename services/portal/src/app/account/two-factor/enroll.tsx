"use client";

import { useActionState } from "react";

import { confirmTwoFactorAction, startTwoFactorAction, type EnrollState } from "@/app/actions";

/** Two steps: password -> QR code and backup codes -> the first code from the app turns it on */
export function Enroll() {
  const [state, start, pending] = useActionState<EnrollState, FormData>(startTwoFactorAction, {});
  if (!state.qrSvg) {
    return (
      <form action={start} className="panel">
        {state.error && <p className="notice error">{state.error}</p>}
        <label htmlFor="password">Your password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <p>
          <button className="primary" type="submit" disabled={pending}>
            Continue
          </button>
        </p>
      </form>
    );
  }
  const secret = state.secretUri ? new URL(state.secretUri).searchParams.get("secret") : "";
  return (
    <div className="panel">
      <p>1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others).</p>
      <div className="qr" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />
      <details>
        <summary className="muted">No camera? Enter this key instead</summary>
        <p className="mono" style={{ wordBreak: "break-all" }}>
          {secret}
        </p>
      </details>
      <p>2. Save these backup codes somewhere safe. Each works once, if you lose your phone.</p>
      <p className="mono">{state.backupCodes?.join("  ")}</p>
      <form action={confirmTwoFactorAction}>
        <label htmlFor="code">3. Enter the 6-digit code the app shows now</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        <p>
          <button className="primary" type="submit">
            Turn on two-factor
          </button>
        </p>
      </form>
    </div>
  );
}
