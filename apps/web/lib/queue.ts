import { Queue } from 'bullmq';
import { QUEUE_NAME, RUN_JOB_OPTIONS, type RunJob } from '@auditor/shared';
import { getRedis } from '@/lib/redis.ts';

let queue: Queue<RunJob> | undefined;

function getQueue(): Queue<RunJob> {
  queue ??= new Queue<RunJob>(QUEUE_NAME, {
    connection: getRedis(),
    // Same options the daily scheduler uses (packages/shared/src/run.ts): 3 attempts with
    // exponential backoff; timeouts and blocked URLs are made unrecoverable by the worker.
    defaultJobOptions: RUN_JOB_OPTIONS,
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
