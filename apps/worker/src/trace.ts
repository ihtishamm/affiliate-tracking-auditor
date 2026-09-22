import type { BrowserContext, Page, Request } from 'playwright';
import { snapshotInPage } from './in-page.ts';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_STORAGE_KEY,
  redactBody,
  redactQuery,
  redactUrl,
  scrubText,
  RUN_LIMITS,
  UTM_PARAMS,
  type FunnelStep,
  type KnownIdentity,
  type Logger,
  type PageSnapshot,
  type RunTrace,
  type SsrfOptions,
  type TraceRequest,
} from '@auditor/shared';
import { checkTargetUrl } from '@auditor/shared/ssrf';

// The trace collector: everything the browser does during a run, written down as it happens,
// redacted as it happens (§8). It attaches to the BrowserContext, not the Page, so requests
// from iframes, popups and service workers are seen too. Raw bodies live only inside the
// `request` handler below: `redactBody()` turns them into a param map and the string is
// dropped on the same tick. Nothing here retains a value it did not classify first.
//
// §9's "re-check after every redirect hop" is enforced in two places. The route handler
// below vets each navigation Chromium asks to make (first load, clicks) before it is sent,
// which gives a precise reason cheaply. But Chromium follows redirects internally, and no
// route handler sees the redirected request — so the enforcement that actually holds is the
// egress proxy every connection passes through (egress-proxy.ts). When the proxy refuses a
// hop, the browser reports a tunnel failure or a 403 carrying `x-auditor-blocked`; both are
// turned into a `blocked` hop here and end the run.

// Consent tools, most common first. The advertorial's own banner is last; the point of the
// list is to recognise a stranger's.
const CONSENT_SELECTORS = [
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '#usercentrics-root',
  '.cc-window',
  '#cookie-banner',
  '#cookieConsent',
  '[id*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[class*="cookie-banner" i]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
  '#shopify-pc__banner',
];

export interface CollectorOptions {
  runId: string;
  startedAt: number;
  expectedClickId: string;
  clickIdParam: string;
  ssrf: SsrfOptions;
  /** The egress proxy's reason for refusing `host`, if it did (see egress-proxy.ts). */
  refusedReason: (host: string) => string | undefined;
  log: Logger;
}

export class TraceCollector {
  readonly requests: TraceRequest[] = [];
  readonly hops: RunTrace['hops'] = [];
  readonly steps: PageSnapshot[] = [];
  truncated = false;
  /** Set when a hop was refused; the runner turns it into the run's stop reason. */
  blocked: string | null = null;

  private step: FunnelStep = 'landing';
  private known: KnownIdentity | undefined;
  private lastMainUrl = '';
  /** Raw (unredacted, in-memory only) URL of the request a server redirected away from, for the password gate. */
  redirectedFromRaw: string | null = null;
  private readonly byRequest = new WeakMap<
    Request,
    { entry: TraceRequest; startedAt: number; hop: RunTrace['hops'][number] | null }
  >();
  private readonly opts: CollectorOptions;

  constructor(opts: CollectorOptions) {
    this.opts = opts;
  }

  setStep(step: FunnelStep): void {
    this.step = step;
  }

  /** Called when the runner types an identity at checkout, so hashed twins can be judged. */
  setKnownIdentity(identity: KnownIdentity): void {
    this.known = identity;
  }

