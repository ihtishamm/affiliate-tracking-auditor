import { describe, expect, it } from 'vitest';
import { absoluteHttpUrl } from '../src/funnel.ts';

// The CTA on a stranger's landing page is often not clickable — a sticky header or a consent
// bar covers it, or it opens in a new tab — so the driver falls back to the href. That is only
// safe if "is this href somewhere a navigation can go" is decided explicitly: `#` and
// `javascript:` are the two spellings that would otherwise turn a click failure into a crash
// or a pointless reload.

describe('absoluteHttpUrl', () => {
  const base = 'https://funnel.example/lp/offer?click_id=abc';

  it('resolves relative hrefs against the page, keeping the query the CTA carries', () => {
    expect(absoluteHttpUrl('/products/x?click_id=abc', base)).toBe(
      'https://funnel.example/products/x?click_id=abc',
    );
    expect(absoluteHttpUrl('../shop', base)).toBe('https://funnel.example/shop');
  });

  it('keeps an absolute href on another host — the cross-domain handoff is the point', () => {
    expect(absoluteHttpUrl('https://shop.example/p/1', base)).toBe('https://shop.example/p/1');
    expect(absoluteHttpUrl('//shop.example/p/1', base)).toBe('https://shop.example/p/1');
  });

  it('refuses anything a navigation cannot follow, so the click failure stays the reason', () => {
    expect(absoluteHttpUrl('#buy', base)).toBeNull(); // same document, different fragment
    expect(absoluteHttpUrl('/lp/offer?click_id=abc', base)).toBeNull(); // the page it is on
    expect(absoluteHttpUrl('javascript:void(0)', base)).toBeNull();
    expect(absoluteHttpUrl('mailto:sales@example.com', base)).toBeNull();
    expect(absoluteHttpUrl('tel:+12125550147', base)).toBeNull();
    expect(absoluteHttpUrl('', 'not a url')).toBeNull();
  });
});
