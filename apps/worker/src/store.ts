import { lt, schema, type Db } from '@auditor/db';
import { RUN_LIMITS, type RunStatus, type RunTrace } from '@auditor/shared';

// The worker's writes. Append-only, like the web app's: status transitions are new rows in
// run_events, the trace is one row in run_traces. The single DELETE in the codebase is
// `deleteExpiredTraces`, which §8 requires.

export function appendRunEvent(db: Db) {
  return async (
    runId: string,
    status: RunStatus,
    attempt: number,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    await db.insert(schema.runEvents).values({ runId, status, attempt, detail });
  };
}

export function insertTrace(db: Db) {
  return async (trace: RunTrace): Promise<number> => {
    const bytes = Buffer.byteLength(JSON.stringify(trace));
    const expiresAt = new Date(Date.now() + RUN_LIMITS.traceTtlDays * 24 * 60 * 60 * 1000);
    // A retried attempt that somehow completes twice must not fail on the unique run_id.
    await db
      .insert(schema.runTraces)
      .values({ runId: trace.runId, trace, bytes, expiresAt })
      .onConflictDoNothing({ target: schema.runTraces.runId });
    return bytes;
  };
}

/** Removes traces past their expiry. Returns how many rows went. */
export function deleteExpiredTraces(db: Db) {
  return async (now = new Date()): Promise<number> => {
    const rows = await db
      .delete(schema.runTraces)
      .where(lt(schema.runTraces.expiresAt, now))
      .returning({ id: schema.runTraces.id });
    return rows.length;
  };
}
