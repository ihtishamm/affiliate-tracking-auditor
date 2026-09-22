import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import * as schema from './schema.ts';

// Writers and readers both apps need (M8 moved them here from the web app so the worker can
// schedule and score runs with the same code). All writers are append-only; the two that
// return a boolean rely on a unique index to decide who won a race, never on a prior SELECT.

export interface NewRun {
  idempotencyKey: string;
  url: string;
  urlHost: string;
  clickIdParam: string;
  funnelId?: string | null;
}

/** Returns the run id and whether this call created it; a repeat of the key reads the earlier row. */
export async function insertRun(db: Db, run: NewRun): Promise<{ id: string; created: boolean }> {
  const rows = await db
    .insert(schema.runs)
    .values({ ...run, funnelId: run.funnelId ?? null })
    .onConflictDoNothing({ target: schema.runs.idempotencyKey })
    .returning({ id: schema.runs.id });
  const won = rows[0];
  if (won) return { id: won.id, created: true };
  const existing = await db.query.runs.findFirst({
    where: eq(schema.runs.idempotencyKey, run.idempotencyKey),
    columns: { id: true },
  });
  if (!existing) throw new Error('run insert lost the race but the winner is not visible');
  return { id: existing.id, created: false };
}

export async function appendRunEvent(
  db: Db,
  runId: string,
  status: string,
  attempt: number,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.runEvents).values({ runId, status, attempt, detail });
}

/** Structurally the check engine's `ServerEvents`; defined here so this package stays free of the checks package. */
export interface ServerRows {
  order: { id: string; name: string; attribution: Record<string, string> } | null;
  conversionAttempts: Array<{
    kind: 'capi' | 'postback';
    attempt: number;
    eventId: string;
    statusCode: number | null;
    ok: boolean;
    error: string | null;
    piiHashed: boolean | null;
  }>;
  postbackEvents: Array<{ postbackId: string; clickId: string; orderId: string; status: string }>;
}

/** The M3 rows for one order — what the server-side checks (6, 8, half of 9) decide from. */
export async function loadServerEvents(db: Db, orderId: string): Promise<ServerRows> {
  const [order, attempts, postbacks] = await Promise.all([
    db.query.shopifyWebhookEvents.findFirst({
      where: eq(schema.shopifyWebhookEvents.orderId, orderId),
    }),
    db.query.conversionAttempts.findMany({ where: eq(schema.conversionAttempts.orderId, orderId) }),
    db.query.postbackEvents.findMany({ where: eq(schema.postbackEvents.orderId, orderId) }),
  ]);
  return {
    order: order
      ? { id: order.orderId, name: order.orderName, attribution: order.attribution }
      : null,
    conversionAttempts: attempts
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .map((a) => ({
        kind: a.kind === 'capi' ? 'capi' : 'postback',
        attempt: a.attempt,
        eventId: a.eventId,
        statusCode: a.statusCode,
        ok: a.ok,
        error: a.error,
        piiHashed: a.piiHashed,
      })),
    postbackEvents: postbacks.map((p) => ({
      postbackId: p.postbackId,
      clickId: p.clickId,
      orderId: p.orderId,
      status: p.status,
    })),
  };
}

// ---- M8 --------------------------------------------------------------------------------------------

export async function listFunnels(db: Db) {
  return db.query.funnels.findMany({ orderBy: [desc(schema.funnels.createdAt)] });
}

/** How many funnels are saved; the cap on the daily schedule's total work (RUN_LIMITS.maxSavedFunnels). */
export async function countFunnels(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.funnels);
  return row?.n ?? 0;
}

export async function getFunnel(db: Db, id: string) {
  return db.query.funnels.findFirst({ where: eq(schema.funnels.id, id) });
}

export async function insertFunnel(
  db: Db,
  funnel: {
    url: string;
    urlHost: string;
    clickIdParam: string;
    label: string;
    purchaseHost: string | null;
  },
): Promise<string> {
  const [row] = await db.insert(schema.funnels).values(funnel).returning({ id: schema.funnels.id });
  if (!row) throw new Error('funnel insert returned no row');
  return row.id;
}

