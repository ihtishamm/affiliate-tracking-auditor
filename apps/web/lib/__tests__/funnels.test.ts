import { describe, expect, it } from 'vitest';
import { dailyRunKey } from '@auditor/shared';
import { labelFor } from '../funnels.ts';

describe('saved funnels', () => {
  it('the daily key is one per funnel per UTC day, so a second tick cannot double-run', () => {
    const a = dailyRunKey('f1', new Date('2026-09-21T06:00:00Z'));
    const b = dailyRunKey('f1', new Date('2026-09-21T23:59:59Z'));
    const c = dailyRunKey('f1', new Date('2026-09-22T00:00:01Z'));
    expect(a).toBe('daily:f1:2026-09-21');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('labels a funnel by host and path, showing toggles when the saved URL carries them', () => {
    expect(labelFor('https://shop.example/landing?click_id=x')).toBe('shop.example/landing');
    expect(labelFor('https://shop.example/?__break=drop_click_id')).toBe(
      'shop.example (drop_click_id)',
    );
  });
});
