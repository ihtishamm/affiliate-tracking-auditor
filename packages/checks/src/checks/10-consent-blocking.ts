import type { Check } from '../check.ts';
import { fail, pass } from '../check.ts';

// 10. Consent blocking — a consent banner is not silently holding the pixel back. Real
// consent tools block tracking until accepted, and most visitors never accept; a funnel
// configured that way is dark from its first page and nobody notices because the pixel
// "works" for whoever tests it and clicks Accept. The runner never clicks Accept, on
// purpose: it is the visitor who does not.
//
// Evidence: `consent.bannerVisible` per snapshot, and whether any pixel hit was fired from
// that page (`dl` matches the snapshot URL, or during that step).
export const consentBlocking: Check = {
  id: 'consent_blocking',
  number: 10,
  title: 'Consent banner not blocking the pixel',
  run(ctx) {
    const withBanner = ctx.trace.steps.filter((s) => s.consent.bannerVisible);
    if (withBanner.length === 0) {
      return pass({
        observed: `no consent banner detected on ${ctx.trace.steps.length} pages`,
        expected: 'no banner, or a banner that does not block the pixel',
        reason: 'nothing stands between the pixel and the visitor',
      });
    }
    const blocked: string[] = [];
    const fine: string[] = [];
    for (const snap of withBanner) {
      const doc = ctx.documentAt(snap.t);
      const fired = ctx.hits.some((h) => h.document === doc);
      (fired ? fine : blocked).push(`${shortUrl(snap.url)} (${snap.consent.matched})`);
    }
    if (blocked.length > 0) {
      return fail({
        observed: `consent banner visible and no pixel event fired on: ${blocked.join('; ')}`,
        expected:
          'PageView fired on the page, or an explicit decision that tracking waits for consent',
        reason: 'for a visitor who does not click Accept — most of them — this page sends nothing',
        fixHint:
          'Fire the pixel in a consent-appropriate limited mode before consent, or confirm with legal that blocking is intended and measure the accept rate.',
      });
    }
    return pass({
      observed: `consent banner visible on ${fine.join('; ')} and the pixel still fired`,
      expected: 'a banner that does not block the pixel',
      reason: 'the banner is informational; tracking is not gated on it',
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
