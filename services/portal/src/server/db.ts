import "server-only";

import pg from "pg";

import { fromPgPool, strictTls, type Db } from "../../../control-plane/src/db";

/**
 * Two logins, two pools (control-plane: npm run service-login):
 *  - PORTAL_DATABASE_URL: portal_login, which may act only as app_user (the signed-in person, under
 *    row-level security) and as the test gate;
 *  - AUTH_DATABASE_URL: auth_login, Better Auth's tables in the auth schema and nothing else.
 */
const g = globalThis as unknown as { __portalPool?: pg.Pool; __authPool?: pg.Pool };

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see services/portal/README.md)`);
  return v;
}

export function portalDb(): Db {
  g.__portalPool ??= new pg.Pool({ connectionString: strictTls(need("PORTAL_DATABASE_URL")), max: 5 });
  return fromPgPool(g.__portalPool);
}

export function authPool(): pg.Pool {
  g.__authPool ??= new pg.Pool({ connectionString: strictTls(need("AUTH_DATABASE_URL")), max: 5 });
  return g.__authPool;
}
