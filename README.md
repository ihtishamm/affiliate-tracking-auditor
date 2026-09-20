# Affiliate Tracking Auditor

Paste an affiliate funnel URL and get a pass/fail tracking report with an accuracy score and
the exact broken line, produced by driving the funnel in a real headless browser and checking
every network call. It also reconciles Shopify orders against observed pixel events and
received postbacks and names the order IDs that went missing.

**Live demo:** _M10_

> Status: M4 (queue and Playwright runner) in progress. Sections marked _Mn_ are written when that module lands.

## Tracking teardown: five ways attribution silently breaks on duplicate funnels

_M5 / M10_

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
snippet like a UTM, written as a cart attribute, and read by the checkout pixel from
`checkout.customAttributes` (and from M3, by the webhook handler from the order). Nothing is
stored server-side; a run is fully described by its URL.

| Toggle           | What breaks                                                       | Verify by hand                                                                                                                  | Caught by check |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `drop_click_id`  | `/go` forwards UTMs but not `click_id`                            | Store URL has no `click_id`; debug panel `click_id` row is `—`; order has no `click_id`                                         | 3, 1            |
| `strip_utms`     | `/go` drops `utm_*`                                               | Store URL has `click_id` but no `utm_*`                                                                                         | 2               |
| `strip_event_id` | All pixel events sent without `event_id`                          | DevTools → Network → `facebook.com/tr`: no `eid=` on PageView/ViewContent; console `[meta-checkout]` lines show `eventID: null` | 5, 6            |
| `double_fire`    | Storefront PageView fires twice, different `event_id`s            | Two `ev=PageView` requests per store page                                                                                       | 7               |
| `duplicate_gtm`  | Same GTM container loaded twice on the advertorial                | Two `googletagmanager.com/gtm.js?id=GTM-AUD1T0R…` requests                                                                      | 7               |
| `unhashed_email` | Checkout pixel sends the email in plaintext as a custom parameter | Purchase request has `cd[email]=…` in clear                                                                                     | 9               |
| `consent_wall`   | Advertorial shows a consent bar; pixel does not load until Accept | No `facebook.com/tr` request on the advertorial until you click Accept                                                          | 10              |
| `capi_mismatch`  | Server-side Purchase uses a random `event_id`                     | _from M3_                                                                                                                       | 6               |
| `postback_500`   | Postback receiver answers 500                                     | _from M3_                                                                                                                       | 8               |

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
  hops, 2 000 requests per trace.

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
- **TTL:** traces expire after 7 days and are deleted by the worker.

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
- **Rate limit:** 5 submissions per hour per client address (fixed window in Redis), checked
  before the DNS lookup so a flood cannot use the auditor as a resolver. **Global cap:** 20
  queued jobs → 503; 2 concurrent runs per worker.
- **Hard timeout:** 90 s per run, enforced in the worker by closing the browser context.
- **robots.txt** is fetched and evaluated for the landing path and the verdict is shown in the
  report; it does not stop a run, because the person submitting a URL is meant to be its owner.
- **Purchases only on the demo store.** The job carries the one host where checkout may be
  completed; everywhere else the run ends at the checkout page.

Known limits, stated rather than hidden: the proxy filters by destination, not by content of
a TLS tunnel; a funnel that legitimately lives on a non-standard port is refused; the
`ALLOW_PRIVATE_TARGETS` switch exists for local development and is rejected by the env schema
when `NODE_ENV=production`.

## Production readiness

_M10_. Production grade here means correct, recoverable and observable. It does not mean built
for scale, and no scale infrastructure was added; the reasoning is stated when this section is
written.

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
(`packages/shared/src/env.ts`). None are committed; `gitleaks` runs pre-commit and in CI.
Rotation procedure: _M9_.
