import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';
import { FUNNEL_EVENTS } from '../context.ts';

// 5. event_id present — every browser event carries an `eid`. Without one, the server-side
// twin of the event (CAPI) can never be deduplicated against it and Meta counts the
// conversion twice. It is invisible in Events Manager until someone compares totals.
//
// Evidence: the `eid` parameter on every `facebook.com/tr` hit for a standard event. Meta's
// automatic events (SubscribedButtonClick…) are not judged; they are Meta's, not the funnel's.
export const eventIdPresent: Check = {
  id: 'event_id_present',
  number: 5,
  title: 'event_id present on every browser event',
  run(ctx) {
    const standard = ctx.hits.filter((h) => (FUNNEL_EVENTS as readonly string[]).includes(h.event));
    if (standard.length === 0) {
      return inconclusive({
        observed: 'no standard pixel events',
        expected: 'an event_id on each event',
        reason: 'no events to inspect (see check 4)',
        fixHint: '',
      });
    }
    const missing = standard.filter((h) => !h.eventId);
    if (missing.length > 0) {
      const byEvent = new Map<string, number>();
      for (const h of missing) byEvent.set(h.event, (byEvent.get(h.event) ?? 0) + 1);
      return fail({
        observed: `${missing.length} of ${standard.length} events without event_id: ${[...byEvent.entries()].map(([e, n]) => `${e}×${n}`).join(', ')}`,
        expected: 'every event sent with fbq(…, { eventID })',
        reason: 'events without an event_id cannot be paired with their server-side copy',
        fixHint:
          'Pass { eventID } on every fbq("track") call, and derive the Purchase id from the order id so the server can compute the same value.',
      });
    }
    return pass({
      observed: `${standard.length} standard events, all with event_id`,
      expected: 'every event sent with an event_id',
      reason: 'each browser event can be paired with a server-side twin',
    });
  },
};
