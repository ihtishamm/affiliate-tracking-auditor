import { NextResponse } from 'next/server';
import { z } from 'zod';
import { repo } from '@auditor/db';
import { parseBreakToggles, RUN_LIMITS } from '@auditor/shared';
import { getDb } from '@/lib/db.ts';
import { runFunnelNow } from '@/lib/funnels.ts';
import { enqueueRun, queueDepth } from '@/lib/queue.ts';
import { clientKeyFromHeaders, rateLimiter } from '@/lib/rate-limit.ts';
import { getRedis } from '@/lib/redis.ts';
import { appendRunEvent } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/** POST /api/funnels/:id/run — audit the saved funnel now (same limits as a submission). */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const wait = await rateLimiter(getRedis())(clientKeyFromHeaders(request.headers));
  if (wait > 0)
    return NextResponse.json({ error: 'rate_limited', retry_after_seconds: wait }, { status: 429 });
  const db = getDb();
  const funnel = await repo.getFunnel(db, id);
  if (!funnel) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // The global cap a submission gets (lib/runs.ts). Without it this button is a way around
  // that cap: same browser, same cost, different route.
  const queued = await queueDepth();
  if (queued >= RUN_LIMITS.maxQueueDepth)
    return NextResponse.json({ error: 'busy', queued }, { status: 503 });
  const isForm = (request.headers.get('content-type') ?? '').includes('form');
  // Optional sabotage for this run only: form `break` fields or JSON `{ break: "a,b" }`.
  let requested = '';
  if (isForm) requested = (await request.formData()).getAll('break').map(String).join(',');
  else
    requested = String(
      ((await request.json().catch(() => ({}))) as { break?: string }).break ?? '',
    );
  const sabotage = parseBreakToggles(requested);
  const { runId } = await runFunnelNow(db, funnel, enqueueRun, appendRunEvent(db), sabotage);
  if (isForm) return NextResponse.redirect(new URL(`/runs/${runId}`, request.url), 303);
  return NextResponse.json({ run_id: runId }, { status: 202 });
}
