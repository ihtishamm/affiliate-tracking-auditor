import { NextResponse } from 'next/server';
import {
  ATTRIBUTION_PARAMS,
  BREAK_PARAM,
  CLICK_ID_PARAM,
  UTM_PARAMS,
  parseBreakToggles,
  serializeBreakToggles,
} from '@auditor/shared';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';

export const dynamic = 'force-dynamic';

// The path on the store we are allowed to send people to. Relative, single leading slash, no
// scheme, no `//`, no query: /go must never become an open redirect to an arbitrary host.
const SAFE_STORE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/;

/**
 * GET /go — the advertorial → store hop of a duplicate funnel, as a real 302.
 *
 * This is the boundary where attribution dies in the wild: an affiliate's landing page links
 * into the merchant's store and the click ID or the UTMs do not make the jump. Forwarding them
 * here is the correct behaviour; the `drop_click_id` and `strip_utms` toggles reproduce the two
 * ways it goes wrong. A server-side redirect (rather than a client-side link) matters because
 * that is what the auditor observes in M4: a response with a Location header it can inspect hop
 * by hop.
 */
export function GET(request: Request): NextResponse {
  const env = getEnv();
  const incoming = new URL(request.url);
  const toggles = parseBreakToggles(incoming.searchParams.get(BREAK_PARAM));

  const requestedPath = incoming.searchParams.get('path') ?? '/';
  const path = SAFE_STORE_PATH.test(requestedPath) ? requestedPath : '/';
  const target = new URL(path, `https://${env.SHOPIFY_STORE_DOMAIN}`);

  const forwarded: string[] = [];
  const dropped: string[] = [];
  for (const key of ATTRIBUTION_PARAMS) {
    const value = incoming.searchParams.get(key);
    if (!value) continue;
    const isUtm = (UTM_PARAMS as readonly string[]).includes(key);
    if (
      (key === CLICK_ID_PARAM && toggles.includes('drop_click_id')) ||
      (isUtm && toggles.includes('strip_utms'))
    ) {
      dropped.push(key);
      continue;
    }
    target.searchParams.set(key, value);
    forwarded.push(key);
  }
  if (toggles.length > 0) target.searchParams.set(BREAK_PARAM, serializeBreakToggles(toggles));

  // Parameter names only, never values: the log is not a second copy of the tracking data.
  log.info('go: redirecting into store', { path, forwarded, dropped, toggles });

  return NextResponse.redirect(target, { status: 302, headers: { 'cache-control': 'no-store' } });
}
