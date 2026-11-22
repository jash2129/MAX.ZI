import "server-only";

import { decryptRecording, loadPrivateKey, RecordingKeyMismatch } from "../../../control-plane/src/recording-crypto";
import { storeFromEnv, type ObjectStore } from "../../../control-plane/src/storage";
import type { Db } from "../../../control-plane/src/db";

import { openRecording, PortalError } from "./portal";

/**
 * Playing a call's recording: the signed-in person's access is checked and audited by the database
 * (openRecording), the encrypted object is fetched from storage and decrypted here, in memory, with
 * RECORDING_PRIVATE_KEY. The audio is never stored decrypted and never cached.
 */
export interface Player {
  store: ObjectStore;
  privateKey: ReturnType<typeof loadPrivateKey>;
}

let cached: Player | null | undefined;
export function playerFromEnv(): Player | null {
  if (cached !== undefined) return cached;
  const store = storeFromEnv();
  const pk = process.env.RECORDING_PRIVATE_KEY;
  cached = store && pk ? { store, privateKey: loadPrivateKey(pk) } : null;
  return cached;
}

export async function playRecording(db: Db, player: Player, userId: string, dealershipId: string, callId: string, opts: { audit?: boolean } = {}) {
  const meta = await openRecording(db, userId, dealershipId, callId, opts);
  const object = await player.store.get(meta.storageKey);
  if (!object) throw new PortalError("The recording file is missing from storage.");
  try {
    return { audio: decryptRecording(object, meta, player.privateKey), format: meta.format };
  } catch (err) {
    if (err instanceof RecordingKeyMismatch) throw new PortalError("This recording was encrypted with a different recording key than this portal has.");
    throw err;
  }
}
