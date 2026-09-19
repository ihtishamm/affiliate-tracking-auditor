import { NextResponse } from 'next/server';
import { pingDb } from '@auditor/db';
import { getDb } from '@/lib/db.ts';
import { getEnv } from '@/lib/env.ts';
import { log } from '@/lib/log.ts';

// A health check that was pre-rendered at build time would report the build machine's view
// of the database forever. Force it to run on every request.
export const dynamic = 'force-dynamic';

export async function GET() {
  let version = 'dev';
  try {
    const env = getEnv();
    version = env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? version;
    await pingDb(getDb());
    return NextResponse.json({ ok: true, db: 'ok', version });
  } catch (err) {
    log.error('health check failed', { err });
    return NextResponse.json({ ok: false, db: 'error', version }, { status: 503 });
  }
}
