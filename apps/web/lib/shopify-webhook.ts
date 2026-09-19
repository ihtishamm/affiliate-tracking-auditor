import { z } from 'zod';
import {
  ATTRIBUTION_PARAMS,
  BREAK_PARAM,
  parseBreakToggles,
  verifyBase64,
  type BreakToggle,
  type Logger,
} from '@auditor/shared';

// The decision core of the Shopify orders/create webhook, free of Next and of the database.
//
// Shopify signs the raw body with the webhook's secret (base64 HMAC-SHA256 in
// X-Shopify-Hmac-Sha256) and retries undelivered webhooks; a retry carries the same
// X-Shopify-Event-Id. So: verify the raw bytes first, then let the unique index on event_id
// decide whether this delivery is new. Shopify expects a 2xx within a few seconds, which is why
// the route hands the accepted order to the conversion sender to run AFTER the response.

export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256';
export const SHOPIFY_EVENT_ID_HEADER = 'x-shopify-event-id';
export const SHOPIFY_WEBHOOK_ID_HEADER = 'x-shopify-webhook-id';
export const SHOPIFY_TOPIC_HEADER = 'x-shopify-topic';
export const SHOPIFY_SHOP_DOMAIN_HEADER = 'x-shopify-shop-domain';

// Only the fields we use. Everything else in the payload (customer, addresses, line items) is
// parsed past and forgotten. `email` and `phone` are read for hashing and never stored.
const orderWebhookSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  total_price: z.string(),
  currency: z.string(),
  created_at: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  shipping_address: z.object({ phone: z.string().nullable().optional() }).nullable().optional(),
  note_attributes: z
    .array(z.object({ name: z.string(), value: z.string().nullable() }))
    .default([]),
});

/** The part of an order that may be persisted: identity, money, attribution. No customer fields. */
export interface StoredOrder {
  id: number;
  name: string;
  totalPrice: string;
  currency: string;
  createdAt: Date;
  attribution: Record<string, string>;
}

/**
 * What the sender receives. `email`/`phone` exist only for the in-memory hashing step; the
 * type given to storage (`StoredOrder`) cannot carry them, so no writer can persist them by
 * accident.
 */
export interface ParsedOrder extends StoredOrder {
  email: string | null;
  phone: string | null;
  breakToggles: BreakToggle[];
}

export interface WebhookRow {
  eventId: string;
  topic: string;
  shopDomain: string;
  order: StoredOrder;
}

export type WebhookOutcome =
  | { status: 401; body: { error: 'invalid_signature' } }
  | { status: 400; body: { error: 'invalid_payload'; issues: string[] } }
  | {
      status: 200;
      body: { status: 'accepted' | 'duplicate'; event_id: string };
      order?: ParsedOrder;
    };

export interface WebhookHeaders {
  hmac: string | null;
  eventId: string | null;
  webhookId: string | null;
  topic: string | null;
  shopDomain: string | null;
}

export interface WebhookReceiverDeps {
  secret: string;
  /** Appends the delivery. Resolves false when `eventId` already exists. */
  insert: (row: WebhookRow) => Promise<boolean>;
  log: Logger;
}

export async function receiveShopifyOrder(
  rawBody: string,
  headers: WebhookHeaders,
  deps: WebhookReceiverDeps,
): Promise<WebhookOutcome> {
  if (!verifyBase64(deps.secret, rawBody, headers.hmac)) {
    deps.log.warn('shopify webhook rejected: invalid signature', {
      topic: headers.topic,
      bytes: rawBody.length,
    });
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid_payload', issues: ['body is not JSON'] } };
  }
  const parsed = orderWebhookSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    deps.log.warn('shopify webhook rejected: schema', { issues });
    return { status: 400, body: { error: 'invalid_payload', issues } };
  }
  const o = parsed.data;

  // Shopify documents X-Shopify-Event-Id as the deduplication key; older deliveries may only
  // carry X-Shopify-Webhook-Id, and as a last resort the order ID itself makes a redelivery of
  // the same order a duplicate rather than a double.
  const eventId = headers.eventId ?? headers.webhookId ?? `order-${o.id}`;

  const attribution: Record<string, string> = {};
  for (const attr of o.note_attributes) {
    if (!attr.value) continue;
    if (
      (ATTRIBUTION_PARAMS as readonly string[]).includes(attr.name) ||
      attr.name === BREAK_PARAM
    ) {
      attribution[attr.name] = attr.value;
    }
  }

  const stored: StoredOrder = {
    id: o.id,
    name: o.name,
    totalPrice: o.total_price,
    currency: o.currency,
    createdAt: new Date(o.created_at),
    attribution,
  };
  const order: ParsedOrder = {
    ...stored,
    email: o.email ?? null,
    phone: o.phone ?? o.shipping_address?.phone ?? null,
    breakToggles: parseBreakToggles(attribution[BREAK_PARAM]),
  };

  const inserted = await deps.insert({
    eventId,
    topic: headers.topic ?? 'orders/create',
    shopDomain: headers.shopDomain ?? '',
    order: stored,
  });
  deps.log.info(inserted ? 'shopify webhook accepted' : 'shopify webhook duplicate ignored', {
    event_id: eventId,
    order_id: o.id,
    order_name: o.name,
    toggles: order.breakToggles,
  });

  return inserted
    ? { status: 200, body: { status: 'accepted', event_id: eventId }, order }
    : { status: 200, body: { status: 'duplicate', event_id: eventId } };
}
