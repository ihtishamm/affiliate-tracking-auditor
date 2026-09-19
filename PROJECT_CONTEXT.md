# PROJECT_CONTEXT.md

Read this fully before writing any code. This file is the source of truth for scope.
If a request conflicts with this file, say so instead of silently following the request.

---

## 1. What we are building

**Affiliate Tracking Auditor.**

A tool that takes an affiliate funnel URL, drives it headlessly in a real browser,
intercepts every network call, and returns a pass/fail report with an accuracy score
and the exact broken line.

It also reconciles three sources of truth for the same orders:

1. Shopify orders (GraphQL Admin API, source of truth)
2. Meta Pixel / CAPI Purchase events observed
3. S2S postbacks received

and reports the diff, for example: `412 orders, 408 pixel events, 397 postbacks, 15 order IDs missing`.

## 2. Why it exists

This is a job application artifact for a Full Stack Developer role at an e-commerce
health brand running a large affiliate program. Their stated pain, in their own words:

- "Guarantee 98% tracking and attribution accuracy from the affiliate's duplicate funnel to Marketing Platform's Pixel and Post-back"
- "Review tracking accuracy on a daily basis to prevent tracking issues from making the affiliate unprofitable"
- "Be in constant communication with affiliate tech teams and quickly make updates (UTM updates, tracking updates, postbacks, hash file integrations)"

The reviewer will paste one of their own live affiliate funnels into the deployed demo.
Everything below follows from that.

## 3. Non-negotiables

- **No signup. No login. No auth wall.** The demo must be usable in under 10 seconds by a stranger.
- **Loads in under 3 seconds.**
- **Never report a failure the runner did not directly observe.** A false positive on their
  live funnel ends the application. When a check cannot determine a result, return
  `inconclusive` with the reason. Do not guess.
- **Never persist customer PII.** See section 8.
- **Public GitHub repo, readable code.** The code is part of the application.
- **Ship date is fixed.** Cut scope to hit it, never extend it.

## 4. Anti-goals (do NOT build these)

Do not build, suggest, or scaffold any of the following. They cover zero requirements
and cost days:

- User accounts, auth, RBAC, multi-tenancy, teams, invites
- An affiliate onboarding flow, affiliate CRUD, commission or payout logic
- A general analytics or BI dashboard
- Kubernetes, Docker Compose orchestration beyond local dev, microservices, Kafka,
  multi-region, autoscaling, load testing
- OpenTelemetry, distributed tracing, or a metrics backend. Structured JSON logs only
- Email/SMS/Slack notification providers beyond one simple webhook alert
- A design system, component library, or animation work. Plain Tailwind, clean and boring
- Unit tests for trivial code. Test the check engine and the HMAC verification, nothing else
- Any new dependency without asking first

**Production grade here means correct, recoverable and observable. It does not mean
built for scale.** Do not add scale infrastructure. State this tradeoff in the README.

## 5. Architecture (locked, do not redesign)

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

- **Web**: Next.js (App Router) + TypeScript + Tailwind. Deployed on Vercel.
  Hosts the dashboard, the mock advertorial, the postback receiver, the API.
- **Worker**: standalone Node + TypeScript + Playwright. Deployed on Railway.
  Consumes jobs from BullMQ. Do not try to run Playwright on Vercel.
- **DB**: Postgres (Neon or Railway) + Drizzle ORM. Append-only run and event tables.
- **Queue**: Redis + BullMQ. Exponential backoff, max 3 attempts, dead letter queue.
- **Subject under test**: a real free Shopify dev store with a custom Liquid section,
  a tracking snippet, and checkout tested via the Bogus Gateway.

Monorepo: `apps/web`, `apps/worker`, `packages/checks`, `packages/db`, `packages/shared`.
The check engine lives in `packages/checks` as pure functions over a captured network
trace, so it is testable without a browser.

## 6. Module plan

Build in this order. Do not start a module until the previous one meets its done criteria.
Modules M1 to M6 are the core. M7 onward are the production-grade layer.

### M0. Repo scaffold
Monorepo, TypeScript strict, ESLint, Prettier, env validation with zod, Drizzle configured,
health check route, deployed skeleton on Vercel and Railway.
**Done when:** both apps deploy from `main` and the health checks return 200.

