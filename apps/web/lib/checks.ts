import { eq, schema, type Db } from '@auditor/db';
import { runChecks, type CheckReport, type ServerEvents } from '@auditor/checks';
import type { RunTrace } from '@auditor/shared';

// M5 wiring: the check engine is pure; this is the one place that feeds it. Server-side
// evidence is looked up by the order id the trace learned from the Purchase pixel hit.
//
// Reports are computed on read rather than stored: the server rows (webhook, CAPI, postback)
// arrive seconds after the run finishes, and a report frozen at completion would say
// "inconclusive" forever about events that exist. Persisting reports is deferred to the
// scheduled runs of M8, which need history rather than a live view.

export async function loadServerEvents(db: Db, orderId: string): Promise<ServerEvents> {
  const [order, attempts, postbacks] = await Promise.all([
    db.query.shopifyWebhookEvents.findFirst({
      where: eq(schema.shopifyWebhookEvents.orderId, orderId),
    }),
    db.query.conversionAttempts.findMany({ where: eq(schema.conversionAttempts.orderId, orderId) }),
    db.query.postbackEvents.findMany({ where: eq(schema.postbackEvents.orderId, orderId) }),
  ]);
  return {
    order: order
      ? { id: order.orderId, name: order.orderName, attribution: order.attribution }
      : null,
    conversionAttempts: attempts
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .map((a) => ({
        kind: a.kind === 'capi' ? 'capi' : 'postback',
        attempt: a.attempt,
        eventId: a.eventId,
        statusCode: a.statusCode,
        ok: a.ok,
        error: a.error,
        piiHashed: a.piiHashed,
      })),
    postbackEvents: postbacks.map((p) => ({
      postbackId: p.postbackId,
      clickId: p.clickId,
      orderId: p.orderId,
      status: p.status,
    })),
  };
}

export async function reportFor(db: Db, trace: RunTrace): Promise<CheckReport> {
  const server = trace.order ? await loadServerEvents(db, trace.order.id) : null;
  return runChecks({ trace, server });
}
