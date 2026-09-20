import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';
import { queryOf, safeHost } from '../context.ts';

// 3. Cross-domain handoff — the click ID survives the jump from the advertorial's domain to
// the store's. Cookies do not cross domains, so the only carrier is the URL of the hop that
// lands on the store. This is the single biggest killer on duplicate funnels: a redirect that
// forwards utm_* but forgets the network's own parameter.
//
// Evidence: the first hop whose host differs from the previous one, its destination query,
// and the first snapshot on the new host (a store may persist the value to a cookie on
// arrival, which `foundIn` sees even without our snippet).
export const crossDomainHandoff: Check = {
  id: 'cross_domain_handoff',
  number: 3,
  title: 'Cross-domain handoff',
  run(ctx) {
    const expected = ctx.trace.expectedClickId;
    const param = ctx.trace.clickIdParam;
    const boundary = ctx.boundaries[0];
    if (!boundary) {
      return inconclusive({
        observed: `every hop stayed on ${safeHost(ctx.trace.entryUrl) ?? 'one host'}`,
        expected: 'a hop from the landing domain into the store',
        reason: ctx.reached('store')
          ? 'the funnel has no domain boundary'
          : `no cross-domain hop was observed: ${ctx.stoppedAt()}`,
        fixHint: '',
      });
    }
    const inUrl = queryOf(boundary.hop.to).get(param) === expected;
    const firstOnStore = ctx.trace.steps.find((s) => safeHost(s.url) === boundary.toHost);
    const foundIn = firstOnStore?.attribution.foundIn;
    const inStore = Boolean(
      foundIn && (foundIn.cookies.length || foundIn.localStorage.length || foundIn.url),
    );

    if (inUrl || inStore) {
      const how = inUrl
        ? `in the URL (${param}=${expected})`
        : `in ${foundIn?.cookies.length ? `cookie ${foundIn.cookies.join(', ')}` : `storage ${foundIn?.localStorage.join(', ')}`}`;
      return pass({
        observed: `${boundary.fromHost} → ${boundary.toHost}: click ID ${how} on arrival`,
        expected: 'the click ID present on the first page of the store',
        reason: 'the value crossed the domain boundary',
      });
    }
    return fail({
      observed: `${boundary.fromHost} → ${boundary.toHost}: the destination URL has no ${param}, and the first store page holds ${expected} in no cookie or storage key`,
      expected: `${param}=${expected} on the URL that lands on ${boundary.toHost}`,
      reason: 'the redirect into the store did not forward the click ID; the store never saw it',
      fixHint: `Forward ${param} (with the UTMs) on the redirect into the store, or use a redirector that preserves the whole query string.`,
    });
  },
};
