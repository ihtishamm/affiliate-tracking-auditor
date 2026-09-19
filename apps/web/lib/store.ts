import { schema, type Db } from '@auditor/db';
import type { PostbackPayload } from '@auditor/shared';
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
        orderId: String(row.order.id),
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
