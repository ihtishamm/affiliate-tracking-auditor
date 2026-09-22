import {
  boolean,
  index,
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

// ---- M4: runs ------------------------------------------------------------------------------------
//
// A run's lifecycle is queued → running → succeeded | failed | timed_out, and "append-only"
// (§5, §11) is taken literally: `runs` is the immutable submission, `run_events` is the log of
// status transitions, and the current status is the latest event. Nothing is ever UPDATEd, so
// the history of a run — including the retries BullMQ made — is always readable. The one
// exception in the whole schema is `run_traces`, which §8 requires to expire after 7 days.

/** One row per accepted submission. `idempotency_key` comes from the form; a double-click loses the unique-index race and gets the same run. */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The submitted URL after redactUrl(): PII-looking query values are already gone. */
    url: text('url').notNull(),
    urlHost: text('url_host').notNull(),
    clickIdParam: text('click_id_param').notNull(),
    /** M8: set when the run was made for a saved funnel (scheduled or "run now"). */
    funnelId: uuid('funnel_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('runs_idempotency_key_idx').on(t.idempotencyKey)],
);

/** Status transitions, appended by the web app (queued) and the worker (everything else). */
export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    /** 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' — see RUN_STATUSES. */
    status: text('status').notNull(),
    /** BullMQ attempt number (1-based); 0 for the submission itself. */
    attempt: integer('attempt').notNull(),
    /** Free-form, small: stop reason, error message, worker version, duration. Never trace data. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('run_events_run_id_created_at_idx').on(t.runId, t.createdAt)],
);

/**
 * The run artifact: a RunTrace (packages/shared/src/run.ts), redacted before it got here.
 * Deleted by the worker's cleanup once `expires_at` passes — the only DELETE in the system.
 */
export const runTraces = pgTable(
  'run_traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    trace: jsonb('trace').notNull(),
    bytes: integer('bytes').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('run_traces_run_id_idx').on(t.runId),
    index('run_traces_expires_at_idx').on(t.expiresAt),
  ],
);

// ---- M8: saved funnels, score history, alerts ----------------------------------------------------

/** A funnel someone asked to be audited daily. Immutable; deleting is out of scope (append-only). */
export const funnels = pgTable('funnels', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull(),
  urlHost: text('url_host').notNull(),
  clickIdParam: text('click_id_param').notNull(),
  label: text('label').notNull(),
  /** The one host where a run of this funnel may complete a purchase; null = observe only. */
  purchaseHost: text('purchase_host'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per scored run of a saved funnel: the report frozen at scoring time. The live report
 * page still computes on read; history needs values that do not change under it.
 */
export const funnelScores = pgTable(
  'funnel_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    funnelId: uuid('funnel_id')
      .notNull()
      .references(() => funnels.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    /** 0–1, or null when nothing was decidable. */
    score: numeric('score', { precision: 5, scale: 4 }),
    /** check id → 'pass' | 'fail' | 'inconclusive' */
    statuses: jsonb('statuses').$type<Record<string, string>>().notNull(),
    counts: jsonb('counts').$type<{ pass: number; fail: number; inconclusive: number }>().notNull(),
    scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('funnel_scores_run_id_idx').on(t.runId),
    index('funnel_scores_funnel_id_idx').on(t.funnelId, t.scoredAt),
  ],
);

/**
 * Exactly one alert per (funnel, run): the unique index is what makes "exactly one" true even
 * if scoring is retried. The webhook is sent only by the insert that wins.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    funnelId: uuid('funnel_id')
      .notNull()
      .references(() => funnels.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    previousScore: numeric('previous_score', { precision: 5, scale: 4 }),
    score: numeric('score', { precision: 5, scale: 4 }),
    /** Why it fired: score drop and/or the checks that flipped pass → fail. */
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    /** HTTP status of the webhook delivery, or null when no webhook is configured. */
    deliveryStatus: integer('delivery_status'),
    deliveryError: text('delivery_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('alerts_funnel_run_idx').on(t.funnelId, t.runId)],
);
