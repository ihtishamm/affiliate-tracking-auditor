import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Tables arrive one module at a time (PROJECT_CONTEXT §6). Every table here is append-only:
// rows are inserted, never updated or deleted (§11). Planned for later modules:
//   M4: runs, run_traces (the one table with a 7-day TTL, §8)
//   M5: check_results     M7: reconciliations     M8: funnels, funnel_scores, alerts

/**
 * Every S2S postback POST /api/postback accepted. `postback_id` is unique: the receiver relies
 * on the database, not on a check-then-insert, to make a replayed postback a no-op. Two
 * identical requests 5 ms apart both pass an application-level "have I seen this?" check; only
 * one of them can win the unique index.
 */
export const postbackEvents = pgTable(
  'postback_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postbackId: text('postback_id').notNull(),
    clickId: text('click_id').notNull(),
    orderId: text('order_id').notNull(),
    status: text('status').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Demo only: break-it toggles that were on the order, for correlating sabotage runs. */
    breakToggles: text('break_toggles'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('postback_events_postback_id_idx').on(t.postbackId)],
);

/**
 * Every Shopify webhook delivery accepted. Shopify retries deliveries and a retry carries the
 * same X-Shopify-Event-Id, hence the unique index. Deliberately NO customer fields: the payload
 * contains the buyer's email, name and address, and none of that is needed after the
 * conversion sender has hashed the email in memory (§8). What is kept is the order identity and
 * the attribution attributes the auditor cares about.
 */
export const shopifyWebhookEvents = pgTable(
  'shopify_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: text('event_id').notNull(),
    topic: text('topic').notNull(),
    shopDomain: text('shop_domain').notNull(),
    orderId: text('order_id').notNull(),
    orderName: text('order_name').notNull(),
    totalPrice: numeric('total_price', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** click_id, utm_*, fbclid, __break as found in note_attributes. Nothing else. */
    attribution: jsonb('attribution').$type<Record<string, string>>().notNull(),
    orderCreatedAt: timestamp('order_created_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('shopify_webhook_events_event_id_idx').on(t.eventId)],
);

/**
 * Every attempt the conversion sender makes, success or failure, one row per try. This is the
 * server-side evidence the check engine reads for "CAPI dedup match" (6) and "postback fired,
 * retries on non-200" (8): S2S traffic is invisible to the browser, so the sender writes down
 * what it did.
 */
export const conversionAttempts = pgTable('conversion_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: text('order_id').notNull(),
  /** 'capi' | 'postback' */
  kind: text('kind').notNull(),
  attempt: integer('attempt').notNull(),
  /** The event_id (CAPI) or postback_id (postback) that was sent. */
  eventId: text('event_id').notNull(),
  /** Host only, never the full URL: the CAPI URL would otherwise carry the pixel ID; fine, but keep it boring. */
  targetHost: text('target_host').notNull(),
  statusCode: integer('status_code'),
  ok: boolean('ok').notNull(),
  error: text('error'),
  /** CAPI only: whether user_data was hashed. False only under the `unhashed_email` sabotage. */
  piiHashed: boolean('pii_hashed'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
});
