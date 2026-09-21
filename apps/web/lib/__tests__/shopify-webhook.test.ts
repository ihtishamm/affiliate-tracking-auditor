import { describe, expect, it } from 'vitest';
import { createLogger, signBase64 } from '@auditor/shared';
import { receiveShopifyOrder, type WebhookHeaders, type WebhookRow } from '../shopify-webhook.ts';

const secret = 'unit-test-shopify-key-not-a-real-secret';
const log = createLogger({ service: 'test', level: 'error', write: () => {} });

// The shape Shopify actually sends, reduced to the fields that matter plus some it also sends.
const order = {
  id: 5592397545769,
  admin_graphql_api_id: 'gid://shopify/Order/5592397545769',
  name: '#1004',
  total_price: '1025.00',
  currency: 'USD',
  created_at: '2026-09-19T13:35:12-04:00',
  email: 'Buyer@Example.com',
  phone: null,
  customer: { id: 1, first_name: 'first', last_name: 'first' },
  shipping_address: { phone: '+1 555 010 0000', city: 'Seattle' },
  note_attributes: [
    { name: 'click_id', value: 'test-003' },
    { name: 'utm_source', value: 'affiliate' },
    { name: '__break', value: 'postback_500' },
    { name: 'gift_note', value: 'happy birthday' },
  ],
};
const body = JSON.stringify(order);

function headers(overrides: Partial<WebhookHeaders> = {}): WebhookHeaders {
  return {
    hmac: signBase64(secret, body),
    eventId: 'evt-1',
    webhookId: 'wh-1',
    topic: 'orders/create',
    shopDomain: 'auditor-demo.myshopify.com',
    ...overrides,
  };
}

function memoryStore() {
  const seen = new Set<string>();
  const inserted: WebhookRow[] = [];
  return {
    inserted,
    insert: async (row: WebhookRow) => {
      if (seen.has(row.eventId)) return false;
      seen.add(row.eventId);
      inserted.push(row);
      return true;
    },
  };
}

describe('receiveShopifyOrder', () => {
  it('accepts a signed delivery, returns the parsed order, keeps only attribution attributes', async () => {
    const store = memoryStore();
    const out = await receiveShopifyOrder(body, headers(), { secret, insert: store.insert, log });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ status: 'accepted', event_id: 'evt-1' });
    const parsed = out.status === 200 ? out.order : undefined;
    expect(parsed?.attribution).toEqual({
      click_id: 'test-003',
      utm_source: 'affiliate',
      __break: 'postback_500',
    });
    expect(parsed?.breakToggles).toEqual(['postback_500']);
    expect(parsed?.phone).toBe('+1 555 010 0000'); // falls back to shipping_address.phone
    // What gets stored carries no customer fields at all.
    const stored = JSON.stringify(store.inserted[0]);
    expect(stored).not.toMatch(/Buyer@Example|Seattle|happy birthday/);
  });

  it("records the auditor's own run prefix from its synthetic checkout email, and nothing else from it", async () => {
    const store = memoryStore();
    const sample = JSON.stringify({
      ...order,
      email: 'audit-1a2b3c4d@example.com',
      note_attributes: [],
    });
    const out = await receiveShopifyOrder(sample, headers({ hmac: signBase64(secret, sample) }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(200);
    expect(store.inserted[0]?.order.attribution).toEqual({ __audit_run: '1a2b3c4d' });
    expect(JSON.stringify(store.inserted[0])).not.toMatch(/@example\.com/);
    // A real customer's email leaves no trace at all.
    const real = JSON.stringify({ ...order, email: 'jane@example.org', note_attributes: [] });
    await receiveShopifyOrder(real, headers({ hmac: signBase64(secret, real), eventId: 'evt-2' }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(store.inserted[1]?.order.attribution).toEqual({});
  });

  it('REPLAY: a redelivery with the same X-Shopify-Event-Id is 200 duplicate and returns no order to act on', async () => {
    const store = memoryStore();
    await receiveShopifyOrder(body, headers(), { secret, insert: store.insert, log });
    const again = await receiveShopifyOrder(body, headers(), { secret, insert: store.insert, log });
    expect(again.body).toEqual({ status: 'duplicate', event_id: 'evt-1' });
    expect(again.status === 200 && again.order).toBeFalsy();
    expect(store.inserted).toHaveLength(1);
  });

  it('TAMPER: an altered body, a wrong secret, or no header is 401 and nothing is stored', async () => {
    const store = memoryStore();
    const altered = body.replace('"1025.00"', '"1.00"');
    const cases = [
      receiveShopifyOrder(altered, headers(), { secret, insert: store.insert, log }),
      receiveShopifyOrder(body, headers({ hmac: signBase64('other', body) }), {
        secret,
        insert: store.insert,
        log,
      }),
      receiveShopifyOrder(body, headers({ hmac: null }), { secret, insert: store.insert, log }),
    ];
    for (const out of await Promise.all(cases)) expect(out.status).toBe(401);
    expect(store.inserted).toHaveLength(0);
  });

  it('falls back to X-Shopify-Webhook-Id, then to the order id, for deduplication', async () => {
    const store = memoryStore();
    const a = await receiveShopifyOrder(body, headers({ eventId: null }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(a.body).toMatchObject({ event_id: 'wh-1' });
    const b = await receiveShopifyOrder(body, headers({ eventId: null, webhookId: null }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(b.body).toMatchObject({ event_id: 'order-5592397545769' });
  });

  it('a signed body missing required fields is 400', async () => {
    const store = memoryStore();
    const bad = JSON.stringify({ id: 'not-a-number', name: '#1' });
    const out = await receiveShopifyOrder(bad, headers({ hmac: signBase64(secret, bad) }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(400);
    expect(store.inserted).toHaveLength(0);
  });

  // Shopify's "Send test notification" order. Its id is above 2^53-1, so JSON.parse has
  // already rounded the number to ...500 by the time anything can look at it; only the gid
  // still holds the real digits. This exact payload was rejected in production before the fix.
  it('reads an int64 order id from admin_graphql_api_id, not from the rounded number', async () => {
    const store = memoryStore();
    const sample = JSON.stringify({
      ...order,
      id: 820982911946154508,
      admin_graphql_api_id: 'gid://shopify/Order/820982911946154508',
      name: '#9999',
    });
    expect(String(JSON.parse(sample).id)).toBe('820982911946154500'); // sanity: already rounded
    const out = await receiveShopifyOrder(sample, headers({ hmac: signBase64(secret, sample) }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(200);
    expect(store.inserted[0]?.order.id).toBe('820982911946154508');
  });

  it('rejects an int64 order id when no gid is present, rather than storing a rounded one', async () => {
    const store = memoryStore();
    const { admin_graphql_api_id: _omit, ...rest } = order;
    const sample = JSON.stringify({ ...rest, id: 820982911946154508 });
    const out = await receiveShopifyOrder(sample, headers({ hmac: signBase64(secret, sample) }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(400);
    expect(out.status === 400 && out.body.issues[0]).toMatch(/2\^53/);
    expect(store.inserted).toHaveLength(0);
  });

  it('still accepts a safe-integer id without a gid', async () => {
    const store = memoryStore();
    const { admin_graphql_api_id: _omit, ...rest } = order;
    const sample = JSON.stringify(rest);
    const out = await receiveShopifyOrder(sample, headers({ hmac: signBase64(secret, sample) }), {
      secret,
      insert: store.insert,
      log,
    });
    expect(out.status).toBe(200);
    expect(store.inserted[0]?.order.id).toBe('5592397545769');
  });
});
