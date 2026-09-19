import { z } from 'zod';

// The S2S postback contract (PROJECT_CONTEXT §6 M3): what the conversion sender emits on
// orders/create and what POST /api/postback accepts.

/** Header carrying the hex HMAC-SHA256 of the raw request body. */
export const POSTBACK_SIGNATURE_HEADER = 'x-postback-signature';

export const postbackPayloadSchema = z.object({
  /** The sender's idempotency token. The receiver deduplicates on it; see postbackIdForOrder. */
  postback_id: z.string().min(1).max(128),
  click_id: z.string().min(1).max(200),
  order_id: z.string().min(1).max(64),
  status: z.enum(['approved', 'pending', 'rejected']),
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurred_at: z.iso.datetime(),
  /**
   * Demo only: the break-it toggles that were on the order, forwarded so the `postback_500`
   * sabotage can be exercised end to end. A real network's receiver has no such field.
   */
  __break: z.string().max(200).optional(),
});
export type PostbackPayload = z.infer<typeof postbackPayloadSchema>;

/**
 * The postback ID for an order is derived from the order, not generated. A retry of the
 * webhook that somehow slips past the webhook's own dedup then produces a postback the receiver
 * recognises as a DUPLICATE (200, no reprocessing) rather than a second conversion. Sender-side
 * idempotency key and receiver-side dedup key agree by construction, with no shared state.
 */
export function postbackIdForOrder(orderId: string | number): string {
  const digits = /\d+$/.exec(String(orderId))?.[0];
  if (!digits) throw new Error(`postbackIdForOrder: no numeric order ID in "${String(orderId)}"`);
  return `pb-${digits}`;
}
