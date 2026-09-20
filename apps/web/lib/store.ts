import { desc, eq, schema, type Db } from '@auditor/db';
import type { PostbackPayload, RunStatus, RunTrace } from '@auditor/shared';
import type { ConversionAttempt } from './conversion-sender.ts';
import type { WebhookRow } from './shopify-webhook.ts';

// Append-only writers. The two `insert…` functions return false on a unique-index conflict:
// `ON CONFLICT DO NOTHING RETURNING id` yields a row for exactly one of any set of concurrent
// identical inserts, so "did I win?" is answered by Postgres, not by a prior SELECT.

export function insertPostbackEvent(db: Db) {
  return async (p: PostbackPayload): Promise<boolean> => {
    const rows = await db
      .insert(schema.postbackEvents)
      .values({
        postbackId: p.postback_id,
        clickId: p.click_id,
        orderId: p.order_id,
        status: p.status,
        amount: p.amount.toFixed(2),
        currency: p.currency,
        occurredAt: new Date(p.occurred_at),
        breakToggles: p.__break ?? null,
      })
      .onConflictDoNothing({ target: schema.postbackEvents.postbackId })
      .returning({ id: schema.postbackEvents.id });
    return rows.length === 1;
  };
}

export function insertShopifyWebhookEvent(db: Db) {
  return async (row: WebhookRow): Promise<boolean> => {
    const rows = await db
      .insert(schema.shopifyWebhookEvents)
      .values({
        eventId: row.eventId,
        topic: row.topic,
        shopDomain: row.shopDomain,
        orderId: row.order.id,
        orderName: row.order.name,
        totalPrice: row.order.totalPrice,
        currency: row.order.currency,
        attribution: row.order.attribution,
        orderCreatedAt: row.order.createdAt,
      })
      .onConflictDoNothing({ target: schema.shopifyWebhookEvents.eventId })
      .returning({ id: schema.shopifyWebhookEvents.id });
    return rows.length === 1;
  };
}

export function recordConversionAttempt(db: Db) {
  return async (a: ConversionAttempt): Promise<void> => {
    await db.insert(schema.conversionAttempts).values({
      orderId: a.orderId,
      kind: a.kind,
      attempt: a.attempt,
      eventId: a.eventId,
      targetHost: a.targetHost,
      statusCode: a.statusCode,
      ok: a.ok,
      error: a.error,
      piiHashed: a.piiHashed,
    });
  };
}

// ---- M4: runs --------------------------------------------------------------------------------

/** Returns the run id and whether this call created it. A repeat of the key wins nothing and reads the earlier row. */
export function insertRun(db: Db) {
  return async (run: {
    idempotencyKey: string;
    url: string;
    urlHost: string;
    clickIdParam: string;
  }): Promise<{ id: string; created: boolean }> => {
    const rows = await db
      .insert(schema.runs)
      .values(run)
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
  };
}

export function appendRunEvent(db: Db) {
  return async (
    runId: string,
    status: RunStatus,
    detail: Record<string, unknown>,
    attempt = 0,
  ): Promise<void> => {
    await db.insert(schema.runEvents).values({ runId, status, attempt, detail });
  };
}

export interface RunView {
  id: string;
  url: string;
  urlHost: string;
  clickIdParam: string;
  createdAt: Date;
  status: RunStatus;
  events: Array<{ status: RunStatus; attempt: number; detail: Record<string, unknown>; at: Date }>;
  trace: RunTrace | null;
}

/** The run with its status derived from the latest event, plus the trace when one exists. */
export async function getRun(
  db: Db,
  id: string,
  opts: { trace: boolean },
): Promise<RunView | null> {
  const run = await db.query.runs.findFirst({ where: eq(schema.runs.id, id) });
  if (!run) return null;
  const events = await db.query.runEvents.findMany({
    where: eq(schema.runEvents.runId, id),
    orderBy: [desc(schema.runEvents.createdAt)],
  });
  const latest = events[0];
  let trace: RunTrace | null = null;
  if (opts.trace) {
    const row = await db.query.runTraces.findFirst({ where: eq(schema.runTraces.runId, id) });
    trace = (row?.trace as RunTrace | undefined) ?? null;
  }
  return {
    id: run.id,
    url: run.url,
    urlHost: run.urlHost,
    clickIdParam: run.clickIdParam,
    createdAt: run.createdAt,
    status: (latest?.status as RunStatus | undefined) ?? 'queued',
    events: events.map((e) => ({
      status: e.status as RunStatus,
      attempt: e.attempt,
      detail: e.detail,
      at: e.createdAt,
    })),
    trace,
  };
}
