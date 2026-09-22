import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RUN_LIMITS } from '@auditor/shared';

// Per-IP rate limit (§9): a fixed one-hour window counted in Redis. INCR + EXPIRE-on-first-hit
// is two commands in a MULTI, atomic enough for a limit of five. The key holds a hash of the
// address, not the address: Redis then never stores an IP either, for the same reason the
// database never stores an email.
const WINDOW_SECONDS = 3600;

export function clientKeyFromHeaders(headers: Headers): string {
  // Vercel overwrites x-forwarded-for with the true client address (it is the proxy), so the
  // first entry is trustworthy here. Behind any other proxy this would need revisiting.
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

/** Resolves 0 when allowed, else the seconds until the window resets. */
// `limit: number`, not the inferred literal: RUN_LIMITS is `as const`, so without the
// annotation the parameter's type would be `5` and no caller (or test) could pass another.
export function rateLimiter(redis: Redis, limit: number = RUN_LIMITS.rateLimitPerHour) {
  return async (clientKey: string): Promise<number> => {
    const key = `rl:runs:${clientKey}`;
    const results = await redis.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').ttl(key).exec();
    // exec() yields [error, value] per command; a Redis error here should surface, not be
    // treated as "allowed".
    const failed = results?.find(([err]) => err);
    if (failed?.[0]) throw failed[0];
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? WINDOW_SECONDS);
    return count > limit ? Math.max(ttl, 1) : 0;
  };
}
