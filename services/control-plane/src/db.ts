import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The few things the control plane needs from Postgres, so the same code runs on node-postgres in
 * production and on PGlite (real Postgres in WebAssembly) in tests.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction on one connection; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
}

/** Roles the application acts as. Never the table owner: owners bypass row-level security. */
export type ServiceRole = "brain_service" | "worker_service" | "gate_service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything a signed-in person does goes through here: one transaction as `app_user` with their id
 * set, so every row they touch is checked by the database's policies.
 */
export async function asUser<T>(db: Db, userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("asUser: user id must be a uuid");
  return db.transaction(async (tx) => {
    await tx.query("set local role app_user");
    await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

/** A service (brain, worker, test gate) acting across tenants within its own narrow policies. */
export async function asService<T>(db: Db, role: ServiceRole, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!["brain_service", "worker_service", "gate_service"].includes(role)) throw new Error(`unknown role ${role}`);
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    await tx.query("select set_config('app.user_id', '', true)");
    return fn(tx);
  });
}

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "../db/migrations");

/** Applies db/migrations/*.sql in name order, each once, each in its own transaction. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    await db.transaction(async (tx) => {
      // PGlite and node-postgres both accept several statements in one simple query
      await tx.query(sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}

/**
 * node-postgres treats sslmode=require (what Neon's connection strings carry) as full certificate
 * verification today and warns it will change; ask for verify-full explicitly so TLS stays strict.
 */
export function strictTls(url: string): string {
  return url.replace(/([?&])sslmode=(require|prefer|verify-ca)\b/, "$1sslmode=verify-full");
}

/** node-postgres adapter (production). */
export function fromPgPool(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; release: () => void }>;
}): Db {
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: async (sql) => {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({ query: (sql, params) => client.query(sql, params) as any });
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
