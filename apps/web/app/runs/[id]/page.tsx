import { notFound } from 'next/navigation';
import { z } from 'zod';
import { TERMINAL_STATUSES } from '@auditor/shared';
import { getDb } from '@/lib/db.ts';
import { getRun } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/**
 * Run status page. Refreshes itself every 3 s until the run is terminal, with a meta tag
 * rather than a script: it is the least that works. M6 turns the trace into the report; M4
 * shows enough to prove the trace exists, is redacted, and how far the funnel got.
 */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const run = await getRun(getDb(), id, { trace: true });
  if (!run) notFound();
  const terminal = TERMINAL_STATUSES.has(run.status);
  const trace = run.trace;

  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      {!terminal && <meta httpEquiv="refresh" content="3" />}
      <p className="text-sm text-neutral-500">Run {run.id}</p>
      <h1 className="mt-1 text-2xl font-semibold">
        {run.status}
        {!terminal && (
          <span className="ml-2 text-base font-normal text-neutral-500">refreshing…</span>
        )}
      </h1>
      <p className="mt-2 break-all text-neutral-700">{run.url}</p>

      <h2 className="mt-8 text-lg font-semibold">Events</h2>
      <ul className="mt-2 space-y-1 font-mono text-sm">
        {[...run.events].reverse().map((e, i) => (
          <li key={i}>
            {e.at.toISOString()} · attempt {e.attempt} · {e.status}
            {Object.keys(e.detail).length > 0 && (
              <span className="text-neutral-500"> {JSON.stringify(e.detail)}</span>
            )}
          </li>
        ))}
      </ul>

      {trace && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Trace</h2>
          <dl className="mt-2 grid grid-cols-[12rem_1fr] gap-y-1 text-sm">
            <dt className="text-neutral-500">Mode</dt>
            <dd>{trace.mode}</dd>
            <dt className="text-neutral-500">Reached</dt>
            <dd>
              {trace.outcome.reachedStep} — {trace.outcome.stopReason}
            </dd>
            <dt className="text-neutral-500">Expected click ID</dt>
            <dd className="font-mono">{trace.expectedClickId}</dd>
            <dt className="text-neutral-500">CTA</dt>
            <dd>{trace.cta ? `${trace.cta.rule}: “${trace.cta.text}”` : 'not found'}</dd>
            <dt className="text-neutral-500">Hops</dt>
            <dd>{trace.hops.length}</dd>
            <dt className="text-neutral-500">Requests</dt>
            <dd>
              {trace.requests.length}
              {trace.requestsTruncated && ' (truncated)'}
            </dd>
            <dt className="text-neutral-500">robots.txt</dt>
            <dd>
              {trace.robots.fetched
                ? trace.robots.allowed === false
                  ? `disallows this path (${trace.robots.matchedRule})`
                  : 'allows'
                : 'not fetched'}
            </dd>
            <dt className="text-neutral-500">Order</dt>
            <dd className="font-mono">{trace.order ? trace.order.id : '—'}</dd>
          </dl>

          <h3 className="mt-6 font-semibold">Steps</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {trace.steps.map((s) => (
              <li key={`${s.step}-${s.t}`}>
                <span className="font-mono">{s.step}</span> · click ID{' '}
                <span className="font-mono">{s.attribution.clickId ?? '—'}</span> (
                {s.attribution.source}){s.consent.bannerVisible && ' · consent banner visible'}
                <span className="block break-all text-neutral-500">{s.url}</span>
              </li>
            ))}
          </ol>

          <h3 className="mt-6 font-semibold">Tracking requests</h3>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {trace.requests
              .filter((r) =>
                /facebook\.com\/tr|googletagmanager|google-analytics|\/cart\/|api\/postback/.test(
                  r.url,
                ),
              )
              .map((r) => (
                <li key={r.seq} className="break-all">
                  {r.step} · {r.method} {r.status ?? '—'} {r.url}
                  {Object.entries(r.params)
                    .filter(([k]) => /^(ev|eid|id|cd\[click_id\]|ud\[em\]|ud\[ph\])$/.test(k))
                    .map(([k, v]) => (
                      <span key={k} className="ml-2 text-neutral-500">
                        {k}={v.kind === 'value' ? v.value : `[${v.kind}]`}
                      </span>
                    ))}
                </li>
              ))}
          </ul>
          <p className="mt-4 text-sm">
            <a className="underline" href={`/api/runs/${run.id}?trace=1`}>
              Full trace as JSON →
            </a>
          </p>
        </>
      )}
    </main>
  );
}
