import {
  FUNNEL_STEPS,
  type FunnelStep,
  type PageSnapshot,
  type RunTrace,
  type TraceRequest,
} from '@auditor/shared';
import type { CheckInput, ServerEvents } from './types.ts';

// Everything the checks read from a trace, derived once. Definitions that more than one check
// depends on live here, so "what is a pixel hit" or "which hop crosses a domain" cannot drift
// between checks.

/** Meta standard events the checks reason about, in the order a purchase funnel fires them. */
export const FUNNEL_EVENTS = [
  'PageView',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'Purchase',
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

/** One Meta pixel request (`facebook.com/tr`) with the parameters the checks use, already redacted. */
export interface PixelHit {
  seq: number;
  t: number;
  step: string;
  /** `ev`: the event name. */
  event: string;
  /** `eid`: the event_id, or null when the pixel sent none. */
  eventId: string | null;
  /** `id`: the pixel / dataset id. */
  pixelId: string | null;
  /** `dl`: the page URL the event was fired from (redacted), when the pixel sent one. */
  pageUrl: string | null;
  /**
   * Index into `trace.hops` of the document that was current when the hit fired — the unit
   * for "same page". Derived from time, so an image-GET pixel with no `dl` is attributed too.
   */
  document: number;
  params: TraceRequest['params'];
}

export interface Boundary {
  index: number;
  fromHost: string;
  toHost: string;
  hop: RunTrace['hops'][number];
}

export class CheckContext {
  readonly trace: RunTrace;
  readonly server: ServerEvents | null;
  readonly hits: PixelHit[];
  readonly boundaries: Boundary[];

  constructor(input: CheckInput) {
    this.trace = input.trace;
    this.server = input.server;
    this.hits = collectPixelHits(input.trace.requests, (t) => this.documentAt(t));
    this.boundaries = findBoundaries(input.trace.hops);
  }

  /** The hop (document) current at trace time `t`: the last navigation or redirect that started at or before it. */
  documentAt(t: number): number {
    let index = -1;
    this.trace.hops.forEach((hop, i) => {
      if (hop.kind !== 'blocked' && hop.t <= t) index = i;
    });
    return index;
  }

  /** A short label for a document, for verdict text. */
  documentLabel(index: number): string {
    const hop = this.trace.hops[index];
    if (!hop) return 'unknown page';
    try {
      const u = new URL(hop.to);
      return u.host + u.pathname;
    } catch {
      return hop.to.slice(0, 60);
    }
  }

  /** Did the funnel driver get at least to `step`? */
  reached(step: FunnelStep): boolean {
    return FUNNEL_STEPS.indexOf(this.trace.outcome.reachedStep) >= FUNNEL_STEPS.indexOf(step);
  }

  /** The last snapshot taken at `step` (a step may be snapshotted twice, e.g. store before and after the password gate). */
  snapshot(step: FunnelStep): PageSnapshot | undefined {
    return this.trace.steps.filter((s) => s.step === step).at(-1);
  }

  /** The last snapshot at or after `step` — "the furthest point where this can be observed". */
  snapshotAtOrAfter(step: FunnelStep): PageSnapshot | undefined {
    const from = FUNNEL_STEPS.indexOf(step);
    return this.trace.steps.filter((s) => FUNNEL_STEPS.indexOf(s.step) >= from).at(-1);
  }

  hitsFor(event: string): PixelHit[] {
    return this.hits.filter((h) => h.event === event);
  }

  /**
   * Loads of Meta's pixel script (`connect.facebook.net/…/fbevents.js`): proof the base code is
   * installed even when no event followed, and — via `failure` — whether the CDN served it.
   */
  pixelScriptLoads(): Array<{ step: string; status: number | null; failure: string | null }> {
    return this.trace.requests
      .filter((r) => /(^|\.)facebook\.net$/.test(r.host) && /fbevents\.js$/.test(r.url))
      .map((r) => ({ step: r.step, status: r.status, failure: r.failure }));
  }

  /** Requests to a host matching `pattern`. */
  requestsTo(pattern: RegExp): TraceRequest[] {
    return this.trace.requests.filter((r) => pattern.test(r.host));
  }

  /** Where the funnel stopped, for `inconclusive` reasons. */
  stoppedAt(): string {
    return `the run reached "${this.trace.outcome.reachedStep}" (${this.trace.outcome.stopReason})`;
  }
}

const META_HOST = /(^|\.)facebook\.com$/;

function collectPixelHits(requests: TraceRequest[], documentAt: (t: number) => number): PixelHit[] {
  const hits: PixelHit[] = [];
  for (const r of requests) {
    if (!META_HOST.test(r.host) || !/\/tr\/?$/.test(r.url)) continue;
    const value = (key: string): string | null => {
      const p = r.params[key];
      return p?.kind === 'value' ? p.value : null;
    };
    const event = value('ev');
    if (!event) continue;
    hits.push({
      seq: r.seq,
      t: r.t,
      step: r.step,
      event,
      eventId: value('eid'),
      pixelId: value('id'),
      pageUrl: value('dl'),
      document: documentAt(r.t),
      params: r.params,
    });
  }
  return hits;
}

/** Hops whose destination host differs from the previous hop's: the domain boundaries. */
function findBoundaries(hops: RunTrace['hops']): Boundary[] {
  const out: Boundary[] = [];
  let prevHost: string | null = null;
  hops.forEach((hop, index) => {
    const toHost = safeHost(hop.to);
    if (prevHost && toHost && toHost !== prevHost) {
      out.push({ index, fromHost: prevHost, toHost, hop });
    }
    if (toHost) prevHost = toHost;
  });
  return out;
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Container ids in a script URL: GTM (`gtm.js?id=GTM-…`), gtag/GA4 (`gtag/js?id=G-…`, `AW-…`), UA. */
export function containerIdsIn(scriptUrl: string): string[] {
  const host = safeHost(scriptUrl);
  if (!host || !/googletagmanager\.com$|google-analytics\.com$/.test(host)) return [];
  const id = queryOf(scriptUrl).get('id');
  return id ? [id] : [];
}
