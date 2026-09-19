// meta-checkout.js — Meta Pixel events for checkout and the thank-you page.
//
// Paste into Shopify admin → Settings → Customer events → Add custom pixel. Set PIXEL_ID below.
//
// Why this exists separately from the storefront snippet: theme Liquid cannot run on checkout or
// the order-status page. Shopify's Web Pixels API is the only supported way to observe those
// pages, and custom pixels run in a sandboxed iframe with their own document — which is enough
// to load fbevents.js and call fbq().
//
// Division of labour (strict, so no event is fired twice):
//   storefront snippet  → PageView, ViewContent            (shopify/snippets/aff-tracking.liquid)
//   this pixel          → InitiateCheckout, Purchase
// `page_viewed` is deliberately NOT subscribed: the Web Pixels API delivers it for storefront
// pages too, and handling it here would double-fire PageView against the snippet.
//
// Known limitation worth stating in an interview: the sandbox is a different origin, so the
// `_fbp` cookie fbevents.js sets here is not the storefront's `_fbp`. Meta will see two browser
// IDs for one shopper. Deduplication does not depend on `_fbp`; it depends on event_id.

const PIXEL_ID = 'PASTE_YOUR_PIXEL_ID';

// mirrors packages/shared/src/tracking.ts
const CLICK_ID_ATTRIBUTE = 'click_id';

// mirrors purchaseEventId() in packages/shared/src/tracking.ts — read the rationale there.
// The webhook handler (M3) derives the identical string from the order ID, which is what lets
// Meta collapse the browser Purchase and the server Purchase into one conversion.
function purchaseEventId(orderId) {
  const digits = /\d+$/.exec(String(orderId));
  return digits ? 'purchase-' + digits[0] : null;
}

// Shopify's pixel editor lints against a fixed list of globals and flags bare `crypto` as
// undefined (it exists at runtime); reaching it through `window` keeps the editor happy.
function randomEventId() {
  const c = window.crypto;
  return c && c.randomUUID
    ? c.randomUUID()
    : 'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

function attribute(checkout, name) {
  const found = (checkout.customAttributes || []).find((a) => a.key === name);
  return found ? found.value : undefined;
}

function contents(checkout) {
  return {
    content_type: 'product',
    content_ids: (checkout.lineItems || []).map((li) => String(li.variant && li.variant.id)),
    num_items: (checkout.lineItems || []).reduce((n, li) => n + (li.quantity || 0), 0),
    value: Number(checkout.totalPrice && checkout.totalPrice.amount),
    currency: checkout.currencyCode,
  };
}

// Meta's base code, expanded, with one deliberate change. The minified original inserts
// fbevents.js *next to the first existing <script> tag*; the pixel sandbox is a bare iframe that
// may have none, and the resulting TypeError would kill this file before anything subscribes.
// Appending to <head> (or the root element) works in any document.
function loadMetaPixel() {
  if (window.fbq) return;
  const n = (window.fbq = function () {
    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
  });
  if (!window._fbq) window._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = '2.0';
  n.queue = [];
  const t = document.createElement('script');
  t.async = true;
  t.src = 'https://connect.facebook.net/en_US/fbevents.js';
  (document.head || document.documentElement).appendChild(t);
}

// One line per event in the browser console (Shopify prefixes it with the pixel name), so a
// person with DevTools open can see what the sandbox sent without a Meta login.
function send(name, params, eventID) {
  fbq('track', name, params, { eventID: eventID });
  console.info('[meta-checkout] ' + name, { eventID: eventID, click_id: params.click_id });
}

// Subscribe first, load second: a failure inside the pixel loader must not cost us the events.
analytics.subscribe('checkout_started', (event) => {
  const checkout = event.data.checkout;
  const clickId = attribute(checkout, CLICK_ID_ATTRIBUTE);
  send(
    'InitiateCheckout',
    Object.assign(contents(checkout), clickId ? { click_id: clickId } : {}),
    randomEventId(),
  );
});

analytics.subscribe('checkout_completed', (event) => {
  const checkout = event.data.checkout;
  const clickId = attribute(checkout, CLICK_ID_ATTRIBUTE);
  const orderId = checkout.order && checkout.order.id;
  const eventID = purchaseEventId(orderId) || randomEventId();

  // Advanced matching. fbevents.js normalises (lower-case, trim; digits only for phone) and
  // SHA-256 hashes these before they leave the browser; the network shows ud[em]=<hash>. This is
  // the hashed-PII behaviour the auditor's PII check (M5, check 9) verifies.
  if (checkout.email || checkout.phone) {
    const userData = {};
    if (checkout.email) userData.em = checkout.email;
    if (checkout.phone) userData.ph = checkout.phone;
    fbq('init', PIXEL_ID, userData);
  }

  const purchase = contents(checkout);
  if (clickId) purchase.click_id = clickId;
  if (orderId) purchase.order_id = String(orderId);
  send('Purchase', purchase, eventID);
});

try {
  loadMetaPixel();
  fbq('init', PIXEL_ID);
} catch (err) {
  console.error('[meta-checkout] pixel failed to load', err);
}
