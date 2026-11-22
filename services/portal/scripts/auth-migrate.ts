/**
 * Creates or updates Better Auth's tables (in the auth schema: AUTH_DATABASE_URL's login has
 * search_path = auth). Run after `npm run migrate` in control-plane created the schema and role.
 *   npm run auth:migrate
 */
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const { getMigrations } = await import("better-auth/db/migration");
const { auth } = await import("../src/server/auth");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
console.log(`target: ${new URL(process.env.AUTH_DATABASE_URL!).host}`);
console.log("tables to create:", toBeCreated.map((t) => t.table).join(", ") || "none");
console.log("columns to add:", toBeAdded.map((t) => `${t.table}(${Object.keys(t.fields).join(", ")})`).join(", ") || "none");
await runMigrations();
console.log("done");
process.exit(0);
