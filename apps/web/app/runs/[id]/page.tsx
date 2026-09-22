import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import type { CheckResult } from '@auditor/checks';
import { BREAK_TOGGLE_INFO, TERMINAL_STATUSES, type BreakToggle } from '@auditor/shared';
import { reportFor } from '@/lib/checks.ts';
import { getDb } from '@/lib/db.ts';
import {
  fixFirst,
  headline,
  orderForReport,
  scoreLabel,
  shortUrl,
  stepProgress,
  togglesCaughtBy,
  togglesOf,
} from '@/lib/report-view.ts';
import { getRun } from '@/lib/store.ts';
import { CopyLink } from './copy-link.tsx';
import { StatusPoller } from './status-poller.tsx';
import { Waterfall } from './waterfall.tsx';

export const dynamic = 'force-dynamic';

/**
 * The report (§6 M6). One server render from the stored trace and the server rows: score,
 * verdicts with failures first, the one fix to do first, the funnel steps, the waterfall.
 * While the run is still going, a small client component polls and triggers a re-render.
 */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const run = await getRun(db, id, { trace: true });
  if (!run) notFound();
  const terminal = TERMINAL_STATUSES.has(run.status);
  const trace = run.trace;
  const report = trace ? await reportFor(db, trace) : null;
  const active = trace ? togglesOf(trace) : [];
  const first = report ? fixFirst(report.results) : null;
  const lastEvent = run.events[0];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href="/" className="text-sm text-neutral-500 hover:underline">
          ← Audit another funnel
        </Link>
        <div className="flex items-center gap-2">
          {terminal && run.trace && !run.funnelId && (
            <form method="post" action="/api/funnels">
              <input type="hidden" name="run_id" value={run.id} />
              <button
                type="submit"
                className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50"
              >
                Save for daily audits
              </button>
            </form>
          )}
          {run.funnelId && (
            <Link href={`/funnels/${run.funnelId}`} className="text-sm underline">
              Saved funnel: history
            </Link>
          )}
          <CopyLink />
        </div>
      </div>
      <p className="mt-4 break-all text-sm text-neutral-500">{run.url}</p>

      {!terminal && <StatusPoller runId={run.id} startedAt={run.createdAt.toISOString()} />}

      {terminal && !report && (
        <section className="mt-6 rounded border border-red-300 bg-red-50 p-4">
          <h1 className="text-xl font-semibold text-red-900">
            The run {run.status === 'timed_out' ? 'timed out' : 'failed'} before producing a trace
          </h1>
          <p className="mt-2 text-sm text-red-900">
            {String(
              lastEvent?.detail['error'] ??
                lastEvent?.detail['reason'] ??
                'No details were recorded.',
            )}
          </p>
        </section>
      )}

      {report && trace && (
        <>
          <header className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="text-6xl font-semibold tabular-nums tracking-tight">
                {scoreLabel(report)}
              </div>
              <div className="mt-1 text-sm text-neutral-500">
                {report.counts.pass} pass · {report.counts.fail} fail · {report.counts.inconclusive}{' '}
                undecided
              </div>
            </div>
            <div className="max-w-md">
              <h1 className="text-xl font-semibold">{headline(report, trace)}</h1>
              <p className="mt-1 text-sm text-neutral-600">
                {trace.mode === 'purchase'
                  ? `A test purchase was completed on the demo store (order ${trace.order?.id ?? '—'}).`
                  : `The run stopped at ${trace.outcome.reachedStep.replace('_', '-')}: ${trace.outcome.stopReason}.`}
                {run.status === 'timed_out' &&
                  ' The run hit its time limit; checks are based on what was seen.'}
              </p>
              {active.length > 0 && (
                <p className="mt-2 text-sm">
                  <span className="text-neutral-500">Sabotaged with: </span>
                  {active.map((t) => (
                    <span key={t} className="mr-1 rounded bg-red-100 px-2 py-0.5 text-red-900">
                      {BREAK_TOGGLE_INFO[t].label}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </header>

          <ol className="mt-6 flex flex-wrap gap-2 text-sm">
            {stepProgress(trace.outcome.reachedStep, true).map((s) => (
              <li
                key={s.step}
                className={
                  s.state === 'done'
                    ? 'rounded bg-green-100 px-2 py-1 text-green-900'
                    : s.state === 'stopped'
                      ? 'rounded bg-amber-100 px-2 py-1 text-amber-900'
                      : 'rounded bg-neutral-100 px-2 py-1 text-neutral-400'
                }
              >
                {s.label}
              </li>
            ))}
          </ol>

          {first && (
            <section className="mt-6 rounded border-2 border-red-600 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">
                Fix this first
              </h2>
              <p className="mt-1 font-semibold">
                {first.number}. {first.title}
              </p>
              <p className="mt-1 text-sm">{first.fixHint}</p>
              <p className="mt-1 text-sm text-neutral-600">
                Earlier in the funnel explains later: a click ID lost at the redirect makes every
                downstream attribution check fail too.
              </p>
            </section>
          )}

          <section className="mt-8">
            <h2 className="text-lg font-semibold">The ten checks</h2>
            <ol className="mt-3 space-y-3">
              {orderForReport(report.results).map((c) => (
                <CheckCard key={c.id} check={c} active={active} />
              ))}
            </ol>
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold">What the browser saw</h2>
            <p className="mt-1 text-sm text-neutral-600">
              Every page hop and every tracking request, on one clock. Customer data was redacted
              before any of this was stored.
            </p>
            <div className="mt-3">
              <Waterfall trace={trace} />
            </div>
          </section>

          <details className="mt-8 text-sm">
            <summary className="cursor-pointer font-semibold">Run details</summary>
            <dl className="mt-3 grid grid-cols-[11rem_1fr] gap-y-1">
              <dt className="text-neutral-500">Opened</dt>
              <dd className="break-all">{trace.entryUrl}</dd>
              <dt className="text-neutral-500">Injected</dt>
              <dd>
                {trace.injected.clickId
                  ? `${trace.clickIdParam}=${trace.injected.clickId}`
                  : 'nothing (URL had a click ID)'}
                {Object.keys(trace.injected.utm).length > 0 &&
                  `; ${Object.entries(trace.injected.utm)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ')}`}
              </dd>
              <dt className="text-neutral-500">Call to action</dt>
              <dd>
                {trace.cta
                  ? `“${trace.cta.text}” (rule: ${trace.cta.rule}) → ${shortUrl(trace.cta.href)}`
                  : 'none found'}
              </dd>
              <dt className="text-neutral-500">robots.txt</dt>
              <dd>
                {!trace.robots.fetched
                  ? 'not fetched'
                  : trace.robots.allowed === false
                    ? `disallows this path (${trace.robots.matchedRule}) — audited anyway at your request`
                    : `allows (HTTP ${trace.robots.status})`}
              </dd>
              <dt className="text-neutral-500">Browser</dt>
              <dd className="break-all">{trace.userAgent}</dd>
              <dt className="text-neutral-500">Duration</dt>
              <dd>
                {((Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) / 1000).toFixed(1)} s
                · {trace.requests.length} requests{trace.requestsTruncated && ' (truncated)'}
              </dd>
              <dt className="text-neutral-500">Run log</dt>
              <dd>
                <ul className="font-mono text-xs">
                  {[...run.events].reverse().map((e, i) => (
                    <li key={i}>
                      {e.at.toISOString().slice(11, 19)} {e.status}
                      {typeof e.detail['step'] === 'string' && ` → ${e.detail['step']}`}
                      {typeof e.detail['reason'] === 'string' && ` · ${e.detail['reason']}`}
                      {typeof e.detail['error'] === 'string' && ` · ${e.detail['error']}`}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            <p className="mt-3">
              <a className="underline" href={`/api/runs/${run.id}?trace=1`}>
                Full trace and report as JSON →
              </a>
            </p>
          </details>
        </>
      )}
    </main>
  );
}

function CheckCard({ check, active }: { check: CheckResult; active: BreakToggle[] }) {
  const tone =
    check.status === 'pass'
      ? { pill: 'bg-green-100 text-green-900', border: 'border-neutral-200' }
      : check.status === 'fail'
        ? { pill: 'bg-red-600 text-white', border: 'border-red-300' }
        : { pill: 'bg-neutral-200 text-neutral-700', border: 'border-neutral-200' };
  const causes = togglesCaughtBy(check, active);
  return (
    <li className={`rounded border ${tone.border} p-4`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`rounded px-2 py-0.5 font-mono text-xs uppercase ${tone.pill}`}>
          {check.status === 'inconclusive' ? 'undecided' : check.status}
        </span>
        <h3 className="font-semibold">
          {check.number}. {check.title}
        </h3>
        {causes.length > 0 && (
          <span className="text-xs text-red-700">
            expected — sabotaged by {causes.map((t) => BREAK_TOGGLE_INFO[t].label).join(', ')}
          </span>
        )}
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="text-neutral-500">Observed</dt>
        <dd>{check.observed}</dd>
        <dt className="text-neutral-500">Expected</dt>
        <dd>{check.expected}</dd>
        <dt className="text-neutral-500">
          {check.status === 'inconclusive' ? 'Why undecided' : 'Because'}
        </dt>
        <dd className="text-neutral-700">{check.reason}</dd>
        {check.fixHint && (
          <>
            <dt className="font-semibold text-red-700">Fix</dt>
            <dd className="font-medium">{check.fixHint}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
