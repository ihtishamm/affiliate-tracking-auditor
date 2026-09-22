import { randomUUID } from 'node:crypto';
import {
  BREAK_PARAM,
  CLICK_ID_PARAM,
  POSTBACK_SIGNATURE_HEADER,
  hashEmail,
  hashPhone,
  normaliseEmail,
  normalisePhone,
  postbackIdForOrder,
  purchaseEventId,
  scrubText,
  signHex,
  type Logger,
  type PostbackPayload,
} from '@auditor/shared';
import type { ParsedOrder } from './shopify-webhook.ts';

// The conversion sender (PROJECT_CONTEXT §6 M3, pushback D): the merchant-side server that turns
// an accepted orders/create webhook into (a) a Conversions API Purchase to Meta and (b) an S2S
// postback to the affiliate network — here, our own receiver.
//
// Two identifiers do the work, and both are DERIVED FROM THE ORDER rather than generated:
//   event_id    = purchaseEventId(order.id)   — identical to what the checkout pixel sent, so
//                 Meta collapses the browser Purchase and this server Purchase into one.
//   postback_id = postbackIdForOrder(order.id) — so a resend is a duplicate at the receiver,
//                 never a second conversion.
// Nothing here talks to the browser pixel; they agree because they compute the same function of
// the same order ID.
//
// Every attempt is written down (conversion_attempts). The browser cannot see S2S traffic, so
// this log is the only evidence the auditor has for checks 6 and 8.

/** Pinned; Meta retires versions roughly two years after release. Bump deliberately. */
const GRAPH_VERSION = 'v22.0';
const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. Short: a webhook handler is not the place for minutes. */
const BACKOFF_MS = [500, 1500] as const;

export interface ConversionAttempt {
  orderId: string;
  kind: 'capi' | 'postback';
  attempt: number;
  eventId: string;
  targetHost: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  piiHashed: boolean | null;
}

export interface SenderDeps {
  fetch: typeof fetch;
  record: (attempt: ConversionAttempt) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  meta: { pixelId: string; capiToken: string; testEventCode?: string | undefined };
  postback: { url: string; secret: string };
  storeDomain: string;
}

export async function sendConversions(order: ParsedOrder, deps: SenderDeps): Promise<void> {
  const log = deps.log.child({ order_id: order.id, order_name: order.name });
  await Promise.all([
    sendCapiPurchase(order, { ...deps, log }),
    sendPostback(order, { ...deps, log }),
  ]);
}

// ---- Meta Conversions API ------------------------------------------------------------------

async function sendCapiPurchase(order: ParsedOrder, deps: SenderDeps): Promise<void> {
  const hashed = !order.breakToggles.includes('unhashed_email');
  const mismatch = order.breakToggles.includes('capi_mismatch');

  // user_data is hashed here, in memory, and the plaintext goes no further. Under the
  // `unhashed_email` sabotage the normalised plaintext is sent instead: Meta rejects it, which
  // is the best case; a less careful endpoint would accept and store it.
  const userData: Record<string, string[]> = {};
  const em = hashed ? hashEmail(order.email) : order.email && normaliseEmail(order.email);
  const ph = hashed ? hashPhone(order.phone) : order.phone && normalisePhone(order.phone);
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];

  // `capi_mismatch` sabotage: a fresh ID that can never match the browser's purchase-<id>.
  const eventId = mismatch ? randomUUID() : purchaseEventId(order.id);

  const body = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(order.createdAt.getTime() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: `https://${deps.storeDomain}/`,
        user_data: userData,
        custom_data: {
          currency: order.currency,
          value: Number(order.totalPrice),
          order_id: order.id,
          ...(order.attribution[CLICK_ID_PARAM]
            ? { click_id: order.attribution[CLICK_ID_PARAM] }
            : {}),
        },
      },
    ],
    // In the body, not the query string: URLs end up in logs; bodies do not.
    access_token: deps.meta.capiToken,
    ...(deps.meta.testEventCode ? { test_event_code: deps.meta.testEventCode } : {}),
  };
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${deps.meta.pixelId}/events`;

  await withRetries(
    {
      kind: 'capi',
      orderId: order.id,
      eventId,
      targetHost: 'graph.facebook.com',
      piiHashed: hashed,
    },
    () =>
      deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    deps,
  );
}

// ---- S2S postback ----------------------------------------------------------------------------

async function sendPostback(order: ParsedOrder, deps: SenderDeps): Promise<void> {
  const postbackId = postbackIdForOrder(order.id);
  const targetHost = new URL(deps.postback.url).host;
  const clickId = order.attribution[CLICK_ID_PARAM];

  if (!clickId) {
    // Nothing to attribute: no click ID reached the order, so there is no postback to send. This
    // is recorded rather than silently skipped; it is precisely the failure check 8 reports.
    deps.log.warn('postback not sent: order carries no click_id');
    await deps.record({
      orderId: order.id,
      kind: 'postback',
      attempt: 1,
      eventId: postbackId,
      targetHost,
      statusCode: null,
      ok: false,
      error: 'no click_id on order',
      piiHashed: null,
    });
    return;
  }

  const payload: PostbackPayload = {
    postback_id: postbackId,
    click_id: clickId,
    order_id: order.id,
    status: 'approved',
    amount: Number(order.totalPrice),
    currency: order.currency,
    occurred_at: order.createdAt.toISOString(),
    ...(order.attribution[BREAK_PARAM] ? { __break: order.attribution[BREAK_PARAM] } : {}),
  };
  // Sign the exact string that is sent. The receiver verifies these bytes, not a re-parse.
  const rawBody = JSON.stringify(payload);
  const signature = signHex(deps.postback.secret, rawBody);

  await withRetries(
    {
      kind: 'postback',
      orderId: order.id,
      eventId: postbackId,
      targetHost,
      piiHashed: null,
    },
    () =>
      deps.fetch(deps.postback.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [POSTBACK_SIGNATURE_HEADER]: signature },
        body: rawBody,
      }),
    deps,
  );
}

// ---- retry loop -----------------------------------------------------------------------------

type AttemptContext = Omit<ConversionAttempt, 'attempt' | 'statusCode' | 'ok' | 'error'>;

/**
 * Up to MAX_ATTEMPTS tries, each recorded whether it succeeded or not. Retrying on any
 * non-2xx (not just 5xx) is deliberate: a receiver that answers 4xx to a valid postback is
 * broken in a way worth three data points in the attempt log.
 */
async function withRetries(
  ctx: AttemptContext,
  attemptFn: () => Promise<Response>,
  deps: SenderDeps,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let statusCode: number | null = null;
    let ok = false;
    let error: string | null = null;
    try {
      const res = await attemptFn();
      statusCode = res.status;
      ok = res.ok;
      // A rejection body is someone else's free text, and it is stored
      // (conversion_attempts.error): Meta's Graph API quotes the parameter it disliked, and a
      // postback receiver can quote the whole request. scrubText also does the truncating.
      if (!ok) error = scrubText(await res.text());
    } catch (err) {
      error = scrubText(err instanceof Error ? err.message : String(err));
    }
    await deps.record({ ...ctx, attempt, statusCode, ok, error });
    deps.log[ok ? 'info' : 'warn'](`${ctx.kind} attempt ${attempt}`, {
      event_id: ctx.eventId,
      status: statusCode,
      ok,
      ...(error ? { error } : {}),
    });
    if (ok) return;
    if (attempt < MAX_ATTEMPTS) await deps.sleep(BACKOFF_MS[attempt - 1] ?? 0);
  }
}
