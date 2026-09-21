import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';
import { reconcileWindow } from '@/lib/reconcile.ts';
import { parseWindow } from '@/lib/reconcile-window.ts';

export const dynamic = 'force-dynamic';

/** GET /api/reconcile?from=YYYY-MM-DD&to=YYYY-MM-DD — orders vs pixel vs CAPI vs postbacks for the window. */
export async function GET(request: Request): Promise<NextResponse> {
  const env = getEnv();
  if (!env.SHOPIFY_ADMIN_TOKEN) {
    return NextResponse.json(
      { error: 'not_configured', reason: 'SHOPIFY_ADMIN_TOKEN is not set' },
      { status: 503 },
    );
  }
  const window = parseWindow(new URL(request.url).searchParams);
  if ('error' in window)
    return NextResponse.json({ error: 'invalid_window', reason: window.error }, { status: 400 });
  try {
    const report = await reconcileWindow(window.from, window.to, {
      db: getDb(),
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      token: env.SHOPIFY_ADMIN_TOKEN,
      fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    });
    return NextResponse.json(report);
  } catch (err) {
    log.error('reconcile failed', { err });
    return NextResponse.json(
      { error: 'upstream', reason: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
