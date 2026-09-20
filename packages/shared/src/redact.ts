import { normaliseEmail, normalisePhone, sha256Hex } from './pii.ts';

// Redaction at capture time (PROJECT_CONTEXT §8). The runner watches a real funnel's network
// traffic, and once a reviewer points it at their own store that traffic carries their
// customers' data: the Meta pixel sends `ud[em]`, a broken pixel sends `email=` in plaintext,
// a checkout form posts a name and an address. None of that may reach the database. The rule
// is therefore applied to every parameter the moment it is observed, in the worker, before
// anything is stored — never as a filter on the way to the screen.
//
// What survives, per parameter, is one of three shapes:
//   value   – the string itself (event names, pixel IDs, click IDs, UTMs, currency, amounts,
//             content IDs…): what the checks actually reason about.
//   pii     – `{ present, looksHashed, hashAlgoGuess, normalised }`, exactly as §8 specifies.
//             Never the value, never a prefix, never a length. This is enough for check 9
//             (are hash-file params hashed and normalised?) and for the unhashed_email toggle.
//   secret  – `{ present: true }` for anything that looks like a credential. Not PII, but a
//             stranger's misconfigured page can leak an API key into a query string, and a
//             trace is a poor place to keep one.
//
// A parameter is PII when EITHER its name says so OR its value does — two independent tests,
// because each misses what the other catches. The name test knows the vocabulary of pixels
// (Meta's `em`/`ph`/`fn`/`ln`, TikTok's `email`/`phone_number`, generic `first_name`) and
// covers hashed values, which have no recognisable shape. The value test catches an email
// or a phone number hiding under an innocent name (`?q=jane@example.com`, `cd[custom]=…`),
// which is precisely how the `unhashed_email` toggle leaks it. When the two tests disagree
// the parameter is redacted: losing one harmless value is cheap, keeping one email is not.
//
// A third test exists because of what was observed on the first full run: Shopify's own
// telemetry and its address-autocomplete API sent the typed first name, street and city
// under keys like `field_value`, `query` and `zone`. No name rule can anticipate those and a
// street has no shape a value rule can recognise — but the runner knows exactly what it
// typed. Any value containing a typed string is therefore PII. It is precise (the runner is
// the only person in the session) and it is the reason `KnownIdentity.values` exists.
//
// `normalised` is only knowable when the runner itself typed the identity at checkout: it
// knows the email it entered, so it can compute sha256(trim(lowercase(email))) and compare.
// A match is `true`; a match against the un-normalised spelling is `false` (hashed, but
// wrongly — Meta will never match it to the user); anything else is `null`, not a guess.
// On a stranger's funnel the runner never reaches checkout, so `normalised` is always null
// there, and check 9 reports what it could see: hashed or not.

const MAX_VALUE_CHARS = 500;
const MAX_PARAMS = 300;
const MAX_DEPTH = 8;

export type ParamValue =
  | { kind: 'value'; value: string; truncated?: true }
  | {
      kind: 'pii';
      present: true;
      looksHashed: boolean;
      hashAlgoGuess: 'sha256' | 'sha1' | 'md5' | null;
      normalised: boolean | null;
    }
  | { kind: 'secret'; present: true };

export type ParamMap = Record<string, ParamValue>;

/** What the runner typed at checkout, so hashed twins and echoed values can be recognised. Never stored. */
export interface KnownIdentity {
  email?: string;
  phone?: string;
  /** Every other typed string (name, street, city, postcode…); a value containing one is PII. */
  values?: string[];
}

export type BodyKind = 'none' | 'form' | 'json' | 'multipart' | 'opaque';

export interface RedactedBody {
  kind: BodyKind;
  bytes: number;
  params: ParamMap;
}

// ---- name test -------------------------------------------------------------------------------

