import { describe, expect, it } from 'vitest';
import { classifyParam, redactBody, redactQuery, redactUrl, scrubText } from '../src/redact.ts';
import { sha256Hex } from '../src/pii.ts';

const email = 'Buyer@Example.com';
const hashedNormalised = sha256Hex('buyer@example.com');
const hashedRaw = sha256Hex(email);

describe('classifyParam — the name test', () => {
  it("Meta's user_data codes are PII whatever their value looks like", () => {
    for (const key of ['ud[em]', 'ud[ph]', 'user_data.fn', 'data[0].user_data.ln', 'em', 'zp']) {
      expect(classifyParam(key, 'anything').kind, key).toBe('pii');
    }
  });

  it('generic PII names, in any casing or nesting, are PII', () => {
    for (const key of [
      'email',
      'Customer-Email',
      'shipping_address.phone',
      'contact[first_name]',
      'billing.postal_code',
      'emailHash',
    ]) {
      expect(classifyParam(key, 'x').kind, key).toBe('pii');
    }
  });

  it('short codes match only the whole leaf', () => {
    expect(classifyParam('state', '1').kind).toBe('value');
    expect(classifyParam('cd[content_type]', 'product').kind).toBe('value');
    expect(classifyParam('st', 'CA').kind).toBe('pii'); // over-redaction is the safe direction
  });
});

describe('classifyParam — the value test', () => {
  it('an email under an innocent name is still PII (the unhashed_email toggle)', () => {
    const c = classifyParam('cd[custom_email_param]', email);
    expect(c).toEqual({
      kind: 'pii',
      present: true,
      looksHashed: false,
      hashAlgoGuess: null,
      normalised: null,
    });
    expect(classifyParam('q', 'jane@example.org').kind).toBe('pii');
  });

  it('phone numbers need a + or separators; bare digit runs are IDs, not phones', () => {
    expect(classifyParam('cd[x]', '+1 555 010 0000').kind).toBe('pii');
    expect(classifyParam('cd[x]', '(555) 010-0000').kind).toBe('pii');
    expect(classifyParam('order_id', '5592397545769').kind).toBe('value');
    expect(classifyParam('ts', '1789850372').kind).toBe('value');
    expect(classifyParam('click_id', 'aud-1a2b3c4d').kind).toBe('value');
  });

  it('a value containing something the runner typed is PII, whatever the key (checkout telemetry)', () => {
    const known = {
      email: 'audit-1@example.com',
      values: ['Auditor', '350 5th Ave', 'New York', '10118'],
    };
    expect(classifyParam('events[6].payload.query', '350 5th Ave', known).kind).toBe('pii');
    expect(classifyParam('events[3].payload.field_value', 'Auditor', known).kind).toBe('pii');
    expect(classifyParam('payload.zone', 'new york', known).kind).toBe('pii');
    expect(classifyParam('json', '{"contact":"audit-1@example.com"}', known).kind).toBe('pii');
    expect(classifyParam('q', 'snowboard', known).kind).toBe('value'); // unrelated values untouched
    expect(classifyParam('ev', 'PageView', { values: ['NY'] }).kind).toBe('value'); // too short to count
  });

  it('a URL value is judged by its query, not its host: "auditor" in the domain is not the typed name', () => {
    const known = { values: ['Auditor', '350 5th Ave'] };
    expect(
      classifyParam('dl', 'https://auditor-demo.myshopify.com/checkouts/cn/abc/thank-you', known)
        .kind,
    ).toBe('value');
    expect(classifyParam('dl', 'https://shop.example/search?q=350+5th+Ave', known).kind).toBe(
      'pii',
    );
  });

  it("Meta's masked field copies (cud[em]=^****.***@***) are recorded as [masked], not judged", () => {
    expect(classifyParam('cud[em]', '^****.***@*******.***')).toEqual({
      kind: 'value',
      value: '[masked]',
    });
    expect(classifyParam('ncud[em]', '*****.***@*******.***')).toEqual({
      kind: 'value',
      value: '[masked]',
    });
  });

  it('an empty value is never PII, even under em/ph (Meta sends cud[em]= when it scraped nothing)', () => {
    expect(classifyParam('cud[em]', '')).toEqual({ kind: 'value', value: '' });
    expect(classifyParam('email', '')).toEqual({ kind: 'value', value: '' });
  });

  it('a 64-hex value under a non-PII name is kept: it is an ID or a signature, not a person', () => {
    expect(classifyParam('event_id', hashedNormalised).kind).toBe('value');
  });
});

