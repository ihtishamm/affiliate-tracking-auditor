import { repo, type Db } from '@auditor/db';
import {
  BREAK_PARAM,
  redactUrl,
  serializeBreakToggles,
  type BreakToggle,
  type RunJob,
  type RunStatus,
} from '@auditor/shared';

// M8 web-side operations on saved funnels: create one from a finished run, and start a run
// on demand. The daily schedule lives in the worker; "run now" is the same submission with
// a different key, so the funnel page can demonstrate the alert without waiting for 06:00.

export async function saveFunnelFromRun(
  db: Db,
  run: { url: string; urlHost: string; clickIdParam: string },
  purchaseHost: string | null,
): Promise<string> {
  const label = labelFor(run.url);
  return repo.insertFunnel(db, {
    url: redactUrl(run.url),
    urlHost: run.urlHost,
    clickIdParam: run.clickIdParam,
    label,
    purchaseHost,
  });
}

/**
 * Audit the saved funnel now. `sabotage` applies break-it toggles to THIS run's entry URL
 * only — the saved funnel stays as it was — which is how a reviewer makes "the funnel broke
 * today" happen on demand instead of editing the store: the next scored run regresses against
 * the baseline and the alert rule fires exactly once.
 */
export async function runFunnelNow(
  db: Db,
  funnel: {
    id: string;
    url: string;
    urlHost: string;
    clickIdParam: string;
    purchaseHost: string | null;
  },
  enqueue: (job: RunJob) => Promise<void>,
  appendEvent: (runId: string, status: RunStatus, detail: Record<string, unknown>) => Promise<void>,
  sabotage: BreakToggle[] = [],
): Promise<{ runId: string; created: boolean }> {
  const key = `manual:${funnel.id}:${Date.now()}`;
  const url = new URL(funnel.url);
  if (sabotage.length > 0) url.searchParams.set(BREAK_PARAM, serializeBreakToggles(sabotage));
  const { id, created } = await repo.insertRun(db, {
    idempotencyKey: key,
    url: url.toString(),
    urlHost: funnel.urlHost,
    clickIdParam: funnel.clickIdParam,
    funnelId: funnel.id,
  });
  if (created) {
    await appendEvent(id, 'queued', { host: funnel.urlHost, funnel: funnel.id, key, sabotage });
    await enqueue({
      runId: id,
      url: url.toString(),
      clickIdParam: funnel.clickIdParam,
      purchaseHost: funnel.purchaseHost,
      funnelId: funnel.id,
    });
  }
  return { runId: id, created };
}

/** host + path, plus the break-it toggles if the URL has any — enough to tell funnels apart in a list. */
export function labelFor(url: string): string {
  try {
    const u = new URL(url);
    const toggles = u.searchParams.get('__break');
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${toggles ? ` (${toggles})` : ''}`;
  } catch {
    return url.slice(0, 80);
  }
}