  /**
   * Every URL that ends up in the stored trace goes through here. It redacts knowing what the
   * runner typed — a checkout URL can carry the typed city or street under a parameter name no
   * rule anticipates — and it never throws: a URL we cannot parse is a field value, not a
   * failed run.
   */
  private safeUrl(url: string | URL): string {
    try {
      return redactUrl(url, this.known);
    } catch {
      return '[unparseable]';
    }
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route, request) => {
      if (isMainFrameNavigation(request)) {
        const verdict = await checkTargetUrl(request.url(), this.opts.ssrf);
        if (!verdict.allowed) {
          this.blocked = verdict.reason;
          this.hops.push({
            t: this.now(),
            from: this.lastMainUrl,
            to: this.safeUrl(request.url()),
            status: null,
            kind: 'blocked',
          });
          this.opts.log.warn('hop blocked', {
            to: safeHost(request.url()),
            reason: verdict.reason,
          });
          await route.abort('blockedbyclient');
          return;
        }
        if (this.hops.filter((h) => h.kind === 'redirect').length >= RUN_LIMITS.maxRedirectHops) {
          this.blocked = `more than ${RUN_LIMITS.maxRedirectHops} redirect hops`;
          await route.abort('blockedbyclient');
          return;
        }
      }
      await route.continue();
    });

    context.on('request', (request) => this.onRequest(request));
    context.on('response', (response) => {
      const rec = this.byRequest.get(response.request());
      if (!rec) return;
      rec.entry.status = response.status();
      rec.entry.contentType = response.headers()['content-type'] ?? null;
      const refused = response.headers()['x-auditor-blocked'];
      if (refused && rec.hop) this.markBlocked(rec.hop, refused);
      const location = response.headers()['location'];
      if (location && response.status() >= 300 && response.status() < 400) {
        try {
          rec.entry.redirectTo = this.safeUrl(new URL(location, response.url()));
        } catch {
          rec.entry.redirectTo = '[unparseable]';
        }
      }
      if (rec.hop) rec.hop.status = response.status();
    });
    const finish = (request: Request): void => {
      const rec = this.byRequest.get(request);
      if (!rec) return;
      rec.entry.durationMs = Date.now() - rec.startedAt;
      rec.entry.failure = request.failure()?.errorText ?? null;
      if (rec.hop && /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(rec.entry.failure ?? '')) {
        this.markBlocked(
          rec.hop,
          this.opts.refusedReason(rec.entry.host) ?? 'refused by the egress proxy',
        );
      }
    };
    context.on('requestfinished', finish);
    context.on('requestfailed', finish);
  }

  private onRequest(request: Request): void {
    if (this.requests.length >= RUN_LIMITS.maxTraceRequests) {
      this.truncated = true;
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    const navigation = isMainFrameNavigation(request);
    const body = redactBody(request.postData(), request.headers()['content-type'], this.known);
    const entry: TraceRequest = {
      seq: this.requests.length,
      t: this.now(),
      method: request.method(),
      url: url.origin + url.pathname,
      host: url.hostname,
      resourceType: request.resourceType(),
      navigation,
      step: this.step,
      status: null,
      contentType: null,
      durationMs: null,
      params: { ...redactQuery(url.searchParams, this.known), ...body.params },
      bodyKind: body.kind,
      bodyBytes: body.bytes,
      redirectTo: null,
      failure: null,
    };
    this.requests.push(entry);

    let hop: RunTrace['hops'][number] | null = null;
    if (navigation) {
      const from = request.redirectedFrom();
      this.redirectedFromRaw = from ? from.url() : null;
      hop = {
        t: entry.t,
        from: from ? this.safeUrl(from.url()) : this.lastMainUrl,
        to: this.safeUrl(url),
        status: null,
        kind: from ? 'redirect' : 'navigate',
      };
      this.hops.push(hop);
      this.lastMainUrl = hop.to;
    }
    this.byRequest.set(request, { entry, startedAt: Date.now(), hop });
  }

  private markBlocked(hop: RunTrace['hops'][number], reason: string): void {
    hop.kind = 'blocked';
    this.blocked ??= reason;
    this.opts.log.warn('hop blocked', { to: hop.to.slice(0, 120), reason });
  }

  /** What the page holds at this step. Never throws: a page mid-navigation yields a partial snapshot. */
  async snapshot(page: Page, step: FunnelStep): Promise<PageSnapshot> {
    this.setStep(step);
    const url = page.url();
    const expected = this.opts.expectedClickId;

    const cookies = await page
      .context()
      .cookies(url)
      .catch(() => []);
    const evaluated = await page
      .evaluate(snapshotInPage, {
        storageKey: ATTRIBUTION_STORAGE_KEY,
        selectors: CONSENT_SELECTORS,
        expected,
      })
      .catch(() => ({
        keys: [],
        containing: [],
        aff: null,
        scripts: [],
        matched: null,
        title: '',
      }));

    const affCookie = cookies.find((c) => c.name === ATTRIBUTION_COOKIE);
    const record = parseAttribution(affCookie?.value ?? null) ?? parseAttribution(evaluated.aff);
    const query = safeSearchParams(url);
    const foundIn = {
      cookies: cookies.filter((c) => c.value.includes(expected)).map((c) => c.name),
      localStorage: evaluated.containing,
      url: query?.get(this.opts.clickIdParam) === expected,
    };
    const source: PageSnapshot['attribution']['source'] =
      foundIn.cookies.length > 0
        ? 'cookie'
        : foundIn.localStorage.length > 0
          ? 'localStorage'
          : foundIn.url
            ? 'url'
            : 'none';
    const utm: Record<string, string> = {};
    for (const key of UTM_PARAMS) {
      const v = record?.[key] ?? query?.get(key);
      if (v) utm[key] = v;
    }

    const snap: PageSnapshot = {
      step,
      t: this.now(),
      url: this.safeUrl(url),
      // A page we do not control, greeting a shopper by the name it was given.
      title: scrubText(evaluated.title, this.known, 200),
      // Values are ours to keep only for the record we defined; everything else is a name.
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.name === ATTRIBUTION_COOKIE ? c.value.slice(0, 1000) : null,
      })),
      localStorageKeys: evaluated.keys.slice(0, 100),
      attribution: {
        clickId: source === 'none' ? null : (record?.['click_id'] ?? expected),
        utm,
        foundIn,
        source,
      },
      scripts: evaluated.scripts.slice(0, 200).map((s) => this.safeUrl(s)),
      consent: { bannerVisible: evaluated.matched !== null, matched: evaluated.matched },
    };
    this.steps.push(snap);
    return snap;
  }

  /**
   * The order, learned from the Purchase pixel hit the way Meta learns it: `eid=purchase-<id>`
   * first, else the `order_id` custom parameter. A pixel that sends neither (a stranger's
   * funnel, or one with event ids stripped and no order id) leaves the order unknown, and the
   * server-side checks say so rather than guess.
   */
  orderFromTrace(): RunTrace['order'] {
    for (const r of this.requests) {
      if (!/(^|\.)facebook\.com$/.test(r.host) || !r.url.includes('/tr')) continue;
      const ev = r.params['ev'];
      if (ev?.kind !== 'value' || ev.value !== 'Purchase') continue;
      const eid = r.params['eid'];
      const eidDigits = eid?.kind === 'value' ? /^purchase-(\d+)$/.exec(eid.value)?.[1] : undefined;
      if (eidDigits && eid?.kind === 'value') return { id: eidDigits, purchaseEventId: eid.value };
      const orderParam = r.params['cd[order_id]'];
      const digits =
        orderParam?.kind === 'value' ? /(\d+)$/.exec(orderParam.value)?.[1] : undefined;
      if (digits) return { id: digits, purchaseEventId: eid?.kind === 'value' ? eid.value : null };
    }
    return null;
  }

  private now(): number {
    return Date.now() - this.opts.startedAt;
  }
}

function isMainFrameNavigation(request: Request): boolean {
  try {
    if (!request.isNavigationRequest()) return false;
    const frame = request.frame();
    return frame === frame.page().mainFrame();
  } catch {
    return false; // service-worker requests have no frame
  }
}

function parseAttribution(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v.slice(0, 200);
      }
      return out;
    }
  } catch {
    /* not our record */
  }
  return null;
}

function safeSearchParams(url: string): URLSearchParams | null {
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '?';
  }
}