describe('classifyParam — what is recorded for PII', () => {
  it('never the value, never a prefix', () => {
    const c = classifyParam('em', hashedNormalised);
    expect(JSON.stringify(c)).not.toContain(hashedNormalised.slice(0, 8));
    expect(JSON.stringify(classifyParam('email', email))).not.toMatch(/buyer|example/i);
  });

  it('guesses the hash algorithm from the shape', () => {
    expect(classifyParam('em', hashedNormalised)).toMatchObject({
      looksHashed: true,
      hashAlgoGuess: 'sha256',
    });
    expect(classifyParam('em', 'a'.repeat(40))).toMatchObject({
      looksHashed: true,
      hashAlgoGuess: 'sha1',
    });
    expect(classifyParam('em', 'b'.repeat(32))).toMatchObject({
      looksHashed: true,
      hashAlgoGuess: 'md5',
    });
    expect(classifyParam('em', email)).toMatchObject({ looksHashed: false, hashAlgoGuess: null });
  });

  it('normalised is judged only against the identity the runner typed', () => {
    const known = { email: `  ${email} ` };
    expect(classifyParam('ud[em]', hashedNormalised, known)).toMatchObject({ normalised: true });
    expect(classifyParam('ud[em]', hashedRaw, known)).toMatchObject({ normalised: false });
    expect(classifyParam('ud[em]', sha256Hex('someone@else.com'), known)).toMatchObject({
      normalised: null,
    });
    expect(classifyParam('ud[em]', hashedNormalised)).toMatchObject({ normalised: null }); // nothing known
    expect(classifyParam('ud[em]', email, known)).toMatchObject({
      looksHashed: false,
      normalised: null,
    });
  });

  it('phone: the E.164-normalised hash is the one that counts', () => {
    const known = { phone: '+1 (555) 010-0000' };
    expect(classifyParam('ud[ph]', sha256Hex('15550100000'), known)).toMatchObject({
      normalised: true,
    });
    expect(classifyParam('ud[ph]', sha256Hex('+1 (555) 010-0000'), known)).toMatchObject({
      normalised: false,
    });
  });
});

describe('secrets', () => {
  it('credential-looking names keep only presence', () => {
    for (const key of [
      'access_token',
      'api_key',
      'apiKey',
      'X-Signature',
      'password',
      'gtm_auth',
      'secret',
    ]) {
      expect(classifyParam(key, 'EAAB…'), key).toEqual({ kind: 'secret', present: true });
    }
  });
  it('but IDs that merely contain "id" or "key"-like words are kept', () => {
    expect(classifyParam('pixel_id', '1541349738037398').kind).toBe('value');
    expect(classifyParam('keyword', 'protein').kind).toBe('value');
  });
});

describe('redactQuery / redactUrl', () => {
  it('keeps attribution and event parameters verbatim', () => {
    const m = redactQuery(
      'id=1541349738037398&ev=PageView&eid=purchase-5592&cd[click_id]=aud-1&utm_source=affiliate',
    );
    expect(m['id']).toEqual({ kind: 'value', value: '1541349738037398' });
    expect(m['ev']).toEqual({ kind: 'value', value: 'PageView' });
    expect(m['cd[click_id]']).toEqual({ kind: 'value', value: 'aud-1' });
    expect(m['utm_source']).toEqual({ kind: 'value', value: 'affiliate' });
  });

  it('a stored URL loses PII query values but nothing else', () => {
    expect(
      redactUrl(
        'https://shop.example/landing?click_id=abc&email=jane@example.org&utm_source=x#frag',
      ),
    ).toBe('https://shop.example/landing?click_id=abc&email=%5Bredacted%5D&utm_source=x');
  });

  it('long values are truncated, not dropped', () => {
    const m = redactQuery(`data=${'x'.repeat(800)}`);
    expect(m['data']).toMatchObject({ kind: 'value', truncated: true });
    expect((m['data'] as { value: string }).value).toHaveLength(500);
  });
});

