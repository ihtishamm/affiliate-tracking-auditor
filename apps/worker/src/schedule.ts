import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { repo, type Db } from '@auditor/db';
import {
  DAILY_CRON,
  QUEUE_NAME,
  RUN_JOB_OPTIONS,
  SCHEDULE_QUEUE_NAME,
  dailyRunKey,
  type Logger,
  type RunJob,
} from '@auditor/shared';

// The daily schedule (§6 M8). One BullMQ job scheduler ticks at DAILY_CRON; its job walks the
// saved funnels and submits one run each, with the key `daily:<funnel>:<date>`. The key is
// the guarantee: `runs.idempotency_key` is unique, so a second tick on the same day (a
// redeploy re-registering the scheduler, two workers) reads the existing run and enqueues
// nothing. Vercel Cron was the alternative; the worker already owns the queue and this keeps
// scheduling where the jobs are.

export interface ScheduleDeps {
  connection: Redis;
  db: Db;
  log: Logger;
}

export async function startScheduler(deps: ScheduleDeps): Promise<{ close: () => Promise<void> }> {
  const runs = new Queue<RunJob>(QUEUE_NAME, { connection: deps.connection });
  const schedule = new Queue(SCHEDULE_QUEUE_NAME, { connection: deps.connection });
  // Idempotent: upserting the same scheduler id replaces its definition instead of adding one.
  await schedule.upsertJobScheduler(
    'funnels-daily',
    { pattern: DAILY_CRON, tz: 'UTC' },
    { name: 'tick' },
  );

  const worker = new Worker(
    SCHEDULE_QUEUE_NAME,
    async () => {
      const funnels = await repo.listFunnels(deps.db);
      const today = new Date();
      let submitted = 0;
      for (const f of funnels) {
        const created = await submitFunnelRun(f, dailyRunKey(f.id, today), { db: deps.db, runs });
        if (created) submitted++;
      }
      deps.log.info('daily tick', { funnels: funnels.length, submitted });
    },
    { connection: deps.connection, concurrency: 1 },
  );
  worker.on('error', (err) => deps.log.warn('scheduler error', { err }));
  deps.log.info('scheduler registered', { cron: DAILY_CRON });
  return {
    close: async () => {
      await worker.close();
      await schedule.close();
      await runs.close();
    },
  };
}

/** Inserts the run row (idempotent on `key`) and enqueues it when this call created it. */
export async function submitFunnelRun(
  funnel: {
    id: string;
    url: string;
    urlHost: string;
    clickIdParam: string;
    purchaseHost: string | null;
  },
  key: string,
  deps: { db: Db; runs: Queue<RunJob> },
): Promise<boolean> {
  const { id, created } = await repo.insertRun(deps.db, {
    idempotencyKey: key,
    url: funnel.url,
    urlHost: funnel.urlHost,
    clickIdParam: funnel.clickIdParam,
    funnelId: funnel.id,
  });
  if (!created) return false;
  await repo.appendRunEvent(deps.db, id, 'queued', 0, {
    host: funnel.urlHost,
    funnel: funnel.id,
    key,
  });
  await deps.runs.add(
    'run',
    {
      runId: id,
      url: funnel.url,
      clickIdParam: funnel.clickIdParam,
      purchaseHost: funnel.purchaseHost,
      funnelId: funnel.id,
    },
    { ...RUN_JOB_OPTIONS, jobId: id },
  );
  return true;
}
