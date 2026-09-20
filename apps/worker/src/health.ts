import { createServer, type Server } from 'node:http';
import type { Logger } from '@auditor/shared';

export type ProbeResult = 'ok' | 'error';
export type Probe = () => Promise<ProbeResult>;

export interface HealthDeps {
  version: string;
  probes: Record<string, Probe>;
  /** Informational fields appended to the body (queue depth); never affect the status code. */
  extra?: () => Promise<Record<string, unknown>>;
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
    const names = Object.keys(deps.probes);
    void Promise.all([
      Promise.all(names.map((n) => deps.probes[n]?.() ?? Promise.resolve<ProbeResult>('error'))),
      deps.extra?.().catch(() => ({})) ?? Promise.resolve({}),
    ]).then(([results, extra]) => {
      const ok = results.every((r) => r === 'ok');
      const body: Record<string, unknown> = { ok, version: deps.version, ...extra };
      names.forEach((n, i) => (body[n] = results[i]));
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify(body));
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
