import { Redis } from 'ioredis';
import { chromium } from 'playwright';
import { createLogger, parseEnv, workerEnv, type Logger } from '@auditor/shared';
import { startHealthServer, withTimeout, type ProbeResult } from './health.ts';

// Chromium flags for running inside a container. /dev/shm is tiny in Docker by default and
// Chromium crashes tabs when it fills; this makes it use /tmp instead.
const CHROMIUM_ARGS = ['--disable-dev-shm-usage'];

async function main(): Promise<void> {
  const env = parseEnv(workerEnv);
  const log = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const version = env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';

  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    // Fail a command immediately while disconnected instead of queueing it forever; the health
    // probe wants a fast, honest "error", not a hang.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  // ioredis emits 'error' on every failed reconnect; an unhandled 'error' event kills the process.
  redis.on('error', (err) => log.warn('redis connection error', { err }));
  // Connect before the health server opens. With the offline queue disabled, a PING sent during
  // the handshake is rejected, so a lazy first probe would report a false "error" -- and the
  // first probe is exactly the one Railway sends after boot. If Redis is down, ioredis keeps
  // retrying in the background and probes fail fast until it returns.
  await redis.connect().catch((err: unknown) => log.warn('redis unavailable at boot', { err }));

  // Launching the browser once at boot is the whole point of M0's worker: it proves the Railway
  // image has a working Chromium before any real run depends on it. The result is cached for
  // /health rather than re-launching on every probe.
  const browserStatus = await chromiumSmokeTest(log);

  const server = startHealthServer(env.PORT, {
    version,
    log,
    probes: {
      redis: () => probe(() => withTimeout(redis.ping(), 2_000)),
      browser: () => Promise.resolve(browserStatus),
    },
  });
  log.info('worker started', { version, node: process.version });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    server.closeAllConnections();
    server.close(() => {
      redis.disconnect();
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function chromiumSmokeTest(log: Logger): Promise<ProbeResult> {
  try {
    const browser = await log.time('chromium smoke test', async () => {
      const b = await chromium.launch({ args: CHROMIUM_ARGS });
      const version = b.version();
      await b.close();
      return version;
    });
    log.info('chromium available', { chromium: browser });
    return 'ok';
  } catch (err) {
    log.error('chromium failed to launch', { err });
    return 'error';
  }
}

async function probe(fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'error';
  }
}

main().catch((err: unknown) => {
  // Boot failures must be readable at a glance in Railway's logs, not a wall of stack trace.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`worker failed to start: ${message}\n`);
  process.exit(1);
});
