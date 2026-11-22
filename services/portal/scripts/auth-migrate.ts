/**
 * Creates or updates Better Auth's tables (in the auth schema: AUTH_DATABASE_URL's login has
 * search_path = auth). Run after `npm run migrate` in control-plane created the schema and role.
 *   npm run auth:migrate
 */
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
// EXPECT_HOST=<database host>: refuse to run against any other database (use it for production)
const target = new URL(process.env.AUTH_DATABASE_URL!).host;
console.log(`target: ${target}`);
if (process.env.EXPECT_HOST && !target.startsWith(process.env.EXPECT_HOST)) {
  console.error(`refusing: target ${target} is not ${process.env.EXPECT_HOST}`);
  process.exit(1);
}
const { getMigrations } = await import("better-auth/db/migration");
const { auth } = await import("../src/server/auth");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
console.log("tables to create:", toBeCreated.map((t) => t.table).join(", ") || "none");
console.log("columns to add:", toBeAdded.map((t) => `${t.table}(${Object.keys(t.fields).join(", ")})`).join(", ") || "none");
await runMigrations();
console.log("done");
process.exit(0);