### M1. Shopify dev store and tracking snippet
Free dev store. A custom Liquid section on product and cart pages. A tracking snippet
that: reads `click_id` and UTM params from the URL, persists them to localStorage and a
first-party cookie, attaches them to checkout attributes, fires Meta Pixel events
(PageView, ViewContent, InitiateCheckout, Purchase) each carrying a generated `event_id`.
Checkout tested end to end with Bogus Gateway test cards.
**Done when:** a real test order completes and the `click_id` appears on the Shopify order.

### M2. Advertorial domain and redirect chain
A separate route/domain that mimics a duplicate affiliate funnel: advertorial page,
then a redirect into the Shopify store. Must forward `click_id` and UTMs across the domain
boundary. Include a **break-it panel** with toggles that deliberately sabotage the funnel:
drop click ID on redirect, strip `event_id`, send email unhashed, double-fire the pixel,
return 500 from the postback.
**Done when:** each toggle produces a genuinely broken funnel that a human can verify.

### M3. Postback receiver
`POST /api/postback`. HMAC-SHA256 signature verified against the **raw body** before
parsing, using timing-safe comparison. Idempotency keyed on the postback ID, duplicates
return 200 without reprocessing. Every postback appended to `postback_events`.
Also a Shopify `orders/create` webhook endpoint with the same HMAC + idempotency treatment
(Shopify retries and will deliver twice).
**Done when:** replayed and tampered requests are both handled correctly, with tests.

### M4. Queue and Playwright runner
Submit a URL, get a `run_id`, job goes on BullMQ. Worker launches Playwright, drives the
funnel, records a **network trace**: every request and response with URL, method, status,
timing, and parsed query/body params. Trace is redacted at capture time (section 8) and
stored as the run artifact. Idempotency on run submission so a double-click does not
spawn two jobs. Hard timeout per run. Exponential backoff, DLQ on repeated failure.
**Done when:** submitting a URL produces a stored, redacted trace and a terminal run status.

### M5. Check engine
Pure functions in `packages/checks` over the captured trace. Each check returns
`{ id, status: 'pass' | 'fail' | 'inconclusive', observed, expected, reason, fixHint }`.

The ten checks:

1. **Click ID persistence** - click ID present on landing and still present at checkout
   (cookie, localStorage or checkout attribute)
2. **UTM survival** - all UTM params survive every page transition and redirect hop
3. **Cross-domain handoff** - click ID survives the advertorial to checkout domain boundary.
   The single biggest killer on duplicate funnels
4. **Pixel load and fire order** - Meta Pixel loads and fires PageView, ViewContent,
   InitiateCheckout, Purchase in the correct order
5. **event_id present** - every browser event carries an `event_id`
6. **CAPI dedup match** - a server-side event was sent with an `event_id` matching the
   browser event
7. **Duplicate containers** - no duplicate GTM or GA4 container IDs on the page
   (the classic silent double-count)
8. **Postback fired** - postback fires on conversion carrying the click ID, correct status
   code, retries on non-200
9. **PII hashing** - hash file params (`em`, `ph`) are SHA-256 hashed and normalised
   (lowercased, trimmed, phone in E.164), never plaintext
10. **Consent blocking** - a consent banner is not silently blocking the pixel from firing

Each check must be defensible in an interview. Write a one-paragraph rationale per check in
`packages/checks/README.md` explaining what breaks in the real world when it fails.

**Done when:** every break-it toggle from M2 is caught by the right check, and a clean run
returns all pass.

### M6. Report UI and scoring
Run submission form, live run status, report view: overall accuracy score, per-check
pass/fail/inconclusive, observed vs expected, one-line fix hint per failure. Waterfall of
the network trace. Break-it toggles wired into the demo so a reviewer can flip one, re-run,
and watch it get caught.
**Done when:** a stranger can go from landing page to a completed report with no instructions.

### M7. Reconciliation job
The headline screen. Pull orders from the Shopify GraphQL Admin API for a date range
(source of truth), compare against observed pixel Purchase events and received postbacks,
output counts plus the specific missing order IDs and the drop-off stage.

