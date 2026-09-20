import { Redis } from 'ioredis';
import { chromium, type Browser } from 'playwright';
import { createDb, pingDb } from '@auditor/db';
import { createLogger, parseEnv, workerEnv, type Logger } from '@auditor/shared';
import { startTraceCleanup } from './cleanup.ts';
import { startEgressProxy } from './egress-proxy.ts';
import { startHealthServer, withTimeout, type ProbeResult } from './health.ts';
import { startQueueWorker } from './queue.ts';
import { appendRunEvent, deleteExpiredTraces, insertTrace } from './store.ts';

// Chromium flags for running inside a container. /dev/shm is tiny in Docker by default and
// Chromium crashes tabs when it fills; this makes it use /tmp instead.
const CHROMIUM_ARGS = ['--disable-dev-shm-usage'];

async function main(): Promise<void> {
  const env = parseEnv(workerEnv);
  const log = createLogger({ service: 'worker', level: env.LOG_LEVEL });
  const version = env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';

  // Two Redis connections on purpose: BullMQ requires `maxRetriesPerRequest: null` and owns
  // the blocking commands on its connection; the health probe keeps a small, fail-fast one.
  const probeRedis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  const queueRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  // ioredis emits 'error' on every failed reconnect; an unhandled 'error' event kills the process.
  probeRedis.on('error', (err) => log.warn('redis connection error', { err }));
  queueRedis.on('error', (err) => log.warn('queue redis connection error', { err }));
  // Connect before the health server opens: with the offline queue disabled, a PING sent during
  // the handshake is rejected, and the first probe is the one Railway sends after boot.
  await probeRedis
    .connect()
    .catch((err: unknown) => log.warn('redis unavailable at boot', { err }));

  const db = createDb(env.DATABASE_URL, { max: 3 });

  // The SSRF enforcement point (see egress-proxy.ts). It must exist before the browser does:
  // Chromium's proxy is fixed at launch, and the whole point is that no run can bypass it.
  const ssrf = { allowPrivate: env.ALLOW_PRIVATE_TARGETS };
  const proxy = await startEgressProxy({ ssrf, log });

  // One browser for the worker's lifetime; each run gets its own isolated context. Launching
  // at boot doubles as the M0 smoke test: a Railway image without a working Chromium fails
  // here, not on the first job.
  const browser = await launchBrowser(proxy.server, log);

  const health = startHealthServer(env.PORT, {
    version,
    log,
    probes: {
      redis: () => probe(() => withTimeout(probeRedis.ping(), 2_000)),
      db: () => probe(() => withTimeout(pingDb(db), 2_000)),
      browser: () => Promise.resolve<ProbeResult>(browser?.isConnected() ? 'ok' : 'error'),
    },
    extra: async () => {
      if (!queue) return {};
      const counts = await withTimeout(
        queue.worker.isRunning() ? getCounts() : Promise.resolve({}),
        2_000,
      );
      return { queue: counts };
    },
  });

  const queue = browser
    ? startQueueWorker({
        connection: queueRedis,
        browser,
        ssrf,
        proxy,
        storefrontPassword: env.SHOPIFY_STOREFRONT_PASSWORD,
        version,
        log,
        appendEvent: appendRunEvent(db),
        insertTrace: insertTrace(db),
      })
    : null;
  const cleanup = startTraceCleanup(deleteExpiredTraces(db), log);

  async function getCounts(): Promise<Record<string, number>> {
    const { Queue } = await import('bullmq');
    const q = new Queue('runs', { connection: queueRedis });
    const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
    await q.close();
    return c;
  }

  log.info('worker started', { version, node: process.version, queue: queue !== null });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    cleanup.stop();
    health.closeAllConnections();
    health.close();
    void Promise.all([queue?.worker.close(), queue?.dlq.close()])
      .then(() => browser?.close())
      .then(() => proxy.close())
      .finally(() => {
        probeRedis.disconnect();
        queueRedis.disconnect();
        process.exit(0);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function launchBrowser(proxyServer: string, log: Logger): Promise<Browser | null> {
  try {
    const browser = await log.time('chromium launch', () =>
      chromium.launch({
        args: CHROMIUM_ARGS,
        // `<-loopback>` removes Chromium's built-in "never proxy localhost" rule: a redirect
        // to http://localhost/ must reach the proxy (and be refused there), not the host.
        proxy: { server: proxyServer, bypass: '<-loopback>' },
      }),
    );
    log.info('chromium available', { chromium: browser.version() });
    browser.on('disconnected', () => {
      // A crashed browser cannot be recovered in place; Railway restarts an unhealthy service.
      log.error('chromium disconnected; exiting for a clean restart');
      process.exit(1);
    });
    return browser;
  } catch (err) {
    log.error('chromium failed to launch', { err });
    return null;
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
