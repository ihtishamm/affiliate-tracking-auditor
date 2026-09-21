import type { FunnelStep } from '@auditor/shared';
import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';
import type { FunnelEvent } from '../context.ts';

// 4. Pixel load and fire order — the Meta pixel is present and fires PageView, ViewContent,
// InitiateCheckout and Purchase, in that order, on the pages that produce them. A pixel that
// fires Purchase but never InitiateCheckout has no funnel to optimise against; a pixel that
// fires nothing at all is the most common state of an affiliate landing page that was cloned
// from a template.
//
// Evidence: `facebook.com/tr` hits, by first occurrence. Only events whose step the run
// reached are required; the rest are not judged.
const REQUIRED: ReadonlyArray<[FunnelEvent, FunnelStep]> = [
  ['PageView', 'landing'],
  ['ViewContent', 'product'],
  ['InitiateCheckout', 'checkout'],
  ['Purchase', 'thank_you'],
];

export const pixelFireOrder: Check = {
  id: 'pixel_fire_order',
  number: 4,
  title: 'Pixel load and fire order',
  run(ctx) {
    if (ctx.hits.length === 0) {
      // The base code asked for the script and did not get it: the funnel has a pixel, the
      // auditor's network could not load it. That is a fact about the auditor, not the funnel
      // (Meta's CDN answers some datacenter addresses with a response Chromium refuses), and
      // it must not be reported as a missing pixel (§3).
      const loads = ctx.pixelScriptLoads();
      const failed = loads.filter((l) => l.failure || (l.status !== null && l.status >= 400));
      if (loads.length > 0 && failed.length === loads.length) {
        const why = failed[0]?.failure ?? `HTTP ${failed[0]?.status}`;
        return inconclusive({
          observed: `the pixel base code requested fbevents.js on ${loads.length} page(s), and every load failed (${why})`,
          expected: 'the pixel script to load and fire PageView',
          reason:
            "Meta's CDN did not serve the pixel script to the auditor's network, so nothing the pixel would have done could be observed; the funnel is not at fault",
          fixHint: '',
        });
      }
      if (!ctx.reached('store')) {
        return inconclusive({
          observed: 'no Meta pixel requests',
          expected: 'PageView on the landing page',
          reason: `too little of the funnel was seen: ${ctx.stoppedAt()}`,
          fixHint: '',
        });
      }
      return fail({
        observed: `no request to facebook.com/tr on any of ${ctx.trace.steps.length} pages`,
        expected: 'a Meta pixel firing PageView on every page and the funnel events on theirs',
        reason: 'no pixel is installed, or it never fires for a first-time visitor',
        fixHint:
          'Install the Meta pixel base code on every page of the funnel (landing page and store), and confirm it fires without user interaction.',
      });
    }
    const required = REQUIRED.filter(([, step]) => ctx.reached(step));
    const firstSeen = new Map<string, number>();
    for (const h of ctx.hits) if (!firstSeen.has(h.event)) firstSeen.set(h.event, h.t);
    const missing = required.filter(([ev]) => !firstSeen.has(ev)).map(([ev]) => ev);
    if (missing.length > 0) {
      return fail({
        observed: `fired: ${[...firstSeen.keys()].filter((e) => REQUIRED.some(([r]) => r === e)).join(' → ') || 'none of the funnel events'}; missing: ${missing.join(', ')}`,
        expected: required.map(([ev]) => ev).join(' → '),
        reason: `${missing.join(', ')} never fired although the run reached the page(s) that should send them`,
        fixHint: `Fire ${missing.join(' and ')} from the page(s) where they belong, with the same pixel id as PageView.`,
      });
    }
    const order = required.map(([ev]) => ev);
    const times = order.map((ev) => firstSeen.get(ev) ?? 0);
    const outOfOrder = times.some((t, i) => i > 0 && t < times[i - 1]!);
    if (outOfOrder) {
      const seen = [...firstSeen.entries()]
        .filter(([e]) => order.includes(e as FunnelEvent))
        .sort((a, b) => a[1] - b[1])
        .map(([e]) => e);
      return fail({
        observed: `first occurrences in order: ${seen.join(' → ')}`,
        expected: order.join(' → '),
        reason:
          'a later funnel event fired before an earlier one — usually a page firing the wrong event',
        fixHint:
          'Fire each standard event only from its own page: ViewContent on product pages, InitiateCheckout on checkout, Purchase on the order status page.',
      });
    }
    const pixelIds = new Set(ctx.hits.map((h) => h.pixelId).filter(Boolean));
    return pass({
      observed: `${order.join(' → ')} fired in order (pixel ${[...pixelIds].join(', ')}; ${ctx.hits.length} hits in total)`,
      expected: order.join(' → '),
      reason: 'every funnel event the run could produce fired, in sequence',
    });
  },
};
