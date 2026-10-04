import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CURVE,
  RULESET_V1,
  appealAward,
  computeActivityAward,
  levelForXp,
  reconcileActivity,
  resolveAllocation,
  reverseAward,
  summarizeProgress,
  xpForLevel,
  type AwardOptions,
  type GameAward,
} from '../src/index.js';
import { T0, activity, at } from './fixtures.js';

function options(ledger: readonly GameAward[] = [], extra: Partial<AwardOptions> = {}): AwardOptions {
  return { ruleset: RULESET_V1, ledger, now: T0 + 3_600_000, ...extra };
}

function award(result: ReturnType<typeof computeActivityAward>): GameAward {
  if (result.kind !== 'award') throw new Error(`skipped: ${result.reason}`);
  return result.award;
}

describe('computeActivityAward', () => {
  it('matches the blueprint example: 50 min focus block → 25 Focus XP', () => {
    const result = award(computeActivityAward(activity({ userConfirmation: 'confirmed' }), options()));
    expect(result).toMatchObject({
      xp: 25,
      status: 'awarded',
      ruleVersion: RULESET_V1.version,
      skillAllocations: [{ skill: 'focus', xp: 25 }],
      basis: { activityType: 'digital_session', minutes: 50, evidenceLevel: 'observed' },
      localDate: '2026-10-05',
    });
    expect(result.explanation[0]).toBe('25 Focus XP');
    expect(result.explanation[1]).toBe('50 min digital session; observed evidence 1.0×');
  });

  it('uses active time rather than wall time when the source provides it', () => {
    const result = award(computeActivityAward(activity({ metrics: { activeSeconds: 30 * 60 } }), options()));
    expect(result.xp).toBe(15);
  });

  it('gives self-reported activity reduced, provisional XP', () => {
    const result = award(
      computeActivityAward(at(0, 40, { canonicalType: 'workout', evidenceLevel: 'self_reported', confidence: 0.5 }), options()),
    );
    expect(result).toMatchObject({ xp: 20, status: 'provisional', skillAllocations: [{ skill: 'strength', xp: 20 }] });
  });

  it('holds flagged and low-confidence unconfirmed activities as pending', () => {
    const flagged = award(computeActivityAward(activity({ verificationStatus: 'flagged', flags: ['implausible_pace'] }), options()));
    const unsure = award(computeActivityAward(activity({ confidence: 0.2 }), options()));
    const vouched = award(computeActivityAward(activity({ confidence: 0.2, userConfirmation: 'confirmed' }), options()));
    expect(flagged.status).toBe('pending');
    expect(flagged.explanation).toContain('Held for review: implausible_pace');
    expect(unsure.status).toBe('pending');
    expect(vouched.status).toBe('awarded');
  });

  it('skips discarded, rejected and already-awarded activities', () => {
    const base = activity();
    const first = award(computeActivityAward(base, options()));
    expect(computeActivityAward(base, options([first]))).toEqual({ kind: 'skipped', reason: 'already_awarded' });
    expect(computeActivityAward(activity({ userConfirmation: 'discarded' }), options())).toMatchObject({ reason: 'discarded' });
    expect(computeActivityAward(activity({ verificationStatus: 'rejected' }), options())).toMatchObject({ reason: 'rejected' });
  });

  it('applies diminishing returns after the daily threshold for a type', () => {
    const morning = award(computeActivityAward(at(0, 170), options()));
    const evening = award(computeActivityAward(at(600, 50), options([morning])));
    // 10 fresh minutes + 40 tired minutes at 0.25 = 20 effective minutes × 0.5
    expect(evening.xp).toBe(10);
    expect(evening.explanation.some((line) => line.includes('40 min past 180 min'))).toBe(true);
  });

  it('applies the session cap and the per-skill daily cap', () => {
    const marathon = award(
      computeActivityAward(at(0, 300, { canonicalType: 'ride', evidenceLevel: 'connected', confidence: 0.9 }), options()),
    );
    expect(marathon.xp).toBe(RULESET_V1.sessionCap);

    const ledger: GameAward[] = [marathon];
    const second = award(
      computeActivityAward(at(400, 120, { canonicalType: 'run', evidenceLevel: 'connected', confidence: 0.9 }), options(ledger)),
    );
    expect(second.xp).toBe(RULESET_V1.dailyCapPerSkill - RULESET_V1.sessionCap);
    expect(second.explanation.some((line) => line.startsWith('Daily Endurance cap'))).toBe(true);
  });

  it('splits XP across user-chosen eligible skills without losing points', () => {
    const result = award(
      computeActivityAward(at(0, 50, { canonicalType: 'creative_session' }), options([], { allocation: { creation: 2, focus: 1, strength: 5 } })),
    );
    expect(result.skillAllocations).toEqual([
      { skill: 'creation', xp: 20 },
      { skill: 'focus', xp: 10 },
    ]);
    expect(resolveAllocation('run', { strength: 1 })).toEqual([{ skill: 'endurance', weight: 1 }]);
  });
});

