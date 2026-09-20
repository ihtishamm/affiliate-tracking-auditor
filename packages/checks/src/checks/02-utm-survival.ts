import { UTM_PARAMS } from '@auditor/shared';
import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';
import { queryOf, safeHost } from '../context.ts';

// 2. UTM survival — every utm_* parameter that arrived on the landing page is still in the
// URL when the shopper lands on the destination domain, and still in the attribution record
// at checkout. UTMs die most often in the redirect chain between affiliate and merchant: a
// redirector rebuilds the URL and forgets the query, and every downstream report attributes
// the sale to "direct".
//
// Evidence: the query string of each hop's destination (`hops[*].to`, redacted URLs keep
// UTM values) up to and including the first page on the final host, and
// `steps[*].attribution.utm` at checkout when the store's attribution record is readable.
export const utmSurvival: Check = {
  id: 'utm_survival',
  number: 2,
  title: 'UTM survival',
  run(ctx) {
    const entry = queryOf(ctx.trace.entryUrl);
    const expected = UTM_PARAMS.filter((p) => entry.has(p)).map(
      (p) => [p, entry.get(p) ?? ''] as const,
    );
    if (expected.length === 0) {
      return inconclusive({
        observed: 'the landing URL carried no utm_* parameters',
        expected: 'utm_* parameters to follow through the funnel',
        reason: 'nothing to track',
        fixHint: '',
      });
    }
    const names = expected.map(([p]) => p).join(', ');

    // Walk the hops until the funnel has settled on its final host; each hop must carry them.
    const hops = ctx.trace.hops.filter((h) => h.kind !== 'blocked');
    const finalHost = hops.length ? safeHost(hops[hops.length - 1]!.to) : null;
    let firstOnFinalHost = -1;
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]!;
      const q = queryOf(hop.to);
      const missing = expected.filter(([p, v]) => q.get(p) !== v).map(([p]) => p);
      const host = safeHost(hop.to);
      if (host === finalHost && firstOnFinalHost === -1) firstOnFinalHost = i;
      // Only the chain up to the first page on the destination counts: later in-store pages
      // legitimately carry no query string (the values live in the cookie by then).
      if (firstOnFinalHost !== -1 && i > firstOnFinalHost) break;
      if (missing.length > 0) {
        const prev = i > 0 ? hops[i - 1]!.to : ctx.trace.entryUrl;
        return fail({
          observed: `${missing.join(', ')} missing after the hop ${short(prev)} → ${short(hop.to)}`,
          expected: `${names} carried through every redirect to the store`,
          reason: `the redirect at ${safeHost(prev) ?? '?'} rebuilt the URL without the UTM parameters`,
          fixHint:
            'Forward the full query string in every redirect, or append utm_* explicitly when building the destination URL.',
        });
      }
    }

    if (!ctx.reached('checkout')) {
      return inconclusive({
        observed: `${names} present through ${hops.length} hop(s) to ${finalHost ?? 'the destination'}`,
        expected: `${names} also present in the attribution record at checkout`,
        reason: `checkout was not reached: ${ctx.stoppedAt()}`,
        fixHint: '',
      });
    }
    const at = ctx.snapshotAtOrAfter('checkout');
    const record = at?.attribution.utm ?? {};
    if (Object.keys(record).length === 0) {
      return pass({
        observed: `${names} present through every redirect to ${finalHost}; no readable attribution record at checkout to confirm further`,
        expected: `${names} carried to the store`,
        reason: 'the UTMs survived the redirect chain, which is where they are lost in practice',
      });
    }
    const lost = expected.filter(([p, v]) => record[p] !== v).map(([p]) => p);
    if (lost.length > 0) {
      return fail({
        observed: `${lost.join(', ')} not in the attribution record at ${at?.step}`,
        expected: `${names} in the attribution record at checkout`,
        reason: 'the UTMs reached the store but were not persisted with the click',
        fixHint: 'Store utm_* alongside the click ID in the first-party attribution record.',
      });
    }
    return pass({
      observed: `${names} present through every redirect and in the attribution record at ${at?.step}`,
      expected: `${names} carried to checkout`,
      reason: 'every UTM that arrived is still attached at checkout',
    });
  },
};

function short(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 60);
  }
}
