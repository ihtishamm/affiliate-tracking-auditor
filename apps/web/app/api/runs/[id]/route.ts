import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db.ts';
import { getRun } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/** GET /api/runs/:id — status and event log; `?trace=1` includes the redacted trace. */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const withTrace = new URL(request.url).searchParams.get('trace') === '1';
  const run = await getRun(getDb(), id, { trace: withTrace });
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
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
    ...(withTrace ? { trace: run.trace } : {}),
  });
}
