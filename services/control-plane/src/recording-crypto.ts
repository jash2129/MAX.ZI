import { createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants, type KeyObject } from "node:crypto";

/**
 * Call recordings are encrypted by the voice worker so that only the portal can read them:
 *
 *   data key  = 32 random bytes, one per recording
 *   object    = AES-256-GCM(data key, nonce, audio, associated data = the storage key) -> ciphertext || tag
 *   wrapped   = RSA-OAEP-SHA256(the platform's recording PUBLIC key, data key)
 *
 * The worker holds only the public key (RECORDING_PUBLIC_KEY), so a leaked worker can't read past
 * recordings. The portal holds the private key (RECORDING_PRIVATE_KEY). key_id names the key pair
 * (first 16 hex of SHA-256 over the public key's DER), so a rotated key is detected, not mis-decrypted.
 *
 * Keys are kept in env vars as base64 DER: public SPKI, private PKCS#8.
 */

export function keyIdOf(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

export function generateRecordingKeys(): { publicKey: string; privateKey: string; keyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    keyId: keyIdOf(publicKey),
  };
}

export function loadPrivateKey(b64: string): { key: KeyObject; keyId: string } {
  const key = createPrivateKey({ key: Buffer.from(b64.trim(), "base64"), format: "der", type: "pkcs8" });
  return { key, keyId: keyIdOf(createPublicKey(key)) };
}

export interface EncryptedRecording {
  storageKey: string;
  keyId: string;
  keyWrapped: string; // base64
  nonce: string; // base64, 12 bytes
  sha256: string; // hex, of the object
}

export class RecordingKeyMismatch extends Error {}

export function decryptRecording(object: Uint8Array, meta: EncryptedRecording, privateKey: { key: KeyObject; keyId: string }): Buffer {
  if (meta.keyId !== privateKey.keyId) throw new RecordingKeyMismatch(`recording was encrypted for key ${meta.keyId}, this portal has ${privateKey.keyId}`);
  if (createHash("sha256").update(object).digest("hex") !== meta.sha256) throw new Error("recording object does not match its checksum");
  const dataKey = privateDecrypt({ key: privateKey.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(meta.keyWrapped, "base64"));
  const buf = Buffer.from(object);
  if (buf.length < 16) throw new Error("recording object is too short");
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(meta.nonce, "base64"));
  decipher.setAAD(Buffer.from(meta.storageKey, "utf8"));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
}
