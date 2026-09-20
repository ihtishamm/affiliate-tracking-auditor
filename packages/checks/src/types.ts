import type { RunTrace } from '@auditor/shared';

// The check engine's contract (PROJECT_CONTEXT §6 M5). Inputs are the run's trace and the
// server-side rows the M3 receivers wrote for the same order; outputs are ten verdicts. The
// engine is pure: no I/O, no clock, no randomness, so a fixture trace always yields the same
// report and a verdict can be reproduced from the stored artifact alone.

export type CheckStatus = 'pass' | 'fail' | 'inconclusive';

export const CHECK_IDS = [
  'click_id_persistence',
  'utm_survival',
  'cross_domain_handoff',
  'pixel_fire_order',
  'event_id_present',
  'capi_dedup_match',
  'duplicate_containers',
  'postback_fired',
  'pii_hashing',
  'consent_blocking',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface CheckResult {
  id: CheckId;
  /** 1–10, the numbering PROJECT_CONTEXT and the break-it panel use. */
  number: number;
  title: string;
  status: CheckStatus;
  /** What the trace actually showed, in one or two sentences. Names, counts, hops — never PII. */
  observed: string;
  /** What a healthy funnel would have shown. */
  expected: string;
  /** Why the status is what it is; for `inconclusive`, what was missing. */
  reason: string;
  /** What to change in the funnel. Empty for a pass. */
  fixHint: string;
}

/**
 * Server-side evidence for the order the run produced (§6 M3 tables), keyed by order id.
 * Absent on a stranger's funnel (observe mode) and until the webhook has arrived.
 */
export interface ServerEvents {
  order: {
    id: string;
    name: string;
    /** click_id, utm_*, __break as found on the order. */
    attribution: Record<string, string>;
  } | null;
  conversionAttempts: Array<{
    kind: 'capi' | 'postback';
    attempt: number;
    eventId: string;
    statusCode: number | null;
    ok: boolean;
    error: string | null;
    piiHashed: boolean | null;
  }>;
  postbackEvents: Array<{
    postbackId: string;
    clickId: string;
    orderId: string;
    status: string;
  }>;
}

export interface CheckInput {
  trace: RunTrace;
  server: ServerEvents | null;
}

export interface CheckReport {
  results: CheckResult[];
  counts: { pass: number; fail: number; inconclusive: number };
  /**
   * passes / (passes + fails), inconclusive excluded; null when nothing was decidable. An
   * inconclusive check is a gap in evidence, not a defect, so it neither helps nor hurts.
   */
  score: number | null;
}

export const EMPTY_SERVER_EVENTS: ServerEvents = {
  order: null,
  conversionAttempts: [],
  postbackEvents: [],
};
