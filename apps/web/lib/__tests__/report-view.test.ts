import { describe, expect, it } from 'vitest';
import type { CheckResult } from '@auditor/checks';
import type { RunTrace } from '@auditor/shared';
import {
  fixFirst,
  orderForReport,
  stepProgress,
  togglesOf,
  waterfallRows,
} from '../report-view.ts';

const r = (number: number, status: CheckResult['status']): CheckResult => ({
  id: 'pii_hashing',
  number,
  title: `check ${number}`,
  status,
  observed: '',
  expected: '',
  reason: '',
  fixHint: '',
});

describe('report ordering', () => {
  it('shows failures first, then undecided, then passes, each in check order', () => {
    const ordered = orderForReport([
      r(1, 'pass'),
      r(8, 'inconclusive'),
      r(3, 'fail'),
      r(9, 'fail'),
      r(6, 'inconclusive'),
      r(2, 'pass'),
    ]);
    expect(ordered.map((x) => `${x.number}:${x.status}`)).toEqual([
      '3:fail',
      '9:fail',
      '6:inconclusive',
      '8:inconclusive',
      '1:pass',
      '2:pass',
    ]);
  });

  it('"fix first" is the root cause, not the lowest number: a dropped click ID blames the redirect (3), not persistence (1)', () => {
    expect(fixFirst([r(1, 'fail'), r(3, 'fail'), r(8, 'fail')])?.number).toBe(3);
    expect(fixFirst([r(4, 'fail'), r(10, 'fail'), r(5, 'fail')])?.number).toBe(10); // the consent wall explains the rest
    expect(fixFirst([r(6, 'fail'), r(5, 'fail')])?.number).toBe(5); // no event_id explains the dedup miss
    expect(fixFirst([r(1, 'pass'), r(2, 'inconclusive')])).toBeNull();
  });
});

describe('step progress', () => {
  it('marks steps before the furthest as done, the furthest as current while running and stopped when terminal', () => {
    const live = stepProgress('cart', false);
    expect(live.map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'pending',
      'pending',
      'pending',
    ]);
    const stopped = stepProgress('checkout', true);
    expect(stopped[5]?.state).toBe('stopped');
    expect(stepProgress('thank_you', true).every((s) => s.state === 'done')).toBe(true);
    expect(stepProgress(null, false).every((s) => s.state === 'pending')).toBe(true);
  });
});

const trace = {
  entryUrl: 'https://x.example/a?__break=drop_click_id,unhashed_email&click_id=aud-1',
  startedAt: '2026-09-21T00:00:00.000Z',
  finishedAt: '2026-09-21T00:00:10.000Z',
  hops: [
    { t: 100, from: '', to: 'https://x.example/a?click_id=aud-1', status: 200, kind: 'navigate' },
    {
      t: 3000,
      from: 'https://x.example/a',
      to: 'https://shop.example/?click_id=aud-1',
      status: 200,
      kind: 'redirect',
    },
  ],
  requests: [
    {
      seq: 0,
      t: 1500,
      method: 'GET',
      url: 'https://www.facebook.com/tr/',
      host: 'www.facebook.com',
      resourceType: 'image',
      navigation: false,
      step: 'landing',
      status: 200,
      contentType: null,
      durationMs: 40,
      params: { ev: { kind: 'value', value: 'PageView' } },
      bodyKind: 'none',
      bodyBytes: 0,
      redirectTo: null,
      failure: null,
    },
    {
      seq: 1,
      t: 4000,
      method: 'POST',
      url: 'https://shop.example/cart/update.js',
      host: 'shop.example',
      resourceType: 'fetch',
      navigation: false,
      step: 'store',
      status: 200,
      contentType: null,
      durationMs: 90,
      params: {},
      bodyKind: 'json',
      bodyBytes: 10,
      redirectTo: null,
      failure: null,
    },
    {
      seq: 2,
      t: 4100,
      method: 'GET',
      url: 'https://shop.example/cdn/x.js',
      host: 'shop.example',
      resourceType: 'script',
      navigation: false,
      step: 'store',
      status: 200,
      contentType: null,
      durationMs: 5,
      params: {},
      bodyKind: 'none',
      bodyBytes: 0,
      redirectTo: null,
      failure: null,
    },
  ],
} as unknown as RunTrace;

describe('trace-derived views', () => {
  it('reads the break-it toggles from the entry URL', () => {
    expect(togglesOf(trace)).toEqual(['drop_click_id', 'unhashed_email']);
  });

  it('waterfall keeps hops and tracking/attribution requests, drops the rest, in time order', () => {
    const rows = waterfallRows(trace);
    expect(rows.map((x) => `${x.kind}:${x.label}`)).toEqual([
      'hop:x.example/a',
      'pixel:Meta PageView (no event_id)',
      'hop:shop.example',
      'cart:cart attributes',
    ]);
    expect(rows[0]?.end).toBe(3000); // a hop spans until the next hop
    expect(rows[2]?.end).toBe(10000); // the last hop spans to the end of the run
  });
});
