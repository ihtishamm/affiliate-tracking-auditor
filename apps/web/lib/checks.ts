import { repo, type Db } from '@auditor/db';
import { runChecks, type CheckReport } from '@auditor/checks';
import type { RunTrace } from '@auditor/shared';

// M5 wiring: the check engine is pure; this is the one place that feeds it. Server-side
// evidence is looked up by the order id the trace learned from the Purchase pixel hit.
//
// Reports are computed on read rather than stored: the server rows (webhook, CAPI, postback)
// arrive seconds after the run finishes, and a report frozen at completion would say
// "inconclusive" forever about events that exist. Persisting reports is deferred to the
// scheduled runs of M8, which need history rather than a live view.

export async function reportFor(db: Db, trace: RunTrace): Promise<CheckReport> {
  const server = trace.order ? await repo.loadServerEvents(db, trace.order.id) : null;
  return runChecks({ trace, server });
}
