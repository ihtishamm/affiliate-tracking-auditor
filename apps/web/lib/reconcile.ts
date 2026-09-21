import { and, gte, inArray, lte, schema, sql, type Db } from '@auditor/db';
import { reconcile, type ReconcileSources, type Reconciliation } from '@auditor/checks';
import { CLICK_ID_PARAM, type Logger } from '@auditor/shared';
import { fetchOrders, type ThrottleStatus } from './shopify-admin.ts';

// M7 wiring: Shopify's orders for the window are the truth; the four other sources come from
// our own tables. Everything is loaded here and joined by the pure `reconcile()`.

export interface ReconcileReport extends Reconciliation {
  window: { from: string; to: string };
  throttle: ThrottleStatus | null;
  pages: number;
}

export interface ReconcileDeps {
  db: Db;
  storeDomain: string;
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
}

export async function reconcileWindow(
  from: Date,
  to: Date,
  deps: ReconcileDeps,
): Promise<ReconcileReport> {
  const { orders, throttle, pages } = await fetchOrders(from, to, {
    storeDomain: deps.storeDomain,
    token: deps.token,
    fetch: deps.fetch,
    sleep: deps.sleep,
    log: deps.log,
  });
  const ids = orders.map((o) => o.id);
  const sources = ids.length ? await loadSources(deps.db, ids, from, to) : emptySources();
  const joined = reconcile(orders, sources, CLICK_ID_PARAM);
  return { ...joined, window: { from: from.toISOString(), to: to.toISOString() }, throttle, pages };
}

function emptySources(): ReconcileSources {
  return {
    webhookOrderIds: new Set(),
    pixelPurchases: new Map(),
    capiOrderIds: new Set(),
    postbacks: new Map(),
    auditedOrderIds: new Set(),
  };
}

async function loadSources(
  db: Db,
  orderIds: string[],
  from: Date,
  to: Date,
): Promise<ReconcileSources> {
  const [webhooks, attempts, postbacks, traces] = await Promise.all([
    db
      .select({
        orderId: schema.shopifyWebhookEvents.orderId,
        auditRun: sql<string | null>`${schema.shopifyWebhookEvents.attribution}->>'__audit_run'`,
      })
      .from(schema.shopifyWebhookEvents)
      .where(inArray(schema.shopifyWebhookEvents.orderId, orderIds)),
    db
      .select({
        orderId: schema.conversionAttempts.orderId,
        kind: schema.conversionAttempts.kind,
        ok: schema.conversionAttempts.ok,
      })
      .from(schema.conversionAttempts)
      .where(inArray(schema.conversionAttempts.orderId, orderIds)),
    db
      .select({
        orderId: schema.postbackEvents.orderId,
        postbackId: schema.postbackEvents.postbackId,
        clickId: schema.postbackEvents.clickId,
      })
      .from(schema.postbackEvents)
      .where(inArray(schema.postbackEvents.orderId, orderIds)),
    // Traces of runs in the window (plus an hour of slack for a run that started before it):
    // the order id and purchase event id the runner learned from the pixel.
    db
      .select({
        runId: schema.runTraces.runId,
        orderId: sql<string | null>`${schema.runTraces.trace}->'order'->>'id'`,
        purchaseEventId: sql<string | null>`${schema.runTraces.trace}->'order'->>'purchaseEventId'`,
        mode: sql<string>`${schema.runTraces.trace}->>'mode'`,
      })
      .from(schema.runTraces)
      .where(
        and(
          gte(schema.runTraces.createdAt, new Date(from.getTime() - 3_600_000)),
          lte(schema.runTraces.createdAt, new Date(to.getTime() + 3_600_000)),
        ),
      ),
  ]);

  const sources = emptySources();
  for (const w of webhooks) {
    sources.webhookOrderIds.add(w.orderId);
    // An order the auditor's runner placed: the browser side is decidable for it, whether or
    // not a trace ever learned the order id.
    if (w.auditRun) sources.auditedOrderIds.add(w.orderId);
  }
  for (const a of attempts) if (a.kind === 'capi' && a.ok) sources.capiOrderIds.add(a.orderId);
  for (const p of postbacks)
    sources.postbacks.set(p.orderId, { postbackId: p.postbackId, clickId: p.clickId });
  for (const t of traces) {
    if (t.mode !== 'purchase') continue;
    if (t.orderId) {
      sources.auditedOrderIds.add(t.orderId);
      sources.pixelPurchases.set(t.orderId, { runId: t.runId, purchaseEventId: t.purchaseEventId });
    }
  }
  return sources;
}
