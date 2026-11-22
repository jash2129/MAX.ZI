/**
 * Recordings in the portal: a call recorded through the real brain (consent), stored encrypted, played
 * back decrypted for the dealership's people only, every playback audited.
 */
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrain } from "../../brain/src/app";
import { PostgresConfigSource } from "../../brain/src/pg-config";
import { PgCallRecorder } from "../../brain/src/recorder";
import { migrate } from "../../control-plane/src/db";
import { pgliteDb } from "../../control-plane/src/pglite";
import { generateRecordingKeys, loadPrivateKey } from "../../control-plane/src/recording-crypto";
import { seedDemo } from "../../control-plane/src/seed-demo";
import { MemoryStore } from "../../control-plane/src/storage";
import { getCall } from "../src/server/portal";
import { playRecording } from "../src/server/recordings";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");
let db: Awaited<ReturnType<typeof pgliteDb>>;
const U: Record<string, string> = {};
const keys = generateRecordingKeys();
const store = new MemoryStore();
const player = { store, privateKey: loadPrivateKey(keys.privateKey) };
const audio = randomBytes(40_000);

beforeAll(async () => {
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MAX_MODE", "MAX_SPEECH", "MAX_UNDERSTANDING", "MAX_STREAM"]) delete process.env[k];
  db = await pgliteDb();
  await migrate(db);
  U.owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
  for (const [key, email, d, role] of [
    ["viewer", "viewer@mazda.test", "demo-mazda", "viewer"],
    ["other", "mgr@hyundai.test", "demo-hyundai", "manager"],
  ]) {
    U[key] = (await db.query<{ id: string }>("insert into app_user (email) values ($1) returning id", [email])).rows[0].id;
    await db.query("insert into membership (user_id, dealership_id, role) values ($1, $2, $3)", [U[key], d, role]);
  }
  const recorder = new PgCallRecorder(db, { fetchImpl: (async () => new Response("")) as unknown as typeof fetch, webhookRetryMs: [0] });
  const brain = createBrain({ registry: new PostgresConfigSource(db, 0), recorder });
  const post = async (path: string, body: unknown) => brain(new Request(`http://brain${path}`, { method: "POST", body: JSON.stringify(body) }));
  const ids = { dealership_id: "demo-mazda", call_id: "rec" };
  await post("/calls", ids);
  for (const [t, text] of ["Yes, I can hear and see you, it's been great.", "Yes, that makes sense.", "Yes, that makes sense."].entries()) {
    await (await post("/turn", { ...ids, turn_id: t + 1, transcript: text })).text();
    await post("/commit", { ...ids, turn_id: t + 1, heard: true, fraction_heard: 1 });
  }
  const end = await (await post("/end", { ...ids, reason: "customer_left" })).json();
  expect(end.consent).toBe(true);

  // What the voice worker does (max_worker/recording.py)
  const storageKey = "demo-mazda/2026/11/rec.flac.enc";
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, nonce);
  c.setAAD(Buffer.from(storageKey));
  const object = Buffer.concat([c.update(audio), c.final(), c.getAuthTag()]);
  await store.put(storageKey, object);
  const wrapped = publicEncrypt({ key: createPublicKey({ key: Buffer.from(keys.publicKey, "base64"), format: "der", type: "spki" }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
  const res = await post("/recordings", {
    ...ids,
    storage_key: storageKey,
    duration_s: 42,
    bytes: object.length,
    format: "flac",
    sha256: createHash("sha256").update(object).digest("hex"),
    key_id: keys.keyId,
    key_wrapped: wrapped.toString("base64"),
    nonce: nonce.toString("base64"),
  });
  expect(await res.json()).toEqual({ stored: true });
}, 180_000);

afterAll(async () => {
  await db?.close();
});

const listens = async () => (await db.query<any>("select actor from audit_log where table_name = 'recording' and action = 'listen'")).rows.map((r) => r.actor);

describe("recordings in the portal", () => {
  it("the call page shows the recording's details", async () => {
    const { recording } = await getCall(db, U.viewer, "demo-mazda", "demo-mazda:rec");
    expect(Number(recording!.duration_s)).toBe(42);
    expect(recording!.format).toBe("flac");
  });

  it("a person of the dealership plays it back, decrypted; the playback is audited", async () => {
    const out = await playRecording(db, player, U.viewer, "demo-mazda", "demo-mazda:rec");
    expect(out.audio.equals(audio)).toBe(true);
    expect(out.format).toBe("flac");
    expect(await listens()).toEqual([U.viewer]);
    // the player's later pieces of the same playback are not audited again
    await playRecording(db, player, U.viewer, "demo-mazda", "demo-mazda:rec", { audit: false });
    expect(await listens()).toEqual([U.viewer]);
  });

  it("another dealership's manager cannot, and nothing is audited for them", async () => {
    await expect(playRecording(db, player, U.other, "demo-mazda", "demo-mazda:rec")).rejects.toThrow(/no recording, or you don't have access/);
    await expect(playRecording(db, player, U.other, "demo-hyundai", "demo-mazda:rec")).rejects.toThrow(/no recording/);
    expect(await listens()).toEqual([U.viewer]);
  });

  it("a portal with another recording key says so instead of failing obscurely", async () => {
    const other = { store, privateKey: loadPrivateKey(generateRecordingKeys().privateKey) };
    await expect(playRecording(db, other, U.viewer, "demo-mazda", "demo-mazda:rec")).rejects.toThrow(/different recording key/);
  });

  it("after deletion on request the recording is gone and its file queued for deletion", async () => {
    await db.query("select app.forget_call_now('demo-mazda:rec')");
    const { recording } = await getCall(db, U.viewer, "demo-mazda", "demo-mazda:rec");
    expect(recording).toBeNull();
    await expect(playRecording(db, player, U.viewer, "demo-mazda", "demo-mazda:rec")).rejects.toThrow(/no recording/);
    expect((await db.query("select * from storage_deletion where storage_key = 'demo-mazda/2026/11/rec.flac.enc'")).rows).toHaveLength(1);
  });
});
