import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Browser } from 'playwright';
import {
  DLQ_NAME,
  QUEUE_NAME,
  RUN_LIMITS,
  runJobSchema,
  type Logger,
  type RunJob,
  type RunStatus,
  type RunTrace,
  type SsrfOptions,
} from '@auditor/shared';
import type { EgressProxy } from './egress-proxy.ts';
import { executeRun } from './runner.ts';

// The BullMQ consumer. Its contract with the database is simple: every attempt appends a
// `running` event; a completed run appends its terminal status; a thrown error lets BullMQ
// retry (exponential backoff, RUN_LIMITS.attempts) and appends a `queued` event saying so;
// the last failure appends `failed` and copies the job to the dead-letter queue.
//
// What is NOT retried, on purpose: a timed-out run and a run whose URL was blocked. Both are
// properties of the funnel, not of our infrastructure, and would fail again 5 s later; they
// complete normally from BullMQ's point of view and carry their verdict in run_events.

export interface QueueDeps {
  connection: Redis;
  browser: Browser;
  ssrf: SsrfOptions;
  proxy: EgressProxy;
  storefrontPassword: string | undefined;
  version: string;
  log: Logger;
  appendEvent: (
    runId: string,
    status: RunStatus,
    attempt: number,
    detail: Record<string, unknown>,
  ) => Promise<void>;
  insertTrace: (trace: RunTrace) => Promise<number>;
}

export function startQueueWorker(deps: QueueDeps): {
  worker: Worker<RunJob>;
  dlq: Queue<RunJob & { error: string }>;
} {
  const dlq = new Queue<RunJob & { error: string }>(DLQ_NAME, { connection: deps.connection });

  const worker = new Worker<RunJob>(
    QUEUE_NAME,
    async (job) => {
      const data = runJobSchema.parse(job.data);
      const attempt = job.attemptsMade + 1;
      const log = deps.log.child({ run_id: data.runId, attempt });
      await deps.appendEvent(data.runId, 'running', attempt, {
        worker: deps.version,
        host: new URL(data.url).hostname,
      });

      const result = await log.time('run', () =>
        executeRun(data, {
          browser: deps.browser,
          ssrf: deps.ssrf,
          proxy: deps.proxy,
          storefrontPassword: deps.storefrontPassword,
          log,
        }),
      );
      const bytes = await deps.insertTrace(result.trace);
      await deps.appendEvent(data.runId, result.status, attempt, {
        reached: result.trace.outcome.reachedStep,
        reason: result.trace.outcome.stopReason,
        mode: result.trace.mode,
        requests: result.trace.requests.length,
        trace_bytes: bytes,
        duration_ms: Date.parse(result.trace.finishedAt) - Date.parse(result.trace.startedAt),
      });
      log.info('run finished', {
        status: result.status,
        reached: result.trace.outcome.reachedStep,
      });
    },
    {
      connection: deps.connection,
      concurrency: RUN_LIMITS.concurrency,
      // A run may legitimately take the full hard timeout; the lock must outlive it, or a
      // second worker would consider the job stalled and start it again mid-run.
      lockDuration: RUN_LIMITS.hardTimeoutMs + 30_000,
      stalledInterval: 60_000,
    },
  );

  worker.on('failed', (job: Job<RunJob> | undefined, err: Error) => {
    if (!job) return;
    const runId = job.data.runId;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    const error = err.message.split('\n')[0] ?? 'error';
    void (async () => {
      if (exhausted) {
        await deps.appendEvent(runId, 'failed', job.attemptsMade, { error, worker: deps.version });
        await dlq.add('dead', { ...job.data, error }, { jobId: runId, removeOnComplete: false });
        deps.log.error('run failed permanently; moved to DLQ', { run_id: runId, error });
      } else {
        await deps.appendEvent(runId, 'queued', job.attemptsMade, { error, retry: true });
        deps.log.warn('run attempt failed; will retry', {
          run_id: runId,
          attempt: job.attemptsMade,
          error,
        });
      }
    })().catch((e: unknown) =>
      deps.log.error('recording failure failed', { run_id: runId, err: e }),
    );
  });
  worker.on('error', (err) => deps.log.warn('queue worker error', { err }));

  return { worker, dlq };
}
