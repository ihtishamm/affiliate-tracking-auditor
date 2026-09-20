import type { Check } from '../check.ts';
import { fail, inconclusive, pass } from '../check.ts';
import { containerIdsIn } from '../context.ts';

// 7. Duplicate containers — no tag container is loaded twice on a page, and no page fires
// PageView twice. The classic silent double-count: a theme ships a GTM/GA4 container, an app
// adds the same one, and every tag inside fires twice; or two Meta pixel installs each fire
// PageView with their own event_id, which dedup cannot pair. Nothing errors, every number is
// simply 2×.
//
// Evidence: container ids in each snapshot's `<script src>` list (`gtm.js?id=`, `gtag/js?id=`),
// and PageView hits grouped by the page URL they were fired from (`dl`).
export const duplicateContainers: Check = {
  id: 'duplicate_containers',
  number: 7,
  title: 'Duplicate containers',
  run(ctx) {
    const findings: string[] = [];
    let pagesInspected = 0;

    for (const snap of ctx.trace.steps) {
      pagesInspected++;
      const counts = new Map<string, number>();
      for (const s of snap.scripts)
        for (const id of containerIdsIn(s)) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, n] of counts)
        if (n > 1) findings.push(`${id} loaded ${n}× on ${shortUrl(snap.url)}`);
    }

    // PageViews per document, attributed by time: a second install may be an image request
    // with no `dl` and no event_id, and it counts exactly the same.
    const pageViewsByDocument = new Map<number, typeof ctx.hits>();
    for (const h of ctx.hitsFor('PageView')) {
      pageViewsByDocument.set(h.document, [...(pageViewsByDocument.get(h.document) ?? []), h]);
    }
    for (const [doc, views] of pageViewsByDocument) {
      if (views.length > 1) {
        const withoutId = views.filter((v) => !v.eventId).length;
        findings.push(
          `PageView fired ${views.length}× on ${ctx.documentLabel(doc)}${withoutId ? ` (${withoutId} without event_id — an image/noscript pixel)` : ' with different event_ids'}`,
        );
      }
    }

    if (pagesInspected === 0 && ctx.hits.length === 0) {
      return inconclusive({
        observed: 'no pages captured',
        expected: 'each container and PageView once per page',
        reason: ctx.stoppedAt(),
        fixHint: '',
      });
    }
    if (findings.length > 0) {
      return fail({
        observed: findings.join('; '),
        expected: 'every tag container loaded once per page and one PageView per page load',
        reason: 'a duplicated install doubles every metric behind it without any error',
        fixHint:
          'Remove the second install (theme vs app, or two pixel snippets); if two systems must load the same container, gate one behind a check for the other.',
      });
    }
    const containers = new Set(ctx.trace.steps.flatMap((s) => s.scripts.flatMap(containerIdsIn)));
    return pass({
      observed: `${pagesInspected} pages: ${containers.size ? `containers ${[...containers].join(', ')} loaded once each` : 'no GTM/GA containers'}; one PageView per page`,
      expected: 'no duplicated container or PageView',
      reason: 'nothing on these pages counts twice',
    });
  },
};

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 60);
  }
}