describe('redactBody', () => {
  it('form-encoded', () => {
    const b = redactBody(
      'ev=Purchase&ud[em]=' + hashedNormalised + '&cd[value]=10',
      'application/x-www-form-urlencoded',
    );
    expect(b.kind).toBe('form');
    expect(b.params['ud[em]']).toMatchObject({ kind: 'pii', looksHashed: true });
    expect(b.params['cd[value]']).toEqual({ kind: 'value', value: '10' });
  });

  it('JSON is flattened to paths; nested user_data is PII', () => {
    const b = redactBody(
      JSON.stringify({
        data: [
          {
            event_name: 'Purchase',
            user_data: { em: [hashedNormalised], client_ip_address: '1.2.3.4' },
          },
        ],
      }),
      'application/json',
    );
    expect(b.kind).toBe('json');
    expect(b.params['data[0].event_name']).toEqual({ kind: 'value', value: 'Purchase' });
    expect(b.params['data[0].user_data.em[0]']).toMatchObject({ kind: 'pii', looksHashed: true });
    expect(b.params['data[0].user_data.client_ip_address']).toMatchObject({ kind: 'pii' });
  });

  it('sendBeacon text/plain that is really JSON or a form is parsed as such', () => {
    expect(redactBody('{"ev":"PageView"}', 'text/plain').kind).toBe('json');
    expect(redactBody('ev=PageView&id=1', 'text/plain').kind).toBe('form');
    expect(redactBody('just some text', 'text/plain')).toEqual({
      kind: 'opaque',
      bytes: 14,
      params: {},
    });
  });

  it('multipart (what fbevents.js sends via sendBeacon)', () => {
    const boundary = '----WebKitFormBoundaryabc123';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="ev"',
      '',
      'Purchase',
      `--${boundary}`,
      'Content-Disposition: form-data; name="ud[em]"',
      '',
      hashedNormalised,
      `--${boundary}`,
      'Content-Disposition: form-data; name="upload"; filename="a.png"',
      'Content-Type: image/png',
      '',
      'PNGDATA',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const b = redactBody(body, `multipart/form-data; boundary=${boundary}`);
    expect(b.kind).toBe('multipart');
    expect(b.params['ev']).toEqual({ kind: 'value', value: 'Purchase' });
    expect(b.params['ud[em]']).toMatchObject({ kind: 'pii', looksHashed: true });
    expect(b.params['upload']).toEqual({ kind: 'value', value: '[file]' });
    expect(JSON.stringify(b)).not.toContain(hashedNormalised);
  });

  it('empty and unknown bodies record kind and size only', () => {
    expect(redactBody(null, null)).toEqual({ kind: 'none', bytes: 0, params: {} });
    expect(redactBody('\u0000\u0001binary', 'application/octet-stream').kind).toBe('opaque');
  });
});

describe('scrubText — free text that gets stored', () => {
  // What the runner typed at checkout, in the shape the funnel driver builds it.
  const typed = {
    email: 'grace.hopper@example.org',
    values: ['Grace', 'Hopper', '350 5th Ave', 'New York'],
  };

  it("keeps a Playwright error's URL readable and loses its query", () => {
    const scrubbed = scrubText(
      'page.goto: net::ERR_ABORTED at https://shop.example/checkout?email=buyer@example.com&step=2',
    );
    expect(scrubbed).toContain('net::ERR_ABORTED at https://shop.example/checkout');
    expect(scrubbed).toContain('step=2');
    expect(scrubbed).not.toContain('buyer@example.com');
  });

  it('the full stop after a URL is punctuation, not part of the address', () => {
    expect(scrubText('failed at https://shop.example/a?b=1. Retrying.')).toBe(
      'failed at https://shop.example/a?b=1. Retrying.',
    );
  });

  it('a checkout banner quoting what was typed is scrubbed, and still says what went wrong', () => {
    const scrubbed = scrubText(
      "checkout reported: We can't ship to 350 5th Ave, New York — enter a different address",
      typed,
    );
    expect(scrubbed).not.toContain('350 5th Ave');
    expect(scrubbed).not.toContain('New York');
    expect(scrubbed).toContain('enter a different address');
  });

  it('an email or a phone number in prose the runner never typed is still redacted', () => {
    expect(scrubText('rejected: customer@merchant.co.uk is not a valid address')).toBe(
      'rejected: [redacted] is not a valid address',
    );
    expect(scrubText('could not reach +1 212 555 0147 for confirmation')).toBe(
      'could not reach [redacted] for confirmation',
    );
  });

  it('leaves the numbers that make an error useful: order ids, timestamps, click ids', () => {
    const text = 'order 5592 at 1758556800000 for click id aud-20260922-0001 was not found';
    expect(scrubText(text)).toBe(text);
  });

  it('truncates: an error is a clue, not a document', () => {
    const long = `x`.repeat(400);
    const scrubbed = scrubText(long);
    expect(scrubbed).toHaveLength(301);
    expect(scrubbed.endsWith('\u2026')).toBe(true);
  });
});
