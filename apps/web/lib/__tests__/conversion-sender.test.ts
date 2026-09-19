import { describe, expect, it } from 'vitest';
import { createLogger, hashEmail, verifyHex } from '@auditor/shared';
import { sendConversions, type ConversionAttempt } from '../conversion-sender.ts';
import type { ParsedOrder } from '../shopify-webhook.ts';

const log = createLogger({ service: 'test', level: 'error', write: () => {} });
const postbackSecret = 'unit-test-postback-key-not-a-real-secret';

function order(overrides: Partial<ParsedOrder> = {}): ParsedOrder {
  return {
    id: '5592397545769',
    name: '#1004',
    totalPrice: '1025.00',
    currency: 'USD',
    createdAt: new Date('2026-09-19T17:35:12Z'),
    email: ' Buyer@Example.com',
    phone: '+1 555 010 0000',
    attribution: { click_id: 'test-003', utm_source: 'affiliate' },
    breakToggles: [],
    ...overrides,
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake network: scripted status codes per host, and a log of everything sent. */
function harness(statuses: { capi?: number[]; postback?: number[] } = {}) {
  const sent: Sent[] = [];
  const attempts: ConversionAttempt[] = [];
  const queue = {
    capi: [...(statuses.capi ?? [200])],
    postback: [...(statuses.postback ?? [200])],
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: String(init?.body),
    });
    const kind = url.includes('graph.facebook.com') ? 'capi' : 'postback';
    const status = queue[kind].shift() ?? 200;
    return new Response(status >= 400 ? '{"error":"scripted"}' : '{"ok":true}', { status });
  }) as unknown as typeof fetch;
  const deps = {
    fetch: fetchFn,
    record: async (a: ConversionAttempt) => {
      attempts.push(a);
    },
    sleep: async () => {},
    log,
    meta: { pixelId: '123456789012345', capiToken: 'tok', testEventCode: 'TEST1' },
    postback: { url: 'https://auditor.example/api/postback', secret: postbackSecret },
    storeDomain: 'auditor-demo.myshopify.com',
  };
  return { sent, attempts, deps };
}

describe('sendConversions', () => {
  it('sends a CAPI Purchase with event_id derived from the order and hashed, normalised PII', async () => {
    const h = harness();
    await sendConversions(order(), h.deps);
    const capi = h.sent.find((s) => s.url.includes('graph.facebook.com'));
    expect(capi?.url).toBe('https://graph.facebook.com/v22.0/123456789012345/events');
    const body = JSON.parse(capi!.body);
    const ev = body.data[0];
    expect(ev.event_name).toBe('Purchase');
    expect(ev.event_id).toBe('purchase-5592397545769'); // same as the checkout pixel derives
    expect(ev.user_data.em).toEqual([hashEmail('buyer@example.com')]);
    expect(ev.user_data.ph[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(capi!.body).not.toMatch(/Buyer@Example|555 010/); // plaintext never leaves
    expect(ev.custom_data).toMatchObject({
      currency: 'USD',
      value: 1025,
      order_id: '5592397545769',
      click_id: 'test-003',
    });
    expect(body.test_event_code).toBe('TEST1');
    expect(body.access_token).toBe('tok');
  });

  it('sends a signed postback whose postback_id is derived from the order, verifiable over the exact bytes', async () => {
    const h = harness();
    await sendConversions(order(), h.deps);
    const pb = h.sent.find((s) => s.url.endsWith('/api/postback'))!;
    const payload = JSON.parse(pb.body);
    expect(payload.postback_id).toBe('pb-5592397545769');
    expect(payload).toMatchObject({
      click_id: 'test-003',
      order_id: '5592397545769',
      status: 'approved',
      amount: 1025,
      currency: 'USD',
    });
    expect(verifyHex(postbackSecret, pb.body, pb.headers['x-postback-signature'])).toBe(true);
  });

  it('records one attempt per send on success', async () => {
    const h = harness();
    await sendConversions(order(), h.deps);
    expect(h.attempts.map((a) => [a.kind, a.attempt, a.ok, a.statusCode])).toEqual([
      ['capi', 1, true, 200],
      ['postback', 1, true, 200],
    ]);
    expect(h.attempts.find((a) => a.kind === 'capi')?.piiHashed).toBe(true);
  });

  it('retries a failing postback three times, recording each attempt (postback_500 sabotage)', async () => {
    const h = harness({ postback: [500, 500, 500] });
    await sendConversions(
      order({
        breakToggles: ['postback_500'],
        attribution: { click_id: 'x', __break: 'postback_500' },
      }),
      h.deps,
    );
    const pb = h.attempts.filter((a) => a.kind === 'postback');
    expect(pb.map((a) => [a.attempt, a.ok, a.statusCode])).toEqual([
      [1, false, 500],
      [2, false, 500],
      [3, false, 500],
    ]);
    expect(JSON.parse(h.sent.filter((s) => s.url.endsWith('/api/postback'))[0]!.body).__break).toBe(
      'postback_500',
    );
  });

  it('stops retrying once an attempt succeeds', async () => {
    const h = harness({ capi: [503, 200] });
    await sendConversions(order(), h.deps);
    const capi = h.attempts.filter((a) => a.kind === 'capi');
    expect(capi.map((a) => [a.attempt, a.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('capi_mismatch sabotage: a random event_id that cannot match the browser purchase', async () => {
    const h = harness();
    await sendConversions(order({ breakToggles: ['capi_mismatch'] }), h.deps);
    const ev = JSON.parse(h.sent.find((s) => s.url.includes('graph.facebook.com'))!.body).data[0];
    expect(ev.event_id).not.toBe('purchase-5592397545769');
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unhashed_email sabotage: normalised plaintext em/ph, recorded as pii_hashed=false', async () => {
    const h = harness();
    await sendConversions(order({ breakToggles: ['unhashed_email'] }), h.deps);
    const ev = JSON.parse(h.sent.find((s) => s.url.includes('graph.facebook.com'))!.body).data[0];
    expect(ev.user_data.em).toEqual(['buyer@example.com']);
    expect(ev.user_data.ph).toEqual(['15550100000']);
    expect(h.attempts.find((a) => a.kind === 'capi')?.piiHashed).toBe(false);
  });

  it('an order with no click_id sends no postback and records why', async () => {
    const h = harness();
    await sendConversions(order({ attribution: {} }), h.deps);
    expect(h.sent.some((s) => s.url.endsWith('/api/postback'))).toBe(false);
    const pb = h.attempts.find((a) => a.kind === 'postback');
    expect(pb).toMatchObject({
      ok: false,
      statusCode: null,
      error: 'no click_id on order',
      eventId: 'pb-5592397545769',
    });
  });

  it('a network error is recorded as a failed attempt and retried', async () => {
    const h = harness();
    let calls = 0;
    h.deps.fetch = (async (input: string | URL | Request) => {
      calls++;
      if (String(input).includes('graph.facebook.com')) throw new Error('ECONNRESET');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await sendConversions(order(), h.deps);
    const capi = h.attempts.filter((a) => a.kind === 'capi');
    expect(capi).toHaveLength(3);
    expect(capi.every((a) => !a.ok && a.error === 'ECONNRESET')).toBe(true);
    expect(calls).toBe(4); // 3 capi + 1 postback
  });
});
