import type { Db } from "./db.ts";
import type { ObjectStore } from "./storage.ts";

/**
 * Scheduled maintenance, run by the owner (`npm run maintain`, e.g. hourly):
 *  - calls that never ended (the worker died, the host restarted) are closed as "abandoned";
 *  - deals past their expiry (plus a day) are deleted;
 *  - retention (PRD, per dealership): transcripts (turns) older than retention.transcripts_days are
 *    deleted; recording rows past retention_until are deleted;
 *  - recording files whose rows were deleted (retention, deletion on request, no consent) are deleted
 *    from storage (the storage_deletion queue). Without storage configured they stay queued.
 * Each part is safe to run again.
 */
export interface MaintenanceResult {
  abandoned: number;
  deals_deleted: number;
  turns_deleted: number;
  recordings_deleted: number;
  /** files deleted from storage this run */
  files_deleted: number;
  /** files still queued (no storage configured, or a delete failed: retried next run) */
  files_pending: number;
}

export async function maintain(db: Db, opts: { staleHours?: number; storage?: ObjectStore | null } = {}): Promise<MaintenanceResult> {
  const stale = Math.max(1, opts.staleHours ?? 3);
  const rows = await db.transaction(async (tx) => {
    const abandoned = await tx.query(
      `update call set ended_at = now(), end_reason = 'abandoned'
        where ended_at is null and started_at < now() - make_interval(hours => $1) returning id`,
      [stale]
    );
    const deals = await tx.query("delete from deal where expires_at < now() - interval '1 day' returning id");
    const turns = await tx.query(
      `delete from turn t using call c, dealership d
        where t.call_id = c.id and c.dealership_id = d.id
          and c.started_at < now() - make_interval(days => coalesce((d.retention ->> 'transcripts_days')::int, 365))
        returning t.call_id`
    );
    const recordings = await tx.query("delete from recording where retention_until < now() returning call_id");
    return {
      abandoned: abandoned.rows.length,
      deals_deleted: deals.rows.length,
      turns_deleted: turns.rows.length,
      recordings_deleted: recordings.rows.length,
    };
  });
  // Files, outside the transaction (the queue rows were committed above). Each file's queue row goes
  // only once storage confirms the delete.
  let filesDeleted = 0;
  if (opts.storage) {
    const queued = await db.query<{ storage_key: string }>("select storage_key from storage_deletion order by queued_at limit 1000");
    for (const { storage_key } of queued.rows) {
      try {
        await opts.storage.delete(storage_key);
        await db.query("delete from storage_deletion where storage_key = $1", [storage_key]);
        filesDeleted++;
      } catch (err) {
        console.error(JSON.stringify({ event: "storage_delete_failed", error: String((err as Error)?.message ?? err).slice(0, 200) }));
      }
    }
  }
  const pending = Number((await db.query<{ n: string }>("select count(*) as n from storage_deletion")).rows[0].n);
  return { ...rows, files_deleted: filesDeleted, files_pending: pending };
}

/** Deletion on request (owner): a call's transcript, review text and recording; the outcome row stays */
export async function forgetCall(db: Db, callId: string): Promise<void> {
  await db.query("select app.forget_call_now($1)", [callId]);
}
