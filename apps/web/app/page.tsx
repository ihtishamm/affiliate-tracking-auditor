import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import Link from 'next/link';
import { CLICK_ID_PARAM, RUN_LIMITS } from '@auditor/shared';
import { DemoForm } from './demo-form.tsx';

export const dynamic = 'force-dynamic';

/**
 * The landing page: one field for a stranger's funnel, and the demo funnel with its break-it
 * switches right here, so a reviewer goes from this page to a report without instructions
 * (§3, §6 M6). Plain HTML forms posting to /api/runs; the idempotency key is minted at render
 * so a double submit maps to one run.
 */
export default async function HomePage() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const advertorialUrl = `${proto}://${host}/advertorial`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Affiliate Tracking Auditor</h1>
      <p className="mt-3 text-lg text-neutral-600">
        Paste an affiliate funnel URL. A real browser walks it from landing page to checkout and
        runs ten checks on what it saw — click-ID survival, UTMs, pixel events, dedup, hashing,
        consent — and tells you the exact broken link.
      </p>

      <form method="post" action="/api/runs" className="mt-8 rounded border border-neutral-900 p-4">
        <input type="hidden" name="idempotency_key" value={randomUUID()} />
        <label className="block">
          <span className="font-semibold">Funnel URL</span>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              name="url"
              type="url"
              required
              autoFocus
              placeholder="https://example.com/landing?click_id=abc123"
              className="w-full flex-1 rounded border border-neutral-300 px-3 py-2"
            />
            <button
              type="submit"
              className="rounded bg-neutral-900 px-5 py-2 font-semibold text-white hover:bg-neutral-700"
            >
              Audit
            </button>
          </div>
        </label>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-neutral-600">
            Advanced: click-ID parameter name
          </summary>
          <label className="mt-2 block">
            <input
              name="click_id_param"
              type="text"
              defaultValue={CLICK_ID_PARAM}
              pattern="[A-Za-z0-9_\-\[\]]{1,64}"
              className="w-48 rounded border border-neutral-300 px-3 py-1"
            />
            <span className="mt-1 block text-xs text-neutral-500">
              The parameter your network puts the click ID in. If the URL has none, the auditor adds
              one with a value it can trace.
            </span>
          </label>
        </details>
        <p className="mt-3 text-xs text-neutral-500">
          Takes 30–90 seconds. On a funnel we do not own, the run stops at the checkout page and the
          purchase-side checks report as undecided rather than guessed.
        </p>
      </form>

      <div className="mt-6">
        <DemoForm advertorialUrl={advertorialUrl} idempotencyKey={randomUUID()} />
      </div>

      <section className="mt-10 grid gap-6 text-sm text-neutral-600 sm:grid-cols-3">
        <div>
          <h3 className="font-semibold text-neutral-900">What it never keeps</h3>
          <p className="mt-1">
            Customer data is redacted the moment a request is seen: emails, phones, names, addresses
            become “present, hashed or not” — never the value. Traces expire in{' '}
            {RUN_LIMITS.traceTtlDays} days.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-neutral-900">What it never does</h3>
          <p className="mt-1">
            Reach private or internal addresses (every hop is checked), complete a purchase on a
            store it does not own, or report a failure it did not directly observe.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-neutral-900">Limits</h3>
          <p className="mt-1">
            {RUN_LIMITS.rateLimitPerHour} runs per hour per address,{' '}
            {RUN_LIMITS.hardTimeoutMs / 1000} s per run. No account, no login: the report URL is the
            share link.
          </p>
        </div>
      </section>
      <p className="mt-8 text-xs text-neutral-500">
        <a
          className="underline"
          href="/advertorial?click_id=demo-001&utm_source=affiliate&utm_medium=cpc&utm_campaign=demo"
        >
          Walk the demo funnel yourself
        </a>
        {' · '}
        <Link className="underline" href="/reconcile">
          Reconciliation: orders vs pixel vs CAPI vs postbacks
        </Link>
        {' · '}
        <Link className="underline" href="/funnels">
          Saved funnels &amp; daily audits
        </Link>
        {' · '}
        <a className="underline" href="https://github.com/ihtishamm/affiliate-tracking-auditor">
          Source
        </a>
      </p>
    </main>
  );
}
