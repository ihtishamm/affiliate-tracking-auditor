import { Redis } from 'ioredis';
import { getEnv } from '@/lib/env.ts';

let redis: Redis | undefined;

/**
 * One connection per server instance, created on first use. Vercel keeps a warm instance
 * around between invocations, so this is usually reused; a cold start pays one handshake.
 * `maxRetriesPerRequest: null` is BullMQ's requirement (it must never see a command fail
 * because of a transient reconnect).
 */
export function getRedis(): Redis {
  redis ??= new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: 5_000,
    lazyConnect: true,
  });
  return redis;
}
