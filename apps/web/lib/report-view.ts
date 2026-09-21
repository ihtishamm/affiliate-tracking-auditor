import type { CheckReport, CheckResult } from '@auditor/checks';
import {
  BREAK_PARAM,
  BREAK_TOGGLE_INFO,
  FUNNEL_STEPS,
  parseBreakToggles,
  type BreakToggle,
  type FunnelStep,
  type RunTrace,
} from '@auditor/shared';

// Everything the report page derives from a report and a trace, as pure functions: the order
// checks are shown in, the one fix to do first, which break-it toggles the run had on, and the
// rows of the network waterfall. Kept out of the components so the decisions are testable and
// the components only lay things out.

const STATUS_RANK: Record<CheckResult['status'], number> = { fail: 0, inconclusive: 1, pass: 2 };

/** Failures first, then inconclusive, then passes; stable by check number inside each group. */
export function orderForReport(results: CheckResult[]): CheckResult[] {
  return [...results].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.number - b.number,
  );
}

/**
 * Root-cause order: the failure whose fix removes the most downstream failures comes first.
 * The redirect that drops the click ID (3) explains a missing click ID at checkout (1) and an
 * unpaid postback (8); a consent wall (10) explains missing pixel events (4), ids (5) and
 * hashes (9); a missing event_id (5) explains a dedup mismatch (6). So: attribution handoff,
 * then what the pixel is allowed to do, then what it sends, then the server side.
 */
const FIX_ORDER: number[] = [3, 2, 1, 10, 4, 7, 5, 9, 6, 8];

export function fixFirst(results: CheckResult[]): CheckResult | null {
  const rank = (r: CheckResult): number => {
    const i = FIX_ORDER.indexOf(r.number);
    return i === -1 ? FIX_ORDER.length : i;
  };
  return [...results].sort((a, b) => rank(a) - rank(b)).find((r) => r.status === 'fail') ?? null;
}

/** The break-it toggles the run was submitted with, read from the entry URL. */
export function togglesOf(trace: RunTrace): BreakToggle[] {
  try {
    return parseBreakToggles(new URL(trace.entryUrl).searchParams.get(BREAK_PARAM));
  } catch {
    return [];
  }
}

/** Toggles whose documented `caughtBy` includes this check — the link from a failure back to the demo. */
export function togglesCaughtBy(check: CheckResult, active: BreakToggle[]): BreakToggle[] {
  return active.filter((t) => BREAK_TOGGLE_INFO[t].caughtBy.includes(check.number));
}

export function scoreLabel(report: CheckReport): string {
  return report.score === null ? '—' : `${Math.round(report.score * 100)}%`;
}

/** Plain-language verdict for the header. */
export function headline(report: CheckReport, trace: RunTrace): string {
  const { fail, inconclusive, pass } = report.counts;
  if (fail === 0 && inconclusive === 0) return 'Every check passed.';
  if (fail === 0) {
    return `${pass} checks passed; ${inconclusive} could not be decided${trace.mode === 'observe' ? ' because no purchase is completed on a funnel we do not own' : ''}.`;
  }
  return `${fail} check${fail === 1 ? '' : 's'} failed, ${pass} passed${inconclusive ? `, ${inconclusive} undecided` : ''}.`;
}

// ---- progress ---------------------------------------------------------------------------------

export interface StepProgress {
  step: FunnelStep;
  label: string;
  state: 'done' | 'current' | 'pending' | 'stopped';
}

const STEP_LABELS: Record<FunnelStep, string> = {
  landing: 'Landing page',
  cta: 'Call to action',
  store: 'Store',
  product: 'Product',
  cart: 'Cart',
  checkout: 'Checkout',
  payment: 'Payment',
  thank_you: 'Thank-you page',
};

/** Step list for the live view and the report header, from how far the trace says the run got. */
export function stepProgress(reached: FunnelStep | null, terminal: boolean): StepProgress[] {
  const reachedIndex = reached ? FUNNEL_STEPS.indexOf(reached) : -1;
  return FUNNEL_STEPS.map((step, i) => {
    let state: StepProgress['state'];
    if (i < reachedIndex) state = 'done';
    else if (i === reachedIndex)
      state = terminal ? (step === 'thank_you' ? 'done' : 'stopped') : 'current';
    else state = 'pending';
    return { step, label: STEP_LABELS[step], state };
  });
}

// ---- waterfall --------------------------------------------------------------------------------

export interface WaterfallRow {
  /** Trace-relative start, ms. */
  t: number;
  /** Row duration, ms, for hops: until the next hop; for marks: fixed. */
  end: number;
  kind: 'hop' | 'pixel' | 'container' | 'cart' | 'postback';
  label: string;
  detail: string;
  status: number | null;
  blocked: boolean;
}

const TRACKER_HOSTS = /(^|\.)(facebook\.com|googletagmanager\.com|google-analytics\.com)$/;

/**
 * The rows of the waterfall: every main-frame hop as a bar spanning to the next hop, and
 * every tracking or attribution request as a mark on the same time axis. The thousands of
 * other requests (chunks, telemetry, fonts) are what a real waterfall shows and what nobody
 * reads; they stay in the JSON.
 */
export function waterfallRows(trace: RunTrace): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  const finished = Date.parse(trace.finishedAt) - Date.parse(trace.startedAt);
  trace.hops.forEach((hop, i) => {
    const next = trace.hops[i + 1];
    rows.push({
      t: hop.t,
      end: next ? next.t : finished,
      kind: 'hop',
      label: shortUrl(hop.to),
      detail: `${hop.kind}${hop.status !== null ? ` · HTTP ${hop.status}` : ''}`,
      status: hop.status,
      blocked: hop.kind === 'blocked',
    });
  });
  for (const r of trace.requests) {
    let kind: WaterfallRow['kind'] | null = null;
    let label = '';
    if (TRACKER_HOSTS.test(r.host) && /\/tr\/?$/.test(r.url)) {
      kind = 'pixel';
      const ev = r.params['ev'];
      const eid = r.params['eid'];
      label = `Meta ${ev?.kind === 'value' ? ev.value : 'hit'}${eid?.kind === 'value' ? '' : ' (no event_id)'}`;
    } else if (
      /googletagmanager\.com$|google-analytics\.com$/.test(r.host) &&
      r.resourceType === 'script'
    ) {
      kind = 'container';
      const id = r.params['id'];
      label = `container ${id?.kind === 'value' ? id.value : ''}`.trim();
    } else if (/\/cart\/(update|add)(\.js)?$/.test(r.url)) {
      kind = 'cart';
      label = r.url.endsWith('add.js') || r.url.endsWith('/add') ? 'cart add' : 'cart attributes';
    } else if (/\/api\/postback$/.test(r.url)) {
      kind = 'postback';
      label = 'postback';
    }
    if (!kind) continue;
    rows.push({
      t: r.t,
      end: r.t + Math.max(r.durationMs ?? 0, 1),
      kind,
      label,
      detail: `${r.method} ${r.host}${r.status !== null ? ` · ${r.status}` : ''}${r.failure ? ` · ${r.failure}` : ''}`,
      status: r.status,
      blocked: Boolean(r.failure && /BLOCKED|TUNNEL|PROXY/.test(r.failure)),
    });
  }
  return rows.sort((a, b) => a.t - b.t);
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url.slice(0, 60);
  }
}
