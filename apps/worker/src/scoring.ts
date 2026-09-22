import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { eq, repo, schema, type Db } from '@auditor/db';
import { CHECKS, evaluateAlert, runChecks, snapshotOf } from '@auditor/checks';
import { SCORING_QUEUE_NAME, runTraceSchema, type Logger, type RunTrace } from '@auditor/shared';
import { sendAlert, type AlertWebhookDeps } from './alert-webhook.ts';

// Scoring a saved funnel's run (M8). Runs once per finished run, after the trace is stored:
//
//   1. wait (bounded) for the server rows of the order the run placed — the webhook, CAPI and
//      postback arrive seconds after the browser finishes, and a score frozen before them
//      would call checks 6 and 8 undecided forever;
//   2. compute the report and append it to funnel_scores (unique per run: a retry is a no-op);
//   3. compare with the previous score and, if the rule says so, claim an alert row and send
//      the webhook. The claim is the idempotency: the unique (funnel, run) index means the
//      webhook can only ever be sent by the one process that won the insert.

const SERVER_ROWS_WAIT_MS = 90_000;
const SERVER_ROWS_POLL_MS = 5_000;
/** Give the webhook a head start before the first poll. */
const SCORING_DELAY_MS = 20_000;

export interface ScoringJob {
  funnelId: string;
  runId: string;
}

/**
 * Scoring is its own delayed job rather than the tail of the run job: it may wait 90 s for
 * server rows, which would exceed the run job's lock and get it retried as "stalled". The job
 * id is the run id, so a run is scored once however many times completion is observed.
 */
export async function enqueueScoring(queue: Queue<ScoringJob>, job: ScoringJob): Promise<void> {
  // BullMQ forbids ':' in custom ids.
  await queue.add('score', job, {
    jobId: `score-${job.runId}`,
    delay: SCORING_DELAY_MS,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 200 },
  });
}

export function startScoringWorker(
  connection: Redis,
  deps: ScoringDeps,
): { queue: Queue<ScoringJob>; worker: Worker<ScoringJob> } {
  const queue = new Queue<ScoringJob>(SCORING_QUEUE_NAME, { connection });
  const worker = new Worker<ScoringJob>(
    SCORING_QUEUE_NAME,
    async (job) => {
      const row = await deps.db.query.runTraces.findFirst({
        where: eq(schema.runTraces.runId, job.data.runId),
      });
      if (!row) throw new Error(`no trace for run ${job.data.runId}`);
      await scoreFunnelRun(
        job.data.funnelId,
        job.data.runId,
        runTraceSchema.parse(row.trace),
        deps,
      );
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    deps.log.warn('scoring failed', { run_id: job?.data.runId, err: err.message }),
  );
  worker.on('error', (err) => deps.log.warn('scoring worker error', { err }));
  return { queue, worker };
}

export interface ScoringDeps {
  db: Db;
  log: Logger;
  webhook: (Omit<AlertWebhookDeps, 'log'> & { publicWebUrl: string | undefined }) | null;
  sleep: (ms: number) => Promise<void>;
}

export async function scoreFunnelRun(
  funnelId: string,
  runId: string,
  trace: RunTrace,
  deps: ScoringDeps,
): Promise<void> {
  const log = deps.log.child({ run_id: runId, funnel_id: funnelId });
  const server = trace.order ? await waitForServerRows(deps.db, trace.order.id, deps.sleep) : null;
  const report = runChecks({ trace, server });
  const snapshot = snapshotOf(report.results, report.score);
  const wrote = await repo.insertScore(deps.db, {
    funnelId,
    runId,
    score: report.score,
    statuses: snapshot.statuses,
    counts: report.counts,
  });
  if (!wrote) {
    log.info('run already scored');
    return;
  }
  log.info('funnel run scored', { score: report.score, ...report.counts });

  const previous = await repo.previousScore(deps.db, funnelId, runId);
  const titles = Object.fromEntries(CHECKS.map((c) => [c.id, c.title]));
  const verdict = evaluateAlert(previous, snapshot, titles);
  if (!verdict.fire) return;

  const alertId = await repo.insertAlert(deps.db, {
    funnelId,
    runId,
    previousScore: previous?.score ?? null,
    score: report.score,
    reasons: verdict.reasons,
  });
  if (!alertId) {
    log.info('alert already recorded for this run');
    return;
  }
  log.warn('funnel regressed', { reasons: verdict.reasons });
  if (!deps.webhook) return;

  const funnel = await repo.getFunnel(deps.db, funnelId);
  const delivery = await sendAlert(
    {
      type: 'funnel_alert',
      funnel: { id: funnelId, label: funnel?.label ?? funnelId, url: funnel?.url ?? '' },
      run_id: runId,
      report_url: deps.webhook.publicWebUrl ? `${deps.webhook.publicWebUrl}/runs/${runId}` : null,
      previous_score: previous?.score ?? null,
      score: report.score,
      reasons: verdict.reasons,
      flipped: verdict.flipped,
      fired_at: new Date().toISOString(),
    },
    { url: deps.webhook.url, secret: deps.webhook.secret, fetch: deps.webhook.fetch, log },
  );
  await repo.recordAlertDelivery(deps.db, alertId, delivery);
}

/** Polls until both a CAPI and a postback attempt exist for the order, or the wait is up. */
async function waitForServerRows(db: Db, orderId: string, sleep: (ms: number) => Promise<void>) {
  const until = Date.now() + SERVER_ROWS_WAIT_MS;
  for (;;) {
    const rows = await repo.loadServerEvents(db, orderId);
    const kinds = new Set(rows.conversionAttempts.map((a) => a.kind));
    if ((kinds.has('capi') && kinds.has('postback')) || Date.now() >= until) return rows;
    await sleep(SERVER_ROWS_POLL_MS);
  }
}
