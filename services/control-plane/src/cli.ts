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

/**
 * Which database: ENV_FILE=<file> uses only that file (e.g. a Neon branch's), never .env.local;
 * otherwise .env.local / .env (written by `neon deploy`). Real env vars win either way.
 */
function loadLocalEnv() {
  if (process.env.ENV_FILE) {
    const path = resolve(process.env.ENV_FILE);
    if (!existsSync(path)) throw new Error(`ENV_FILE ${path} does not exist`);
    process.loadEnvFile(path);
    return;
  }
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
  // Say which database before changing anything (host only, never the password)
  console.error(`target database: ${new URL(url).host}${process.env.ENV_FILE ? ` (from ${process.env.ENV_FILE})` : " (from .env.local)"}`);
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
      // portal: acts as the signed-in person (app_user) and runs the release gate (gate_service)
      // auth_service: portal sign-in tables only, in the auth schema
      const MEMBER_OF: Record<string, string[]> = {
        brain_service: ["brain_service"],
        worker_service: ["worker_service"],
        gate_service: ["gate_service"],
        portal: ["app_user", "gate_service"],
        auth_service: ["auth_service"],
      };
      if (!role || !MEMBER_OF[role] || !target) {
        throw new Error(`usage: service-login <${Object.keys(MEMBER_OF).join("|")}> <env file> [ENV_VAR_NAME]`);
      }
      const login = role === "portal" ? "portal_login" : role.replace(/_service$/, "_login");
      const envVar = process.argv[5] || "DATABASE_URL";
      const password = randomBytes(24).toString("base64url");
      const exists = (await db.query("select 1 from pg_roles where rolname = $1", [login])).rows.length > 0;
      const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
      await db.exec(
        exists
          ? `alter role ${login} with login password ${lit(password)}`
          : `create role ${login} with login password ${lit(password)} in role ${MEMBER_OF[role].join(", ")}`
      );
      // Better Auth creates and uses its tables in the auth schema
      if (role === "auth_service") await db.exec(`alter role ${login} set search_path = auth`);
      // Services use the pooled endpoint (every role switch is SET LOCAL inside a transaction)
      const pooled = new URL(process.env.DATABASE_URL || url);
      pooled.username = login;
      pooled.password = password;
      writeEnvVar(resolve(target), envVar, pooled.toString());
      console.log(`${exists ? "rotated" : "created"} ${login} (member of ${MEMBER_OF[role].join(", ")}); ${envVar} written to ${resolve(target)}`);
    } else if (cmd === "invite") {
      // invite <email> <file>: the first admin's way in (or anyone's, by the owner). Writes the one-time
      // link to <file> instead of printing it: it is a credential until used.
      const email = (arg ?? "").trim().toLowerCase();
      const file = process.argv[4];
      if (!email.includes("@") || !file) throw new Error("usage: invite <email> <file to write the link to>");
      const user = (await db.query<{ id: string }>("select id from app_user where email = $1", [email])).rows[0];
      if (!user) throw new Error(`${email} is not a person in the control plane yet (add them to a dealership, or seed-demo for the owner)`);
      const token = randomBytes(32).toString("hex");
      await db.transaction(async (tx) => {
        await tx.query("delete from invite where user_id = $1 and used_at is null", [user.id]);
        await tx.query("insert into invite (token_hash, user_id) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2)", [token, user.id]);
      });
      const base = process.env.PORTAL_URL || "http://localhost:3100";
      writeFileSync(resolve(file), `${base}/invite/${token}\n`, { mode: 0o600 });
      console.log(`invite link for ${email} written to ${resolve(file)} (works once, 7 days)`);
    } else {
      throw new Error("usage: cli.ts migrate | seed-demo <report.json> | service-login <role> <env file> | invite <email> <file>");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
