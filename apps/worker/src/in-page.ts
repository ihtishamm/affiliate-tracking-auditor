/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

// Functions in this file are serialised by Playwright and executed INSIDE the audited page.
// They must be self-contained: no imports, no closures over module scope — only their
// argument and the DOM. They are the only worker code with DOM types, hence the references
// above; everything else in the worker is Node.

export interface CtaPick {
  rule: string;
  href: string;
  text: string;
  index: number;
}

/**
 * Picks the link a shopper would click, by rule priority. The rule that matched is recorded
 * in the trace so a surprising choice can be explained. No rule is specific to our demo:
 * the tool has to find a stranger's CTA the same way.
 */
export function findCtaInPage(): CtaPick | null {
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const usable = anchors
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => {
      const href = a.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return false;
      const rect = a.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  const text = (a: HTMLAnchorElement): string => (a.textContent ?? '').replace(/\s+/g, ' ').trim();
  const social = /facebook|twitter|x\.com|instagram|youtube|tiktok|pinterest|linkedin|google/i;
  const rules: Array<[string, () => { a: HTMLAnchorElement; index: number } | undefined]> = [
    ['data-aff-cta', () => usable.find(({ a }) => a.hasAttribute('data-aff-cta'))],
    [
      'cta-text',
      () =>
        usable.find(({ a }) =>
          /\b(shop|buy|order|get|claim|try|start|checkout|offer|discount|% off)\b/i.test(text(a)),
        ),
    ],
    [
      'redirect-path',
      () =>
        usable.find(({ a }) => /\/(go|out|click|redirect|visit|track|link)(\/|$)/.test(a.pathname)),
    ],
    [
      'external-link',
      () => usable.find(({ a }) => a.host !== location.host && !social.test(a.host)),
    ],
  ];
  for (const [rule, pick] of rules) {
    const hit = pick();
    if (hit) return { rule, href: hit.a.href, text: text(hit.a).slice(0, 120), index: hit.index };
  }
  return null;
}

export interface SnapshotArgs {
  storageKey: string;
  selectors: string[];
  expected: string;
}

export interface SnapshotInPage {
  keys: string[];
  /** localStorage keys whose value contains the expected click ID. */
  containing: string[];
  aff: string | null;
  scripts: string[];
  matched: string | null;
  title: string;
}

/** Reads what a snapshot needs from the page: storage keys, our record, scripts, a visible consent banner. */
export function snapshotInPage({ storageKey, selectors, expected }: SnapshotArgs): SnapshotInPage {
  let keys: string[] = [];
  let containing: string[] = [];
  let aff: string | null = null;
  try {
    keys = Object.keys(window.localStorage);
    containing = keys.filter((k) => (window.localStorage.getItem(k) ?? '').includes(expected));
    aff = window.localStorage.getItem(storageKey);
  } catch {
    /* storage blocked: an empty list is the honest answer */
  }
  const scripts = Array.from(document.scripts)
    .map((s) => s.src)
    .filter(Boolean);
  let matched: string | null = null;
  for (const sel of selectors) {
    let el: HTMLElement | null = null;
    try {
      el = document.querySelector<HTMLElement>(sel);
    } catch {
      continue;
    }
    // Not offsetParent: it is null for position: fixed, which is how consent bars are placed.
    if (el) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0'
      ) {
        matched = sel;
        break;
      }
    }
  }
  return { keys, containing, aff, scripts, matched, title: document.title };
}
