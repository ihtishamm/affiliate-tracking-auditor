import { describe, expect, it } from 'vitest';
import { evaluateAlert, type ScoreSnapshot } from '../src/alerts.ts';

const healthy: ScoreSnapshot = {
  score: 1,
  statuses: {
    click_id_persistence: 'pass',
    cross_domain_handoff: 'pass',
    postback_fired: 'inconclusive',
  },
};
const titles = {
  cross_domain_handoff: 'Cross-domain handoff',
  click_id_persistence: 'Click ID persistence',
};

describe('evaluateAlert', () => {
  it('fires when a check flips pass → fail, naming the check', () => {
    const v = evaluateAlert(
      healthy,
      { score: 0.9, statuses: { ...healthy.statuses, cross_domain_handoff: 'fail' } },
      titles,
    );
    expect(v.fire).toBe(true);
    expect(v.flipped).toEqual(['cross_domain_handoff']);
    expect(v.reasons).toEqual(['Cross-domain handoff went from pass to fail']);
  });

  it('fires on a score drop of at least 20 points even with no individual flip named', () => {
    const v = evaluateAlert({ score: 0.9, statuses: {} }, { score: 0.7, statuses: {} });
    expect(v.fire).toBe(true);
    expect(v.reasons).toEqual(['score dropped from 90% to 70%']);
    expect(v.scoreDrop).toBeCloseTo(0.2);
  });

  it('does not fire on a small dip, an improvement, or the same result', () => {
    expect(evaluateAlert({ score: 0.9, statuses: {} }, { score: 0.8, statuses: {} }).fire).toBe(
      false,
    );
    expect(evaluateAlert({ score: 0.5, statuses: {} }, { score: 0.9, statuses: {} }).fire).toBe(
      false,
    );
    expect(evaluateAlert(healthy, healthy).fire).toBe(false);
  });

  it('never fires on the first run: there is no baseline', () => {
    expect(evaluateAlert(null, { score: 0, statuses: { click_id_persistence: 'fail' } }).fire).toBe(
      false,
    );
  });

  it('inconclusive → fail is not a regression', () => {
    const v = evaluateAlert(healthy, {
      score: 0.9,
      statuses: { ...healthy.statuses, postback_fired: 'fail' },
    });
    expect(v.fire).toBe(false);
    expect(v.flipped).toEqual([]);
  });

  it('a fail that stays a fail does not alert again', () => {
    const broken = { score: 0.8, statuses: { ...healthy.statuses, cross_domain_handoff: 'fail' } };
    expect(evaluateAlert(broken, broken).fire).toBe(false);
  });
});
