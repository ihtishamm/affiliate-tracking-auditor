# Shopify dev store — the subject under test

Everything in this directory is pasted into a Shopify development store by hand. Nothing here is
deployed by CI; the store is the funnel the auditor drives, not part of the auditor.

| File                                | Where it goes                                 | Runs on                                 |
| ----------------------------------- | --------------------------------------------- | --------------------------------------- |
| `snippets/aff-tracking.liquid`      | Online Store → Themes → Edit code → Snippets  | every storefront page                   |
| `sections/attribution-debug.liquid` | Online Store → Themes → Edit code → Sections  | product + cart pages (via theme editor) |
| `pixels/meta-checkout.js`           | Settings → Customer events → Add custom pixel | checkout + thank-you page               |

Why two code paths: theme Liquid cannot run on checkout or the order-status page. The snippet
handles attribution capture and the storefront pixel events; the custom pixel handles the two
checkout events. Neither fires an event the other does.

## One-time setup (≈ 30 minutes, click order)

### 1. Development store

1. <https://partners.shopify.com> → sign up (free) → **Stores** → **Add store** → **Create development store**.
2. Type **Dev**, plan **Basic**, name it anything (`auditor-demo`). Tick **Generate test data** (sample products _and_ a pre-installed Bogus Gateway). Leave **Test a feature preview** unticked — previews change platform behaviour, and the store should behave like a real merchant's.
3. Open the store admin. **Online Store → Themes → Draft themes → Horizon → Publish.** Horizon is Shopify's current flagship theme; the generated `test-data` theme is a bare test harness and `debut-vintage-theme` predates the section architecture the debug panel needs.

### 2. Make the storefront reachable and buyable

1. **Storefront password.** A development store's password page cannot be removed without picking a paid plan ("Unlock your online store"). Find the password under **Online Store → Preferences → Password protection**; you type it once per browser session when testing. The auditor's runner (M4) submits it itself for this store — a real merchant's funnel has no such page, so this stays dev-store-only behaviour, kept out of the check logic.
2. **Settings → Payments** → confirm **(for testing) Bogus Gateway** is active; the generated test data installs it. If it is missing: _Add payment methods_ → search "Bogus" → Activate.
   Test cards at checkout: number `1` = approved, `2` = declined, `3` = gateway error. Any name, any future expiry, any CVV.
3. **Online Store → Customize** (Horizon) → open a product page → in the left panel expand **Product information → Details → Buy buttons** → click the **eye icon** on the **Accelerated checkout** child block to hide it → Save. (Horizon exposes the dynamic checkout button as its own block rather than a checkbox; a hidden block does not render.)
   _Why:_ "Buy it now" skips the cart, and cart attributes are how the click ID reaches the order. With those buttons on, a shopper can complete a purchase that carries no attribution — a real-world leak, not a demo artefact.

### 3. Theme code

**Online Store → Themes → Horizon ⋯ → Edit code** — check the theme name at the top of the editor; do not edit `test-data`.

1. **Snippets → Add a new snippet** → name `aff-tracking` → paste `snippets/aff-tracking.liquid` → Save.
2. **Layout → theme.liquid** → directly before `</head>` add one line, with your Meta Pixel ID:
   ```liquid
   {% render 'aff-tracking', meta_pixel_id: '123456789012345' %}
   ```
   Save.
3. **Sections → Add a new section** → name `attribution-debug` → paste `sections/attribution-debug.liquid` → Save.
4. **Customize** → page dropdown → Products → **Default product** (the template assigned to all products) → **Add section → Attribution debug**. Page dropdown → **Cart** → same. Save. (Adding it to the **Header** group instead puts it on every page, which is also fine for a demo store.)

### 4. Checkout pixel

1. **Settings → Customer events → Add custom pixel** → name `meta-checkout`.
2. Customer privacy: **Permission: Not required**, **Data sale: Does not qualify as data sale**. (The dev store has no consent banner; with the default _Required_ the pixel would never fire.)
3. Paste `pixels/meta-checkout.js`, replace `PASTE_YOUR_PIXEL_ID` with your Meta Pixel ID → **Save** → **Connect**.

### 5. Meta Pixel ID

1. <https://business.facebook.com/events_manager> → **Connect data sources → Web → Connect** → name it (`auditor-demo`) → Create.
2. Choose **Meta Pixel only** (skip the partner integration and the Conversions API for now; the CAPI token is set up in M3).
3. The 15–16 digit **Dataset ID / Pixel ID** shown at the top is what both code files need.
4. Keep the **Test events** tab open while you test: events appear there within seconds, with their event IDs.

### 6. Order webhook (M3)

