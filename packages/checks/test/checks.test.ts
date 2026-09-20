import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runTraceSchema, type RunTrace } from '@auditor/shared';
import { runChecks, summarise } from '../src/index.ts';
import type { CheckId, CheckResult, ServerEvents } from '../src/types.ts';

// M5 done criterion: every break-it toggle is caught by the right check and a clean run
// passes everything it can decide. The fixtures are real traces of the demo funnel captured
// by the runner (see scripts/slim-trace.ts) — nothing in them was typed by hand — so these
// tests pin the engine to what the browser actually saw.

const fixture = (name: string): RunTrace =>
  runTraceSchema.parse(
    JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')),
  );

const byId = (results: CheckResult[], id: CheckId): CheckResult => {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r;
};

/** Server rows the M3 receivers would hold for the trace's order, as a healthy funnel produces them. */
function healthyServer(trace: RunTrace, overrides: Partial<ServerEvents> = {}): ServerEvents {
  const id = trace.order?.id ?? '0';
  return {
    order: { id, name: '#1', attribution: { click_id: trace.expectedClickId } },
    conversionAttempts: [
      {
        kind: 'capi',
        attempt: 1,
        eventId: `purchase-${id}`,
        statusCode: 200,
        ok: true,
        error: null,
        piiHashed: true,
      },
      {
        kind: 'postback',
        attempt: 1,
        eventId: `pb-${id}`,
        statusCode: 200,
        ok: true,
        error: null,
        piiHashed: null,
      },
    ],
    postbackEvents: [
      { postbackId: `pb-${id}`, clickId: trace.expectedClickId, orderId: id, status: 'approved' },
    ],
    ...overrides,
  };
}

describe('a clean run', () => {
  const trace = fixture('clean');

  it('passes every check it can decide, and decides all ten once the server rows exist', () => {
    const report = runChecks({ trace, server: healthyServer(trace) });
    const statuses = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
    expect(statuses).toEqual({
      click_id_persistence: 'pass',
      utm_survival: 'pass',
      cross_domain_handoff: 'pass',
      pixel_fire_order: 'pass',
      event_id_present: 'pass',
      capi_dedup_match: 'pass',
      duplicate_containers: 'pass',
      postback_fired: 'pass',
      pii_hashing: 'pass',
      consent_blocking: 'pass',
    });
    expect(report.score).toBe(1);
  });

  it('without server rows, the two server-side checks are inconclusive — never fail', () => {
    const report = runChecks({ trace, server: null });
    expect(byId(report.results, 'capi_dedup_match').status).toBe('inconclusive');
    expect(byId(report.results, 'postback_fired').status).toBe('inconclusive');
    expect(report.counts).toEqual({ pass: 8, fail: 0, inconclusive: 2 });
    expect(report.score).toBe(1); // inconclusive neither helps nor hurts
  });

  it('never puts an email, a hash or a typed value into a verdict', () => {
    const text = JSON.stringify(runChecks({ trace, server: healthyServer(trace) }));
    expect(text).not.toMatch(/@example\.com|[0-9a-f]{64}|5th Ave|Auditor Run/);
  });
});

