import Link from 'next/link';
import { repo } from '@auditor/db';
import { getDb } from '@/lib/db.ts';

export const dynamic = 'force-dynamic';

/** Saved funnels: audited daily at 06:00 UTC, with their latest score. */
export default async function FunnelsPage() {
  const db = getDb();
  const funnels = await repo.listFunnels(db);
  const latest = await Promise.all(
    funnels.map((f) => repo.listScores(db, f.id, 1).then((s) => s[0] ?? null)),
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">
        ← Auditor
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Saved funnels</h1>
      <p className="mt-1 text-neutral-600">
        Each is re-audited daily at 06:00 UTC. A score that drops 20 points, or any check that goes
        from pass to fail, sends one alert. Save a funnel from any report page.
      </p>
      {funnels.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">Nothing saved yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded border border-neutral-200">
          {funnels.map((f, i) => {
            const s = latest[i];
            return (
              <li key={f.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <Link href={`/funnels/${f.id}`} className="font-semibold hover:underline">
                    {f.label}
                  </Link>
                  <p className="truncate text-xs text-neutral-500">{f.url}</p>
                </div>
                <div className="text-right text-sm">
                  <div className="text-2xl font-semibold tabular-nums">
                    {!s || s.score === null ? '—' : `${Math.round(s.score * 100)}%`}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {s
                      ? `${s.counts.fail} fail · ${s.scoredAt.toISOString().slice(0, 10)}`
                      : 'not scored yet'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
