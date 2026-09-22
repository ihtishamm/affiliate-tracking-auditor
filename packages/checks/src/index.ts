// The check engine (PROJECT_CONTEXT §6 M5): ten pure functions over a run's trace and the
// server-side rows for its order. No I/O, no clock. Each check either decides (pass/fail)
// from what the trace directly shows, or says `inconclusive` and why (§3: never report a
// failure the runner did not observe). A check that throws is `inconclusive` too — an error
// is never a pass (§11).
import type { Check } from './check.ts';
import { clickIdPersistence } from './checks/01-click-id-persistence.ts';
import { utmSurvival } from './checks/02-utm-survival.ts';
import { crossDomainHandoff } from './checks/03-cross-domain-handoff.ts';
import { pixelFireOrder } from './checks/04-pixel-fire-order.ts';
import { eventIdPresent } from './checks/05-event-id-present.ts';
import { capiDedupMatch } from './checks/06-capi-dedup-match.ts';
import { duplicateContainers } from './checks/07-duplicate-containers.ts';
import { postbackFired } from './checks/08-postback-fired.ts';
import { piiHashing } from './checks/09-pii-hashing.ts';
import { consentBlocking } from './checks/10-consent-blocking.ts';
import { CheckContext } from './context.ts';
import type { CheckInput, CheckReport, CheckResult } from './types.ts';

export const CHECKS: readonly Check[] = [
  clickIdPersistence,
  utmSurvival,
  crossDomainHandoff,
  pixelFireOrder,
  eventIdPresent,
  capiDedupMatch,
  duplicateContainers,
  postbackFired,
  piiHashing,
  consentBlocking,
];

export function runChecks(input: CheckInput): CheckReport {
  const ctx = new CheckContext(input);
  const results: CheckResult[] = CHECKS.map((check) => {
    try {
      return { id: check.id, number: check.number, title: check.title, ...check.run(ctx) };
    } catch (err) {
      return {
        id: check.id,
        number: check.number,
        title: check.title,
        status: 'inconclusive',
        observed: 'the check could not be evaluated',
        expected: '',
        reason: `check error: ${err instanceof Error ? err.message : String(err)}`,
        fixHint: '',
      };
    }
  });
  return { results, ...summarise(results) };
}

/**
 * Fewer decided checks than this and there is no score: a run that never got past the
 * landing page decides two or three checks, all of which may pass, and 3/3 = 100% would put
 * a network outage into the trend as a perfect day — and make it the baseline the next run
 * is judged against.
 */
export const MIN_DECIDED_FOR_SCORE = 3;

export function summarise(results: CheckResult[]): Pick<CheckReport, 'counts' | 'score'> {
  const counts = { pass: 0, fail: 0, inconclusive: 0 };
  for (const r of results) counts[r.status]++;
  const decided = counts.pass + counts.fail;
  return { counts, score: decided < MIN_DECIDED_FOR_SCORE ? null : counts.pass / decided };
}

export { CheckContext } from './context.ts';
export type { PixelHit } from './context.ts';
export { CHECK_IDS, EMPTY_SERVER_EVENTS } from './types.ts';
export type {
  CheckId,
  CheckInput,
  CheckReport,
  CheckResult,
  CheckStatus,
  ServerEvents,
} from './types.ts';
export { reconcile } from './reconcile.ts';
export type {
  DropOff,
  OrderLine,
  ReconcileOrder,
  ReconcileSources,
  Reconciliation,
} from './reconcile.ts';
export { DEFAULT_DROP_THRESHOLD, evaluateAlert, snapshotOf } from './alerts.ts';
export type { AlertVerdict, ScoreSnapshot } from './alerts.ts';
