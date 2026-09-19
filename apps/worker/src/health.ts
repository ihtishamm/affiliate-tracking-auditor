import { createServer, type Server } from 'node:http';
import type { Logger } from '@auditor/shared';

export type ProbeResult = 'ok' | 'error';
export type Probe = () => Promise<ProbeResult>;

export interface HealthDeps {
  version: string;
  probes: { redis: Probe; browser: Probe };
  log: Logger;
}

/**
 * The worker is a queue consumer, not a web server; this tiny listener exists only so Railway
 * can tell a healthy worker from a wedged one. 200 means every probe passed, 503 otherwise,
 * and the body says which probe failed.
 */
export function startHealthServer(port: number, deps: HealthDeps): Server {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'GET' || path !== '/health') {
      res.writeHead(404).end();
      return;
    }
    void Promise.all([deps.probes.redis(), deps.probes.browser()]).then(([redis, browser]) => {
      const ok = redis === 'ok' && browser === 'ok';
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok, redis, browser, version: deps.version }));
    });
  });

  // A bind failure is a boot failure: say what happened in one line and stop, instead of the
  // unhandled-'error' stack trace Node prints by default.
  server.on('error', (err: NodeJS.ErrnoException) => {
    const hint = err.code === 'EADDRINUSE' ? ` (set WORKER_PORT to move the worker)` : '';
    deps.log.error(`health server failed to listen on ${port}${hint}`, { err });
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => deps.log.info('health server listening', { port }));
  return server;
}

/** Rejects if `promise` has not settled within `ms`; a hung probe must not hang the check. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
