// Browser-side Meta Pixel helpers for pages this app serves (the advertorial). The Shopify
// storefront and checkout carry their own copies under shopify/, because pasted code cannot
// import from here.

type Fbq = {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: Fbq;
  loaded: boolean;
  version: string;
};

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

/** Meta's base code, expanded so it can be read, appending to <head> rather than beside the first script tag. */
export function loadMetaPixel(pixelId: string): void {
  if (window.fbq) return;
  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue.push(args);
  } as Fbq;
  fbq.queue = [];
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  window.fbq = fbq;
  if (!window._fbq) window._fbq = fbq;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(script);
  fbq('init', pixelId);
}

/**
 * Fires a pixel event. `eventId === null` deliberately omits the eventID option: that is the
 * `strip_event_id` sabotage, and the only reason a caller should ever pass null.
 */
export function trackMetaEvent(
  name: string,
  params: Record<string, unknown>,
  eventId: string | null,
): void {
  if (!window.fbq) return;
  if (eventId === null) window.fbq('track', name, params);
  else window.fbq('track', name, params, { eventID: eventId });
}

export function newEventId(): string {
  return crypto.randomUUID();
}

/**
 * Injects a Google Tag Manager container script. `dataLayerName` mirrors GTM's optional `l`
 * argument; passing it on one copy and not the other is how two real installs (a theme snippet
 * and an app snippet) usually differ. That difference matters: Chromium coalesces two identical
 * in-flight script URLs into a single fetch, so a byte-identical duplicate is invisible on the
 * wire even though both tags execute.
 */
export function loadGtmContainer(containerId: string, dataLayerName?: string): void {
  const script = document.createElement('script');
  script.async = true;
  const url = new URL('https://www.googletagmanager.com/gtm.js');
  url.searchParams.set('id', containerId);
  if (dataLayerName) url.searchParams.set('l', dataLayerName);
  script.src = url.toString();
  document.head.appendChild(script);
}
