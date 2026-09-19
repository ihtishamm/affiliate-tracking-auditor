import { createHash } from 'node:crypto';

// Hashing of customer identifiers for Meta's Conversions API (PROJECT_CONTEXT §8, §6 M3).
//
// Meta matches a server event to a person by comparing our SHA-256 of the email with its own
// SHA-256 of the email it holds. Hashes only match if both sides hashed the SAME bytes, so the
// value must be normalised the way Meta normalises before hashing: whitespace trimmed and
// letters lower-cased for email; digits only, with the country code and no leading zeros, for
// phone. sha256("Buyer@Example.com ") and sha256("buyer@example.com") share nothing, and the
// difference is invisible in any dashboard: the event is simply "unmatched". That silent
// mismatch is what the auditor's PII check (M5, check 9) looks for.
//
// The plaintext is used in memory for the hash and then dropped. It is never logged or stored.

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Digits only, leading zeros removed. "+1 (555) 010-0000" → "15550100000". Meta requires the
 * country code to be present; we cannot add one we do not have, so a national-format number
 * from the checkout hashes as given (and will not match, which the check would report).
 */
export function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '').replace(/^0+/, '');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Normalised-then-hashed email, or null when nothing usable was supplied. */
export function hashEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalised = normaliseEmail(email);
  return normalised ? sha256Hex(normalised) : null;
}

/** Normalised-then-hashed phone, or null when nothing usable was supplied. */
export function hashPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normalised = normalisePhone(phone);
  return normalised ? sha256Hex(normalised) : null;
}

/** True when `value` has the shape of a hex SHA-256 digest: the check engine's "looks hashed". */
export function looksLikeSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}
