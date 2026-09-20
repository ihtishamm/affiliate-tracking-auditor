import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';

// 6. CAPI dedup match — the server-side Purchase was sent with the same event_id as the
// browser Purchase. Meta deduplicates only on that pair; a server event with its own id is
// a second sale in every report. The two sides never talk to each other, so the only way
// they agree is to derive the id from something both can see (the order id).
//
// Evidence: the browser Purchase's `eid` from the trace; the server's from
// `conversion_attempts` (kind = capi) for the same order. Both are needed for a verdict.
export const capiDedupMatch: Check = {
  id: 'capi_dedup_match',
  number: 6,
  title: 'CAPI dedup match',
  run(ctx) {
    if (ctx.trace.mode !== 'purchase' || !ctx.trace.order) {
      return inconclusive({
        observed:
          ctx.trace.mode === 'observe'
            ? 'observe mode: no purchase was completed on this funnel'
            : 'no order id was learned from the run',
        expected: 'a browser Purchase and a server Purchase with the same event_id',
        reason:
          'purchases are only completed on the demo store; without an order there is no server event to compare',
        fixHint: '',
      });
    }
    const browser = ctx.hitsFor('Purchase').at(-1);
    if (!browser) {
      return inconclusive({
        observed: 'no browser Purchase hit',
        expected: 'a browser Purchase with an event_id',
        reason: 'the pixel sent no Purchase (see check 4)',
        fixHint: '',
      });
    }
    const capi = ctx.server?.conversionAttempts.filter((a) => a.kind === 'capi') ?? [];
    const sent = capi.find((a) => a.ok) ?? capi.at(-1);
    if (!browser.eventId) {
      return fail({
        observed: `browser Purchase for order ${ctx.trace.order.id} has no event_id${sent ? `; server sent ${sent.eventId}` : ''}`,
        expected: `both sides sending purchase-${ctx.trace.order.id}`,
        reason: 'without a browser event_id the server event can never be deduplicated',
        fixHint:
          'Send the Purchase with { eventID: "purchase-<orderId>" } from the checkout pixel.',
      });
    }
    if (!sent) {
      return inconclusive({
        observed: `browser Purchase ${browser.eventId}; no server-side Purchase recorded for order ${ctx.trace.order.id}`,
        expected: `a server Purchase with event_id ${browser.eventId}`,
        reason: ctx.server?.order
          ? 'the webhook arrived but the sender has left no CAPI attempt yet'
          : 'the order webhook has not arrived yet, or was not delivered',
        fixHint: '',
      });
    }
    if (sent.eventId === browser.eventId) {
      return pass({
        observed: `browser ${browser.eventId} = server ${sent.eventId} (CAPI attempt ${sent.attempt}, HTTP ${sent.statusCode})`,
        expected: 'identical event_ids',
        reason: 'Meta will count one purchase',
      });
    }
    return fail({
      observed: `browser ${browser.eventId} ≠ server ${sent.eventId}`,
      expected: `both sides sending purchase-${ctx.trace.order.id}`,
      reason: 'the server chose its own event_id, so Meta sees two purchases',
      fixHint:
        'Derive the CAPI event_id from the order id exactly as the pixel does; never generate it.',
    });
  },
};
