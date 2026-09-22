# Affiliate Tracking Auditor

Paste an affiliate funnel URL and get a pass/fail tracking report with an accuracy score and
the exact broken line, produced by driving the funnel in a real headless browser and checking
every network call. It also reconciles Shopify orders against observed pixel events and
received postbacks and names the order IDs that went missing.

**Live demo:** <https://affiliate-tracking-auditor.vercel.app>

Sixty seconds with it: paste the demo funnel on the landing page and watch the run; open the
report and read the score, the failing checks and the waterfall; run it again with a break-it
switch on and compare; then [`/reconcile`](https://affiliate-tracking-auditor.vercel.app/reconcile)
for the merchant's view of a day of orders, and
[`/funnels`](https://affiliate-tracking-auditor.vercel.app/funnels) for the same funnel audited
daily with one alert when it regresses.

## Tracking teardown: five ways attribution silently breaks on duplicate funnels

A duplicate funnel is a chain of handoffs: affiliate network → advertorial on one domain → a
302 → the store on another domain → checkout → the ad platform, and back to the network. At
every handoff, identity is carried by convention — a query parameter, a cookie, a cart
attribute — and nothing enforces it. When one handoff drops it the page still renders, the
customer still buys, and every dashboard still shows a number. That is what makes these
failures expensive rather than merely annoying: the first symptom is usually an affiliate
asking why their conversions fell off a cliff three weeks ago.

Each one below is reproducible here with a switch, and each is what a particular check exists
to catch.

### 1. The click ID does not survive the redirect

The affiliate sends `?click_id=…` to the advertorial. The redirect that hands the shopper to
the store rebuilds the URL from a template and forwards the UTMs someone remembered to list,
but not the network's click ID — or it forwards it once and a later hop nobody thinks about (a
locale redirect, a trailing-slash canonicaliser, www → apex) eats it.

**Why it is silent:** the UTMs still arrive, so analytics and the store's own reports look
attributed. The only thing missing is the ID the payout is computed from.

**How it shows here:** the trace records every main-frame hop with its query, so check 3 can
name the hop where the value stopped, and check 1 then looks for it on every later page — in
the URL, in cookies, in localStorage, and in what the cart writes. Without the hops, a funnel
that loses the ID at the last redirect looks exactly like one that never had it.
Switch: **Drop click ID on redirect**.

**Fix:** forward it on every hop, and persist it into a first-party cookie the moment the
landing page loads — not at checkout, by which point four redirects have had their chance.

### 2. The UTMs die while the click ID lives

The mirror image, and the one that lasts longer: the network's ID survives — the network
checks — while `utm_source` and `utm_campaign` are dropped somewhere in the chain.

**Why it is silent:** the affiliate is paid, so nobody complains. The sale simply arrives in
analytics as `direct / none`, and the campaign that produced it looks unprofitable next to the
campaigns whose UTMs happen to survive. Budget then moves away from the thing that worked.

**How it shows here:** check 2 compares the UTMs in the landing URL against the attribution
record that exists at checkout, so a partial loss ("source survived, campaign did not") is
reported as exactly that. Switch: **Strip UTMs on redirect**.

**Fix:** carry attribution as one record, written once on landing, instead of as loose
parameters every hop has to remember to re-append.

### 3. The same sale is counted twice

Three routes to it, all ordinary: the pixel fires without an `event_id`; the same container is
loaded twice because the theme includes it and so does the tag manager; or a "fallback" copy of
the event is sent alongside the real one.

**Why it is silent:** nothing errors — there is simply more conversion than there was revenue.
ROAS looks better than it is, which is the direction nobody investigates.

**How it shows here:** check 5 requires `eid` on every standard event, check 7 counts container
IDs per page and PageViews per document, and check 6 compares the browser Purchase's `eid` with
what the server sent for the same order. Deduplication only happens when the event name **and**
the event ID match inside the platform's window, so "we send both browser and server" is not by
itself protection — it is two records hoping to be recognised as one. Switches: **Strip
event_id**, **Double-fire the pixel**, **Duplicate GTM container**, **CAPI event_id mismatch**.

**Fix:** derive the ID from the order (`purchase-<orderId>`), so the browser and the server
compute the same string without having to coordinate.

### 4. The browser reports the sale and the server never does

The pixel fires on the thank-you page, so the ad platform sees the conversion. The affiliate
network never does: the postback returned a 500 and nothing retried it, or it was fired from a
page the customer closed before the request finished.

**Why it is silent:** the ad platform's numbers — the dashboard people actually watch — are
fine. The network's are not, and an unpaid affiliate turns off the traffic rather than filing
a bug report.

**How it shows here:** check 8 reads every attempt recorded for that order, so "sent once, got
a 500, never retried" and "never attempted" are different answers instead of one shrug. The
same join over a whole day of Shopify's own order list is `/reconcile`, which names the order
IDs that went missing and at which stage. Switch: **Postback returns 500**.

**Fix:** send conversions from the server, keyed on the order, with retries and an attempt log.
The browser is the wrong place to guarantee delivery.

### 5. The identity is sent, but not in a form the platform can use

Advanced matching sends the customer's email and phone. If they go unhashed, or hashed without
normalising first (`Buyer@Example.com ` and `buyer@example.com` have different SHA-256s), the
match fails.

**Why it is silent:** the event is still accepted and still counted; only match quality falls,
and match quality is a number nobody has a baseline for. Server-side it is worse, and this
project observed it live: Meta **rejects** a Conversions API event whose `user_data` is not
hashed, so the server half of the funnel disappears while the browser half keeps reporting.

**How it shows here:** check 9 reports the redactor's verdict — present, hashed, which
algorithm, and whether the hash matches the normalised value — without ever storing the value.
In production that sabotaged run also appears in `/reconcile` as `capi_missing`, which is the
silent failure made visible from the merchant's side. Switch: **Send email unhashed**.

**Fix:** normalise, then hash, at the source (trim, lowercase, E.164), and verify against a
known hash in a test rather than by eye.

## Architecture

```
Shopify dev store          Advertorial domain        Auditor
(Liquid + tracking)  --->  (Next.js, redirects)  <-- Playwright worker
       |                          |                        |
       +--------- postbacks ------+                        |
                    |                                      |
              Postback receiver (Next.js API) ----> Postgres <---- Web UI
                                                       ^
                                                    Redis + BullMQ
```

| Piece             | Where                           | Why                                                                                                                                       |
| ----------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`        | Vercel                          | Next.js App Router: dashboard, mock advertorial, postback receiver, API. Stateless, so serverless is a fit.                               |
| `apps/worker`     | Railway                         | Node + Playwright, consumes BullMQ jobs. A headless browser needs a long-lived process with system libraries; Vercel cannot host it.      |
| `packages/checks` | library                         | The check engine as pure functions over a captured trace. Testable without a browser.                                                     |
| `packages/db`     | library                         | Drizzle schema and client. Append-only run and event tables; SQL migrations are committed.                                                |
| `packages/shared` | library                         | Env validation (zod) and the structured logger.                                                                                           |
| `shopify/`        | pasted into a Shopify dev store | The subject under test: attribution snippet, checkout pixel, debug panel. Not deployed by us; see [shopify/README.md](shopify/README.md). |
| Postgres          | Neon                            | Pooled endpoint, because Vercel functions cannot share a connection pool.                                                                 |
| Redis             | Railway                         | Job queue (BullMQ) and rate-limit counters, on the worker's private network.                                                              |

## Demo funnel and break-it panel

The demo funnel is a duplicate affiliate funnel end to end: **advertorial** (`/advertorial`, this
app) → **redirect** (`/go`, a real 302 that forwards `click_id` and UTMs into the store) →
**Shopify dev store** (theme snippet + checkout pixel, see [shopify/README.md](shopify/README.md))
→ Bogus Gateway order.

Start it as an affiliate link would: [`/advertorial?click_id=demo-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo`](https://affiliate-tracking-auditor.vercel.app/advertorial?click_id=demo-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo).

The **break-it panel** on the advertorial sabotages the funnel one realistic failure at a time.
Toggle state travels as `__break=a,b` in the URL, is forwarded by `/go`, captured by the store
snippet like a UTM into the `_aff` cookie and the cart attributes, and read by the checkout
pixel from the cookie (and from M3, by the webhook handler from the order's `note_attributes`).
Nothing is stored server-side; a run is fully described by its URL.

| Toggle           | What breaks                                                       | Verify by hand                                                                                                                                    | Caught by check |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `drop_click_id`  | `/go` forwards UTMs but not `click_id`                            | Store URL has no `click_id`; debug panel `click_id` row is `—`; order has no `click_id`                                                           | 3, 1            |
| `strip_utms`     | `/go` drops `utm_*`                                               | Store URL has `click_id` but no `utm_*`                                                                                                           | 2               |
| `strip_event_id` | All pixel events sent without `event_id`                          | DevTools → Network → `facebook.com/tr`: no `eid=` on PageView/ViewContent; console `[meta-checkout]` lines show `eventID: null`                   | 5, 6            |
| `double_fire`    | Storefront PageView also sent as the `<noscript>` fallback image  | Two `ev=PageView` requests per store page, one without `eid`                                                                                      | 7               |
| `duplicate_gtm`  | Same GTM container loaded twice on the advertorial                | Two `googletagmanager.com/gtm.js?id=GTM-AUD1T0R…` requests                                                                                        | 7               |
| `unhashed_email` | Checkout pixel sends the email in plaintext as a custom parameter | Purchase request has `cd[email]=…` in clear                                                                                                       | 9               |
| `consent_wall`   | Advertorial shows a consent bar; pixel does not load until Accept | No `facebook.com/tr` request on the advertorial until you click Accept                                                                            | 10              |
| `capi_mismatch`  | Server-side Purchase uses a random `event_id`                     | `conversion_attempts` row for the order has an `event_id` that is not `purchase-<orderId>`; Events Manager shows the server event un-deduplicated | 6               |
| `postback_500`   | Postback receiver answers 500                                     | three `conversion_attempts` rows of kind `postback` for the order, all `status_code` 500; no `postback_events` row                                | 8               |

## Postbacks, webhooks and the conversion sender

Two inbound endpoints, both verified against the **raw request bytes** with a constant-time
HMAC-SHA256 compare before anything is parsed, both idempotent through a **unique index plus
`INSERT … ON CONFLICT DO NOTHING`** rather than a check-then-insert (which races):

| Endpoint                                   | Signature                                                 | Dedup key            | Table                    |
| ------------------------------------------ | --------------------------------------------------------- | -------------------- | ------------------------ |
| `POST /api/postback`                       | `X-Postback-Signature`, hex, `POSTBACK_HMAC_SECRET`       | body `postback_id`   | `postback_events`        |
| `POST /api/webhooks/shopify/orders-create` | `X-Shopify-Hmac-Sha256`, base64, `SHOPIFY_WEBHOOK_SECRET` | `X-Shopify-Event-Id` | `shopify_webhook_events` |

Responses: `401` bad or missing signature (body never parsed, never logged); `400` valid
signature but invalid body, with the reasons; `200 {status:"duplicate"}` for a replay, with no
reprocessing; `200 {status:"accepted"}` otherwise.

On an accepted order the app also plays the merchant's **conversion sender** (after the
response is sent): a Conversions API `Purchase` to Meta with `event_id = purchase-<orderId>` —
the same derivation the checkout pixel uses, so Meta deduplicates browser and server — and a
signed S2S postback with `postback_id = pb-<orderId>`. Customer email and phone are normalised
and SHA-256-hashed in memory for Meta and are never stored. Every attempt, success or failure,
is a row in `conversion_attempts` (3 tries, backoff) — the only evidence of S2S traffic the
auditor can have, since a browser never sees it. The reasoning for each of these choices is in
the code: `packages/shared/src/hmac.ts`, `pii.ts`, `postback.ts`, `apps/web/lib/*`.

## Runs: queue and Playwright runner

Paste a URL on `/` → `POST /api/runs` → a BullMQ job → the Railway worker opens the URL in a
fresh Chromium context and walks the funnel: landing → CTA → store → product → add to cart →
cart → checkout. On the demo store — and only there — it continues through Shopify's checkout
with the Bogus Gateway (card `1`) to the thank-you page. Anywhere else it stops at checkout:
completing a stranger's checkout would place a real order. The run's artifact is a **trace**
(`packages/shared/src/run.ts`): every request with its redacted parameters, every main-frame
hop (navigations and redirects, with status), a snapshot per step (which cookies and storage
keys hold the click ID, UTMs, loaded scripts, whether a consent banner is showing), the
`robots.txt` verdict, and how far the funnel got and why. The check engine (M5) reads that and
nothing else.

Design points worth knowing:

- **Idempotent submission.** The form mints an idempotency key when it renders; a double
  submit loses the unique-index race in `runs` and gets the same `run_id`. BullMQ's `jobId`
  is the run id, a second line of defence.
- **Append-only status.** `runs` is the immutable submission, `run_events` is the log
  (queued → running → succeeded | failed | timed_out, one row per transition, retries
  included); the current status is the latest row. `run_traces` is the only table that is ever
  deleted from, by the worker's hourly TTL sweep (7 days, §8).
- **Hard timeout in the worker** (90 s, `Promise.race` + context close), not just in the queue.
  A timed-out run and a blocked URL are terminal, not retried: they are facts about the funnel.
  Infrastructure errors are retried 3× with exponential backoff, then land in `runs-dlq`.
- **A normal Chrome user agent.** Meta's pixel sends nothing to `HeadlessChrome` (found in M2);
  the runner presents the same Chromium as ordinary Chrome and leaves `navigator.webdriver` alone.
- **The order ID is learned from the pixel.** The thank-you page's Purchase hit carries
  `eid=purchase-<orderId>`; the runner reads it the way Meta does, which is what lets M5 join
  the browser trace to the webhook, CAPI and postback rows for the same order.
- **Limits** (`RUN_LIMITS`): 5 runs/hour/IP, 20 queued jobs, 2 concurrent runs, 10 redirect
  hops, 4 000 requests per trace.

## The ten checks

`packages/checks` is pure: `runChecks({ trace, server })` over the run's trace and the M3 rows
for its order, no I/O. Each check answers `pass`, `fail` or `inconclusive` with what it
observed, what it expected, why, and a fix hint. `inconclusive` is the answer whenever the
funnel stopped before the evidence exists (a stranger's funnel never reaches a purchase, so
checks 6 and 8 are inconclusive there) — it is never a `fail`. Score = passes ÷ (passes +
fails). The rationale for every check — what breaks in the real world when it fails — is in
[`packages/checks/README.md`](packages/checks/README.md).

| #   | Check                     | Decided from                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------- |
| 1   | Click ID persistence      | where the expected click ID was found on each page, and cart-attribute writes   |
| 2   | UTM survival              | the query of every hop to the store, then the attribution record at checkout    |
| 3   | Cross-domain handoff      | the first hop whose host changes, and the first store page                      |
| 4   | Pixel load and fire order | first occurrence of PageView → ViewContent → InitiateCheckout → Purchase        |
| 5   | event_id present          | `eid` on every standard pixel event                                             |
| 6   | CAPI dedup match          | browser Purchase `eid` vs the server's `conversion_attempts` row                |
| 7   | Duplicate containers      | container ids per page's scripts; PageViews per document (by time)              |
| 8   | Postback fired            | `postback_events` and every `conversion_attempts` try for the order             |
| 9   | PII hashing               | the redactor's verdicts (`looksHashed`, algorithm, `normalised`) — never values |
| 10  | Consent blocking          | a visible banner on a page from which no pixel event fired                      |

Reports are computed when a run is read, not stored: the server rows arrive seconds after
the run ends, and a report frozen at completion would stay inconclusive about events that
exist. The tests run the engine over real traces of the demo funnel, one per break-it toggle.

### On a funnel that is not ours

The demo funnel is the one case where everything can be decided. A stranger's funnel is the
case that matters, so the tool was smoke-tested against a live DTC supplement storefront
nobody here controls, entered as an affiliate link would enter it.

It returned **4 pass, 1 fail, 5 undecided**. The five undecided are undecided by construction:
no purchase is ever completed off the demo store, so the CAPI and postback checks have nothing
to compare, and the run stopped at the product page — their variant picker needs a selection
the driver does not make — so the click-ID and UTM checks stop short of a cart. The single
failure was real and specific: `fbevents.js` was present on the collection page and not on the
product page, so `ViewContent` never fired. That is an ordinary, expensive defect — it is the
event catalogue retargeting is built on.

That run is also how the driver learned to follow a call to action whose click Playwright
cannot land (a sticky header over the button): it now falls back to the anchor's href, because
what the checks care about is the page the shopper reaches, not the input method.

## The report

`/` is one field and one button, plus the demo funnel with its break-it switches on the same
page, so a reviewer reaches a report without instructions (§6 M6). Submitting posts a plain
form; the run page then polls its own JSON every 2 s, shows the furthest funnel step the worker
has reported (`run_events` rows with a `step`), and re-renders itself once the run is terminal.
The report is one server render from the stored trace and the server rows:

- the **score** (passes ÷ decided) with pass / fail / undecided counts and a one-line verdict;
- **which switches were on**, read from the run's entry URL, and on each failed card the switch
  that caused it — the demo's proof that a toggle is caught by the check that claims it;
- **Fix this first**: the failed check whose fix removes the most downstream failures, in
  root-cause order (redirect handoff → UTMs → persistence → consent → pixel presence →
  duplicates → event ids → hashing → CAPI dedup → postback), not check-number order;
- the ten checks, failures first, each with observed / expected / why / fix;
- a **waterfall** of what the browser saw: every main-frame hop as a bar, every pixel,
  container, cart-attribute and postback request as a mark on the same clock — inline SVG,
  hover for the redacted detail; the ~2 000 other requests stay in the JSON;
- run details (entry URL, what was injected, the CTA rule that matched, robots.txt, the log).

No design system, no chart library, no client state beyond the poller and a copy-link button.
The report URL is the share link.

### When the auditor itself cannot see

Meta's CDN sometimes answers a network with `Cross-Origin-Resource-Policy: same-origin` on
`fbevents.js`, which every browser refuses to run cross-site (`ERR_BLOCKED_BY_RESPONSE`). A
run from such a network sees a pixel that never fires. That is a fact about the auditor's
egress, not the funnel, so check 4 reports it as _undecided_ with that exact reason — the base
code was requested on every page, the script was not served — and the worker's `/health`
carries a `meta_cdn` probe (a real Chromium load at boot) so the condition is visible before
anyone reads a report. First observed 2026-09-21, from two networks at once; the probe reported
the script loading normally again on 2026-09-22. The handling stays, because it is the general
answer to "the auditor could not see this", not a workaround for one outage.

## Reconciliation

`/reconcile?from=&to=` is the merchant's screen: every order Shopify reports for the window
(GraphQL Admin API, the source of truth) against what the tracking chain did for each —

    order → click ID on the order → webhook received → browser Purchase → server Purchase → postback accepted

The first missing stage is the drop-off and explains everything after it; the page names the
order, the stage, and why. Sources: the Admin API for orders (`customAttributes` only — the
query requests no customer fields, which is the PII boundary), `shopify_webhook_events`,
`run_traces` (the order id the runner learned from the Purchase pixel), `conversion_attempts`
and `postback_events`. The join is pure (`packages/checks/src/reconcile.ts`).

Two honesty rules. A real customer's order was watched by no browser, so its browser column
is _not watched_, never _missing_; only orders the auditor's own runner placed (recognised by
its synthetic checkout email, `audit-<run>@example.com`, recorded as a run prefix on the
webhook row — the email itself is never stored) can be _missing_. And the Admin client reads
`extensions.cost.throttleStatus` from every response and waits for the bucket to refill
before the next page, rather than hitting the 429; a 429 is honoured via `Retry-After`.

Needs `SHOPIFY_ADMIN_TOKEN` (a custom app with the `read_orders` scope only); without it the
page says so.

## Saved funnels, daily runs, one alert

Any finished report can be **saved for daily audits**. The worker registers one BullMQ job
scheduler (`0 6 * * *` UTC); its tick submits one run per saved funnel with the key
`daily:<funnel>:<date>` — `runs.idempotency_key` is unique, so a second tick, a redeploy or a
second worker reads the existing run and enqueues nothing. When a saved funnel's run finishes,
a delayed **scoring job** (its own queue, so a 90-second wait for the order's webhook rows
cannot stall the run job) computes the report, appends it to `funnel_scores` (unique per run),
and compares it with the previous score:

- **fires** when the score dropped by ≥ 20 points, or any check went pass → fail;
- **does not fire** on the first run (no baseline), on inconclusive → fail (missing evidence
  is not a regression), or on a fail that stays a fail.

"Exactly one alert" is a database fact, not a code path: the `alerts` row is claimed under a
unique `(funnel, run)` index before the webhook is sent, so only the process that won the
insert sends it. The webhook is one JSON POST, one attempt, five seconds
(`ALERT_WEBHOOK_URL`; optionally signed with `ALERT_WEBHOOK_SECRET`); the body carries
`content` and `text` so a Discord or Slack incoming webhook renders the summary line as-is.
Delivery status is written back onto the alert row — the single UPDATE in the schema.

`/funnels/<id>` shows the score trend (inline SVG), a check-by-run grid, the alerts, and
**Run now** — optionally with a break-it toggle applied to that run only, which is how "the
funnel broke today" is demonstrated without editing the store.

## PII handling

The runner watches a live funnel's traffic, so on a reviewer's own store it is watching their
customers. The rules from PROJECT_CONTEXT §8, and how they are met:

- **Redacted at capture, never at display.** `packages/shared/src/redact.ts` runs inside the
  worker's request handler; the raw body is turned into a parameter map on the same tick and
  dropped. Nothing reaches Postgres that has not been classified.
- **What a PII parameter becomes:** `{ present: true, looksHashed, hashAlgoGuess, normalised }`
  — never the value, never a prefix. A parameter is PII when its _name_ says so (`em`, `ph`,
  `fn`, `ln`, `email`, `phone`, `first_name`, `address`, `zip`, `external_id`… in any nesting)
  **or** its _value_ looks like an email or a phone number under any name — the second test is
  what catches a plaintext email leaking as a custom parameter. Credential-looking names
  (`token`, `secret`, `api_key`, `signature`…) keep only `{ present: true }`.
- **`normalised` is judged, not guessed.** Only for the identity the runner itself typed at
  checkout can a hash be compared with `sha256(trim(lowercase(email)))`; a match is `true`, a
  match against the raw spelling is `false`, anything else is `null`.
- **Cookies and storage:** names are recorded; values only for the `_aff` record we define.
  For every other cookie the trace records whether its value _contains_ the expected click ID,
  which is the evidence check 1 needs and nothing more.
- **Bodies are never stored**, only their parsed parameter map, kind and size. Response bodies
  are not read at all.
- **URLs** in the trace go through the same classifier (`redactUrl`), including the one you
  submitted. The rate limiter keys on a hash of the client address, so Redis holds no IPs.
- **Free text is redacted too.** An error message is prose that quotes the thing that failed:
  Playwright writes `page.goto: net::ERR_ABORTED at https://shop/checkout?email=…`, a checkout
  banner quotes the address that was typed into it, and Meta's API quotes the parameter it
  rejected. All three are stored, so all three go through `scrubText` first — it rewrites every
  URL in the text through `redactUrl`, removes anything the runner typed, and removes bare
  email and phone shapes. Being an error is not an exemption.
- **TTL:** traces expire after 7 days and are deleted by the worker.

Every column that holds text derived from a run, and what keeps it safe:

| Column                                                 | What it holds                                 | What redacts it                                                  |
| ------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| `runs.url`, `funnels.url`, `funnels.label`             | the submitted URL                             | `redactUrl` at submission and at save                            |
| `run_events.detail`                                    | step, host, counts, failure text              | `scrubText` on every error before it is a value                  |
| `run_traces.trace.requests[].params`                   | every query and body parameter                | `classifyParam`: value, `pii{…}` or `secret{…}`                  |
| `run_traces.trace.requests[].url`                      | origin + path only                            | the query never leaves `params`                                  |
| `…steps[].cookies`                                     | cookie names; value only for `_aff`           | names are not values; `foundIn` records containment, not content |
| `…steps[].localStorageKeys`                            | key names only                                | values are never read                                            |
| `…steps[].title`, `…outcome.stopReason`                | page title, why the run stopped               | `scrubText`                                                      |
| `…steps[].scripts`, `…hops[].from`/`to`, `…redirectTo` | URLs                                          | `redactUrl`, told what the runner typed                          |
| `conversion_attempts.error`                            | the rejection body from Meta or the receiver  | `scrubText`                                                      |
| `shopify_webhook_events`                               | order id, name, total, attribution attributes | the handler never reads customer fields from the payload         |
| `postback_events`, `funnel_scores`, `alerts`           | ids, statuses, check names, percentages       | generated here; no funnel content                                |

The invariant is enforced by a test, not by this table: `apps/worker/test/trace-redaction.test.ts`
drives the collector with a typed identity in a hashed pixel parameter, a masked field copy, a
JSON telemetry body, a multipart body, a navigation URL and a search query, then searches the
whole serialised trace — the same JSON that goes to Postgres — for anything the runner typed
and for anything shaped like an email or a phone number. A field added later that forgets to
redact fails it without anyone having predicted which field it would be.

## Abuse prevention

A public tool that drives arbitrary URLs is a proxy into whatever network it runs in unless it
is fenced. PROJECT_CONTEXT §9, and how each rule is enforced:

- **SSRF, at submission:** `checkTargetUrl` (`packages/shared/src/ssrf.ts`) allows only
  http/https on default ports, refuses `localhost`/`.internal`/`.local` and IP literals in
  private, link-local, CGNAT, multicast and reserved ranges (Node's `net.BlockList`, IPv4-mapped
  IPv6 unwrapped), then resolves the name and refuses it if **any** address is private.
- **SSRF, at every hop:** Chromium follows redirects internally — Playwright's request routing
  never sees the redirected request (verified here: a 302 to a blocked host was followed even
  after `route.abort()`). So the worker launches Chromium against its own **egress proxy**
  (`apps/worker/src/egress-proxy.ts`): every connection, including redirect targets, pixels
  and iframes, arrives as a `CONNECT` or absolute-form request, is resolved and vetted there,
  and is opened to the address that was checked. A refused hop shows in the trace as
  `blocked` with the reason. Connecting to the vetted address also closes the DNS-rebinding
  window for that connection.
- **Rate limit:** 5 requests per hour per client address (a fixed window in Redis — `EXPIRE NX`,
  so the window does not slide forward on every hit), checked before the DNS lookup so a flood
  cannot use the auditor as a resolver. It applies to all three endpoints that can start work:
  submitting a URL, saving a funnel, and "run now" on a saved funnel. The key is a hash of the
  address, so Redis holds no IPs. **Global cap:** 20 queued jobs → 503, on the same three
  endpoints; 2 concurrent runs per worker.
- **A cap on saved funnels (25).** Saving a funnel is the one public action with a permanent
  cost: each saved funnel is a browser run every day for as long as the deployment lives. A
  per-IP rate limit bounds how fast funnels can be added, not how many exist, so the total has
  its own cap and the daily schedule's work is bounded by it.
- **Hard timeout:** 90 s per run, enforced in the worker by closing the browser context.
- **robots.txt** is fetched and evaluated for the landing path and the verdict is shown in the
  report; it does not stop a run, because the person submitting a URL is meant to be its owner.
- **Purchases only on the demo store.** The job carries the one host where checkout may be
  completed; everywhere else the run ends at the checkout page.

The two guards with the most ways to be subtly wrong have tests named after them:
`packages/shared/test/ssrf.test.ts` (every blocked range, IPv4-mapped IPv6, a name where only
one of two addresses is private, a URL that does not resolve), `apps/worker/test/egress-proxy.test.ts`
including the redirect hop — a 302 to `169.254.169.254` refused when the browser follows
it, which is the hop no browser-side hook sees — and `apps/web/lib/__tests__/rate-limit.test.ts`
(the fixed window, the per-client counting, and a Redis failure surfacing instead of being read
as "allowed").

Known limits, stated rather than hidden: the proxy filters by destination, not by content of
a TLS tunnel; a funnel that legitimately lives on a non-standard port is refused; the
`ALLOW_PRIVATE_TARGETS` switch exists for local development and is rejected by the env schema
when `NODE_ENV=production`.

## Production readiness

Production grade here means correct, recoverable and observable. It does not mean built for
scale, and no scale infrastructure was added — for a tool whose throughput is two concurrent
browsers, that would be decoration. What exists, and why:

**Correct at the boundaries.**

- Every inbound webhook and postback is verified before it is believed: HMAC over the **raw**
  body (parse after verifying, never before), a constant-time compare, and a unique index on
  the sender's own event ID so a replay is a no-op rather than a second conversion
  (`app/api/postback`, `app/api/webhooks/shopify/orders-create`).
- Idempotency at three layers, because each covers a different failure: the submission key (a
  double-clicked form is one run), BullMQ's `jobId` (a re-enqueue is refused), and unique
  indexes on `postback_id`, Shopify's `event_id`, `funnel_scores.run_id` and
  `(funnel_id, run_id)` for alerts. Every one of them decides the race in the database, never
  from a prior `SELECT`.
- Every boundary is parsed with zod — form → API, API → queue, worker → database. A trace the
  check engine could not read fails in the worker, loudly, instead of becoming a bad report.

**Recoverable.**

- Runs retry three times with exponential backoff and then land in a dead-letter queue with
  their reason. A timeout is terminal on purpose: retrying a 90-second browser run that may
  already have placed an order is worse than failing it.
- The schema is append-only apart from a single `UPDATE`, which records an alert's delivery
  outcome — and only after the alert row has been claimed, because that unique index is what
  makes "exactly one alert per regression" true under retries.
- Migrations are committed SQL (`drizzle-kit generate`), applied as an explicit step, never
  `push`. Nothing runs migrations at boot.
- Conversions are sent server-side with one row per attempt, so a failure is a record instead
  of a gap — which is what lets check 8 distinguish "tried and was refused" from "never tried".

**Observable.**

- Structured JSON lines carrying `service`, `version` and `run_id`, with timed spans for each
  run; the run's own event log is append-only and is shown on the report.
- `/api/health` and the worker's `/health` report database, Redis, browser, queue depth and the
  deployed commit. The commit is not decoration: it is how a version skew between the web app
  and the worker becomes visible at all. The worker's health also probes Meta's CDN, because an
  outage there changes what the checks can honestly conclude.

**Guarded.** SSRF in three layers plus the egress proxy that every connection passes through,
a per-IP rate limit, a global queue cap, a cap on saved funnels, a 90-second hard timeout, PII
redacted at capture and held to it by an invariant test, secrets scanned pre-commit and in CI
with a documented rotation procedure. The two sections above say how each works.

**Deliberately not built:**

| Not built                            | Why                                                                                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and auth                    | The tool has to be usable by a stranger with a URL (§4). The cost is that every guard has to hold for anonymous traffic — which is why the caps exist and why they are tested.                                                            |
| Multi-tenancy                        | There is one tenant. Ownership columns and an authorisation surface would be real complexity protecting nothing.                                                                                                                          |
| Autoscaling, sharding, read replicas | The workload is two browsers at a time. The queue is the throttle and a 503 at the cap is the honest answer to overload; a bigger cluster would only fail later and more expensively.                                                     |
| A caching layer                      | Reports are computed on read — the server-side rows arrive seconds after the browser finishes, so a report frozen at completion would be permanently undecided about events that exist. Computing takes milliseconds over a stored trace. |
| APM, distributed tracing, dashboards | The only question this system is ever asked is "what happened to this run", and the event log, the trace and two health endpoints answer it.                                                                                              |
| A client-side app                    | Forms are plain HTML posts and pages are server-rendered, so the tool works with JavaScript disabled. The only client components are the status poller, the copy-link button and the break-it panel.                                      |
| Deleting or editing history          | Runs, events, orders and alerts are facts about the past. Only expired traces are deleted, by the TTL job.                                                                                                                                |

## Local setup

Prerequisites: Node 24 (`.nvmrc`), pnpm 12 (`corepack enable` or `npm i -g pnpm@12`), Docker,
and [gitleaks](https://github.com/gitleaks/gitleaks#installing) for the pre-commit hook. Any
gitleaks 8.x works; the hook handles both the current `gitleaks git` CLI and the older
`gitleaks protect` one that distro packages (Ubuntu 24.04: 8.16) still ship.

```sh
git clone <repo> && cd <repo>
git config core.hooksPath .githooks          # pre-commit secret scan
pnpm install
cp .env.example .env                         # local defaults match docker-compose.yml
ln -s ../../.env apps/web/.env               # Next reads env from its own directory
docker compose up -d                         # Postgres on :5433, Redis on :6380
pnpm --filter @auditor/worker exec playwright install chromium
pnpm dev                                     # web on :3000, worker health on :8080
```

Then `curl localhost:3000/api/health` and `curl localhost:8080/health` should both return 200.
If a port is taken, Next moves itself to the next free one (read its log line); move the worker
with `WORKER_PORT=8090` in `.env`.

To audit the local demo funnel end to end, set `ALLOW_PRIVATE_TARGETS=true` in `.env` (the SSRF
guard would otherwise refuse `localhost`; production rejects the flag) and, for the purchase
leg, `SHOPIFY_STOREFRONT_PASSWORD`. Then submit `http://localhost:3000/advertorial` on `/`,
or: `curl -X POST localhost:3000/api/runs -H 'content-type: application/json'
-d '{"url":"http://localhost:3000/advertorial","idempotency_key":"local-1"}'` and open
`/runs/<run_id>`.

Other commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format`,
`pnpm db:generate` (write a migration from schema changes), `pnpm db:migrate` (apply them).

The worker runs its TypeScript directly under Node 24's built-in type stripping; there is no
build step, and `tsc` is used only to type-check.

## Deploy

- **Vercel** (web): import the repo, set Root Directory to `apps/web`, add `DATABASE_URL`
  (Neon pooled string), `SHOPIFY_STORE_DOMAIN`, `META_PIXEL_ID`, and set
  `ENABLE_EXPERIMENTAL_COREPACK=1` so the pnpm version comes from `package.json`. Env is
  validated at boot, so a module that introduces a variable must have it set **before** its
  branch merges, or every route (including `/api/health`) fails fast until it is.
- **Railway** (worker): create a service from the repo; `railway.json` points it at
  `apps/worker/Dockerfile` and `/health`. Add a Redis service and set `REDIS_URL` to its
  private URL. Railway injects `PORT`. From M4 the worker also needs `DATABASE_URL` (the same
  Neon pooled string) and, for the demo store, `SHOPIFY_STOREFRONT_PASSWORD`; and the Redis
  service needs its **TCP proxy** enabled so Vercel can reach it (its `REDIS_PUBLIC_URL` becomes
  the web app's `REDIS_URL`). The proxy is password-only, no TLS — acceptable for a demo,
  listed under Production readiness.
- **Neon**: create a project, use the pooled connection string as `DATABASE_URL`.

Env vars added per module (all validated at boot, so set them **before** merging the module):
M2 `SHOPIFY_STORE_DOMAIN`, `META_PIXEL_ID`; M3 `POSTBACK_HMAC_SECRET`, `SHOPIFY_WEBHOOK_SECRET`,
`META_CAPI_TOKEN`, optional `META_TEST_EVENT_CODE`; M4 web `REDIS_URL`, worker `DATABASE_URL`
and optional `SHOPIFY_STOREFRONT_PASSWORD`.

Migrations are applied by hand from a machine with the production `DATABASE_URL`:
`DATABASE_URL=... pnpm db:migrate` (a variable set in the shell takes precedence over `.env`).

### Secrets and rotation

All secrets live in environment variables and are validated at boot
(`packages/shared/src/env.ts`), so a missing or malformed one fails the deploy rather than the
first request that needs it. None are committed: `.env` is ignored, the pre-commit hook runs
`gitleaks` on the staged diff and refuses to run if `gitleaks` is not installed (a scanner that
silently skips is not a scanner), and CI re-scans the **full history** on every push, because a
hook can be bypassed locally.

| Secret                                       | Set in                 | What it protects                                                                   | Rotating it                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTBACK_HMAC_SECRET`                       | Vercel                 | signs and verifies `/api/postback`; without it anyone could post a fake conversion | `openssl rand -hex 32`, set, redeploy. Signer and verifier are the same deployment, so both halves change at once; a postback in flight during the swap fails and is retried (each try is a `conversion_attempts` row). |
| `SHOPIFY_WEBHOOK_SECRET`                     | Vercel                 | proves an `orders/create` POST is really Shopify's                                 | Regenerate in Shopify (Settings → Notifications → the webhook), set, redeploy. Shopify retries a failed delivery for 48 h, so nothing is lost if the redeploy is not instant.                                           |
| `META_CAPI_TOKEN`                            | Vercel                 | permission to send server-side Purchases to the dataset                            | Issue a second system-user token in Events Manager, set it, redeploy, **then** revoke the old one. Both are valid meanwhile, so there is no gap.                                                                        |
| `SHOPIFY_ADMIN_TOKEN`                        | Vercel (optional)      | `read_orders` for `/reconcile`                                                     | Regenerating it in the custom app kills the old one immediately; `/reconcile` says what is missing until the new value is deployed. Nothing else depends on it.                                                         |
| `SHOPIFY_STOREFRONT_PASSWORD`                | Railway (optional)     | the dev store's password page                                                      | Change in Shopify, set, redeploy. Only the demo store's runs use it.                                                                                                                                                    |
| `ALERT_WEBHOOK_SECRET` / `ALERT_WEBHOOK_URL` | Railway (optional)     | signs outgoing alerts (`x-auditor-signature`)                                      | Change on the receiver first, then here. An alert that fails to deliver is still recorded in `alerts`, with the failure in `delivery_error`.                                                                            |
| `DATABASE_URL`                               | Vercel **and** Railway | everything stored                                                                  | Reset the role's password in Neon, then update both services. Use the **unpooled** host for migrations and the pooled host for the apps.                                                                                |
| `REDIS_URL`                                  | Vercel **and** Railway | the queue and the rate-limit counters                                              | Rotate the password in Railway, update both. Vercel gets the TCP-proxy URL, the worker keeps the private-network one.                                                                                                   |

If a secret is ever exposed, rotate it **at its source first** — in Shopify, Meta, Neon or
Railway — so the leaked value stops working, and only then update the deployments. A secret
that reached a public commit is burned even after the commit is removed, because clones and
caches keep it; rotation is the only fix, and `gitleaks detect` over the full history says
whether it happened. After any rotation, `/api/health` and the worker's `/health` are the two
URLs that say whether the new values took.