// Leaf names that are PII outright. Short codes are Meta's user_data keys (`ud[em]` on the
// pixel, `user_data.em` on CAPI) and only match the whole leaf; `st` alone must not redact a
// `state=1` toggle by substring — though it will redact `st=CA`, which is the safe direction.
const PII_LEAF_EXACT = new Set([
  'em',
  'ph',
  'fn',
  'ln',
  'ge',
  'db',
  'ct',
  'st',
  'zp',
  'country',
  'external_id',
  'client_ip_address',
  'email',
  'e_mail',
  'mail',
  'phone',
  'phone_number',
  'tel',
  'telephone',
  'mobile',
  'first_name',
  'firstname',
  'last_name',
  'lastname',
  'name',
  'full_name',
  'fullname',
  'address',
  'address1',
  'address2',
  'street',
  'city',
  'zip',
  'zipcode',
  'postal_code',
  'postcode',
  'dob',
  'birthdate',
  'birthday',
  'date_of_birth',
  'gender',
  'ssn',
  'ip',
  'ip_address',
  'client_ip',
  'sha256_email',
  'sha256_phone',
  'hashed_email',
  'hashed_phone',
]);
// Longer names that contain PII words anywhere: customer_email, shipping_address_1, emailHash…
const PII_LEAF_PATTERN =
  /email|phone|first_?name|last_?name|address|postal|zip|birth|gender|ssn|passport|national_?id/;

const SECRET_LEAF_PATTERN =
  /token|secret|passw|pwd|api_?key|access_?key|private_?key|credential|(^|_)auth$|authorization|^sig$|signature|hmac/;

/** `ud[em]` → `em`, `data[0].user_data.ph` → `ph`, `Customer-Email` → `customer_email`. */
function leafOf(key: string): string {
  const stripped = key.replace(/\]$/, '');
  // Array indices are positions, not names: `em[0]` is still `em`.
  const parts = stripped.split(/[.[\]]+/).filter((p) => p && !/^\d+$/.test(p));
  const leaf = parts[parts.length - 1] ?? stripped;
  return leaf.toLowerCase().replace(/-/g, '_');
}

function nameSaysPii(leaf: string): boolean {
  return PII_LEAF_EXACT.has(leaf) || PII_LEAF_PATTERN.test(leaf);
}

// ---- value test ------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@/]+@[^\s@]+\.[a-z]{2,}$/i;
// A phone number written by a human or a form carries a leading `+` (E.164) or separators.
// A bare run of digits is far more often an order ID, a timestamp or a click ID, and
// redacting those would blind the checks that matter; that trade-off is deliberate.
const PHONE_RE = /^(\+\d[\d\s().-]{6,}|\(?\d{2,4}\)?[\s.-]\d[\d\s().-]{5,})$/;

function valueSaysPii(value: string, known: KnownIdentity | undefined): boolean {
  if (known && containsTypedValue(value, known)) return true;
  if (value.length > 320) return false;
  if (EMAIL_RE.test(value)) return true;
  if (PHONE_RE.test(value)) {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
  }
  return false;
}

function containsTypedValue(value: string, known: KnownIdentity): boolean {
  const haystack = value.toLowerCase();
  const typed = [...(known.values ?? []), known.email, known.phone];
  for (const t of typed) {
    // Short strings ("NY", "1") would match everything; three characters is the floor.
    if (t && t.length >= 3 && haystack.includes(t.toLowerCase())) return true;
  }
  return false;
}

function hashGuess(value: string): 'sha256' | 'sha1' | 'md5' | null {
  if (/^[0-9a-f]{64}$/i.test(value)) return 'sha256';
  if (/^[0-9a-f]{40}$/i.test(value)) return 'sha1';
  if (/^[0-9a-f]{32}$/i.test(value)) return 'md5';
  return null;
}

/**
 * Compares a hashed value with the hashes of the identity the runner typed. Only sha256 can
 * be judged: that is the algorithm every ad platform specifies for hash-file matching.
 */
function normalisedVerdict(value: string, known: KnownIdentity | undefined): boolean | null {
  if (!known || hashGuess(value) !== 'sha256') return null;
  const v = value.toLowerCase();
  for (const raw of [known.email, known.phone].filter((s): s is string => Boolean(s))) {
    const isEmail = raw.includes('@');
    const normalised = isEmail ? normaliseEmail(raw) : normalisePhone(raw);
    if (v === sha256Hex(normalised)) return true;
    // Hashed without normalising: the raw spelling, or lowercase-only for an email with
    // surrounding whitespace. Either yields a hash Meta can never match.
    const variants = new Set([raw, raw.trim(), raw.toLowerCase()]);
    variants.delete(normalised);
    for (const variant of variants) if (v === sha256Hex(variant)) return false;
  }
  return null;
}

