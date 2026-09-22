import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { saveFunnelFromRun } from '@/lib/funnels.ts';
import { clientKeyFromHeaders, rateLimiter } from '@/lib/rate-limit.ts';
import { getRedis } from '@/lib/redis.ts';
import { getRun } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/** POST /api/funnels — save a finished run's funnel for daily audits. Form or JSON `{ run_id }`. */
export async function POST(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const isForm = (request.headers.get('content-type') ?? '').includes('form');
  const input = isForm
    ? Object.fromEntries((await request.formData()).entries())
    : await request.json().catch(() => null);
  const parsed = z.object({ run_id: z.uuid() }).safeParse(input);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 });

  const wait = await rateLimiter(getRedis())(clientKeyFromHeaders(request.headers));
  if (wait > 0)
    return NextResponse.json({ error: 'rate_limited', retry_after_seconds: wait }, { status: 429 });

  const db = getDb();
  const run = await getRun(db, parsed.data.run_id, { trace: false });
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const purchaseHost =
    run.urlHost === env.SHOPIFY_STORE_DOMAIN || run.url.includes('/advertorial')
      ? env.SHOPIFY_STORE_DOMAIN
      : null;
  const id = await saveFunnelFromRun(db, run, purchaseHost);
  if (isForm) return NextResponse.redirect(new URL(`/funnels/${id}`, request.url), 303);
  return NextResponse.json({ funnel_id: id }, { status: 201 });
}
