import {
  parseBreakToggles,
  postbackPayloadSchema,
  verifyHex,
  type Logger,
  type PostbackPayload,
} from '@auditor/shared';

// The decision core of POST /api/postback, kept free of Next and of the database so the
// replay/tamper behaviour is testable with an in-memory `insert`.
//
// Order of operations is the point:
//   1. signature over the raw bytes  → 401 if wrong, and nothing else is looked at
//   2. schema over the parsed JSON   → 400 if wrong; a valid signature does not make a body sane
//   3. (demo) simulated failure      → 500 before anything is stored, so the sender's retries
//                                       hit the same wall each time
//   4. insert with ON CONFLICT       → the database decides new vs duplicate; both are 200
// A duplicate is a success: the sender wanted this postback recorded, and it is.

export type PostbackOutcome =
  | { status: 401; body: { error: 'invalid_signature' } }
  | { status: 400; body: { error: 'invalid_payload'; issues: string[] } }
  | { status: 500; body: { error: 'simulated_failure' } }
  | { status: 200; body: { status: 'accepted' | 'duplicate'; postback_id: string } };

export interface PostbackReceiverDeps {
  secret: string;
  /** Appends the event. Resolves false when `postback_id` already exists (unique index conflict). */
  insert: (payload: PostbackPayload) => Promise<boolean>;
  log: Logger;
}

export async function receivePostback(
  rawBody: string,
  signature: string | null,
  deps: PostbackReceiverDeps,
): Promise<PostbackOutcome> {
  if (!verifyHex(deps.secret, rawBody, signature)) {
    // Nothing about the body is logged: an unsigned body is untrusted input.
    deps.log.warn('postback rejected: invalid signature', { bytes: rawBody.length });
    return { status: 401, body: { error: 'invalid_signature' } };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    deps.log.warn('postback rejected: body is not JSON');
    return { status: 400, body: { error: 'invalid_payload', issues: ['body is not JSON'] } };
  }
  const parsed = postbackPayloadSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    deps.log.warn('postback rejected: schema', { issues });
    return { status: 400, body: { error: 'invalid_payload', issues } };
  }
  const payload = parsed.data;

  if (parseBreakToggles(payload.__break).includes('postback_500')) {
    deps.log.warn('postback: simulated 500 (break-it toggle)', {
      postback_id: payload.postback_id,
    });
    return { status: 500, body: { error: 'simulated_failure' } };
  }

  const inserted = await deps.insert(payload);
  deps.log.info(inserted ? 'postback accepted' : 'postback duplicate ignored', {
    postback_id: payload.postback_id,
    order_id: payload.order_id,
  });
  return {
    status: 200,
    body: { status: inserted ? 'accepted' : 'duplicate', postback_id: payload.postback_id },
  };
}