// ---- classification --------------------------------------------------------------------------

/** The rule for one parameter. Exported so the tests can pin every branch. */
export function classifyParam(key: string, value: string, known?: KnownIdentity): ParamValue {
  const leaf = leafOf(key);
  if (SECRET_LEAF_PATTERN.test(leaf)) return { kind: 'secret', present: true };
  if (nameSaysPii(leaf) || valueSaysPii(value, known)) {
    const guess = hashGuess(value);
    return {
      kind: 'pii',
      present: true,
      looksHashed: guess !== null,
      hashAlgoGuess: guess,
      normalised: normalisedVerdict(value, known),
    };
  }
  if (value.length > MAX_VALUE_CHARS) {
    return { kind: 'value', value: value.slice(0, MAX_VALUE_CHARS), truncated: true };
  }
  return { kind: 'value', value };
}

export function redactParams(entries: Iterable<[string, string]>, known?: KnownIdentity): ParamMap {
  const out: ParamMap = {};
  let count = 0;
  for (const [key, value] of entries) {
    if (count++ >= MAX_PARAMS) break;
    out[key] = classifyParam(key, value, known);
  }
  return out;
}

export function redactQuery(search: string | URLSearchParams, known?: KnownIdentity): ParamMap {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return redactParams(params.entries(), known);
}

/**
 * A URL safe to persist: same origin and path, with every PII-looking or secret-looking
 * query value replaced by the marker `[redacted]`. Used for the submitted URL, page URLs in
 * snapshots and script URLs — anywhere a URL, rather than a param map, is stored.
 */
export function redactUrl(input: string | URL): string {
  const url = new URL(input);
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const c = classifyParam(key, value);
    params.set(key, c.kind === 'value' ? c.value : '[redacted]');
  }
  url.search = params.size > 0 ? `?${params.toString()}` : '';
  url.hash = '';
  return url.toString();
}

// ---- bodies ----------------------------------------------------------------------------------

/**
 * Turns a request body into a redacted param map and forgets the body. Form, JSON and
 * multipart are the three encodings pixels and checkouts use; anything else is recorded by
 * kind and size only.
 */
export function redactBody(
  body: string | null | undefined,
  contentType: string | null | undefined,
  known?: KnownIdentity,
): RedactedBody {
  if (!body) return { kind: 'none', bytes: 0, params: {} };
  const bytes = Buffer.byteLength(body);
  const type = (contentType ?? '').toLowerCase();

  if (type.includes('multipart/form-data')) {
    // From the original header: boundaries are case-sensitive and `type` is lower-cased.
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType ?? '')?.[2];
    return {
      kind: 'multipart',
      bytes,
      params: redactParams(multipartEntries(body, boundary), known),
    };
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return { kind: 'form', bytes, params: redactQuery(body, known) };
  }
  // JSON declared, or undeclared (sendBeacon sends text/plain) but shaped like it.
  if (type.includes('json') || /^\s*[[{]/.test(body)) {
    try {
      return { kind: 'json', bytes, params: redactParams(flattenJson(JSON.parse(body)), known) };
    } catch {
      /* not JSON after all */
    }
  }
  if (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(body)) {
    return { kind: 'form', bytes, params: redactQuery(body, known) };
  }
  return { kind: 'opaque', bytes, params: {} };
}

function* flattenJson(value: unknown, path = '', depth = 0): Generator<[string, string]> {
  if (depth > MAX_DEPTH) return;
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* flattenJson(value[i], `${path}[${i}]`, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      yield* flattenJson(v, path ? `${path}.${k}` : k, depth + 1);
    }
    return;
  }
  yield [path || '(root)', String(value)];
}

function* multipartEntries(
  body: string,
  boundary: string | undefined,
): Generator<[string, string]> {
  if (!boundary) return;
  for (const part of body.split(`--${boundary}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const head = part.slice(0, split);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    // A file part is never a tracking parameter; its name is enough.
    if (/filename=/.test(head)) {
      yield [name, '[file]'];
      continue;
    }
    yield [name, part.slice(split + 4).replace(/\r\n$/, '')];
  }
}
