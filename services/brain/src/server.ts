import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { createBrain } from "./app.ts";
import type { CallRecorder } from "./recorder.ts";
import { DealershipRegistry, type ConfigSource, type DealSource } from "./tenants.ts";

// Local development: .env.local (written by `npm run service-login` in control-plane). Real env vars win.
// BRAIN_ENV_FILE=off: never (tests, which must not reach a real database).
const localEnv = new URL("../.env.local", import.meta.url);
if (process.env.NODE_ENV !== "production" && process.env.BRAIN_ENV_FILE !== "off" && existsSync(localEnv)) process.loadEnvFile(localEnv);

// Always-on process (Fly.io / Render / Railway): live calls need it, serverless functions do not fit.
async function configSource(): Promise<{ registry: ConfigSource; recorder?: CallRecorder; deals?: DealSource }> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return { registry: DealershipRegistry.fromDirectory(process.env.DEALERSHIP_CONFIG_DIR || undefined) };
  // The control plane. This login must be a member of the brain_service role (and nothing more):
  //   create role brain_login login password '...' in role brain_service;
  const [{ default: pg }, { fromPgPool, strictTls }, { PostgresConfigSource, PostgresDealSource }, { PgCallRecorder }] = await Promise.all([
    import("pg"),
    import("../../control-plane/src/db.ts"),
    import("./pg-config.ts"),
    import("./recorder.ts"),
  ]);
  const db = fromPgPool(new pg.Pool({ connectionString: strictTls(url), max: 5 }));
  return { registry: new PostgresConfigSource(db), recorder: new PgCallRecorder(db), deals: new PostgresDealSource(db) };
}

const { registry, recorder, deals } = await configSource();
const handle = createBrain({
  registry,
  recorder,
  deals,
  token: process.env.BRAIN_TOKEN?.trim() || undefined,
  production: process.env.NODE_ENV === "production",
});

const MAX_BODY = 64 * 1024;

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  return new Request(`http://brain${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

const server = createServer(async (req, res) => {
  try {
    const response = await handle(await toRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      // Stream NDJSON lines as they are produced (early sentences must not wait for the final reply)
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
    } else res.end();
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
  }
});

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => {
  console.log(JSON.stringify({ event: "brain_listening", port, config: registry.kind, dealerships: registry.ids?.() ?? null }));
});

// Graceful shutdown (deploys, restarts): stop taking requests, then finish writing queued call
// records before exiting; they live in memory until written. Up to 30 s, then exit anyway.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "brain_stopping", signal }));
  server.close();
  const deadline = new Promise((r) => setTimeout(r, 30_000));
  await Promise.race([recorder?.flush() ?? Promise.resolve(), deadline]);
  console.log(JSON.stringify({ event: "brain_stopped" }));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
