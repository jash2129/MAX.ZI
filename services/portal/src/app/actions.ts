"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";

import { auth, inviteScope } from "@/server/auth";
import { portalDb } from "@/server/db";
import {
  PortalError,
  addPerson,
  approve,
  createApiKey,
  createDealership,
  createDraft,
  forgetCall,
  revokeApiKey,
  deleteDraft,
  getVersion,
  needsTwoFactor,
  peekInvite,
  redeemInvite,
  reinvite,
  removePerson,
  removeWebhook,
  rollbackTo,
  runGate,
  saveDraft,
  setStatus,
  setWebhook,
  userIdForEmail,
  type DealershipRole,
  type Kind,
} from "@/server/portal";
import { requirePerson } from "@/server/session";
import { portalUrl, secureCookies } from "@/server/url";

/**
 * Server actions. Forms post here; errors come back as ?error=... on the page (no client JS needed).
 * Every action that touches config goes through the data layer, so the database decides.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const KINDS = new Set(["script", "price", "kb"]);
const kindOf = (f: FormData): Kind => {
  const k = str(f, "kind");
  if (!KINDS.has(k)) throw new PortalError("Unknown kind.");
  return k as Kind;
};

/** A message safe to show: our own wording, or the API's plain message, never a stack */
function message(err: unknown): string {
  if (err instanceof PortalError) return err.message;
  const body = (err as { body?: { message?: string } })?.body;
  if (body?.message) return body.message;
  return "Something went wrong. Nothing was changed.";
}

/** Runs `fn` and goes to `to`, or back to `back` with the error. (redirect() must stay outside try.) */
async function act(back: string, fn: () => Promise<string | void>): Promise<never> {
  let to: string;
  try {
    to = (await fn()) || back;
  } catch (err) {
    console.error(JSON.stringify({ event: "portal_action_failed", back, error: String((err as Error)?.message ?? err) }));
    redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(message(err))}`);
  }
  redirect(to);
}

// ---------------------------------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------------------------------

export async function signInAction(form: FormData) {
  await act("/sign-in", async () => {
    const res = (await auth.api.signInEmail({ body: { email: str(form, "email"), password: String(form.get("password") ?? "") }, headers: await headers() })) as {
      twoFactorRedirect?: boolean;
    };
    if (res?.twoFactorRedirect) return "/sign-in/two-factor";
    return "/";
  });
}

export async function verifyTwoFactorAction(form: FormData) {
  await act("/sign-in/two-factor", async () => {
    await auth.api.verifyTOTP({ body: { code: str(form, "code").replace(/\s/g, "") }, headers: await headers() });
    return "/";
  });
}

export async function signOutAction() {
  await act("/sign-in", async () => {
    await auth.api.signOut({ headers: await headers() });
    return "/sign-in";
  });
}

/** Invite link: create the password account for the invited email, then use up the link */
export async function acceptInviteAction(form: FormData) {
  const token = str(form, "token");
  await act(`/invite/${encodeURIComponent(token)}`, async () => {
    const db = portalDb();
    const email = await peekInvite(db, token);
    if (!email) throw new PortalError("This invite link has expired or was already used. Ask for a new one.");
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) throw new PortalError("The two passwords are not the same.");
    if (password.length < 12) throw new PortalError("Use at least 12 characters.");
    await inviteScope.run(email, async () =>
      auth.api.signUpEmail({ body: { email, password, name: str(form, "name") || email }, headers: await headers() })
    );
    if (!(await redeemInvite(db, token))) throw new PortalError("This invite link was just used. Sign in instead.");
    const id = await userIdForEmail(db, email);
    return id && (await needsTwoFactor(db, id)) ? "/account/two-factor" : "/";
  });
}

export interface EnrollState {
  qrSvg?: string;
  secretUri?: string;
  backupCodes?: string[];
  error?: string;
}

/** Step 1 of two-factor set-up: check the password, return the QR code and backup codes */
export async function startTwoFactorAction(_prev: EnrollState, form: FormData): Promise<EnrollState> {
  try {
    const res = (await auth.api.enableTwoFactor({ body: { password: String(form.get("password") ?? "") }, headers: await headers() })) as {
      totpURI: string;
      backupCodes: string[];
    };
    return { qrSvg: await QRCode.toString(res.totpURI, { type: "svg", margin: 1 }), secretUri: res.totpURI, backupCodes: res.backupCodes };
  } catch (err) {
    return { error: message(err) };
  }
}

/** Step 2: the first code from the app turns two-factor on */
export async function confirmTwoFactorAction(form: FormData) {
  await act("/account/two-factor", async () => {
    await auth.api.verifyTOTP({ body: { code: str(form, "code").replace(/\s/g, "") }, headers: await headers() });
    return "/?twofactor=on";
  });
}

// ---------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------

const versionPage = (d: string, k: Kind, v: string) => `/d/${encodeURIComponent(d)}/${k}/${v}`;

export async function newDraftAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  await act(`/d/${encodeURIComponent(d)}`, async () => versionPage(d, kind, await createDraft(portalDb(), p.id, d, kind, str(form, "from") || undefined)));
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PortalError(`${what} is not valid JSON.`);
  }
}

export async function saveDraftAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  const id = str(form, "version");
  await act(versionPage(d, kind, id), async () => {
    const db = portalDb();
    let content: Record<string, unknown>;
    if (kind === "price") {
      const steps = str(form, "steps")
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((s) => Number(s.replace(/^\$/, "")));
      if (steps.some((n) => !Number.isFinite(n))) throw new PortalError("Daily rates must be numbers, like 4, 3.50, 3.25, 3.");
      content = { steps };
    } else if (kind === "kb") {
      content = { facts: parseJson(str(form, "facts"), "The facts") };
    } else {
      const current = await getVersion(db, p.id, "script", id);
      const beats = (current.beats as Array<Record<string, unknown>>).map((b) => ({ ...b, text: String(form.get(`beat_${b.id}`) ?? b.text) }));
      content = {
        beats,
        disclosure: str(form, "disclosure"),
        fixed_lines: parseJson(str(form, "fixed_lines") || "{}", "Fixed lines"),
        recaps: parseJson(str(form, "recaps") || "{}", "Recaps"),
        // Empty or unchanged from the built-in prompt = the built-in prompt (stored as null)
        free_prompt: str(form, "free_prompt"),
        // Max's prompt (the native engine); empty or the built-in one = stored as null
        native_prompt: str(form, "native_prompt"),
      };
    }
    await saveDraft(db, p.id, kind, id, content, str(form, "notes"));
    return `${versionPage(d, kind, id)}?saved=1`;
  });
}

export async function statusAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  const id = str(form, "version");
  const to = str(form, "to") === "draft" ? "draft" : "in_test";
  await act(versionPage(d, kind, id), async () => setStatus(portalDb(), p.id, kind, id, to));
}

export async function runGateAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  const id = str(form, "version");
  await act(versionPage(d, kind, id), async () => {
    const r = await runGate(portalDb(), p.id, kind, id);
    return `${versionPage(d, kind, id)}?gate=${r.hard_failures === 0 ? "passed" : "failed"}`;
  });
}

export async function approveAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  const id = str(form, "version");
  await act(versionPage(d, kind, id), async () => {
    await approve(portalDb(), p.id, kind, id);
    return `/d/${encodeURIComponent(d)}?approved=${kind}`;
  });
}

export async function rollbackAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  const id = str(form, "version");
  await act(versionPage(d, kind, id), async () => {
    await rollbackTo(portalDb(), p.id, kind, id);
    return `/d/${encodeURIComponent(d)}?rolledback=${kind}`;
  });
}

export async function deleteDraftAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const kind = kindOf(form);
  const id = str(form, "version");
  await act(versionPage(d, kind, id), async () => {
    await deleteDraft(portalDb(), p.id, kind, id);
    return `/d/${encodeURIComponent(d)}`;
  });
}

// ---------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------

/** The invite link is shown once, from a short-lived cookie, never in a URL (history, logs) */
async function flashInvite(email: string, token: string) {
  const base = portalUrl();
  (await cookies()).set("flash_invite", JSON.stringify({ email, link: `${base}/invite/${token}` }), {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookies(),
    maxAge: 120,
    path: "/",
  });
}

export async function addPersonAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => {
    const email = str(form, "email").toLowerCase();
    const { token } = await addPerson(portalDb(), p.id, d, email, str(form, "role") as DealershipRole);
    await flashInvite(email, token);
    return `/d/${encodeURIComponent(d)}#people`;
  });
}

