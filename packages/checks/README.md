# @auditor/checks

Pure functions over a run's captured, redacted trace and the server-side rows for its order.
No browser, no database, no clock. `runChecks({ trace, server })` returns ten results of the
shape `{ id, number, title, status: 'pass' | 'fail' | 'inconclusive', observed, expected, reason, fixHint }`,
plus counts and a score (`passes / (passes + fails)`; inconclusive checks are excluded — a gap
in evidence is not a defect, so it neither helps nor hurts).

Three rules hold for every check:

- **A `fail` is something the browser saw.** A check decides only from the trace (and the
  server rows for checks 6 and 8). When the funnel stopped before the step a check needs, or
  a server row has not arrived, the answer is `inconclusive` with the reason — never `fail`.
- **Verdict text never contains a value that could identify a person.** Keys, counts, hosts,
  hops, event names, event ids — yes. Emails, hashes, names, addresses — the trace does not
  hold them (see `packages/shared/src/redact.ts`), so the verdicts cannot leak them.
- **A check that throws is `inconclusive`.** An error is never a pass.

Tests run the engine over real traces of the demo funnel (`test/fixtures/*.json`, produced by
`scripts/slim-trace.ts` from stored runs), one per break-it toggle, and assert that each
toggle is caught by the check the toggle documentation names.

## Why each check exists

**1. Click ID persistence.** The affiliate network's click ID arrives on the landing page and
must still be attached to the shopper at checkout — in a first-party cookie, in localStorage,
or written onto the cart so it becomes an order attribute. When it is not, the order carries
no attribution, the network is never told which click produced the sale, and the affiliate
who paid for the traffic is not paid for the conversion. Merchants then see the sale as
"direct" and cut the partner that produced it. The check reads where the expected value was
found on each page and the cart-attribute writes; it decides only once checkout was reached.

**2. UTM survival.** `utm_*` parameters die most often in the redirect chain between the
affiliate's page and the merchant: a redirector rebuilds the destination URL and forgets the
query, and from then on every report attributes the sale to "direct". The check walks the
hops to the first page on the destination host and requires every UTM that arrived on
landing to be present at each, then — where the store's attribution record is readable —
requires them again at checkout. It names the hop where they vanished.

**3. Cross-domain handoff.** Cookies do not cross domains, so the only thing that can carry
the click ID from the advertorial's domain into the store is the URL of the hop that lands
there. This is the single biggest killer on duplicate funnels: a redirect that forwards the
UTMs but forgets the network's own parameter, because the person who built the redirect had
never heard of it. The check finds the first hop whose host changes and requires the click
ID either on that URL or in a cookie/storage key on the first store page.

**4. Pixel load and fire order.** A Meta pixel that never fires is the most common state of
an affiliate landing page cloned from a template; a pixel that fires Purchase but never
InitiateCheckout gives the ad platform no funnel to optimise against; events out of order
mean a page is firing the wrong event. The check requires PageView, ViewContent,
InitiateCheckout and Purchase, in that order of first occurrence, for the steps the run
reached, and fails on a funnel with no pixel requests at all once the store was reached.

**5. event_id present.** Without an `eid` on every browser event, the server-side copy of
the event (CAPI) can never be deduplicated against it, and Meta counts each conversion twice.
Nothing in Events Manager flags it; only someone comparing totals notices. The check requires
an event_id on every standard event the pixel sent.

**6. CAPI dedup match.** Meta deduplicates a browser event and a server event only when they
carry the same event_id. The two sides never talk to each other, so the only way they can
agree is to derive the id from something both can see — the order id. A server that
generates its own id reports a second sale in every campaign. The check compares the browser
Purchase's event_id with the server's `conversion_attempts` row for the same order; it is
inconclusive without an order or before the webhook arrives, and fails outright when the
browser Purchase has no event_id at all.

**7. Duplicate containers.** A theme ships a GTM/GA4 container, an app adds the same one, and
every tag inside fires twice; or a second Meta install — a pasted `<noscript>` image, a
second snippet — sends PageView twice per page. Nothing errors; every number is simply 2×.
The check counts container ids among each page's scripts and PageView hits per document
(attributed by time, so an image request with no page URL is counted like any other).

**8. Postback fired.** The server-to-server postback is how the affiliate network learns
that a sale happened; without it the affiliate is unpaid however well the pixel behaved. A
browser cannot see it, so the evidence is the sender's own log: `postback_events` (what the
receiver accepted) and `conversion_attempts` (every try and its status). The check passes on
an accepted postback carrying the click ID, fails when attempts never succeeded — and says
whether they were retried — and is inconclusive when there was no order to post back.

**9. PII hashing.** Identity parameters sent for advanced matching (`em`, `ph`, …) must be
SHA-256 hashes of normalised values: a plaintext email is a privacy incident, and a hash of
the un-normalised value is silently useless because Meta hashes its own copy after
normalising and the two never match. The trace never holds the values — the redactor
recorded only whether each looked hashed, with what algorithm, and (for the identity the
runner typed) whether the hash matched the normalised form. The check reads those verdicts,
plus the sender's `pii_hashed` flag on the CAPI attempt.

**10. Consent blocking.** Consent tools block tracking until accepted, and most visitors never
accept; a funnel configured that way is dark from its first page, and nobody notices because
the pixel works for whoever tests it and clicks Accept. The runner never clicks Accept — it
is the visitor who does not. The check fails when a page shows a consent banner and no pixel
event fired from that page; it passes when there is no banner, or when the pixel fired
regardless.
