// Break-it toggles (PROJECT_CONTEXT §6 M2): deliberate sabotage of the demo funnel, one toggle per
// real-world failure, so a reviewer can flip one, re-run the auditor, and watch the right check
// catch it.
//
// Toggle state travels with the attribution data rather than living in a database: it is a URL
// parameter on the advertorial, forwarded by /go into the store, captured by the storefront
// snippet like a UTM, written as a cart attribute, read by the checkout pixel from
// checkout.customAttributes and (M3) by the webhook handler from note_attributes. Every stage that
// must misbehave can therefore see the instruction, including the two that run inside Shopify's
// sandbox with no access to our backend. A run is fully described by its URL.
//
// The Liquid snippet and the checkout pixel carry a minimal copy of the parser
// ("mirrors packages/shared/src/break-it.ts"). Toggle names are the contract; change both.

/** The URL parameter / cart attribute that carries the comma-separated toggle list. */
export const BREAK_PARAM = '__break';

export const BREAK_TOGGLES = [
  'drop_click_id',
  'strip_utms',
  'strip_event_id',
  'double_fire',
  'duplicate_gtm',
  'unhashed_email',
  'consent_wall',
  'capi_mismatch',
  'postback_500',
] as const;
export type BreakToggle = (typeof BREAK_TOGGLES)[number];

export interface BreakToggleInfo {
  label: string;
  /** What silently goes wrong in a real funnel when this happens. */
  breaks: string;
  /** Which part of the funnel misbehaves. */
  actsIn: string;
  /** Check numbers from PROJECT_CONTEXT §6 M5 that must report `fail` for this toggle. */
  caughtBy: readonly number[];
  /** Toggles whose effect only exists once M3 ships the server side. */
  requires?: 'M3';
}

export const BREAK_TOGGLE_INFO: Record<BreakToggle, BreakToggleInfo> = {
  drop_click_id: {
    label: 'Drop click ID on redirect',
    breaks:
      'The redirect into the store forwards the UTMs but not click_id. The order is placed with no affiliate attribution and the affiliate is never paid.',
    actsIn: '/go redirect',
    caughtBy: [3, 1],
  },
  strip_utms: {
    label: 'Strip UTMs on redirect',
    breaks:
      'utm_* parameters are lost crossing the domain boundary. The sale is attributed to "direct" in every downstream report.',
    actsIn: '/go redirect',
    caughtBy: [2],
  },
  strip_event_id: {
    label: 'Strip event_id',
    breaks:
      'Browser events are sent without an event_id, so the server-side (CAPI) copy of each event can never be deduplicated against them. Every purchase counts twice.',
    actsIn: 'advertorial pixel, storefront snippet, checkout pixel',
    caughtBy: [5, 6],
  },
  double_fire: {
    label: 'Double-fire the pixel',
    breaks:
      'PageView fires twice per page with different event_ids: the signature of two pixel installs (theme plus app) that nobody noticed.',
    actsIn: 'storefront snippet',
    caughtBy: [7],
  },
  duplicate_gtm: {
    label: 'Duplicate GTM container',
    breaks:
      'The same Tag Manager container loads twice on the advertorial, so every tag inside it fires twice.',
    actsIn: 'advertorial',
    caughtBy: [7],
  },
  unhashed_email: {
    label: 'Send email unhashed',
    breaks:
      'The customer email is sent to Meta in plaintext as a custom parameter instead of as a normalised SHA-256 hash.',
    actsIn: 'checkout pixel (and the CAPI sender from M3)',
    caughtBy: [9],
  },
  consent_wall: {
    label: 'Consent banner blocks the pixel',
    breaks:
      'A consent banner holds the pixel back until accepted. Most visitors never click accept, so the advertorial fires nothing and the funnel is dark from its first page.',
    actsIn: 'advertorial',
    caughtBy: [10],
  },
  capi_mismatch: {
    label: 'CAPI event_id mismatch',
    breaks:
      'The server-side Purchase uses a fresh event_id instead of the one derived from the order ID, so Meta cannot pair it with the browser Purchase.',
    actsIn: 'conversion sender',
    caughtBy: [6],
    requires: 'M3',
  },
  postback_500: {
    label: 'Postback returns 500',
    breaks:
      'The postback receiver answers 500. The sender must retry, and the auditor must see the retries; without them the network never learns of the sale.',
    actsIn: 'postback receiver',
    caughtBy: [8],
    requires: 'M3',
  },
};

const KNOWN = new Set<string>(BREAK_TOGGLES);

/** Parses `__break=a,b,c`. Unknown names are ignored; the result is in canonical order. */
export function parseBreakToggles(value: string | null | undefined): BreakToggle[] {
  if (!value) return [];
  const requested = new Set(
    value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => KNOWN.has(v)),
  );
  return BREAK_TOGGLES.filter((t) => requested.has(t));
}

/** Inverse of parseBreakToggles: canonical order, comma-separated, empty string for none. */
export function serializeBreakToggles(toggles: Iterable<BreakToggle>): string {
  const set = new Set(toggles);
  return BREAK_TOGGLES.filter((t) => set.has(t)).join(',');
}
