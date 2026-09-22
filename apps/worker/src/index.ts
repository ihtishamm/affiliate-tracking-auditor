import { Redis } from 'ioredis';
import { chromium, type Browser } from 'playwright';
import { createDb, pingDb } from '@auditor/db';
import { createLogger, parseEnv, workerEnv, type Logger } from '@auditor/shared';
import { startTraceCleanup } from './cleanup.ts';
import { startEgressProxy } from './egress-proxy.ts';
import { startHealthServer, withTimeout, type ProbeResult } from './health.ts';
import { startQueueWorker } from './queue.ts';
import { startScheduler } from './schedule.ts';
import { enqueueScoring, startScoringWorker } from './scoring.ts';
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

  // Meta's CDN answers some datacenter addresses with a response Chromium refuses to run
  // (Cross-Origin-Resource-Policy: same-origin → ERR_BLOCKED_BY_RESPONSE). A run from such a
  // worker sees a pixel that never fires — a fact about this worker's egress, not the funnel.
  // Probed once at boot, from Chromium through the proxy exactly as a run would load it, and
  // reported by /health so it is visible without reading a trace.
  const metaCdn = browser ? await probeMetaPixelScript(browser, log) : null;

  const health = startHealthServer(env.PORT, {
    version,
    log,
    probes: {
      redis: () => probe(() => withTimeout(probeRedis.ping(), 2_000)),
      db: () => probe(() => withTimeout(pingDb(db), 2_000)),
      browser: () => Promise.resolve<ProbeResult>(browser?.isConnected() ? 'ok' : 'error'),
    },
    extra: async () => {
      if (!queue) return { meta_cdn: metaCdn };
      const counts = await withTimeout(
        queue.worker.isRunning() ? getCounts() : Promise.resolve({}),
        2_000,
      );
      return { queue: counts, meta_cdn: metaCdn };
    },
  });

  // M8: scoring of saved funnels' runs, and the daily schedule that creates those runs.
  const scoring = startScoringWorker(queueRedis, {
    db,
    log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    webhook: env.ALERT_WEBHOOK_URL
      ? {
          url: env.ALERT_WEBHOOK_URL,
          secret: env.ALERT_WEBHOOK_SECRET,
          fetch,
          publicWebUrl: env.PUBLIC_WEB_URL,
        }
      : null,
  });
  const scheduler = await startScheduler({ connection: queueRedis, db, log });

  const queue = browser
    ? startQueueWorker({
        connection: queueRedis,
        onFunnelRunFinished: (funnelId, runId) =>
          enqueueScoring(scoring.queue, { funnelId, runId }),
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
    void Promise.all([
      queue?.worker.close(),
      queue?.dlq.close(),
      scoring.worker.close(),
      scoring.queue.close(),
      scheduler.close(),
    ])
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

interface MetaPixelScriptProbe {
  /** Whether Chromium accepted the script from connect.facebook.net. */
  loads: boolean;
  status: number | null;
  failure: string | null;
}

async function probeMetaPixelScript(browser: Browser, log: Logger): Promise<MetaPixelScriptProbe> {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });
  try {
    const page = await context.newPage();
    const outcome = new Promise<MetaPixelScriptProbe>((resolve) => {
      page.on('requestfinished', (r) => {
        if (/fbevents\.js$/.test(r.url())) {
          void r
            .response()
            .then((res) => resolve({ loads: true, status: res?.status() ?? null, failure: null }));
        }
      });
      page.on('requestfailed', (r) => {
        if (/fbevents\.js$/.test(r.url()))
          resolve({ loads: false, status: null, failure: r.failure()?.errorText ?? 'failed' });
      });
    });
    // A real document origin, so the script request looks like every site's (Sec-Fetch-Site:
    // cross-site, a Referer); from about:blank Facebook serves the variant Chromium refuses.
    // The page itself is fulfilled locally and never touches the network.
    await page.route('https://probe.auditor.invalid/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>probe</title><script src="https://connect.facebook.net/en_US/fbevents.js"></script>',
      }),
    );
    await page
      .goto('https://probe.auditor.invalid/', { waitUntil: 'load', timeout: 10_000 })
      .catch(() => undefined);
    const probe = await withTimeout(outcome, 10_000);
    (probe.loads ? log.info : log.warn).call(log, 'meta pixel script probe', { ...probe });
    return probe;
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    log.warn('meta pixel script probe failed', { err: failure });
    return { loads: false, status: null, failure };
  } finally {
    await context.close().catch(() => undefined);
  }
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