**Respect Shopify's cost-based rate limit**: read `throttleStatus` from every GraphQL
response and back off before hitting the ceiling. Paginate with cursors.
**Done when:** a seeded discrepancy is correctly identified down to the order ID.

### M8. Scheduled runs and alerting
A cron that re-runs each saved funnel daily. Store the score history. Alert (one webhook,
nothing fancier) when a score drops beyond a threshold or a check flips pass to fail.
A small trend chart per funnel.
**Done when:** a deliberately broken funnel triggers exactly one alert on the next run.

### M9. Hardening
See sections 8 and 9. SSRF protection, rate limiting, PII redaction audit, secret scanning.
**Done when:** the SSRF and rate limit tests pass and no secret is committable.

### M10. Ship
README with the production-readiness section and the tracking teardown (section 10),
deploy, smoke test on a real third-party funnel.

## 7. Secrets and config

All secrets in env, validated with zod at boot, never committed. Add a pre-commit secret
scanner (gitleaks). Document rotation in the README. Secrets needed:
`SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `POSTBACK_HMAC_SECRET`,
`META_CAPI_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `ALERT_WEBHOOK_URL`.

## 8. PII handling (critical)

The auditor intercepts live network traffic. When a reviewer pastes their real funnel,
we are observing their customers' data. Therefore:

- **Redact at capture time, not at display time.** The raw value must never reach the DB.
- For any field that could contain PII (`em`, `ph`, `fn`, `ln`, `external_id`, emails,
  phone numbers, addresses anywhere in a query string or body), store only:
  `{ present: true, looksHashed: true, hashAlgoGuess: 'sha256', normalised: true }`.
  Never the value, never a prefix, never a partial.
- Full request bodies are not stored. Store the parsed, redacted param map only.
- TTL on run artifacts: 7 days, enforced by a cleanup job.
- Say all of this explicitly in the README. It is a trust signal, not a footnote.

## 9. Abuse prevention (critical)

This is a public, unauthenticated tool that drives arbitrary URLs headlessly. That is a
weapon if unguarded.

- **SSRF**: resolve the hostname, then block private ranges (10/8, 172.16/12, 192.168/16,
  127/8, 169.254/16, ::1, fc00::/7) and re-check after every redirect hop. Block non-http(s)
  schemes. Cap redirect depth.
- **Rate limit** per IP, low. Cap global concurrency of Playwright runs.
- **Hard timeout** on every run, enforced in the worker, not just the queue.
- **robots.txt is not a legal shield but check it anyway** and surface the result in the report.

## 10. README requirements

The README is part of the application. It must contain:

1. What it does, in two sentences, with the live link
2. A **tracking teardown**: the five ways attribution silently breaks on duplicate funnels
   and how each is detected. This is the section most likely to get forwarded internally
3. Architecture diagram and why each piece
4. The PII and abuse-prevention sections above, stated plainly
5. A **Production readiness** section: what is built (HMAC verification, idempotency,
   retry queue with DLQ, append-only event log, reconciliation, daily scheduled runs,
   structured logs with run_id, secret management), and what was deliberately not built
   (scale infrastructure, auth, multi-tenancy) with the reasoning
6. Local setup that actually works from a clean clone

## 11. Conventions

- TypeScript strict. No `any`. Zod at every boundary (env, API input, webhook bodies,
  external API responses).
- Errors: typed results over thrown exceptions in the check engine. Never swallow an error
  into a `pass`. An error is `inconclusive`.
- Logging: structured JSON, `run_id` threaded through every log line in a run, timing per check.
- DB: append-only for runs and events. No destructive migrations.
- Commits: small, conventional commits, one module per branch.

## 12. How to work with me

- **Work one module at a time.** At the start of a module, state the plan and the files you
  will touch, then wait for a go-ahead.
- **Ask before adding any dependency.** Name the alternative you rejected and why.
- **Do not refactor code outside the current module** without asking.
- **Flag scope creep out loud.** If something I ask for belongs in section 4, say so.
- **Do not generate the tracking, dedup, hashing or HMAC logic and move on.** Those are the
  parts I have to defend in an interview. Explain the reasoning for each, inline, before
  writing it, and keep the explanation in a comment.
- When a module is done, list what was built against its done criteria and what was skipped.
