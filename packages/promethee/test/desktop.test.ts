import { MINUTE, SECOND } from '@lifeos/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESKTOP_SETTINGS,
  aggregateDesktopSamples,
  applyFocusBlocks,
  desktopSessionToObservation,
  forgetSamples,
  type DesktopTrackingSettings,
  type ForegroundSample,
} from '../src/index.js';

const T0 = Date.UTC(2026, 9, 5, 9, 0);

const settings: DesktopTrackingSettings = {
  ...DEFAULT_DESKTOP_SETTINGS,
  sampleIntervalMs: MINUTE,
  categoryByApp: { 'com.editor': 'video-editing', 'com.ide': 'coding', 'com.chat': 'messaging' },
  deniedApps: ['com.chat'],
  typeByCategory: { 'video-editing': 'creative_session' },
  mergeGapMs: 3 * MINUTE,
  minSessionMs: 5 * MINUTE,
};

/** One sample per minute for `minutes` minutes starting at `offset` minutes. */
function samples(appId: string, offset: number, minutes: number, idle = false): ForegroundSample[] {
  return Array.from({ length: minutes }, (_, i) => ({ at: T0 + (offset + i) * MINUTE, appId, idle }));
}

describe('aggregateDesktopSamples', () => {
  it('builds category sessions, merging short idle gaps', () => {
    const sessions = aggregateDesktopSamples(
      [...samples('com.editor', 0, 20), ...samples('com.editor', 20, 2, true), ...samples('com.editor', 22, 28)],
      settings,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      appCategory: 'video-editing',
      type: 'creative_session',
      activeSeconds: 48 * 60,
      interval: { start: T0, end: T0 + 50 * MINUTE },
    });
  });

  it('splits on long idle and drops sessions shorter than the minimum', () => {
    const sessions = aggregateDesktopSamples(
      [...samples('com.ide', 0, 10), ...samples('com.ide', 10, 10, true), ...samples('com.ide', 20, 3)],
      settings,
    );
    expect(sessions.map((s) => s.activeSeconds)).toEqual([600]);
    expect(sessions[0]!.type).toBe('digital_session');
  });

  it('never tracks denied or unmapped apps', () => {
    const sessions = aggregateDesktopSamples(
      [...samples('com.chat', 0, 30), ...samples('com.unknown', 30, 30)],
      settings,
    );
    expect(sessions).toEqual([]);
  });

  it('respects pause windows', () => {
    const sessions = aggregateDesktopSamples(samples('com.ide', 0, 30), {
      ...settings,
      pauses: [{ start: T0 + 10 * MINUTE, end: T0 + 25 * MINUTE }],
    });
    expect(sessions.map((s) => s.activeSeconds)).toEqual([600, 300]);
  });

  it('caps a stale sample at the sampling interval', () => {
    const sessions = aggregateDesktopSamples(
      [{ at: T0, appId: 'com.ide', idle: false }, { at: T0 + 2 * 60 * MINUTE, appId: 'com.ide', idle: false }],
      { ...settings, sampleIntervalMs: 30 * SECOND, minSessionMs: 0 },
    );
    expect(sessions.map((s) => s.activeSeconds)).toEqual([30, 30]);
  });
});

describe('focus blocks and observations', () => {
  it('tags sessions inside a focus block and carries no content', () => {
    const [session] = applyFocusBlocks(aggregateDesktopSamples(samples('com.ide', 0, 30), settings), [
      { interval: { start: T0, end: T0 + 30 * MINUTE }, taskId: 'task-42' },
    ]);
    const observation = desktopSessionToObservation(session!, 'Europe/Paris');

    expect(observation.context).toEqual({ appCategory: 'coding', taskId: 'task-42', tags: ['focus'] });
    expect(observation.metrics).toEqual({ activeSeconds: 1800 });
    expect(JSON.stringify(observation)).not.toContain('com.ide');
  });

  it('forgets a range of local samples', () => {
    const kept = forgetSamples(samples('com.ide', 0, 60), { start: T0, end: T0 + 30 * MINUTE });
    expect(kept).toHaveLength(30);
    expect(kept[0]!.at).toBe(T0 + 30 * MINUTE);
  });
});
