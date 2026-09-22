export { logLevelSchema, parseEnv, webEnv, workerEnv } from './env.ts';
export type { WebEnv, WorkerEnv } from './env.ts';
export { createLogger } from './log.ts';
export type { LogFields, Logger, LoggerOptions, LogLevel } from './log.ts';
export {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_PARAMS,
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_TTL_DAYS,
  CLICK_ID_PARAM,
  META_CLICK_PARAM,
  UTM_PARAMS,
  purchaseEventId,
} from './tracking.ts';
export type { AttributionParam } from './tracking.ts';
export {
  BREAK_PARAM,
  BREAK_TOGGLES,
  BREAK_TOGGLE_INFO,
  parseBreakToggles,
  serializeBreakToggles,
} from './break-it.ts';
export type { BreakToggle, BreakToggleInfo } from './break-it.ts';
export { hmacSha256, signBase64, signHex, verifyBase64, verifyHex } from './hmac.ts';
export {
  hashEmail,
  hashPhone,
  looksLikeSha256,
  normaliseEmail,
  normalisePhone,
  sha256Hex,
} from './pii.ts';
export {
  POSTBACK_SIGNATURE_HEADER,
  postbackIdForOrder,
  postbackPayloadSchema,
} from './postback.ts';
export type { PostbackPayload } from './postback.ts';
// ssrf.ts is NOT re-exported here: it imports node:net and node:dns, and this entry point is
// also bundled into the browser by the advertorial's client components. Server code imports
// it from '@auditor/shared/ssrf'.
export type { SsrfOptions, SsrfVerdict } from './ssrf.ts';
export {
  classifyParam,
  redactBody,
  redactParams,
  redactQuery,
  redactUrl,
  scrubText,
} from './redact.ts';
export type { BodyKind, KnownIdentity, ParamMap, ParamValue, RedactedBody } from './redact.ts';
export {
  DAILY_CRON,
  DLQ_NAME,
  FUNNEL_STEPS,
  RUN_JOB_OPTIONS,
  SCHEDULE_QUEUE_NAME,
  SCORING_QUEUE_NAME,
  dailyRunKey,
  QUEUE_NAME,
  RUN_LIMITS,
  RUN_STATUSES,
  TERMINAL_STATUSES,
  pageSnapshotSchema,
  runJobSchema,
  runSubmissionSchema,
  runTraceSchema,
  traceRequestSchema,
} from './run.ts';
export type {
  FunnelStep,
  PageSnapshot,
  RunJob,
  RunStatus,
  RunSubmission,
  RunTrace,
  TraceRequest,
} from './run.ts';
