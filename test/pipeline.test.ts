import { HOUR, MINUTE } from '@lifeos/contracts';
import {
  RULESET_V1,
  computeActivityAward,
  dailyFocusQuest,
  evaluateQuest,
  questCompletionAward,
  summarizeProgress,
  type GameAward,
} from '@lifeos/eclipse';
import {
  DEFAULT_DESKTOP_SETTINGS,
  DESKTOP_COMPANION,
  aggregateDesktopSamples,
  applyFocusBlocks,
  applyCorrection,
  assessActivities,
  deduplicate,
  desktopSessionToObservation,
  grantConsent,
  normalizeObservation,
  type ForegroundSample,
} from '@lifeos/promethee';
import { describe, expect, it } from 'vitest';

/**
 * The MVP daily loop end to end (blueprint §4, §6):
 * plan → act → evidence → reflect.
 */
describe('daily loop', () => {
  const tz = 'Europe/Paris';
  const start = Date.UTC(2026, 9, 5, 7, 0); // 09:00 in Paris
  const dayWindow = { start: start - 9 * HOUR, end: start + 15 * HOUR };

  it('turns a consented focus block into quest progress and explained XP', () => {
    // Plan: the user accepts today's focus quest and starts a focus block.
    const quest = dailyFocusQuest('focus-2026-10-05', dayWindow);
    const focusBlock = { interval: { start, end: start + 60 * MINUTE }, taskId: 'edit-reel' };

    // Act: the companion samples the foreground app locally every minute.
    const samples: ForegroundSample[] = Array.from({ length: 50 }, (_, i) => ({
      at: start + i * MINUTE,
      appId: 'com.example.editor',
      idle: i >= 20 && i < 22,
    }));

    // Evidence: aggregate locally, then normalize under the user's consent.
    const sessions = applyFocusBlocks(
      aggregateDesktopSamples(samples, {
        ...DEFAULT_DESKTOP_SETTINGS,
        sampleIntervalMs: MINUTE,
        categoryByApp: { 'com.example.editor': 'video-editing' },
      }),
      [focusBlock],
    );
    const consent = grantConsent([], 'desktop_activity', start - HOUR, 'privacy-v1');
    const events = sessions.map((session) => {
      const result = normalizeObservation({
        userId: 'u1',
        observation: desktopSessionToObservation(session, tz),
        connector: DESKTOP_COMPANION,
        consent,
        receivedAt: start + 2 * HOUR,
      });
      if (!result.ok) throw new Error(result.detail);
      return result.event;
    });
    const [inferred] = assessActivities(deduplicate(events));
    expect(inferred).toMatchObject({ canonicalType: 'digital_session', evidenceLevel: 'observed', visibility: 'private' });

    // Reflect: "We think this was a video-editing session" — the user recategorizes it.
    const activity = applyCorrection(inferred!, { kind: 'recategorize', type: 'creative_session' });

    let ledger: GameAward[] = [];
    const activityAward = computeActivityAward(activity, { ruleset: RULESET_V1, ledger, now: start + 2 * HOUR });
    if (activityAward.kind !== 'award') throw new Error(activityAward.reason);
    ledger = [...ledger, activityAward.award];

    const evaluation = evaluateQuest(quest, [activity]);
    const bonus = questCompletionAward(quest, evaluation, { userId: 'u1', ledger, now: start + 2 * HOUR, timeZone: tz });
    ledger = [...ledger, bonus!];

    expect(activityAward.award.explanation.slice(0, 2)).toEqual([
      '29 Creation XP',
      '48 min creative session; observed evidence 1.0×',
    ]);
    expect(evaluation.complete).toBe(true);
    expect(summarizeProgress(ledger)).toMatchObject({
      totalXp: 29 + 5,
      skills: { creation: { xp: 29 }, focus: { xp: 5 } },
    });
  });

  it('records nothing when desktop consent was never granted', () => {
    const result = normalizeObservation({
      userId: 'u1',
      observation: {
        sourceEventId: 'x',
        type: 'digital_session',
        interval: { start, end: start + 30 * MINUTE },
        timeZone: tz,
      },
      connector: DESKTOP_COMPANION,
      consent: [],
      receivedAt: start + HOUR,
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_consent' });
  });
});
