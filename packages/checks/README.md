# @auditor/checks

Pure functions over a captured, redacted network trace. No browser, no database, no I/O.
Every check returns `{ id, status: 'pass' | 'fail' | 'inconclusive', observed, expected, reason, fixHint }`.
An error inside a check is never a `pass`; it is `inconclusive` with the error as the reason.

## Why each check exists

One paragraph per check, written with the check in M5: what silently breaks in a real affiliate
funnel when it fails, what the runner must directly observe to call it a `fail`, and when it
must say `inconclusive` instead.

1. Click ID persistence
2. UTM survival
3. Cross-domain handoff
4. Pixel load and fire order
5. `event_id` present
6. CAPI dedup match
7. Duplicate containers
8. Postback fired
9. PII hashing
10. Consent blocking
