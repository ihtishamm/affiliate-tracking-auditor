import { describe, expect, it } from 'vitest';
import { reconcile, type ReconcileOrder, type ReconcileSources } from '../src/reconcile.ts';

// M7 done criterion: a seeded discrepancy is identified down to the order id. Six orders,
// one per situation, and the join must name each one with the right drop-off.

const order = (id: string, name: string, attrs: Record<string, string> = {}): ReconcileOrder => ({
  id,
  name,
  createdAt: `2026-09-21T0${id.at(-1)}:00:00Z`,
  total: '24.95',
  currency: 'USD',
  attributes: attrs,
});

const orders: ReconcileOrder[] = [
  order('1001', '#1001', { click_id: 'aud-1', __audit_run: 'r1' }), // healthy, audited
  order('1002', '#1002', {}), // no click ID (drop_click_id)
  order('1003', '#1003', { click_id: 'aud-3' }), // webhook never arrived
  order('1004', '#1004', { click_id: 'aud-4', __audit_run: 'r4' }), // audited, pixel never fired
  order('1005', '#1005', { click_id: 'aud-5', __audit_run: 'r5' }), // capi missing
  order('1006', '#1006', { click_id: 'aud-6' }), // real customer: postback never accepted (postback_500)
  order('1007', '#1007', { click_id: 'aud-7' }), // real customer, everything fine, browser unknown
];

const sources: ReconcileSources = {
  webhookOrderIds: new Set(['1001', '1002', '1004', '1005', '1006', '1007']),
  auditedOrderIds: new Set(['1001', '1004', '1005']),
  pixelPurchases: new Map([
    ['1001', { runId: 'run-1', purchaseEventId: 'purchase-1001' }],
    ['1005', { runId: 'run-5', purchaseEventId: 'purchase-1005' }],
  ]),
  capiOrderIds: new Set(['1001', '1002', '1004', '1006', '1007']),
  postbacks: new Map([
    ['1001', { postbackId: 'pb-1001', clickId: 'aud-1' }],
    ['1004', { postbackId: 'pb-1004', clickId: 'aud-4' }],
    ['1005', { postbackId: 'pb-1005', clickId: 'aud-5' }],
    ['1007', { postbackId: 'pb-1007', clickId: 'aud-7' }],
  ]),
};

describe('reconcile', () => {
  const result = reconcile(orders, sources);
  const line = (id: string) => result.orders.find((l) => l.id === id)!;

  it('names each seeded discrepancy by order id with the first missing stage', () => {
    expect(result.discrepancies.map((d) => [d.id, d.dropOff])).toEqual([
      ['1002', 'no_click_id'],
      ['1003', 'webhook_missing'],
      ['1004', 'pixel_missing'],
      ['1005', 'capi_missing'],
      ['1006', 'postback_missing'],
    ]);
  });

  it('a healthy audited order and a healthy real order both have no drop-off', () => {
    expect(line('1001').dropOff).toBeNull();
    expect(line('1001').runId).toBe('run-1');
    expect(line('1007').dropOff).toBeNull();
  });

  it("a real customer's order is 'unknown' on the browser side, never 'missing'", () => {
    expect(line('1007').pixel).toBe('unknown');
    expect(line('1007').why).toMatch(/no auditor run watched/);
    expect(line('1006').pixel).toBe('unknown'); // still unknown even though the postback is missing
  });

  it('counts add up', () => {
    expect(result.counts).toEqual({
      orders: 7,
      attributed: 6,
      webhooks: 6,
      pixelPurchases: 2,
      pixelUnknown: 4,
      capi: 5,
      postbacks: 4,
      discrepancies: 5,
    });
  });

  it('respects a custom click-id parameter name', () => {
    const r = reconcile(
      [order('2', '#2', { aff_sub: 'x' })],
      {
        ...sources,
        webhookOrderIds: new Set(['2']),
        capiOrderIds: new Set(['2']),
        postbacks: new Map([['2', { postbackId: 'pb-2', clickId: 'x' }]]),
      },
      'aff_sub',
    );
    expect(r.orders[0]?.clickId).toBe('x');
    expect(r.orders[0]?.dropOff).toBeNull();
  });
});