export async function reinviteAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => {
    const token = await reinvite(portalDb(), p.id, str(form, "person"));
    await flashInvite(str(form, "email"), token);
    return `/d/${encodeURIComponent(d)}#people`;
  });
}

export async function removePersonAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => removePerson(portalDb(), p.id, d, str(form, "person"), str(form, "role") as DealershipRole));
}

// ---------------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------------

export async function setWebhookAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => {
    const secret = await setWebhook(portalDb(), p.id, d, str(form, "url"));
    // shown once, like an invite link
    (await cookies()).set("flash_webhook_secret", secret, { httpOnly: true, sameSite: "strict", secure: secureCookies(), maxAge: 120, path: "/" });
    return `/d/${encodeURIComponent(d)}#webhook`;
  });
}

// ---------------------------------------------------------------------------------------------------
// Onboarding, API keys, deletion on request
// ---------------------------------------------------------------------------------------------------

export async function createDealershipAction(form: FormData) {
  const p = await requirePerson();
  await act("/", async () => {
    const id = str(form, "id").toLowerCase();
    await createDealership(portalDb(), p.id, {
      id,
      name: str(form, "name"),
      agency: str(form, "agency") || null,
      template: str(form, "template"),
      vehicle: { year: str(form, "vehicle_year"), make: str(form, "vehicle_make"), model: str(form, "vehicle_model") },
      keyterms: str(form, "keyterms").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 50),
    });
    return `/d/${encodeURIComponent(id)}?created=1`;
  });
}

export async function createApiKeyAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => {
    const key = await createApiKey(portalDb(), p.id, d, str(form, "label"));
    (await cookies()).set("flash_api_key", key, { httpOnly: true, sameSite: "strict", secure: secureCookies(), maxAge: 120, path: "/" });
    return `/d/${encodeURIComponent(d)}#api-keys`;
  });
}

export async function revokeApiKeyAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => {
    await revokeApiKey(portalDb(), p.id, str(form, "key"));
    return `/d/${encodeURIComponent(d)}#api-keys`;
  });
}

export async function forgetCallAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  const call = str(form, "call");
  await act(`/d/${encodeURIComponent(d)}/calls/${encodeURIComponent(call)}`, async () => {
    if (str(form, "confirm") !== "DELETE") throw new PortalError('Type DELETE to confirm.');
    await forgetCall(portalDb(), p.id, call);
    return `/d/${encodeURIComponent(d)}/calls/${encodeURIComponent(call)}?forgotten=1`;
  });
}

export async function removeWebhookAction(form: FormData) {
  const p = await requirePerson();
  const d = str(form, "dealership");
  await act(`/d/${encodeURIComponent(d)}`, async () => {
    await removeWebhook(portalDb(), p.id, d);
    return `/d/${encodeURIComponent(d)}#webhook`;
  });
}
