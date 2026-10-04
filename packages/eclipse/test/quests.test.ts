import { DAY, HOUR } from '@lifeos/contracts';
import { describe, expect, it } from 'vitest';
import {
  dailyFocusQuest,
  evaluatePooledQuest,
  evaluateQuest,
  isDiscoverable,
  questCompletionAward,
  validateQuest,
  weeklyMovementQuest,
  weeklyRecoveryQuest,
} from '../src/index.js';
import { T0, TZ, at } from './fixtures.js';

const DAY_WINDOW = { start: T0 - 9 * HOUR, end: T0 + 15 * HOUR };
const WEEK_WINDOW = { start: T0 - 9 * HOUR, end: T0 - 9 * HOUR + 7 * DAY };

describe('daily focus quest', () => {
  const quest = dailyFocusQuest('focus-2026-10-05', DAY_WINDOW);

  it('needs an observed, focus-tagged block of at least 25 minutes', () => {
    expect(evaluateQuest(quest, [at(0, 50)]).complete).toBe(false); // no focus tag
    expect(evaluateQuest(quest, [at(0, 20, { context: { tags: ['focus'] } })]).complete).toBe(false);
    expect(
      evaluateQuest(quest, [at(0, 30, { context: { tags: ['focus'] }, evidenceLevel: 'self_reported' })]).complete,
    ).toBe(false);

    const evaluation = evaluateQuest(quest, [at(0, 30, { id: 'ok', context: { tags: ['focus'] } })]);
    expect(evaluation).toMatchObject({ complete: true, progress: 1, qualifyingActivityIds: ['ok'] });
  });

  it('ignores flagged and discarded activities, and time outside the window', () => {
    const tagged = { context: { tags: ['focus'] } };
    expect(evaluateQuest(quest, [at(0, 30, { ...tagged, verificationStatus: 'flagged' })]).complete).toBe(false);
    expect(evaluateQuest(quest, [at(0, 30, { ...tagged, userConfirmation: 'discarded' })]).complete).toBe(false);
    // Starts 10 minutes before the window closes: only 10 minutes count.
    expect(evaluateQuest(quest, [at(15 * 60 - 10, 30, tagged)]).complete).toBe(false);
  });

  it('awards the quest bonus once', () => {
    const evaluation = evaluateQuest(quest, [at(0, 30, { context: { tags: ['focus'] } })]);
    const options = { userId: 'u1', ledger: [], now: T0 + HOUR, timeZone: TZ, seasonId: 's1' };
    const award = questCompletionAward(quest, evaluation, options);
    expect(award).toMatchObject({
      awardType: 'quest_completion',
      xp: 5,
      status: 'awarded',
      seasonId: 's1',
      explanation: ['+5 quest bonus: Focus block', '1 qualifying activity'],
    });
    expect(questCompletionAward(quest, evaluation, { ...options, ledger: [award!] })).toBeNull();
  });
});

describe('weekly movement quest', () => {
  const quest = weeklyMovementQuest('move-w41', WEEK_WINDOW);
  const run = (day: number, minutes: number) =>
    at(day * 24 * 60, minutes, { canonicalType: 'run', evidenceLevel: 'self_reported', confidence: 0.5 });

  it('needs both 150 minutes and three distinct days', () => {
    const twoDays = evaluateQuest(quest, [run(0, 90), run(1, 90)]);
    expect(twoDays.complete).toBe(false);
    expect(twoDays.criteria.map((c) => c.current)).toEqual([180, 2]);
    expect(twoDays.progress).toBeCloseTo(2 / 3);

    const done = evaluateQuest(quest, [run(0, 50), run(2, 50), run(4, 50)]);
    expect(done.complete).toBe(true);
    expect(done.lowestEvidence).toBe('self_reported');
  });

  it('marks completions backed by self-reported evidence as provisional', () => {
    const done = evaluateQuest(quest, [run(0, 50), run(2, 50), run(4, 50)]);
    const award = questCompletionAward(quest, done, { userId: 'u1', ledger: [], now: T0, timeZone: TZ });
    expect(award?.status).toBe('provisional');
  });
});

describe('quest rule builder', () => {
  it('accepts the built-in templates', () => {
    expect(validateQuest(dailyFocusQuest('a', DAY_WINDOW))).toEqual([]);
    expect(validateQuest(weeklyMovementQuest('b', WEEK_WINDOW))).toEqual([]);
    expect(validateQuest(weeklyRecoveryQuest('c', WEEK_WINDOW))).toEqual([]);
  });

  it('rejects oversized windows, rewards and unmoderated public challenges', () => {
    const base = dailyFocusQuest('a', DAY_WINDOW);
    expect(validateQuest({ ...base, window: WEEK_WINDOW })).toContain('A daily quest cannot run longer than its timeframe');
    expect(validateQuest({ ...base, reward: { xp: 1000, skill: 'focus' } })).toHaveLength(1);
    expect(validateQuest({ ...base, criteria: [{ metric: 'sessions', count: 0 }] })).toHaveLength(1);

    const challenge = { ...base, kind: 'challenge' as const, eligibility: { ...base.eligibility, minEvidence: 'self_reported' as const } };
    expect(validateQuest(challenge)).toEqual([
      'Challenges cannot accept self-reported evidence',
      'Public quests require moderation before discovery',
    ]);
    expect(isDiscoverable({ ...base, kind: 'challenge', moderation: 'pending' })).toBe(false);
    expect(isDiscoverable({ ...base, kind: 'challenge', moderation: 'approved' })).toBe(true);
  });
});

describe('pooled guild quests', () => {
  it('reports only the aggregate and contributor count', () => {
    const quest = { ...weeklyMovementQuest('guild-w41', WEEK_WINDOW), kind: 'guild' as const, criteria: [{ metric: 'minutes' as const, minutes: 120 }] };
    const physical = { canonicalType: 'walk' as const, evidenceLevel: 'self_reported' as const };
    const result = evaluatePooledQuest(
      quest,
      new Map([
        ['u1', [at(0, 60, { ...physical, userId: 'u1' })]],
        ['u2', [at(60, 60, { ...physical, userId: 'u2' })]],
        ['u3', [at(0, 5, { ...physical, userId: 'u3' })]],
      ]),
    );
    expect(result).toEqual({ complete: true, progress: 1, contributors: 2 });
  });
});
