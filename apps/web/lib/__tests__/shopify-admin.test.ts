import { describe, expect, it } from 'vitest';
import { createLogger } from '@auditor/shared';
import { backoffMs, fetchOrders, type ThrottleStatus } from '../shopify-admin.ts';

const log = createLogger({ service: 'test', level: 'error', write: () => {} });

function page(
  nodes: Array<{ id: number; name: string; attrs?: Record<string, string> }>,
  hasNext: boolean,
  throttle: ThrottleStatus,
  cost = 52,
) {
  return {
    data: {
      orders: {
        pageInfo: {
          hasNextPage: hasNext,
          endCursor: hasNext ? `cursor-${nodes.at(-1)?.id}` : null,
        },
        nodes: nodes.map((n) => ({
          id: `gid://shopify/Order/${n.id}`,
          name: n.name,
          createdAt: '2026-09-21T00:00:00Z',
          totalPriceSet: { shopMoney: { amount: '24.95', currencyCode: 'USD' } },
          customAttributes: Object.entries(n.attrs ?? {}).map(([key, value]) => ({ key, value })),
        })),
      },
    },
    extensions: {
      cost: { requestedQueryCost: cost, actualQueryCost: cost, throttleStatus: throttle },
    },
  };
}

function harness(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{
    body: { variables: { after: string | null; query: string } };
    token: string | undefined;
  }> = [];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      token: (init?.headers as Record<string, string>)['x-shopify-access-token'],
    });
    const next = responses.shift() ?? { status: 500 };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  };
  return {
    calls,
    sleeps,
    deps: {
      storeDomain: 'auditor-demo.myshopify.com',
      token: 'shpat_test_token_not_real',
      fetch: fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log,
    },
  };
}

const full: ThrottleStatus = { maximumAvailable: 2000, currentlyAvailable: 1948, restoreRate: 100 };

describe('backoffMs', () => {
  it('waits nothing when the bucket holds enough, and the shortfall over the refill rate otherwise', () => {
    expect(backoffMs(full, 52)).toBe(0);
    expect(backoffMs({ ...full, currentlyAvailable: 10 }, 52)).toBe(1000); // needs ~62, has 10 → 52/100 s → 1 s
    expect(backoffMs({ ...full, currentlyAvailable: 0, restoreRate: 50 }, 500)).toBe(12000);
  });
});

describe('fetchOrders', () => {
  it('pages with cursors until hasNextPage is false, sends the token and the created_at window, and normalises ids', async () => {
    const h = harness([
      {
        body: page([{ id: 1, name: '#1', attrs: { click_id: 'a', utm_source: 'x' } }], true, full),
      },
      { body: page([{ id: 2, name: '#2' }], false, full) },
    ]);
    const out = await fetchOrders(
      new Date('2026-09-20T00:00:00Z'),
      new Date('2026-09-21T00:00:00Z'),
      h.deps,
    );
    expect(out.orders.map((o) => o.id)).toEqual(['1', '2']);
    expect(out.orders[0]?.attributes).toEqual({ click_id: 'a', utm_source: 'x' });
    expect(out.pages).toBe(2);
    expect(h.calls[0]?.token).toBe('shpat_test_token_not_real');
    expect(h.calls[0]?.body.variables.after).toBeNull();
    expect(h.calls[1]?.body.variables.after).toBe('cursor-1');
    expect(h.calls[0]?.body.variables.query).toBe(
      "created_at:>='2026-09-20T00:00:00.000Z' AND created_at:<='2026-09-21T00:00:00.000Z'",
    );
    expect(h.sleeps).toEqual([]);
  });

  it('reads throttleStatus and waits before the next page when the bucket is low', async () => {
    const low: ThrottleStatus = {
      maximumAvailable: 2000,
      currentlyAvailable: 30,
      restoreRate: 100,
    };
    const h = harness([
      { body: page([{ id: 1, name: '#1' }], true, low) },
      { body: page([{ id: 2, name: '#2' }], false, full) },
    ]);
    const out = await fetchOrders(
      new Date('2026-09-20T00:00:00Z'),
      new Date('2026-09-21T00:00:00Z'),
      h.deps,
    );
    expect(out.orders).toHaveLength(2);
    expect(h.sleeps).toEqual([1000]); // (52*1.2 - 30) / 100 → 0.32 s → rounded up to 1 s
  });

  it('honours a 429 with Retry-After instead of hammering', async () => {
    const h = harness([
      { status: 429, headers: { 'retry-after': '3' } },
      { body: page([{ id: 9, name: '#9' }], false, full) },
    ]);
    const out = await fetchOrders(
      new Date('2026-09-20T00:00:00Z'),
      new Date('2026-09-21T00:00:00Z'),
      h.deps,
    );
    expect(out.orders.map((o) => o.id)).toEqual(['9']);
    expect(h.sleeps).toEqual([3000]);
  });

  it('surfaces GraphQL errors and never requests customer fields', async () => {
    const h = harness([{ body: { errors: [{ message: 'Access denied for orders field' }] } }]);
    await expect(
      fetchOrders(new Date('2026-09-20T00:00:00Z'), new Date('2026-09-21T00:00:00Z'), h.deps),
    ).rejects.toThrow(/Access denied/);
    const query = (h.calls[0] as unknown as { body: { query: string } }).body.query;
    expect(query).toMatch(/customAttributes/);
    expect(query).not.toMatch(/customer|email|phone|shippingAddress|billingAddress/);
  });
});
