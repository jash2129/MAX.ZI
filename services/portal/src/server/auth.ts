import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";

import { authPool, portalDb } from "./db";
import { userIdForEmail } from "./portal";
import { portalUrl } from "./url";

/**
 * Sign-in (Better Auth, self-hosted: Neon's managed auth has no two-factor yet).
 *
 * Who can have an account: only people an admin has added (app_user). Password accounts are created
 * only through a one-time invite link (inviteSignUp below), because there is no email verification;
 * Google / Microsoft sign-in, which verify the email, is allowed for added people's emails.
 * Two-factor (authenticator app) is required for everyone who can edit or approve (see session.ts).
 */

/** The email an invite link was just checked for, while its password account is created */
export const inviteScope = new AsyncLocalStorage<string>();

const social: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> = {};
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  social.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
}
if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
  social.microsoft = {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    tenantId: process.env.MICROSOFT_TENANT_ID || "common",
  };
}
export const socialProviders = Object.keys(social) as Array<"google" | "microsoft">;

export const auth = betterAuth({
  appName: "Max portal",
  baseURL: portalUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: authPool(),
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
  socialProviders: social,
  session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
  rateLimit: { enabled: true, window: 60, max: 30 },
  plugins: [twoFactor({ issuer: "Max portal" }), nextCookies()],
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          const email = String(user.email ?? "").toLowerCase();
          if (!(await userIdForEmail(portalDb(), email))) return false; // nobody added this person
          const path = ctx?.path ?? "";
          // A password account only through an invite link (no email verification to rely on)
          if (path.startsWith("/sign-up")) return inviteScope.getStore() === email;
          return true; // OAuth: the provider verified the email
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
