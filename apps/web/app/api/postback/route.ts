import { NextResponse } from 'next/server';
import { POSTBACK_SIGNATURE_HEADER } from '@auditor/shared';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';
import { receivePostback } from '@/lib/postback-receiver.ts';
import { insertPostbackEvent } from '@/lib/store.ts';

export const dynamic = 'force-dynamic';

/** POST /api/postback — the affiliate network's side of an S2S postback. See postback-receiver.ts. */
export async function POST(request: Request): Promise<NextResponse> {
  // The raw text, untouched: the signature covers these exact bytes.
  const rawBody = await request.text();
  const outcome = await receivePostback(rawBody, request.headers.get(POSTBACK_SIGNATURE_HEADER), {
    secret: getEnv().POSTBACK_HMAC_SECRET,
    insert: insertPostbackEvent(getDb()),
    log,
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
