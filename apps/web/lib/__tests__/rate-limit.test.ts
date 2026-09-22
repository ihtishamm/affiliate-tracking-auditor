import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { clientKeyFromHeaders, rateLimiter } from '../rate-limit.ts';

// The per-IP limit is one of M9's two named done criteria (§9), and it is the guard that is
// easiest to get subtly wrong: a window that slides forward on every request never resets, and
// a Redis error swallowed into "allowed" removes the limit exactly when the system is unwell.
// Both are asserted here, against a Redis double that records the commands it was given —
// `EXPIRE … NX` is the difference between a fixed window and a sliding one, so the test looks
// at the argument, not only at the outcome.
//
// The double is 30 lines of the four commands the limiter uses, rather than `ioredis-mock`:
// a dependency carried for one test file, and one that would not let the test see `NX` at all.

interface Recorded {
  redis: Redis;
  commands: string[][];
  entries: Map<string, { count: number; ttl: number }>;
}

function fakeRedis(execError?: Error): Recorded {
  const entries = new Map<string, { count: number; ttl: number }>();
  const commands: string[][] = [];
  const multi = (): unknown => {
    const queued: Array<() => [Error | null, unknown]> = [];
    const chain = {
      incr(key: string) {
        commands.push(['incr', key]);
        queued.push(() => {
          const entry = entries.get(key) ?? { count: 0, ttl: -1 };
          entry.count += 1;
          entries.set(key, entry);
          return [null, entry.count];
        });
        return chain;
      },
      expire(key: string, seconds: number, mode?: string) {
        commands.push(['expire', key, String(seconds), mode ?? '']);
        queued.push(() => {
          const entry = entries.get(key);
          if (!entry) return [null, 0];
          // Real Redis semantics: NX sets the TTL only when the key has none.
          if (mode === 'NX' && entry.ttl !== -1) return [null, 0];
          entry.ttl = seconds;
          return [null, 1];
        });
        return chain;
      },
      ttl(key: string) {
        commands.push(['ttl', key]);
        queued.push(() => [null, entries.get(key)?.ttl ?? -2]);
        return chain;
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        if (execError) return queued.map(() => [execError, null]);
        return queued.map((run) => run());
      },
    };
    return chain;
  };
  return { redis: { multi } as unknown as Redis, commands, entries };
}

describe('clientKeyFromHeaders', () => {
  it('takes the first entry of x-forwarded-for (Vercel overwrites it with the true client)', () => {
    const key = clientKeyFromHeaders(
      new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18', 'x-real-ip': '198.51.100.9' }),
    );
    expect(key).toBe(createHash('sha256').update('203.0.113.7').digest('hex').slice(0, 32));
  });

  it('falls back to x-real-ip, then to a constant — an unknown client is still rate limited', () => {
    expect(clientKeyFromHeaders(new Headers({ 'x-real-ip': '198.51.100.9' }))).toBe(
      createHash('sha256').update('198.51.100.9').digest('hex').slice(0, 32),
    );
    expect(clientKeyFromHeaders(new Headers())).toBe(
      createHash('sha256').update('unknown').digest('hex').slice(0, 32),
    );
  });

  it('is a hash: the address itself never reaches Redis', () => {
    const key = clientKeyFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }));
    expect(key).not.toContain('203.0.113.7');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('rateLimiter', () => {
  it('allows up to the limit, then answers with the seconds left in the window', async () => {
    const { redis } = fakeRedis();
    const limit = rateLimiter(redis, 3);
    expect(await limit('client-a')).toBe(0);
    expect(await limit('client-a')).toBe(0);
    expect(await limit('client-a')).toBe(0);
    expect(await limit('client-a')).toBe(3600);
  });

  it('counts per client, so one flood does not lock everyone out', async () => {
    const { redis } = fakeRedis();
    const limit = rateLimiter(redis, 1);
    expect(await limit('client-a')).toBe(0);
    expect(await limit('client-a')).toBeGreaterThan(0);
    expect(await limit('client-b')).toBe(0);
  });

  it('sets the expiry with NX: a fixed window, not one that slides away from the caller', async () => {
    const { redis, commands, entries } = fakeRedis();
    const limit = rateLimiter(redis, 5);
    await limit('client-a');
    const key = 'rl:runs:client-a';
    expect(commands).toEqual([
      ['incr', key],
      ['expire', key, '3600', 'NX'],
      ['ttl', key],
    ]);
    // A later request inside the window must not push the reset further out.
    entries.set(key, { count: 1, ttl: 120 });
    await limit('client-a');
    expect(entries.get(key)?.ttl).toBe(120);
  });

  it('reports at least one second: retry-after 0 would invite an immediate retry', async () => {
    const { redis, entries } = fakeRedis();
    entries.set('rl:runs:client-a', { count: 9, ttl: 0 });
    expect(await rateLimiter(redis, 1)('client-a')).toBe(1);
  });

  it('a Redis failure surfaces; it is never read as "allowed"', async () => {
    const { redis } = fakeRedis(new Error('READONLY You cannot write against a read only replica'));
    await expect(rateLimiter(redis, 5)('client-a')).rejects.toThrow('READONLY');
  });
});
