import type { Db } from "./db.ts";

/**
 * Scheduled maintenance, run by the owner (`npm run maintain`, e.g. hourly):
 *  - calls that never ended (the worker died, the host restarted) are closed as "abandoned";
 *  - deals past their expiry (plus a day) are deleted;
 *  - retention (PRD, per dealership): transcripts (turns) older than retention.transcripts_days are
 *    deleted; recording rows past retention_until are deleted (the files themselves: with recordings).
 * Each part is one statement and safe to run again.
 */
export interface MaintenanceResult {
  abandoned: number;
  deals_deleted: number;
  turns_deleted: number;
  recordings_deleted: number;
}

export async function maintain(db: Db, opts: { staleHours?: number } = {}): Promise<MaintenanceResult> {
  const stale = Math.max(1, opts.staleHours ?? 3);
  return db.transaction(async (tx) => {
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
}

/** Deletion on request (owner): a call's transcript, review text and recording; the outcome row stays */
export async function forgetCall(db: Db, callId: string): Promise<void> {
  await db.query("select app.forget_call_now($1)", [callId]);
}
