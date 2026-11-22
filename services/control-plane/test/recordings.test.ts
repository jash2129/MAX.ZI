/**
 * Call recordings (migration 011): storage signing, envelope encryption, consent-only storage, the
 * file deletion queue, and the playback audit.
 */
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asService, asUser, migrate, type Db } from "../src/db.ts";
import { maintain } from "../src/maintenance.ts";
import { pgliteDb } from "../src/pglite.ts";
import { decryptRecording, generateRecordingKeys, loadPrivateKey, RecordingKeyMismatch } from "../src/recording-crypto.ts";
import { seedDemo } from "../src/seed-demo.ts";
import { MemoryStore, S3Store, signV4 } from "../src/storage.ts";

const REPORT = resolve(import.meta.dirname, "../../../testing-skill/reports/sim-batch-2026-11-21T06-26-38-028Z.json");

describe("S3 signing (AWS Signature Version 4)", () => {
  it("matches AWS's published GET Object example", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html ("GET Object")
    const h = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
  });

  it("path-style requests; a missing object is null; deleting a missing object succeeds; bad keys are refused", async () => {
    const seen: Array<{ method: string; url: string; auth: string }> = [];
    const fake = (async (url: URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ method: String(init.method), url: String(url), auth: headers.authorization });
      return new Response(init.method === "GET" ? null : "", { status: init.method === "PUT" ? 200 : 404 });
    }) as unknown as typeof fetch;
    const s = new S3Store({ endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "max-recordings", region: "auto", accessKeyId: "AK", secretAccessKey: "SK" }, fake);
    await s.put("demo-mazda/2026/11/demo-mazda:c1.flac.enc", new Uint8Array([1, 2, 3]));
    expect(await s.get("demo-mazda/2026/11/x.flac.enc")).toBeNull();
    await s.delete("demo-mazda/2026/11/x.flac.enc");
    expect(seen[0].url).toBe("https://acct.r2.cloudflarestorage.com/max-recordings/demo-mazda/2026/11/demo-mazda%3Ac1.flac.enc");
    expect(seen.every((r) => r.auth.startsWith("AWS4-HMAC-SHA256 Credential=AK/"))).toBe(true);
    await expect(s.get("demo-mazda/../other/x")).rejects.toThrow(/invalid storage key/);
    await expect(s.get("/abs")).rejects.toThrow(/invalid storage key/);
  });
});

/** What the voice worker does (Python, max_worker/recording.py), here in Node for the round trip */
function encryptLikeWorker(audio: Buffer, storageKey: string, publicKeyB64: string) {
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, nonce);
  c.setAAD(Buffer.from(storageKey));
  const object = Buffer.concat([c.update(audio), c.final(), c.getAuthTag()]);
  const pub = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
  return { object, meta: { storageKey, nonce: nonce.toString("base64"), keyWrapped: wrapped.toString("base64"), sha256: createHash("sha256").update(object).digest("hex") } };
}

describe("envelope encryption", () => {
  const keys = generateRecordingKeys();
  const priv = loadPrivateKey(keys.privateKey);
  const audio = randomBytes(50_000);

  it("only the private key reads it back; the key id names the pair", () => {
    expect(priv.keyId).toBe(keys.keyId);
    const { object, meta } = encryptLikeWorker(audio, "demo-mazda/2026/11/c1.flac.enc", keys.publicKey);
    expect(decryptRecording(object, { ...meta, keyId: keys.keyId }, priv).equals(audio)).toBe(true);
  });

  it("a tampered object, an object moved to another key, or another key pair are refused", () => {
    const { object, meta } = encryptLikeWorker(audio, "demo-mazda/2026/11/c1.flac.enc", keys.publicKey);
    const bad = Buffer.from(object);
    bad[10] ^= 1;
    expect(() => decryptRecording(bad, { ...meta, keyId: keys.keyId }, priv)).toThrow(/checksum/);
    expect(() => decryptRecording(bad, { ...meta, sha256: createHash("sha256").update(bad).digest("hex"), keyId: keys.keyId }, priv)).toThrow();
    expect(() => decryptRecording(object, { ...meta, storageKey: "demo-hyundai/2026/11/c1.flac.enc", keyId: keys.keyId }, priv)).toThrow();
    const other = loadPrivateKey(generateRecordingKeys().privateKey);
    expect(() => decryptRecording(object, { ...meta, keyId: keys.keyId }, other)).toThrow(RecordingKeyMismatch);
  });
});

