import type { Browser } from 'playwright';
import {
  RUN_LIMITS,
  UTM_PARAMS,
  redactUrl,
  runTraceSchema,
  type FunnelStep,
  type Logger,
  type RunJob,
  type RunTrace,
  type SsrfOptions,
} from '@auditor/shared';
import type { EgressProxy } from './egress-proxy.ts';
import { driveFunnel, type FunnelIdentity, type FunnelResult } from './funnel.ts';
import { checkRobots } from './robots.ts';
import { TraceCollector } from './trace.ts';

// One run, start to finish: build the entry URL, open an isolated browser context with a
// believable user agent, drive the funnel under a hard deadline, and assemble the trace.
// The deadline is enforced HERE, with the context closed on expiry (§9: "in the worker, not
// just the queue"): BullMQ's stalled-job detection would only notice a hung run minutes later.

export interface RunResult {
  status: 'succeeded' | 'timed_out';
  trace: RunTrace;
}

export interface RunnerDeps {
  browser: Browser;
  ssrf: SsrfOptions;
  proxy: EgressProxy;
  storefrontPassword: string | undefined;
  log: Logger;
  fetch?: typeof fetch;
}

export class RunTimeout extends Error {
  constructor() {
    super(`run exceeded ${RUN_LIMITS.hardTimeoutMs} ms`);
  }
}

export async function executeRun(job: RunJob, deps: RunnerDeps): Promise<RunResult> {
  const startedAt = Date.now();
  const log = deps.log.child({ run_id: job.runId });
  const short = job.runId.slice(0, 8);

  // Attribution the checks can look for. The submitted URL's own values are used when
  // present; otherwise the runner adds ones it recognises, and says so in the trace.
  const entry = new URL(job.url);
  const injected: RunTrace['injected'] = { clickId: null, utm: {} };
  let expectedClickId = entry.searchParams.get(job.clickIdParam);
  if (!expectedClickId) {
    expectedClickId = `aud-${short}`;
    entry.searchParams.set(job.clickIdParam, expectedClickId);
    injected.clickId = expectedClickId;
  }
  if (!UTM_PARAMS.some((p) => entry.searchParams.has(p))) {
    injected.utm = { utm_source: 'auditor', utm_medium: 'audit', utm_campaign: `run-${short}` };
    for (const [k, v] of Object.entries(injected.utm)) entry.searchParams.set(k, v);
  }

  // A real, deliverable address: Shopify validates addresses and a made-up street earns a
  // "did you mean" prompt that blocks payment. Every string here is also what the redactor
  // scrubs from the trace, wherever the checkout echoes it.
  const identity: FunnelIdentity = {
    email: `audit-${short}@example.com`,
    firstName: 'Auditor',
    lastName: `Run ${short}`,
    address1: '350 5th Ave',
    city: 'New York',
    zone: 'NY',
    postalCode: '10118',
  };

  // Meta's pixel sends nothing when the UA says HeadlessChrome (found in M2). The context
  // presents the same Chromium as a normal Chrome; navigator.webdriver stays true.
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor(deps.browser.version())}.0.0.0 Safari/537.36`;

  const collector = new TraceCollector({
    runId: job.runId,
    startedAt,
    expectedClickId,
    clickIdParam: job.clickIdParam,
    ssrf: deps.ssrf,
    refusedReason: deps.proxy.reasonFor,
    log,
  });

  const robotsPromise = checkRobots(entry, deps.fetch);
  const context = await deps.browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    serviceWorkers: 'block',
  });
  await collector.attach(context);
  const page = await context.newPage();

  let funnel: FunnelResult;
  let status: RunResult['status'] = 'succeeded';
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new RunTimeout()), RUN_LIMITS.hardTimeoutMs).unref(),
  );
  try {
    funnel = await Promise.race([
      driveFunnel(entry.toString(), {
        page,
        collector,
        purchaseHost: job.purchaseHost,
        storefrontPassword: deps.storefrontPassword,
        identity,
        log,
      }),
      deadline,
    ]);
  } catch (err) {
    if (!(err instanceof RunTimeout)) {
      await context.close().catch(() => undefined);
      throw err; // infrastructure failure: let BullMQ retry
    }
    status = 'timed_out';
    const reached = (collector.steps.at(-1)?.step ?? 'landing') as FunnelStep;
    funnel = {
      reachedStep: reached,
      stopReason: `timed out after ${RUN_LIMITS.hardTimeoutMs / 1000} s at step ${reached}`,
      mode: 'observe',
      cta: null,
    };
    log.warn('run timed out', { reached });
  } finally {
    await context.close().catch(() => undefined);
  }

  const robots = await robotsPromise;
  const trace: RunTrace = {
    version: 1,
    runId: job.runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    entryUrl: redactUrl(entry),
    injected,
    clickIdParam: job.clickIdParam,
    expectedClickId,
    mode: funnel.mode,
    userAgent,
    robots,
    cta: funnel.cta,
    hops: collector.hops,
    steps: collector.steps,
    requests: collector.requests,
    requestsTruncated: collector.truncated,
    order: collector.orderFromTrace(),
    outcome: { reachedStep: funnel.reachedStep, stopReason: funnel.stopReason },
  };
  // The trace is validated before it is stored: a shape M5 cannot read is a worker bug, and
  // it should fail here, loudly, not in the check engine.
  return { status, trace: runTraceSchema.parse(trace) };
}

function chromeMajor(version: string): string {
  return /^(\d+)\./.exec(version)?.[1] ?? '124';
}
