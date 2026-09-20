import { Queue } from 'bullmq';
import { QUEUE_NAME, RUN_LIMITS, type RunJob } from '@auditor/shared';
import { getRedis } from '@/lib/redis.ts';

let queue: Queue<RunJob> | undefined;

function getQueue(): Queue<RunJob> {
  queue ??= new Queue<RunJob>(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      // Exponential backoff, max 3 attempts (§5). The worker marks timeouts and blocked URLs
      // unrecoverable so they do not burn the remaining attempts.
      attempts: RUN_LIMITS.attempts,
      backoff: { type: 'exponential', delay: RUN_LIMITS.backoffMs },
      removeOnComplete: { count: 200 },
      // Failed jobs stay: they are also copied to the DLQ by the worker, but a failed set
      // that can be inspected in Redis costs nothing.
      removeOnFail: { count: 500 },
    },
  });
  return queue;
}

/** `jobId = runId`: BullMQ refuses a second job with the same id, a belt to the database's braces. */
export async function enqueueRun(job: RunJob): Promise<void> {
  await getQueue().add('run', job, { jobId: job.runId });
}

/** Jobs not yet picked up. The submission endpoint refuses new work past RUN_LIMITS.maxQueueDepth. */
export async function queueDepth(): Promise<number> {
  const counts = await getQueue().getJobCounts('waiting', 'delayed', 'prioritized');
  return (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0) + (counts['prioritized'] ?? 0);
}