describe('break-it toggles are caught by the right check', () => {
  it('drop_click_id → 3 (handoff) and 1 (persistence) fail', () => {
    const trace = fixture('drop_click_id');
    const { results } = runChecks({ trace, server: null });
    expect(byId(results, 'cross_domain_handoff')).toMatchObject({ status: 'fail' });
    expect(byId(results, 'click_id_persistence')).toMatchObject({ status: 'fail' });
    expect(byId(results, 'utm_survival').status).toBe('pass'); // only the click ID was dropped
  });

  it('strip_utms → 2 fails and names the hop', () => {
    const trace = fixture('strip_utms');
    const r = byId(runChecks({ trace, server: null }).results, 'utm_survival');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/utm_source.*missing after the hop/);
    expect(byId(runChecks({ trace, server: null }).results, 'cross_domain_handoff').status).toBe(
      'pass',
    );
  });

  it('strip_event_id → 5 fails, and 6 fails because the browser Purchase cannot be paired', () => {
    const trace = fixture('strip_event_id');
    const { results } = runChecks({ trace, server: healthyServer(trace) });
    expect(byId(results, 'event_id_present')).toMatchObject({ status: 'fail' });
    expect(byId(results, 'event_id_present').observed).toMatch(/PageView|Purchase/);
    expect(byId(results, 'capi_dedup_match')).toMatchObject({ status: 'fail' });
    expect(byId(results, 'capi_dedup_match').reason).toMatch(/without a browser event_id/);
  });

  it('double_fire → 7 fails on the doubled PageView (one of them the noscript image)', () => {
    const trace = fixture('double_fire');
    const r = byId(runChecks({ trace, server: null }).results, 'duplicate_containers');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/PageView fired 2×.*without event_id/);
  });

  it('duplicate_gtm → 7 fails on the container loaded twice', () => {
    const trace = fixture('duplicate_gtm');
    const r = byId(runChecks({ trace, server: null }).results, 'duplicate_containers');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/GTM-AUD1T0R loaded 2×/);
  });

  it('unhashed_email → 9 fails on a plaintext parameter, and on the unhashed server event', () => {
    const trace = fixture('unhashed_email');
    const server = healthyServer(trace);
    server.conversionAttempts[0]!.piiHashed = false; // the M3 sender honours the same toggle
    const r = byId(runChecks({ trace, server }).results, 'pii_hashing');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/plaintext/);
    expect(r.observed).toMatch(/server-side Purchase sent user_data unhashed/);
    expect(r.observed).not.toMatch(/@/); // the key is named, never the value
  });

  it('consent_wall → 10 fails on the landing page; the pixel order check is not blamed', () => {
    const trace = fixture('consent_wall');
    const { results } = runChecks({ trace, server: null });
    const r = byId(results, 'consent_blocking');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/consent banner visible and no pixel event fired on: localhost/);
    expect(byId(results, 'pixel_fire_order').status).toBe('pass');
  });

  it('capi_mismatch → 6 fails when the server chose its own event_id', () => {
    const trace = fixture('capi_mismatch');
    const server = healthyServer(trace);
    server.conversionAttempts[0]!.eventId = '3f1c2e0a-random-uuid';
    const r = byId(runChecks({ trace, server }).results, 'capi_dedup_match');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/≠/);
  });

  it('postback_500 → 8 fails, and says the retries happened', () => {
    const trace = fixture('postback_500');
    const id = trace.order?.id ?? '0';
    const server = healthyServer(trace, {
      conversionAttempts: [
        {
          kind: 'capi',
          attempt: 1,
          eventId: `purchase-${id}`,
          statusCode: 200,
          ok: true,
          error: null,
          piiHashed: true,
        },
        ...[1, 2, 3].map((attempt) => ({
          kind: 'postback' as const,
          attempt,
          eventId: `pb-${id}`,
          statusCode: 500,
          ok: false,
          error: null,
          piiHashed: null,
        })),
      ],
      postbackEvents: [],
    });
    const r = byId(runChecks({ trace, server }).results, 'postback_fired');
    expect(r.status).toBe('fail');
    expect(r.observed).toMatch(/3 attempt\(s\), none accepted: 500 → 500 → 500/);
    expect(r.reason).toMatch(/retries happened/);
  });

  it('a postback that was not retried is called out', () => {
    const trace = fixture('postback_500');
    const id = trace.order?.id ?? '0';
    const server = healthyServer(trace, {
      conversionAttempts: [
        {
          kind: 'postback',
          attempt: 1,
          eventId: `pb-${id}`,
          statusCode: 502,
          ok: false,
          error: null,
          piiHashed: null,
        },
      ],
      postbackEvents: [],
    });
    expect(byId(runChecks({ trace, server }).results, 'postback_fired').reason).toMatch(
      /not retried/,
    );
  });
});

describe("a stranger's funnel (observe mode)", () => {
  // A clean trace cut at the checkout step: no purchase, no order, no server rows.
  const clean = fixture('clean');
  const cutAt = clean.steps.findIndex((s) => s.step === 'payment');
  const tAtCut = clean.steps[cutAt]?.t ?? Infinity;
  const observe: RunTrace = runTraceSchema.parse({
    ...clean,
    mode: 'observe',
    order: null,
    steps: clean.steps.slice(0, cutAt),
    requests: clean.requests.filter((r) => r.t < tAtCut),
    outcome: { reachedStep: 'checkout', stopReason: 'observe mode: checkout reached' },
  });

  it('decides what it saw and says inconclusive for what it could not', () => {
    const report = runChecks({ trace: observe, server: null });
    const status = (id: CheckId): string => byId(report.results, id).status;
    expect(status('click_id_persistence')).toBe('pass');
    expect(status('utm_survival')).toBe('pass');
    expect(status('cross_domain_handoff')).toBe('pass');
    expect(status('pixel_fire_order')).toBe('pass'); // Purchase not required: thank_you was not reached
    expect(status('event_id_present')).toBe('pass');
    expect(status('capi_dedup_match')).toBe('inconclusive');
    expect(status('postback_fired')).toBe('inconclusive');
    expect(status('pii_hashing')).toBe('inconclusive'); // no identity was ever sent
    expect(status('consent_blocking')).toBe('pass');
    expect(byId(report.results, 'postback_fired').observed).toMatch(/no purchase was completed/);
    expect(report.counts.fail).toBe(0);
  });
});

describe('the engine itself', () => {
  it('a check that throws is inconclusive, never a pass, and the other nine still run', () => {
    const trace = fixture('clean');
    // hops with unparsable URLs exercise every URL-parsing path without crashing the engine
    const broken: RunTrace = {
      ...trace,
      hops: trace.hops.map((h) => ({ ...h, to: '::not a url::' })),
    };
    const report = runChecks({ trace: broken, server: null });
    expect(report.results).toHaveLength(10);
    expect(report.results.every((r) => ['pass', 'fail', 'inconclusive'].includes(r.status))).toBe(
      true,
    );
  });

  it('score excludes inconclusive checks and is null when nothing was decided', () => {
    const mk = (status: CheckResult['status']): CheckResult => ({
      id: 'pii_hashing',
      number: 9,
      title: '',
      status,
      observed: '',
      expected: '',
      reason: '',
      fixHint: '',
    });
    expect(summarise([mk('pass'), mk('fail'), mk('inconclusive'), mk('pass')]).score).toBeCloseTo(
      2 / 3,
    );
    expect(summarise([mk('inconclusive')]).score).toBeNull();
  });
});