describe("recording rows, deletion queue and playback audit", () => {
  let db: Db & { close(): Promise<void> };
  const U: Record<string, string> = {};

  beforeAll(async () => {
    db = await pgliteDb();
    await migrate(db);
    U.owner = (await seedDemo(db, { ownerEmail: "owner@example.com", reportPath: REPORT })).owner;
    for (const [k, email, d, role] of [["viewer", "v@mazda.test", "demo-mazda", "viewer"], ["other", "m@hyundai.test", "demo-hyundai", "manager"]]) {
      U[k] = (await db.query<{ id: string }>("insert into app_user (email) values ($1) returning id", [email])).rows[0].id;
      await db.query("insert into membership (user_id, dealership_id, role) values ($1, $2, $3)", [U[k], d, role]);
    }
    await asService(db, "brain_service", async (tx) => {
      await tx.query("insert into call (id, dealership_id, consent_at) values ('demo-mazda:c1', 'demo-mazda', now()), ('demo-mazda:c2', 'demo-mazda', null)");
    });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  const add = (call: string, key: string, d = "demo-mazda") =>
    asService(db, "brain_service", async (tx) => (await tx.query<{ s: boolean }>("select app.add_recording($1, $2, $3, 60, 1000, 'flac', $4, '0123456789abcdef', 'd3JhcHBlZGtleXdyYXBwZWQ=', 'bm9uY2Vub25jZQ==') as s", [call, d, key, "b".repeat(64)])).rows[0].s);

  it("stored only for a call with consent, under its own dealership's prefix", async () => {
    expect(await add("demo-mazda:c1", "demo-mazda/2026/11/c1.flac.enc")).toBe(true);
    expect(await add("demo-mazda:c2", "demo-mazda/2026/11/c2.flac.enc")).toBe(false);
    await expect(add("demo-mazda:c1", "demo-hyundai/2026/11/c1.flac.enc")).rejects.toThrow(/must start with the dealership/);
    expect(await add("demo-mazda:c1", "demo-hyundai/x", "demo-hyundai")).toBe(false); // not that dealership's call
    const queued = (await db.query<{ storage_key: string }>("select storage_key from storage_deletion order by storage_key")).rows.map((r) => r.storage_key);
    expect(queued).toEqual(["demo-hyundai/x", "demo-mazda/2026/11/c2.flac.enc"]);
  });

  it("people of the dealership see the recording row; others don't; nobody but the owner sees the queue", async () => {
    expect((await asUser(db, U.viewer, (tx) => tx.query("select call_id from recording"))).rows).toHaveLength(1);
    expect((await asUser(db, U.other, (tx) => tx.query("select call_id from recording"))).rows).toHaveLength(0);
    await expect(asUser(db, U.viewer, (tx) => tx.query("select * from storage_deletion"))).rejects.toThrow(/permission denied/);
  });

  it("every playback is audited; another dealership or no person cannot note one", async () => {
    await asUser(db, U.viewer, (tx) => tx.query("select app.note_recording_access('demo-mazda:c1')"));
    const log = (await db.query<any>("select actor, action, dealership_id from audit_log where table_name = 'recording'")).rows;
    expect(log).toEqual([{ actor: U.viewer, action: "listen", dealership_id: "demo-mazda" }]);
    await expect(asUser(db, U.other, (tx) => tx.query("select app.note_recording_access('demo-mazda:c1')"))).rejects.toThrow(/not allowed/);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("set local role app_user");
        await tx.query("select app.note_recording_access('demo-mazda:c1')");
      })
    ).rejects.toThrow(/not allowed/);
  });

  it("maintenance deletes queued files from storage; past-retention recordings go too; without storage they stay queued", async () => {
    const store = new MemoryStore();
    for (const k of ["demo-mazda/2026/11/c1.flac.enc", "demo-mazda/2026/11/c2.flac.enc", "demo-hyundai/x"]) await store.put(k, new Uint8Array([1]));
    const noStore = await maintain(db, {});
    expect(noStore).toMatchObject({ files_deleted: 0, files_pending: 2 });

    await db.query("update recording set retention_until = now() - interval '1 minute' where call_id = 'demo-mazda:c1'");
    const r = await maintain(db, { storage: store });
    expect(r).toMatchObject({ recordings_deleted: 1, files_deleted: 3, files_pending: 0 });
    expect(store.objects.size).toBe(0);
    expect((await db.query("select * from recording")).rows).toHaveLength(0);
  });

  it("a failed storage delete stays queued for the next run", async () => {
    await db.query("insert into storage_deletion (storage_key, reason) values ('demo-mazda/z', 'test')");
    const failing = { get: async () => null, put: async () => {}, delete: async () => { throw new Error("HTTP 500"); } };
    expect(await maintain(db, { storage: failing })).toMatchObject({ files_deleted: 0, files_pending: 1 });
    expect(await maintain(db, { storage: new MemoryStore() })).toMatchObject({ files_deleted: 1, files_pending: 0 });
  });
});
