import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { CHECKS } from '@auditor/checks';
import { BREAK_TOGGLES, BREAK_TOGGLE_INFO } from '@auditor/shared';
import { repo } from '@auditor/db';
import { getDb } from '@/lib/db.ts';

export const dynamic = 'force-dynamic';

/**
 * One saved funnel: the score trend (inline SVG), a check-by-run grid, the alerts it has
 * raised, and a "Run now" button — which is how a deliberately broken funnel is shown to
 * trigger exactly one alert without waiting for the daily tick.
 */
export default async function FunnelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const funnel = await repo.getFunnel(db, id);
  if (!funnel) notFound();
  const [scores, alerts, runs] = await Promise.all([
    repo.listScores(db, id, 60),
    repo.listAlerts(db, id, 20),
    repo.runsForFunnel(db, id, 30),
  ]);
  const series = [...scores].reverse(); // oldest first
  const alertRunIds = new Set(alerts.map((a) => a.runId));

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/funnels" className="text-sm text-muted-foreground hover:underline">
        ← Saved funnels
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-3xl font-semibold">{funnel.label}</h1>
          <p className="break-all text-sm text-muted-foreground">{funnel.url}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Audited daily at 06:00 UTC · saved {funnel.createdAt.toISOString().slice(0, 10)}
          </p>
        </div>
        <form method="post" action={`/api/funnels/${funnel.id}/run`} className="card p-3 text-sm">
          <button type="submit" className="btn btn-primary">
            Run now
          </button>
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground">
              …with something broken (this run only)
            </summary>
            <ul className="mt-1 space-y-1">
              {BREAK_TOGGLES.map((t) => (
                <li key={t}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="break" value={t} />
                    <span>
                      {BREAK_TOGGLE_INFO[t].label}{' '}
                      <span className="text-xs text-muted-foreground">
                        (check {BREAK_TOGGLE_INFO[t].caughtBy.join(', ')})
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        </form>
      </div>

      <section className="mt-8">
        <h2 className="font-serif text-xl font-semibold">Score history</h2>
        {series.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No scored runs yet. The first run sets the baseline; alerts start with the second.
          </p>
        ) : (
          <Trend series={series} alertRunIds={alertRunIds} />
        )}
      </section>

      {series.length > 0 && (
        <section className="mt-8 overflow-x-auto">
          <h2 className="font-serif text-xl font-semibold">Checks by run</h2>
          <table className="card mt-2 border-separate border-spacing-1 p-2 text-xs">
            <thead>
              <tr>
                <th className="pr-3 text-left font-normal text-muted-foreground">check</th>
                {series.map((s) => (
                  <th
                    key={s.runId}
                    className="px-1 font-normal text-muted-foreground"
                    title={s.scoredAt.toISOString()}
                  >
                    <Link href={`/runs/${s.runId}`} className="hover:underline">
                      {s.scoredAt.toISOString().slice(5, 10)}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CHECKS.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap pr-3">
                    {c.number}. {c.title}
                  </td>
                  {series.map((s) => {
                    const st = s.statuses[c.id];
                    return (
                      <td key={s.runId} className="px-1 text-center">
                        <span
                          className={`pill px-1.5 py-0 ${
                            st === 'pass'
                              ? 'pill-pass'
                              : st === 'fail'
                                ? 'pill-fail'
                                : 'pill-undecided'
                          }`}
                          title={st ?? 'not run'}
                        >
                          {st === 'pass' ? '✓' : st === 'fail' ? '✗' : '?'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="mt-8">
        <h2 className="font-serif text-xl font-semibold">Alerts</h2>
        {alerts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">None raised.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {alerts.map((a) => (
              <li key={a.id} className="card border-destructive bg-destructive/10 border-2 p-3">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold">
                    {a.createdAt.toISOString().replace('T', ' ').slice(0, 16)} UTC ·{' '}
                    {pct(a.previousScore)} → {pct(a.score)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {a.deliveryStatus === null && a.deliveryError === null
                      ? 'recorded (no webhook configured)'
                      : a.deliveryStatus && a.deliveryStatus < 300
                        ? `webhook delivered (HTTP ${a.deliveryStatus})`
                        : `webhook failed: ${a.deliveryError ?? a.deliveryStatus}`}
                  </span>
                </div>
                <ul className="mt-1 list-disc pl-5">
                  {a.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <Link href={`/runs/${a.runId}`} className="mt-1 inline-block text-xs underline">
                  the run
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="mt-8 text-sm">
        <summary className="cursor-pointer font-semibold">Runs ({runs.length})</summary>
        <ul className="mt-2 font-mono text-xs">
          {runs.map((r) => (
            <li key={r.id}>
              {r.createdAt.toISOString().replace('T', ' ').slice(0, 16)} ·{' '}
              {r.idempotencyKey.split(':')[0]} ·{' '}
              <Link href={`/runs/${r.id}`} className="underline">
                {r.id.slice(0, 8)}
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}

function pct(s: string | null): string {
  return s === null ? '—' : `${Math.round(Number(s) * 100)}%`;
}

function Trend({
  series,
  alertRunIds,
}: {
  series: Array<{ runId: string; score: number | null; scoredAt: Date }>;
  alertRunIds: Set<string>;
}) {
  const W = 640;
  const H = 140;
  const PAD = 24;
  const n = series.length;
  const x = (i: number): number => (n === 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD));
  const y = (s: number | null): number => H - PAD - (s ?? 0) * (H - 2 * PAD);
  const points = series.map((s, i) => `${x(i)},${y(s.score)}`).join(' ');
  return (
    <figure className="mt-2">
      <svg
        viewBox={`-26 0 ${W + 26} ${H}`}
        className="w-full max-w-2xl text-[10px]"
        role="img"
        aria-label="Score over time"
      >
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line
              x1={PAD}
              x2={W - PAD}
              y1={y(g)}
              y2={y(g)}
              stroke="var(--border)"
              strokeOpacity={0.3}
            />
            <text x={PAD - 4} y={y(g) + 3} textAnchor="end" fill="var(--muted-foreground)">
              {Math.round(g * 100)}%
            </text>
          </g>
        ))}
        {n > 1 && <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth={2} />}
        {series.map((s, i) => (
          <g key={s.runId}>
            <title>{`${s.scoredAt.toISOString().slice(0, 16).replace('T', ' ')} UTC — ${s.score === null ? 'undecided' : `${Math.round(s.score * 100)}%`}${alertRunIds.has(s.runId) ? ' — alert' : ''}`}</title>
            <circle
              cx={x(i)}
              cy={y(s.score)}
              r={alertRunIds.has(s.runId) ? 6 : 3.5}
              fill={alertRunIds.has(s.runId) ? 'var(--destructive)' : 'var(--primary)'}
              stroke={alertRunIds.has(s.runId) ? 'var(--foreground)' : 'none'}
              strokeWidth={1.5}
            />
          </g>
        ))}
      </svg>
      <figcaption className="text-muted-foreground text-xs">
        {n} scored run{n === 1 ? '' : 's'} · red = an alert was raised on that run
      </figcaption>
    </figure>
  );
}
