import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC verification for inbound webhooks and postbacks (PROJECT_CONTEXT §6 M3).
//
// Three rules, each closing a real hole:
//
// 1. Verify the RAW BYTES the sender transmitted, never a parsed-and-re-serialised body. A
//    signature proves "this exact byte sequence was produced by someone holding the secret".
//    Re-serialising changes bytes (key order, whitespace, number formatting), and a verifier
//    that normalises can be made to accept a forged body that normalises the same way.
//    Callers therefore pass `await request.text()` and parse JSON only after this returns true.
//
// 2. Compare in constant time. A byte-by-byte `===` returns at the first mismatch; the timing
//    difference leaks how many leading bytes of a guess were right, which lets an attacker
//    recover a valid signature one byte at a time. `timingSafeEqual` always touches every byte.
//
// 3. Check the length first, because `timingSafeEqual` throws on unequal lengths. This
//    short-circuit is safe: the correct length is public (32 bytes for SHA-256), so learning
//    "wrong length" tells an attacker nothing they did not already know.

const ALGORITHM = 'sha256';

/** HMAC-SHA256 of `rawBody` with `secret`, as raw bytes. */
export function hmacSha256(secret: string, rawBody: string | Uint8Array): Buffer {
  return createHmac(ALGORITHM, secret).update(rawBody).digest();
}

/** Hex-encoded signature, the format our own postbacks use. */
export function signHex(secret: string, rawBody: string | Uint8Array): string {
  return hmacSha256(secret, rawBody).toString('hex');
}

/** Base64-encoded signature, the format Shopify webhooks use (X-Shopify-Hmac-Sha256). */
export function signBase64(secret: string, rawBody: string | Uint8Array): string {
  return hmacSha256(secret, rawBody).toString('base64');
}

export function verifyHex(
  secret: string,
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;
  // Buffer.from tolerates malformed hex by producing a shorter buffer; the length check below
  // then rejects it, so garbage can never compare equal.
  return digestsMatch(hmacSha256(secret, rawBody), Buffer.from(signature, 'hex'));
}

export function verifyBase64(
  secret: string,
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;
  return digestsMatch(hmacSha256(secret, rawBody), Buffer.from(signature, 'base64'));
}

function digestsMatch(expected: Buffer, provided: Buffer): boolean {
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
