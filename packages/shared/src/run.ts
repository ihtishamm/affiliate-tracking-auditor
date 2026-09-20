import { z } from 'zod';
import { CLICK_ID_PARAM } from './tracking.ts';

// The run is the unit of work: one submitted URL, one browser session, one trace. Three
// boundaries carry it and each is validated (§11): the submission form → API, the API → queue
// (job data), and the worker → database (trace). The types below are that contract; M5's
// check engine reads `RunTrace` and nothing else.

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'timed_out'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
]);

/** Steps the funnel driver moves through, in order. The trace records how far it got. */
export const FUNNEL_STEPS = [
  'landing',
  'cta',
  'store',
  'product',
  'cart',
  'checkout',
  'payment',
  'thank_you',
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const QUEUE_NAME = 'runs';
export const DLQ_NAME = 'runs-dlq';

/** Limits agreed for M4. One place, so the README and the code cannot disagree. */
export const RUN_LIMITS = {
  hardTimeoutMs: 90_000,
  attempts: 3,
  backoffMs: 5_000,
  concurrency: 2,
  maxRedirectHops: 10,
  maxTraceRequests: 4_000, // a Shopify checkout alone is ~1 000 requests of telemetry
  traceTtlDays: 7,
  rateLimitPerHour: 5,
  maxQueueDepth: 20,
} as const;

// ---- submission ------------------------------------------------------------------------------

export const runSubmissionSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  /** Generated when the form renders; a double-click submits it twice and gets one run. */
  idempotency_key: z.string().min(8).max(128),
  /** The name of the click-ID parameter in this funnel's landing URL. */
  click_id_param: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_\-[\]]{1,64}$/)
    .default(CLICK_ID_PARAM),
});
export type RunSubmission = z.infer<typeof runSubmissionSchema>;

// ---- queue -----------------------------------------------------------------------------------

export const runJobSchema = z.object({
  runId: z.uuid(),
  /** Already SSRF-checked and PII-redacted at submission; the worker re-checks every hop. */
  url: z.url(),
  clickIdParam: z.string(),
  /** The one host where the runner may complete a purchase (our dev store). Anywhere else, it stops at checkout. */
  purchaseHost: z.string().nullable(),
});
export type RunJob = z.infer<typeof runJobSchema>;

// ---- trace -----------------------------------------------------------------------------------

const paramValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.string(), truncated: z.literal(true).optional() }),
  z.object({
    kind: z.literal('pii'),
    present: z.literal(true),
    looksHashed: z.boolean(),
    hashAlgoGuess: z.enum(['sha256', 'sha1', 'md5']).nullable(),
    normalised: z.boolean().nullable(),
  }),
  z.object({ kind: z.literal('secret'), present: z.literal(true) }),
]);
const paramMapSchema = z.record(z.string(), paramValueSchema);

export const traceRequestSchema = z.object({
  seq: z.number().int(),
  /** Milliseconds since the run started. */
  t: z.number(),
  method: z.string(),
  /** Origin + path only; the query lives in `params`, redacted. */
  url: z.string(),
  host: z.string(),
  resourceType: z.string(),
  /** Main-frame document request (a navigation or a redirect hop) vs everything else. */
  navigation: z.boolean(),
  /** Which funnel step the page was on when this request started. */
  step: z.string(),
  status: z.number().int().nullable(),
  contentType: z.string().nullable(),
  durationMs: z.number().nullable(),
  /** Query and body parameters merged; body wins on a name clash. */
  params: paramMapSchema,
  bodyKind: z.enum(['none', 'form', 'json', 'multipart', 'opaque']),
  bodyBytes: z.number().int(),
  /** Location target when the response was a redirect (redacted URL). */
  redirectTo: z.string().nullable(),
  failure: z.string().nullable(),
});
export type TraceRequest = z.infer<typeof traceRequestSchema>;

export const pageSnapshotSchema = z.object({
  step: z.enum(FUNNEL_STEPS),
  t: z.number(),
  url: z.string(),
  title: z.string(),
  /** Every cookie name; values only for the attribution cookie, which we defined and own. */
  cookies: z.array(z.object({ name: z.string(), value: z.string().nullable() })),
  localStorageKeys: z.array(z.string()),
  /**
   * Where the expected click ID was seen on this page. `foundIn` lists cookie names and
   * localStorage keys whose value CONTAINS the expected value — evidence of survival on any
   * funnel, without storing a stranger's cookie values. `clickId`/`utm` are read from our own
   * `_aff` record when present, else from the URL.
   */
  attribution: z.object({
    clickId: z.string().nullable(),
    utm: z.record(z.string(), z.string()),
    foundIn: z.object({
      cookies: z.array(z.string()),
      localStorage: z.array(z.string()),
      url: z.boolean(),
    }),
    source: z.enum(['cookie', 'localStorage', 'url', 'none']),
  }),
  /** External script URLs on the page, redacted. Check 7 counts container IDs in these. */
  scripts: z.array(z.string()),
  consent: z.object({ bannerVisible: z.boolean(), matched: z.string().nullable() }),
});
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;

export const runTraceSchema = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  /** The URL actually opened (redacted): the submission plus any injected attribution. */
  entryUrl: z.string(),
  injected: z.object({ clickId: z.string().nullable(), utm: z.record(z.string(), z.string()) }),
  clickIdParam: z.string(),
  /** Which value the checks should look for across the funnel. */
  expectedClickId: z.string(),
  mode: z.enum(['observe', 'purchase']),
  userAgent: z.string(),
  robots: z.object({
    fetched: z.boolean(),
    status: z.number().int().nullable(),
    allowed: z.boolean().nullable(),
    matchedRule: z.string().nullable(),
  }),
  cta: z.object({ rule: z.string(), href: z.string(), text: z.string() }).nullable(),
  /** Main-frame hops: navigations and redirects, in order. Check 2/3 walk these. */
  hops: z.array(
    z.object({
      t: z.number(),
      from: z.string(),
      to: z.string(),
      status: z.number().int().nullable(),
      kind: z.enum(['navigate', 'redirect', 'blocked']),
    }),
  ),
  steps: z.array(pageSnapshotSchema),
  requests: z.array(traceRequestSchema),
  requestsTruncated: z.boolean(),
  /** Learned from the Purchase pixel request (`eid=purchase-<id>`, else `cd[order_id]`), the same way Meta learns it. `purchaseEventId` is null when the pixel sent no event id. */
  order: z.object({ id: z.string(), purchaseEventId: z.string().nullable() }).nullable(),
  outcome: z.object({
    reachedStep: z.enum(FUNNEL_STEPS),
    stopReason: z.string(),
  }),
});
export type RunTrace = z.infer<typeof runTraceSchema>;
