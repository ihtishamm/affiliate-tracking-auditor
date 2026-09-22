import type { CheckResult } from './types.ts';

// Alert rule (§6 M8). One question, asked once per scored run: did this run get materially
// worse than the previous one? Two things count as worse:
//
//   1. the score dropped by at least `dropThreshold` (default 20 points) — the funnel lost a
//      chunk of its checks at once;
//   2. any check went from pass to fail — a specific regression, whatever the score did.
//
// Two things deliberately do NOT count:
//   - inconclusive → fail. Inconclusive means the evidence was missing last time, not that the
//     check was healthy; calling that a regression would alert on the first complete run of
//     a funnel that was always broken. It shows in the score history; it is not an alarm.
//   - the very first run. There is nothing to have got worse than. The first score is the
//     baseline the next run is judged against.
//
// The rule is pure and per pair (previous, current). "Exactly one alert per run" is not this
// function's job: the caller claims an `alerts` row under a unique (funnel, run) index and
// sends the webhook only when the claim succeeds.

export interface ScoreSnapshot {
  score: number | null;
  /** check id → status */
  statuses: Record<string, string>;
}

export interface AlertVerdict {
  fire: boolean;
  /** Why, in the order it will be shown. Empty when `fire` is false. */
  reasons: string[];
  /** Check ids that went pass → fail. */
  flipped: string[];
  scoreDrop: number | null;
}

export const DEFAULT_DROP_THRESHOLD = 0.2;

export function evaluateAlert(
  previous: ScoreSnapshot | null,
  current: ScoreSnapshot,
  titles: Record<string, string> = {},
  dropThreshold = DEFAULT_DROP_THRESHOLD,
): AlertVerdict {
  if (!previous) return { fire: false, reasons: [], flipped: [], scoreDrop: null };

  const flipped = Object.entries(current.statuses)
    .filter(([id, status]) => status === 'fail' && previous.statuses[id] === 'pass')
    .map(([id]) => id);

  const scoreDrop =
    previous.score !== null && current.score !== null ? previous.score - current.score : null;

  const reasons: string[] = [];
  if (scoreDrop !== null && scoreDrop >= dropThreshold) {
    reasons.push(`score dropped from ${pct(previous.score)} to ${pct(current.score)}`);
  }
  for (const id of flipped) reasons.push(`${titles[id] ?? id} went from pass to fail`);

  return { fire: reasons.length > 0, reasons, flipped, scoreDrop };
}

/** The frozen shape stored per run: statuses by check id. */
export function snapshotOf(results: CheckResult[], score: number | null): ScoreSnapshot {
  const statuses: Record<string, string> = {};
  for (const r of results) statuses[r.id] = r.status;
  return { score, statuses };
}

function pct(score: number | null): string {
  return score === null ? '—' : `${Math.round(score * 100)}%`;
}
