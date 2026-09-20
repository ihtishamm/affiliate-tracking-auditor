import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';
import { enqueueRun, queueDepth } from '@/lib/queue.ts';
import { clientKeyFromHeaders, rateLimiter } from '@/lib/rate-limit.ts';
import { getRedis } from '@/lib/redis.ts';
import { submitRun } from '@/lib/runs.ts';
import { appendRunEvent, insertRun } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/runs — accepts JSON or a plain HTML form. A form submission is answered with a
 * redirect to the run page (so the landing page needs no JavaScript); JSON gets JSON.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const db = getDb();
  const isForm = (request.headers.get('content-type') ?? '').includes('form');
  const input = isForm
    ? Object.fromEntries((await request.formData()).entries())
    : await request.json().catch(() => null);

  const outcome = await submitRun(input, clientKeyFromHeaders(request.headers), {
    insertRun: insertRun(db),
    appendEvent: appendRunEvent(db),
    enqueue: enqueueRun,
    queueDepth,
    rateLimit: rateLimiter(getRedis()),
    ssrf: { allowPrivate: env.ALLOW_PRIVATE_TARGETS },
    purchaseHost: env.SHOPIFY_STORE_DOMAIN,
    log,
  });

  if (isForm && outcome.status === 202) {
    return NextResponse.redirect(new URL(`/runs/${outcome.body.run_id}`, request.url), 303);
  }
  const headers: Record<string, string> = {};
  if (outcome.status === 429) headers['retry-after'] = String(outcome.body.retry_after_seconds);
  return NextResponse.json(outcome.body, { status: outcome.status, headers });
}