export interface ScoreRow {
  runId: string;
  score: number | null;
  statuses: Record<string, string>;
  counts: { pass: number; fail: number; inconclusive: number };
  scoredAt: Date;
}

export async function listScores(db: Db, funnelId: string, limit = 60): Promise<ScoreRow[]> {
  const rows = await db.query.funnelScores.findMany({
    where: eq(schema.funnelScores.funnelId, funnelId),
    orderBy: [desc(schema.funnelScores.scoredAt)],
    limit,
  });
  return rows.map((r) => ({
    runId: r.runId,
    score: r.score === null ? null : Number(r.score),
    statuses: r.statuses,
    counts: r.counts,
    scoredAt: r.scoredAt,
  }));
}

/**
 * The most recent SCORED run before `runId`: the baseline an alert compares against. Runs
 * without a score (too little decided — an outage, a funnel that never loaded) are skipped,
 * or a regression right after one would be compared against a run that decided nothing.
 */
export async function previousScore(
  db: Db,
  funnelId: string,
  runId: string,
): Promise<ScoreRow | null> {
  const rows = await db.query.funnelScores.findMany({
    where: and(
      eq(schema.funnelScores.funnelId, funnelId),
      sql`${schema.funnelScores.runId} <> ${runId}`,
      sql`${schema.funnelScores.score} is not null`,
    ),
    orderBy: [desc(schema.funnelScores.scoredAt)],
    limit: 1,
  });
  const r = rows[0];
  return r
    ? {
        runId: r.runId,
        score: r.score === null ? null : Number(r.score),
        statuses: r.statuses,
        counts: r.counts,
        scoredAt: r.scoredAt,
      }
    : null;
}

/** Appends the frozen report; a retry of the same run is a no-op (unique run_id). Resolves true when this call wrote it. */
export async function insertScore(
  db: Db,
  row: {
    funnelId: string;
    runId: string;
    score: number | null;
    statuses: Record<string, string>;
    counts: ScoreRow['counts'];
  },
): Promise<boolean> {
  const rows = await db
    .insert(schema.funnelScores)
    .values({ ...row, score: row.score === null ? null : row.score.toFixed(4) })
    .onConflictDoNothing({ target: schema.funnelScores.runId })
    .returning({ id: schema.funnelScores.id });
  return rows.length === 1;
}

/** Records the alert; resolves the new row's id, or null when one already exists for this (funnel, run). */
export async function insertAlert(
  db: Db,
  row: {
    funnelId: string;
    runId: string;
    previousScore: number | null;
    score: number | null;
    reasons: string[];
  },
): Promise<string | null> {
  const rows = await db
    .insert(schema.alerts)
    .values({
      ...row,
      previousScore: row.previousScore === null ? null : row.previousScore.toFixed(4),
      score: row.score === null ? null : row.score.toFixed(4),
    })
    .onConflictDoNothing({ target: [schema.alerts.funnelId, schema.alerts.runId] })
    .returning({ id: schema.alerts.id });
  return rows[0]?.id ?? null;
}

export async function recordAlertDelivery(
  db: Db,
  alertId: string,
  delivery: { status: number | null; error: string | null },
): Promise<void> {
  // The single UPDATE in the schema. The alert row must be claimed BEFORE the webhook is sent
  // (the unique index is what makes "exactly one alert" true under retries), so the delivery
  // outcome can only be written afterwards, onto the row it belongs to.
  await db
    .update(schema.alerts)
    .set({ deliveryStatus: delivery.status, deliveryError: delivery.error })
    .where(eq(schema.alerts.id, alertId));
}

export async function listAlerts(db: Db, funnelId: string, limit = 20) {
  return db.query.alerts.findMany({
    where: eq(schema.alerts.funnelId, funnelId),
    orderBy: [desc(schema.alerts.createdAt)],
    limit,
  });
}

export async function runsForFunnel(db: Db, funnelId: string, limit = 30) {
  return db.query.runs.findMany({
    where: eq(schema.runs.funnelId, funnelId),
    orderBy: [desc(schema.runs.createdAt)],
    limit,
  });
}
