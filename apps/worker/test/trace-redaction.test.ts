import type { BrowserContext, Request } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createLogger, sha256Hex } from '@auditor/shared';
import { TraceCollector } from '../src/trace.ts';

// PROJECT_CONTEXT §8 as a test rather than as a claim.
//
// The other redaction tests check one rule at a time: this key, that value, this body shape.
// They cannot catch the failure that actually matters — a field somebody added later that
// nobody thought to redact. So this one drives the collector the way a real checkout does,
// then searches the WHOLE serialised trace (the same JSON `insertTrace` writes to Postgres)
// for anything the runner typed and for anything shaped like an email or a phone number.
// If a future field carries a customer's data into the database, this test fails without
// anyone having to predict which field it was.
//
// It also asserts the opposite direction, which is the part that makes redaction useful
// rather than merely safe: the event name, the pixel ID and the click ID are still there,
// because a trace that redacted everything would pass the first half and be worthless.

const log = createLogger({ service: 'test', level: 'error', write: () => {} });

const TYPED = {
  email: 'grace.hopper@example.org',
  firstName: 'Grace',
  lastName: 'Hopper',
  address1: '350 5th Ave',
  city: 'New York',
  phone: '+1 212 555 0147',
};

interface FakeInit {
  url: string;
  method?: string;
  body?: string;
  contentType?: string;
  navigation?: boolean;
}

/** The handful of Playwright `Request` methods the collector actually calls. */
function fakeRequest(init: FakeInit): Request {
  const frame = { page: () => ({ mainFrame: () => frame }) };
  return {
    url: () => init.url,
    method: () => init.method ?? 'GET',
    resourceType: () => (init.navigation ? 'document' : 'xhr'),
    postData: () => init.body ?? null,
    headers: () => (init.contentType ? { 'content-type': init.contentType } : {}),
    isNavigationRequest: () => init.navigation === true,
    frame: () => frame,
    redirectedFrom: () => null,
  } as unknown as Request;
}

async function collectorWithTypedIdentity(): Promise<{
  collector: TraceCollector;
  emit: (init: FakeInit) => void;
}> {
  const collector = new TraceCollector({
    runId: '00000000-0000-4000-8000-000000000001',
    startedAt: Date.now(),
    expectedClickId: 'aud-test-1',
    clickIdParam: 'click_id',
    ssrf: { allowPrivate: true },
    refusedReason: () => undefined,
    log,
  });
  const handlers = new Map<string, (arg: unknown) => void>();
  const context = {
    route: async () => undefined,
    on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
  } as unknown as BrowserContext;
  await collector.attach(context);
  // What the funnel driver does the moment before it types anything at checkout.
  collector.setKnownIdentity({
    email: TYPED.email,
    values: [
      TYPED.firstName,
      TYPED.lastName,
      `${TYPED.firstName} ${TYPED.lastName}`,
      TYPED.address1,
      TYPED.city,
    ],
  });
  const request = handlers.get('request');
  if (!request) throw new Error('the collector did not subscribe to requests');
  return { collector, emit: (init) => request(fakeRequest(init)) };
}

describe('the stored trace never contains what the runner typed', () => {
  it('holds for every shape a checkout sends it in', async () => {
    const { collector, emit } = await collectorWithTypedIdentity();

    // 1. The Meta pixel: hashed advanced matching, plus the masked field copies, plus `dl`
    //    (the page URL) carrying the typed city in a query parameter.
    emit({
      url:
        'https://www.facebook.com/tr/?id=1541349738037398&ev=Purchase&eid=purchase-5592' +
        `&ud[em]=${sha256Hex(TYPED.email)}&cud[em]=^****.******%40*******.***` +
        '&dl=https%3A%2F%2Fshop.example%2Fcheckout%3Fship_city%3DNew%2BYork' +
        '&cd[click_id]=aud-test-1',
    });

    // 2. Shopify's own telemetry, which echoed the typed name and street under keys no name
    //    rule could anticipate (observed on this project's first full run).
    emit({
      url: 'https://shop.example/.well-known/shopify/monorail/unstable/produce_batch',
      method: 'POST',
      contentType: 'text/plain;charset=UTF-8',
      body: JSON.stringify({
        events: [
          { schema_id: 'trekkie_storefront', payload: { field_value: TYPED.address1 } },
          { schema_id: 'checkout_ui', payload: { query: `${TYPED.firstName} ${TYPED.lastName}` } },
        ],
      }),
    });

    // 3. A plaintext leak: a pixel configured to send the email unhashed, in a multipart body.
    emit({
      url: 'https://analytics.example/collect',
      method: 'POST',
      contentType: 'multipart/form-data; boundary=X',
      body:
        `--X\r\nContent-Disposition: form-data; name="customer_email"\r\n\r\n${TYPED.email}\r\n` +
        `--X\r\nContent-Disposition: form-data; name="tel"\r\n\r\n${TYPED.phone}\r\n--X--\r\n`,
    });

    // 4. A navigation whose own URL carries the identity — this becomes a stored hop as well
    //    as a stored request.
    emit({
      url: `https://shop.example/checkout?email=${encodeURIComponent(TYPED.email)}&phone=${encodeURIComponent(TYPED.phone)}&click_id=aud-test-1`,
      navigation: true,
    });

    // 5. The address-autocomplete call: the typed street as a search term.
    emit({
      url: `https://atlas.shopifysvc.com/suggest?q=${encodeURIComponent(TYPED.address1)}`,
    });

    const stored = JSON.stringify({
      requests: collector.requests,
      hops: collector.hops,
      steps: collector.steps,
    });

    for (const typed of Object.values(TYPED)) {
      expect(stored.toLowerCase()).not.toContain(typed.toLowerCase());
      // Query strings are stored percent-encoded, so the encoded spelling has to be gone too.
      expect(stored.toLowerCase()).not.toContain(encodeURIComponent(typed).toLowerCase());
    }
    // Nothing shaped like an email or a phone number, whoever it belongs to.
    expect(stored).not.toMatch(/[^\s@"'\\/]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(stored).not.toMatch(/\+\d[\d\s().-]{5,}\d/);
    // Not even the hash of the email survives as a value — check 9 needs the verdict, not the digest.
    expect(stored).not.toContain(sha256Hex(TYPED.email));

    // And the trace is still worth having.
    const pixel = collector.requests[0];
    expect(pixel?.params['ev']).toEqual({ kind: 'value', value: 'Purchase' });
    expect(pixel?.params['id']).toEqual({ kind: 'value', value: '1541349738037398' });
    expect(pixel?.params['cd[click_id]']).toEqual({ kind: 'value', value: 'aud-test-1' });
    // The hashed email is recorded as a verdict: present, hashed, sha256, normalised.
    expect(pixel?.params['ud[em]']).toEqual({
      kind: 'pii',
      present: true,
      looksHashed: true,
      hashAlgoGuess: 'sha256',
      normalised: true,
    });
    expect(collector.hops.at(-1)?.to).toContain('click_id=aud-test-1');
  });
});
