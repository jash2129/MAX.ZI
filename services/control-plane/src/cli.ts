/**
 *   npm run migrate                      apply db/migrations to DATABASE_URL
 *   npm run seed-demo -- <report.json>   the two demo dealerships, demo content as approved v1
 *
 * DATABASE_URL here is the OWNER (migration) connection, never the one the services use.
 */
import { resolve } from "node:path";

import { fromPgPool, migrate } from "./db.ts";
import { seedDemo } from "./seed-demo.ts";

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const db = fromPgPool(pool);
  try {
    if (cmd === "migrate") {
      const applied = await migrate(db);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    } else if (cmd === "seed-demo") {
      if (!arg) throw new Error("usage: seed-demo <simulator report .json>");
      const out = await seedDemo(db, { ownerEmail: process.env.SEED_OWNER_EMAIL || "owner@example.com", reportPath: resolve(arg) });
      console.log(JSON.stringify(out, null, 2));
    } else {
      throw new Error("usage: cli.ts migrate | seed-demo <report.json>");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
