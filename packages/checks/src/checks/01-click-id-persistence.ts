import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';

// 1. Click ID persistence — the click ID that arrived on the landing page is still available
// at checkout, in a cookie, in localStorage, or as a checkout/cart attribute. If it is not,
// the order that follows carries no affiliate attribution and the affiliate is never paid;
// the merchant sees the sale as "direct" and cuts the partner that produced it.
//
// Evidence: `steps[*].attribution.foundIn` (cookie names / storage keys whose value contains
// the expected click ID, or the URL) and cart-attribute writes (`/cart/update.js`,
// `/cart/add`) carrying it. Decidable only once the checkout step was reached.
export const clickIdPersistence: Check = {
  id: 'click_id_persistence',
  number: 1,
  title: 'Click ID persistence',
  run(ctx) {
    const expected = ctx.trace.expectedClickId;
    const landing = ctx.snapshot('landing');
    if (!landing)
      return inconclusive({
        observed: 'no landing snapshot',
        expected: `click ID ${expected} on landing`,
        reason: ctx.stoppedAt(),
        fixHint: '',
      });

    const onLanding = landing.attribution.source !== 'none';
    if (!onLanding) {
      return fail({
        observed: `the landing page did not carry ${ctx.trace.clickIdParam}=${expected} in its URL, cookies or storage`,
        expected: `the click ID present on the landing page`,
        reason:
          'the landing URL was opened with the click ID and it was gone by the time the page settled — a redirect or a router rewrite dropped it',
        fixHint:
          'Keep the query string through every redirect on the landing domain, or persist the click ID to a first-party cookie before rewriting the URL.',
      });
    }

    if (!ctx.reached('checkout')) {
      return inconclusive({
        observed: `click ID present on landing (${landing.attribution.source})`,
        expected: 'the click ID still present at checkout',
        reason: `checkout was not reached: ${ctx.stoppedAt()}`,
        fixHint: '',
      });
    }

    const at = ctx.snapshotAtOrAfter('checkout');
    const where: string[] = [];
    if (at) {
      if (at.attribution.foundIn.cookies.length)
        where.push(`cookie ${at.attribution.foundIn.cookies.join(', ')}`);
      if (at.attribution.foundIn.localStorage.length)
        where.push(`localStorage ${at.attribution.foundIn.localStorage.join(', ')}`);
      if (at.attribution.foundIn.url) where.push('URL');
    }
    const cartWrite = ctx.trace.requests.find((r) => {
      if (!/\/cart\/(update|add)(\.js)?$/.test(r.url)) return false;
      return Object.entries(r.params).some(
        ([k, v]) => /click_id/.test(k) && v.kind === 'value' && v.value === expected,
      );
    });
    if (cartWrite) where.push('cart attribute (becomes the order’s note_attributes)');

    if (where.length > 0) {
      return pass({
        observed: `${expected} found at ${at?.step ?? 'checkout'} in: ${where.join('; ')}`,
        expected: 'the click ID available at checkout',
        reason:
          'the value that arrived on the landing page is still attached to the shopper at checkout',
      });
    }
    return fail({
      observed: `${expected} was on the landing page but not in any cookie, storage key, URL or cart attribute at ${at?.step ?? 'checkout'}`,
      expected: 'the click ID available at checkout',
      reason:
        'the click ID was lost somewhere between landing and checkout; the order will have no affiliate attribution',
      fixHint:
        'Persist the click ID to a first-party cookie and localStorage on landing and write it onto the cart as an attribute so it reaches the order.',
    });
  },
};