1. **Settings → Notifications → Webhooks** (scroll to the bottom of Notifications) → **Create webhook**.
2. Event **Order creation**, format **JSON**, URL `https://affiliate-tracking-auditor.vercel.app/api/webhooks/shopify/orders-create`, latest API version → Save.
3. The Webhooks section now shows _"Your webhooks will be signed with …"_ followed by a secret. That is `SHOPIFY_WEBHOOK_SECRET` — one secret per store, shared by all its webhooks. Set it in Vercel (and locally) **before** merging M3, or the whole app fails env validation at boot.
4. **Send test notification** on the webhook row delivers a sample order; it should answer 200 and appear in `shopify_webhook_events`.

### 7. Conversions API token (M3)

**Events Manager → Datasets → your dataset → Settings → Conversions API → Generate access token.**
That is `META_CAPI_TOKEN`; it is a secret. The **Test events** tab shows a code such as
`TEST63632`; set it as `META_TEST_EVENT_CODE` so server-side Purchases appear in that tab next to
the browser ones, marked as deduplicated when the `event_id`s match.

## Verifying M1 (the done criterion)

1. Visit the storefront with attribution parameters (enter the store password if asked):
   ```
   https://<your-store>.myshopify.com/?click_id=test-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo
   ```
2. Open a product. The **Attribution debug** panel shows `test-001` under **cookie** and **storage**; **cart** stays `—` while the cart is empty (Shopify does not keep attributes on an empty cart, so the snippet does not try). DevTools → Network → filter `facebook.com/tr` shows `PageView` and `ViewContent`, each with `eid=` (the event_id) and `cd[click_id]=test-001`.
3. **Add to cart** → open the **Cart** page. All three columns now show `test-001`: the snippet re-applied the attributes the moment the cart came into existence.
4. **Check out**. Any address, email like `test@example.com`. Payment: Bogus Gateway, card number `1`. Place the order. With DevTools → Console open, the pixel logs `[meta-checkout] InitiateCheckout` and `[meta-checkout] Purchase {eventID: 'purchase-<order id>'}`.
5. **Admin → Orders → the new order → Additional details** (right column, near Notes): `click_id: test-001`, `utm_source: affiliate`, … ✅ _This is the done criterion._
6. **Events Manager → Datasets → your pixel → Test events**: `PageView`, `ViewContent`, `InitiateCheckout`, `Purchase`; the Purchase event ID reads `purchase-<order id>`. (Only the browser you opened Test events from is shown there; another browser's events reach the pixel but are not tagged as test traffic.)

If step 5 shows no Additional details card, the attributes never reached the cart: check the Network tab for `cart/update.js` after the add-to-cart and look at its status.

## Break-it toggles (M2)

Both pasted files read the `__break` value (a comma-separated toggle list) that the snippet
captures from the URL and writes as a cart attribute. In the snippet: `strip_event_id` sends
events without an `event_id`, `double_fire` fires PageView twice. In the pixel:
`strip_event_id` as above, `unhashed_email` adds the customer email as a plaintext custom
parameter to Purchase. After pulling M2, re-paste `snippets/aff-tracking.liquid`,
`sections/attribution-debug.liquid` (new `__break` row) and `pixels/meta-checkout.js`.

## What the dev store taught us (kept for the README teardown)

- **Shopify discards attributes written to an empty cart.** Order #1002 arrived with no attribution after a land → quick-add → checkout flow. The snippet now syncs only when the cart has items and re-applies attributes after every `/cart/add`.
- **Horizon prerenders pages on hover** (Speculation Rules), and scripts run inside the prerender. Without a `document.prerendering` guard, PageView fired for pages that were never shown — bursts of three in three seconds.
- **Meta's minified base code assumes a `<script>` tag exists** to insert next to. Shopify's pixel sandbox is a bare document; the pixel loader now appends to `<head>`/root instead.
- **Shopify's pixel editor lints against a fixed globals list**: bare `crypto` is flagged; `window.crypto` is not.
- **Meta's pixel does not fire in headless Chrome.** With `HeadlessChrome` in the user agent, `fbevents.js` loads, drains its queue and sends nothing; with a normal Chrome UA (and `navigator.webdriver` still `true`) it fires. The auditor's runner (M4) must present a regular UA or every pixel check would fail on healthy funnels.
- **Shopify's "Send test notification" order has an id above 2⁵³.** `820982911946154508` is rounded by `JSON.parse` before any code can see it, and zod's `int()` rightly refused the rounded number — the first test notification in production was a 400. The receiver now reads the id from the string `admin_graphql_api_id` (int64-safe) and only trusts the numeric field while it is still a safe integer.
- **Chromium coalesces identical in-flight script URLs.** Two byte-identical `<script src>` tags for one GTM container produce one network request; the `duplicate_gtm` toggle varies the second URL (`&l=dataLayer`, as a theme+app pair would) so both are observable on the wire.
