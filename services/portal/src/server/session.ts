import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "./auth";
import { portalDb } from "./db";
import { me, needsTwoFactor, userIdForEmail, type Me } from "./portal";

export interface Person extends Me {
  twoFactorEnabled: boolean;
  needsTwoFactor: boolean;
}

/** The signed-in person, or null (no session, or an account nobody added) */
export async function currentPerson(): Promise<Person | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const id = await userIdForEmail(portalDb(), session.user.email);
  if (!id) return null;
  const db = portalDb();
  const [person, mustUse2fa] = await Promise.all([me(db, id), needsTwoFactor(db, id)]);
  return { ...person, twoFactorEnabled: Boolean((session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled), needsTwoFactor: mustUse2fa };
}

/**
 * Every portal page: signed in, and admins (anyone who can edit or approve) with two-factor set up.
 * With two-factor on, Better Auth only creates a session after the code was checked.
 */
export async function requirePerson(): Promise<Person> {
  const p = await currentPerson();
  if (!p) redirect("/sign-in");
  if (p.needsTwoFactor && !p.twoFactorEnabled) redirect("/account/two-factor");
  return p;
}
