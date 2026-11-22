/**
 *   npm run migrate                      apply db/migrations to DATABASE_URL
 *   npm run seed-demo -- <report.json>   the two demo dealerships, demo content as approved v1
 *
 * DATABASE_URL here is the OWNER (migration) connection, never the one the services use.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { fromPgPool, migrate, strictTls } from "./db.ts";
import { seedDemo } from "./seed-demo.ts";

/** Sets KEY=value in an env file, keeping its other lines. The value is never printed. */
function writeEnvVar(path: string, key: string, value: string) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((l) => !l.startsWith(`${key}=`)) : [];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`${key}=${value}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** Local development: `neon deploy` / `neon env pull` write .env.local; real env vars win. */
function loadLocalEnv() {
  for (const f of [".env.local", ".env"]) {
    const path = resolve(import.meta.dirname, "..", f);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

async function main() {
  loadLocalEnv();
  const [cmd, arg] = process.argv.slice(2);
  // Neon: DDL and seeding over the direct connection, not the PgBouncer pooler (transaction mode)
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (or DATABASE_URL_UNPOOLED) is required");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: strictTls(url), max: 2 });
  const db = fromPgPool(pool);
  try {
    if (cmd === "migrate") {
      const applied = await migrate(db);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    } else if (cmd === "seed-demo") {
      if (!arg) throw new Error("usage: seed-demo <simulator report .json>");
      const out = await seedDemo(db, { ownerEmail: process.env.SEED_OWNER_EMAIL || "owner@example.com", reportPath: resolve(arg) });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === "service-login") {
      // service-login <brain_service|worker_service|gate_service> <env file to write DATABASE_URL into>
      const role = arg;
      const target = process.argv[4];
      if (!["brain_service", "worker_service", "gate_service"].includes(role ?? "") || !target) {
        throw new Error("usage: service-login <brain_service|worker_service|gate_service> <env file>");
      }
      const login = role!.replace(/_service$/, "_login");
      const password = randomBytes(24).toString("base64url");
      const exists = (await db.query("select 1 from pg_roles where rolname = $1", [login])).rows.length > 0;
      const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
      await db.exec(
        exists
          ? `alter role ${login} with login password ${lit(password)}`
          : `create role ${login} with login password ${lit(password)} in role ${role}`
      );
      // Services use the pooled endpoint (every role switch is SET LOCAL inside a transaction)
      const pooled = new URL(process.env.DATABASE_URL || url);
      pooled.username = login;
      pooled.password = password;
      writeEnvVar(resolve(target), "DATABASE_URL", pooled.toString());
      console.log(`${exists ? "rotated" : "created"} ${login} (member of ${role}); DATABASE_URL written to ${resolve(target)}`);
    } else {
      throw new Error("usage: cli.ts migrate | seed-demo <report.json> | service-login <role> <env file>");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
