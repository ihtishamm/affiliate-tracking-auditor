import { randomUUID } from 'node:crypto';
import { CLICK_ID_PARAM, RUN_LIMITS } from '@auditor/shared';

export const dynamic = 'force-dynamic';

/**
 * The submission form. Deliberately plain HTML: it must work in under 10 seconds for a
 * stranger with nothing installed (§3), and a form that posts to /api/runs needs no
 * JavaScript. The idempotency key is minted when the page renders, so the same rendered
 * form submitted twice — a double-click, a browser retry — maps to one run. M6 replaces the
 * look of this page, not the mechanism.
 */
export default function HomePage() {
  const idempotencyKey = randomUUID();
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Affiliate Tracking Auditor</h1>
      <p className="mt-3 text-neutral-600">
        Paste an affiliate funnel URL. A real browser walks it from landing page to checkout and
        records every tracking request, with customer data redacted before it is stored.
      </p>

      <form method="post" action="/api/runs" className="mt-8 space-y-4">
        <input type="hidden" name="idempotency_key" value={idempotencyKey} />
        <label className="block">
          <span className="text-sm font-medium">Funnel URL</span>
          <input
            name="url"
            type="url"
            required
            placeholder="https://example.com/landing?click_id=abc123"
            className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Click-ID parameter name</span>
          <input
            name="click_id_param"
            type="text"
            defaultValue={CLICK_ID_PARAM}
            pattern="[A-Za-z0-9_\-\[\]]{1,64}"
            className="mt-1 w-48 rounded border border-neutral-300 px-3 py-2"
          />
          <span className="mt-1 block text-xs text-neutral-500">
            If the URL has no such parameter, the auditor adds one with a value it can trace.
          </span>
        </label>
        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Audit this funnel
        </button>
      </form>

      <p className="mt-8 text-sm text-neutral-500">
        Limits: {RUN_LIMITS.rateLimitPerHour} runs per hour per address,{' '}
        {RUN_LIMITS.hardTimeoutMs / 1000} s per run, traces kept {RUN_LIMITS.traceTtlDays} days.
        Private and internal addresses are refused. Purchases are only completed on the demo store;
        anywhere else the run stops at the checkout page.
      </p>
      <p className="mt-4 text-sm">
        <a
          className="underline"
          href="/advertorial?click_id=demo-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo"
        >
          Open the demo funnel yourself →
        </a>
      </p>
    </main>
  );
}
