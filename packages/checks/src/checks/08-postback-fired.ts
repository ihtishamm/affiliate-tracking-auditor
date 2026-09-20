import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';

// 8. Postback fired — the network's server-to-server postback fired for the conversion,
// carrying the click ID, was accepted (2xx), and was retried when it was not. This is how the
// affiliate network learns that a sale happened; without it the affiliate is unpaid however
// well the pixel behaved. A browser cannot see it, so the evidence is the sender's own log.
//
// Evidence: `postback_events` (what the receiver accepted) and `conversion_attempts`
// (kind = postback: every try with its status) for the run's order.
export const postbackFired: Check = {
  id: 'postback_fired',
  number: 8,
  title: 'Postback fired',
  run(ctx) {
    if (ctx.trace.mode !== 'purchase' || !ctx.trace.order) {
      return inconclusive({
        observed: 'no purchase was completed on this funnel',
        expected: 'a postback for the order carrying the click ID',
        reason:
          'server-to-server traffic is invisible to the browser; without an order there is nothing to have been posted back',
        fixHint: '',
      });
    }
    const orderId = ctx.trace.order.id;
    const attempts = ctx.server?.conversionAttempts.filter((a) => a.kind === 'postback') ?? [];
    const accepted = ctx.server?.postbackEvents.filter((p) => p.orderId === orderId) ?? [];
    const expectedClick = ctx.trace.expectedClickId;

    if (accepted.length > 0) {
      const withClick = accepted.find((p) => p.clickId === expectedClick);
      if (!withClick) {
        return fail({
          observed: `postback accepted for order ${orderId} but with click_id ${accepted.map((p) => p.clickId).join(', ')}`,
          expected: `a postback carrying ${expectedClick}`,
          reason: 'the network was told about the sale but credited the wrong click',
          fixHint:
            'Read the click ID from the order attributes and pass it unchanged in the postback.',
        });
      }
      const retried =
        attempts.length > 1
          ? `, after ${attempts.length} attempts (${attempts.map((a) => a.statusCode ?? a.error ?? '?').join(' → ')})`
          : '';
      return pass({
        observed: `postback ${withClick.postbackId} accepted with click_id ${expectedClick}${retried}`,
        expected: 'an accepted postback carrying the click ID',
        reason: 'the network received the conversion for the right click',
      });
    }

    if (attempts.length === 0) {
      return inconclusive({
        observed: `no postback attempt recorded for order ${orderId}`,
        expected: 'a postback for the order',
        reason: ctx.server?.order
          ? 'the order webhook arrived but the sender has left no postback attempt yet'
          : 'the order webhook has not arrived yet, or was not delivered',
        fixHint: '',
      });
    }
    const statuses = attempts.map((a) => a.statusCode ?? a.error ?? '?').join(' → ');
    const noClick = attempts.every((a) => /click_id/i.test(a.error ?? ''));
    return fail({
      observed: `${attempts.length} attempt(s), none accepted: ${statuses}${attempts.length === 1 ? ' (no retry)' : ''}`,
      expected: 'a 2xx from the postback endpoint, with retries on failure',
      reason: noClick
        ? 'the order carried no click ID, so there was nothing to post back'
        : attempts.length > 1
          ? 'the receiver kept failing; the retries happened but the network never learned of the sale'
          : 'the first attempt failed and was not retried',
      fixHint: noClick
        ? 'Fix the click-ID handoff (checks 1 and 3) so the order carries it.'
        : 'Make the postback endpoint answer 2xx; keep retrying with backoff and alert when all attempts fail.',
    });
  },
};