describe('reversal, appeal and reconciliation', () => {
  it('reverses once and allows appeals of held or reversed awards', () => {
    const original = award(computeActivityAward(activity(), options()));
    const reversed = reverseAward(original, 'duplicate', T0);
    expect(reversed).toMatchObject({ status: 'reversed', reversal: { reason: 'duplicate' } });
    expect(() => reverseAward(reversed, 'again', T0)).toThrow();
    expect(appealAward(reversed).status).toBe('appealed');
    expect(() => appealAward(original)).toThrow();
  });

  it('reverses and recomputes after a recategorization', () => {
    const before = activity({ id: 'edit' });
    const original = award(computeActivityAward(before, options()));
    const after = { ...before, canonicalType: 'creative_session' as const, userConfirmation: 'corrected' as const };

    const { reversed, created } = reconcileActivity(after, options([original]));
    expect(reversed.map((a) => a.status)).toEqual(['reversed']);
    expect(created).toMatchObject({ xp: 30, skillAllocations: [{ skill: 'creation', xp: 30 }] });

    const ledger = [...reversed, created!];
    expect(reconcileActivity(after, options(ledger))).toEqual({ reversed: [], created: null });
  });

  it('reverses the award when the user discards the activity', () => {
    const before = activity({ id: 'oops' });
    const original = award(computeActivityAward(before, options()));
    const { reversed, created } = reconcileActivity({ ...before, userConfirmation: 'discarded' }, options([original]));
    expect(created).toBeNull();
    expect(reversed[0]!.reversal!.reason).toBe('activity discarded');
  });
});

describe('levels and progress', () => {
  it('maps XP to levels at exact boundaries', () => {
    expect(levelForXp(0, ACCOUNT_CURVE).level).toBe(1);
    expect(levelForXp(xpForLevel(2, ACCOUNT_CURVE) - 1, ACCOUNT_CURVE).level).toBe(1);
    expect(levelForXp(xpForLevel(2, ACCOUNT_CURVE), ACCOUNT_CURVE)).toMatchObject({ level: 2, xpIntoLevel: 0 });
    for (let level = 1; level < 60; level++) {
      expect(levelForXp(xpForLevel(level, ACCOUNT_CURVE), ACCOUNT_CURVE).level).toBe(level);
    }
  });

  it('counts awarded and provisional XP, reports held XP, ignores reversed', () => {
    const a = award(computeActivityAward(activity(), options()));
    const b = award(computeActivityAward(activity({ evidenceLevel: 'self_reported', confidence: 0.5 }), options()));
    const c = award(computeActivityAward(activity({ verificationStatus: 'flagged' }), options()));
    const d = reverseAward(award(computeActivityAward(activity(), options())), 'test', T0);

    const summary = summarizeProgress([a, b, c, d]);
    expect(summary.totalXp).toBe(a.xp + b.xp);
    expect(summary.heldXp).toBe(c.xp);
    expect(summary.skills.focus.xp).toBe(a.xp + b.xp);
    expect(summary.skills.strength.xp).toBe(0);
  });
});
