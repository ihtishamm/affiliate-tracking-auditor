// Names and rules shared by every party that touches attribution data: the storefront snippet,
// the checkout pixel, the conversion sender (M3), the runner (M4) and the checks (M5).
//
// The Liquid and JS files under shopify/ are pasted into Shopify and cannot import this module.
// Each carries a copy marked "mirrors packages/shared/src/tracking.ts". Change both or neither.

/** The affiliate network's click identifier, as it appears in the landing URL and on the order. */
export const CLICK_ID_PARAM = 'click_id';

export const UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

/** Meta's own click identifier, appended by Facebook/Instagram to outbound ad links. */
export const META_CLICK_PARAM = 'fbclid';

/** Every URL parameter the snippet captures, persists, and writes onto the cart. */
export const ATTRIBUTION_PARAMS = [CLICK_ID_PARAM, ...UTM_PARAMS, META_CLICK_PARAM] as const;
export type AttributionParam = (typeof ATTRIBUTION_PARAMS)[number];

export const ATTRIBUTION_COOKIE = '_aff';
export const ATTRIBUTION_STORAGE_KEY = 'aff_attribution';
export const ATTRIBUTION_TTL_DAYS = 30;

/**
 * The Meta `event_id` for a Purchase, derived from the Shopify order ID.
 *
 * Meta deduplicates a browser-side pixel event against a server-side CAPI event only when both
 * carry the same `event_id`. The browser pixel (shopify/pixels/meta-checkout.js) and the server
 * (M3 webhook handler) never communicate, but both observe the order ID, so both can compute
 * this value independently and arrive at the same string. A random UUID would make the two
 * events look like two purchases.
 *
 * Accepts either the numeric ID the Admin API and webhooks use (`5592397545769`) or the GID the
 * Web Pixels API exposes (`gid://shopify/OrderIdentity/5592397545769`); both reduce to the digits.
 */
export function purchaseEventId(orderId: string | number): string {
  const digits = /\d+$/.exec(String(orderId))?.[0];
  if (!digits) {
    throw new Error(`purchaseEventId: no numeric order ID in "${String(orderId)}"`);
  }
  return `purchase-${digits}`;
}
