import { z } from 'zod';
import type { Logger } from '@auditor/shared';

// Shopify GraphQL Admin API client for M7: orders in a window, paginated by cursor, throttled
// by Shopify's cost-based leaky bucket. The API tells us after every call how many cost
// points remain and how fast they refill (`extensions.cost.throttleStatus`); the client reads
// that and waits before the bucket runs dry instead of hitting the 429 and retrying blind.
//
// Only the fields the reconciliation needs are requested: id, name, created_at, total and the
// custom attributes (click_id, utm_*). No customer, no addresses, no email — the query
// itself is the PII boundary here (§8), not a filter applied afterwards.

/** Pinned so a Shopify deprecation is a deliberate bump, not a surprise. */
export const ADMIN_API_VERSION = '2026-01';
const PAGE_SIZE = 50;

export interface AdminOrder {
  /** Numeric id as digits, the same key every other table uses. */
  id: string;
  name: string;
  createdAt: string;
  total: string;
  currency: string;
  attributes: Record<string, string>;
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

const responseSchema = z.object({
  data: z
    .object({
      orders: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            createdAt: z.string(),
            totalPriceSet: z.object({
              shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }),
            }),
            customAttributes: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
          }),
        ),
      }),
    })
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
  extensions: z
    .object({
      cost: z.object({
        requestedQueryCost: z.number(),
        actualQueryCost: z.number().nullable(),
        throttleStatus: z.object({
          maximumAvailable: z.number(),
          currentlyAvailable: z.number(),
          restoreRate: z.number(),
        }),
      }),
    })
    .optional(),
});

const ORDERS_QUERY = `
query AuditorOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      totalPriceSet { shopMoney { amount currencyCode } }
      customAttributes { key value }
    }
  }
}`;

/**
 * How long to wait before a call that will cost `nextCost`, given the bucket's state. Zero
 * when the bucket already holds enough. Shopify refills `restoreRate` points per second, so
 * the wait is the shortfall divided by the rate, rounded up, with a small margin so we never
 * arrive at exactly zero.
 */
export function backoffMs(status: ThrottleStatus, nextCost: number): number {
  const needed = nextCost * 1.2;
  if (status.currentlyAvailable >= needed) return 0;
  const shortfall = needed - status.currentlyAvailable;
  return Math.ceil(shortfall / Math.max(status.restoreRate, 1)) * 1000;
}

export interface AdminClientDeps {
  storeDomain: string;
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
}

export interface OrdersResult {
  orders: AdminOrder[];
  /** Bucket state after the last call, for the page to show. */
  throttle: ThrottleStatus | null;
  pages: number;
}

/** Every order created in [from, to], oldest first, across as many pages as it takes. */
export async function fetchOrders(
  from: Date,
  to: Date,
  deps: AdminClientDeps,
): Promise<OrdersResult> {
  const url = `https://${deps.storeDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const query = `created_at:>='${from.toISOString()}' AND created_at:<='${to.toISOString()}'`;
  const orders: AdminOrder[] = [];
  let after: string | null = null;
  let throttle: ThrottleStatus | null = null;
  let lastCost = PAGE_SIZE + 2; // a fair first estimate: one point per node plus overhead
  let pages = 0;

  for (;;) {
    if (throttle) {
      const wait = backoffMs(throttle, lastCost);
      if (wait > 0) {
        deps.log.info('shopify admin: waiting for cost bucket', { wait_ms: wait, ...throttle });
        await deps.sleep(wait);
      }
    }
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': deps.token },
      body: JSON.stringify({ query: ORDERS_QUERY, variables: { first: PAGE_SIZE, after, query } }),
    });
    if (res.status === 429) {
      // The bucket was already empty (someone else is using it): Shopify says how long.
      const retry = Number(res.headers.get('retry-after') ?? '2');
      deps.log.warn('shopify admin: throttled', { retry_after_s: retry });
      await deps.sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Shopify Admin API HTTP ${res.status}`);
    const parsed = responseSchema.parse(await res.json());
    if (parsed.errors?.length)
      throw new Error(`Shopify Admin API: ${parsed.errors.map((e) => e.message).join('; ')}`);
    if (!parsed.data) throw new Error('Shopify Admin API: no data');
    pages++;
    if (parsed.extensions) {
      throttle = parsed.extensions.cost.throttleStatus;
      lastCost =
        parsed.extensions.cost.actualQueryCost ?? parsed.extensions.cost.requestedQueryCost;
    }
    for (const node of parsed.data.orders.nodes) {
      const attributes: Record<string, string> = {};
      for (const a of node.customAttributes) if (a.value) attributes[a.key] = a.value;
      orders.push({
        id: /(\d+)$/.exec(node.id)?.[1] ?? node.id,
        name: node.name,
        createdAt: node.createdAt,
        total: node.totalPriceSet.shopMoney.amount,
        currency: node.totalPriceSet.shopMoney.currencyCode,
        attributes,
      });
    }
    if (!parsed.data.orders.pageInfo.hasNextPage || !parsed.data.orders.pageInfo.endCursor) break;
    after = parsed.data.orders.pageInfo.endCursor;
  }
  return { orders, throttle, pages };
}
