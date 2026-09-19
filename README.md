# Affiliate Tracking Auditor

Paste an affiliate funnel URL and get a pass/fail tracking report with an accuracy score and
the exact broken line, produced by driving the funnel in a real headless browser and checking
every network call. It also reconciles Shopify orders against observed pixel events and
received postbacks and names the order IDs that went missing.

**Live demo:** _M10_

> Status: M2 (advertorial + break-it panel) in progress. Sections marked _Mn_ are written when that module lands.

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

## PII handling

_M4_

## Abuse prevention

_M4 / M9_

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
  private URL. Railway injects `PORT`.
- **Neon**: create a project, use the pooled connection string as `DATABASE_URL`.

Migrations are applied by hand from a machine with the production `DATABASE_URL`:
`DATABASE_URL=... pnpm db:migrate` (a variable set in the shell takes precedence over `.env`).

### Secrets and rotation

All secrets live in environment variables and are validated at boot
(`packages/shared/src/env.ts`). None are committed; `gitleaks` runs pre-commit and in CI.
Rotation procedure: _M9_.
