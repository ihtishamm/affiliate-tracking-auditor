import {
  redactUrl,
  runSubmissionSchema,
  RUN_LIMITS,
  type Logger,
  type RunJob,
  type RunStatus,
  type SsrfOptions,
} from '@auditor/shared';
import { checkTargetUrl } from '@auditor/shared/ssrf';

// Run submission (M4). Everything that decides whether a URL becomes a job is here, as a
// function over injected dependencies, so the tests can pin every outcome without Redis or
// Postgres. The route handler only adapts HTTP to this.
//
// Order matters:
//   1. shape (zod)           — cheap, no I/O
//   2. rate limit            — before the SSRF check's DNS lookup, so a flood cannot use us as
//                              a resolver
//   3. SSRF verdict          — §9; the worker repeats it per hop
//   4. queue depth           — the global cap that a per-IP limit cannot give
//   5. insert + enqueue      — insert first; if the key already exists the earlier run is
//                              returned and NOT re-enqueued (BullMQ would also refuse a
//                              duplicate jobId, but the database is the source of truth).

export type SubmitOutcome =
  | { status: 202; body: { run_id: string; status: RunStatus; deduplicated: boolean } }
  | { status: 400; body: { error: 'invalid_input'; issues: string[] } }
  | { status: 422; body: { error: 'url_not_allowed'; reason: string } }
  | { status: 429; body: { error: 'rate_limited'; retry_after_seconds: number } }
  | { status: 503; body: { error: 'busy'; queued: number } };

export interface SubmitDeps {
  /** Resolves to the existing run id when `idempotencyKey` was seen before, else null. */
  insertRun: (run: {
    idempotencyKey: string;
    url: string;
    urlHost: string;
    clickIdParam: string;
  }) => Promise<{ id: string; created: boolean }>;
  appendEvent: (runId: string, status: RunStatus, detail: Record<string, unknown>) => Promise<void>;
  enqueue: (job: RunJob) => Promise<void>;
  queueDepth: () => Promise<number>;
  /** Returns how many seconds to wait, or 0 when allowed. */
  rateLimit: (clientKey: string) => Promise<number>;
  ssrf?: SsrfOptions;
  purchaseHost: string | null;
  log: Logger;
}

export async function submitRun(
  input: unknown,
  clientKey: string,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const parsed = runSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { status: 400, body: { error: 'invalid_input', issues } };
  }
  const sub = parsed.data;

  const wait = await deps.rateLimit(clientKey);
  if (wait > 0) return { status: 429, body: { error: 'rate_limited', retry_after_seconds: wait } };

  const verdict = await checkTargetUrl(sub.url, deps.ssrf);
  if (!verdict.allowed) {
    deps.log.warn('run refused: url not allowed', { reason: verdict.reason });
    return { status: 422, body: { error: 'url_not_allowed', reason: verdict.reason } };
  }

  const queued = await deps.queueDepth();
  if (queued >= RUN_LIMITS.maxQueueDepth) return { status: 503, body: { error: 'busy', queued } };

  // Stored form of the URL: PII-looking query values are gone before the row exists.
  const url = redactUrl(verdict.url);
  const { id, created } = await deps.insertRun({
    idempotencyKey: sub.idempotency_key,
    url,
    urlHost: verdict.url.hostname,
    clickIdParam: sub.click_id_param,
  });
  if (!created) {
    deps.log.info('run submission deduplicated', { run_id: id });
    return { status: 202, body: { run_id: id, status: 'queued', deduplicated: true } };
  }

  await deps.appendEvent(id, 'queued', { host: verdict.url.hostname });
  await deps.enqueue({
    runId: id,
    url,
    clickIdParam: sub.click_id_param,
    purchaseHost: deps.purchaseHost,
  });
  deps.log.info('run queued', { run_id: id, host: verdict.url.hostname });
  return { status: 202, body: { run_id: id, status: 'queued', deduplicated: false } };
}
