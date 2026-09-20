import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reportFor } from '@/lib/checks.ts';
import { getDb } from '@/lib/db.ts';
import { getRun } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/** GET /api/runs/:id — status, event log and (once a trace exists) the check report; `?trace=1` includes the redacted trace. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const withTrace = new URL(request.url).searchParams.get('trace') === '1';
  const db = getDb();
  const run = await getRun(db, id, { trace: true });
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const report = run.trace ? await reportFor(db, run.trace) : null;
  return NextResponse.json({
    run_id: run.id,
    status: run.status,
    url: run.url,
    click_id_param: run.clickIdParam,
    created_at: run.createdAt.toISOString(),
    events: run.events.map((e) => ({
      status: e.status,
      attempt: e.attempt,
      at: e.at.toISOString(),
      ...e.detail,
    })),
    ...(report ? { score: report.score, counts: report.counts, checks: report.results } : {}),
    ...(withTrace ? { trace: run.trace } : {}),
  });
}
