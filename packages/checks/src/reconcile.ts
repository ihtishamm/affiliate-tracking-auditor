// Reconciliation (PROJECT_CONTEXT §6 M7): the merchant's view. For every order Shopify says
// exists in a window, did each of the four things that should follow a sale actually happen?
//
//   order ─► carried a click ID ─► webhook reached us ─► pixel Purchase fired ─► CAPI sent ─► postback accepted
//
// Each stage is decided from a different source, and the first stage that is missing is the
// drop-off: it explains everything after it (no click ID → nothing to post back; no webhook →
// no CAPI and no postback). Pure: the caller loads the sources, this only joins them.
//
// Browser evidence has a third state. The auditor only sees pixel Purchases for orders its own
// runs placed; a merchant's real orders have no trace, so the pixel column is `unknown` for
// them — never `missing`. Reporting a missing pixel event for a sale nobody watched would be
// a failure that was not observed (§3).

export interface ReconcileOrder {
  id: string;
  name: string;
  createdAt: string;
  total: string;
  currency: string;
  /** Order attributes (Shopify `customAttributes` / `note_attributes`). */
  attributes: Record<string, string>;
}

export interface ReconcileSources {
  /** Order ids for which an orders/create webhook was received. */
  webhookOrderIds: Set<string>;
  /** Order id → the run whose trace shows the browser Purchase (id learned from the pixel). */
  pixelPurchases: Map<string, { runId: string; purchaseEventId: string | null }>;
  /** Order ids with at least one successful CAPI attempt. */
  capiOrderIds: Set<string>;
  /** Order id → accepted postback (click id it carried). */
  postbacks: Map<string, { postbackId: string; clickId: string }>;
  /** Order ids for which an auditor run exists at all (pixel evidence is decidable). */
  auditedOrderIds: Set<string>;
}

export type DropOff =
  'no_click_id' | 'webhook_missing' | 'pixel_missing' | 'capi_missing' | 'postback_missing';

export interface OrderLine {
  id: string;
  name: string;
  createdAt: string;
  total: string;
  currency: string;
  clickId: string | null;
  webhook: boolean;
  pixel: 'ok' | 'missing' | 'unknown';
  capi: boolean;
  postback: boolean;
  /** The first stage that is missing, or null when every stage that could be judged is fine. */
  dropOff: DropOff | null;
  /** Human-readable, one line. */
  why: string;
  runId: string | null;
}

export interface Reconciliation {
  orders: OrderLine[];
  counts: {
    orders: number;
    attributed: number;
    webhooks: number;
    pixelPurchases: number;
    pixelUnknown: number;
    capi: number;
    postbacks: number;
    discrepancies: number;
  };
  /** Lines with a drop-off, worst-first (earliest stage first), for the page. */
  discrepancies: OrderLine[];
}

const STAGE_ORDER: DropOff[] = [
  'no_click_id',
  'webhook_missing',
  'pixel_missing',
  'capi_missing',
  'postback_missing',
];

const WHY: Record<DropOff, string> = {
  no_click_id: 'the order carries no click ID, so the sale cannot be attributed to any affiliate',
  webhook_missing:
    'the orders/create webhook never reached the receiver; nothing downstream could run',
  pixel_missing: 'an auditor run placed this order and the browser Purchase never fired',
  capi_missing: 'no server-side Purchase was accepted by Meta for this order',
  postback_missing:
    'no postback was accepted for this order; the affiliate network never learned of the sale',
};

export function reconcile(
  orders: ReconcileOrder[],
  sources: ReconcileSources,
  clickIdParam = 'click_id',
): Reconciliation {
  const lines: OrderLine[] = orders.map((o) => {
    const clickId = o.attributes[clickIdParam] ?? null;
    const webhook = sources.webhookOrderIds.has(o.id);
    const traced = sources.pixelPurchases.get(o.id);
    const pixel: OrderLine['pixel'] = traced
      ? 'ok'
      : sources.auditedOrderIds.has(o.id)
        ? 'missing'
        : 'unknown';
    const capi = sources.capiOrderIds.has(o.id);
    const postback = sources.postbacks.has(o.id);

    let dropOff: DropOff | null = null;
    if (!clickId) dropOff = 'no_click_id';
    else if (!webhook) dropOff = 'webhook_missing';
    else if (pixel === 'missing') dropOff = 'pixel_missing';
    else if (!capi) dropOff = 'capi_missing';
    else if (!postback) dropOff = 'postback_missing';

    return {
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      total: o.total,
      currency: o.currency,
      clickId,
      webhook,
      pixel,
      capi,
      postback,
      dropOff,
      why: dropOff
        ? WHY[dropOff]
        : pixel === 'unknown'
          ? 'attributed, sent to Meta and posted back; no auditor run watched the browser side'
          : 'every stage present',
      runId: traced?.runId ?? null,
    };
  });

  const discrepancies = lines
    .filter((l) => l.dropOff !== null)
    .sort(
      (a, b) =>
        STAGE_ORDER.indexOf(a.dropOff!) - STAGE_ORDER.indexOf(b.dropOff!) ||
        a.createdAt.localeCompare(b.createdAt),
    );

  return {
    orders: lines,
    counts: {
      orders: lines.length,
      attributed: lines.filter((l) => l.clickId).length,
      webhooks: lines.filter((l) => l.webhook).length,
      pixelPurchases: lines.filter((l) => l.pixel === 'ok').length,
      pixelUnknown: lines.filter((l) => l.pixel === 'unknown').length,
      capi: lines.filter((l) => l.capi).length,
      postbacks: lines.filter((l) => l.postback).length,
      discrepancies: discrepancies.length,
    },
    discrepancies,
  };
}
