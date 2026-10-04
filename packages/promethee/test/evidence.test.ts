import { MINUTE, type ActivityEvent, type DerivedActivity } from '@lifeos/contracts';
import { describe, expect, it } from 'vitest';
import { applyCorrection, assessActivities, correctionQueue, deduplicate } from '../src/index.js';

const T0 = Date.UTC(2026, 9, 5, 7, 0);

function event(overrides: Partial<ActivityEvent> & Pick<ActivityEvent, 'id'>): ActivityEvent {
  return {
    userId: 'u1',
    sourceId: 'manual-log',
    sourceEventId: overrides.id,
    occurredAt: T0,
    receivedAt: T0 + 2 * 60 * MINUTE,
    type: 'run',
    interval: { start: T0, end: T0 + 30 * MINUTE },
    timeZone: 'Europe/Paris',
    metrics: {},
    context: { tags: [] },
    provenance: { sourceKind: 'manual', connector: 'manual-log', importMethod: 'user_entry' },
    visibility: 'private',
    evidenceLevel: 'self_reported',
    confidence: 0.5,
    consentVersion: 'none',
    retentionPolicy: 'standard',
    ...overrides,
  };
}

const watchProvenance = {
  sourceKind: 'vendor_connector',
  connector: 'test-watch',
  importMethod: 'oauth_sync',
} as const;
const phoneProvenance = {
  sourceKind: 'mobile_companion',
  connector: 'test-phone',
  importMethod: 'device_sync',
} as const;

describe('deduplicate', () => {
  it('merges a manual log with a connected workout, preferring trusted metrics', () => {
    const manual = event({ id: 'm1', type: 'manual_log', metrics: { distanceM: 6000, steps: 7000 }, visibility: 'friends' });
    const watch = event({
      id: 'w1',
      interval: { start: T0 + 2 * MINUTE, end: T0 + 31 * MINUTE },
      metrics: { distanceM: 5100 },
      provenance: watchProvenance,
      evidenceLevel: 'connected',
      confidence: 0.85,
    });

    const [activity, ...rest] = deduplicate([manual, watch]);
    expect(rest).toEqual([]);
    expect(activity).toMatchObject({
      canonicalType: 'run',
      evidenceLevel: 'connected',
      eventIds: ['m1', 'w1'],
      interval: watch.interval,
      metrics: { distanceM: 5100, steps: 7000 },
      visibility: 'private',
    });
    expect(activity!.confidence).toBeCloseTo(1 - 0.5 * 0.15);
  });

  it('marks agreement between independent non-manual sources as corroborated', () => {
    const [activity] = deduplicate([
      event({ id: 'w1', provenance: watchProvenance, evidenceLevel: 'connected', confidence: 0.85 }),
      event({ id: 'p1', type: 'walk', provenance: phoneProvenance, evidenceLevel: 'observed', confidence: 0.6 }),
    ]);
    expect(activity!.evidenceLevel).toBe('corroborated');
    expect(activity!.canonicalType).toBe('run');
  });

  it('does not let a manual log corroborate anything', () => {
    const [activity] = deduplicate([
      event({ id: 'm1' }),
      event({ id: 'w1', provenance: watchProvenance, evidenceLevel: 'connected', confidence: 0.85 }),
    ]);
    expect(activity!.evidenceLevel).toBe('connected');
  });

  it('keeps non-overlapping and incompatible events apart', () => {
    const activities = deduplicate([
      event({ id: 'a' }),
      event({ id: 'b', interval: { start: T0 + 60 * MINUTE, end: T0 + 90 * MINUTE } }),
      event({ id: 'c', type: 'creative_session' }),
      event({ id: 'a' }), // re-ingested duplicate id
    ]);
    expect(activities.map((a) => a.eventIds)).toEqual([['a'], ['c'], ['b']]);
  });
});

function activity(overrides: Partial<DerivedActivity> & Pick<DerivedActivity, 'id'>): DerivedActivity {
  return {
    userId: 'u1',
    eventIds: [overrides.id],
    duplicateGroupId: `dup:${overrides.id}`,
    canonicalType: 'run',
    interval: { start: T0, end: T0 + 30 * MINUTE },
    timeZone: 'Europe/Paris',
    metrics: {},
    context: { tags: [] },
    evidenceLevel: 'connected',
    confidence: 0.85,
    verificationStatus: 'unverified',
    userConfirmation: 'pending',
    visibility: 'private',
    flags: [],
    ...overrides,
  };
}

describe('assessActivities', () => {
  it('flags implausible pace without touching plausible activities', () => {
    const [fast, normal] = assessActivities([
      activity({ id: 'fast', metrics: { distanceM: 20_000 } }), // 40 km/h run
      activity({ id: 'ok', metrics: { distanceM: 6_000 }, interval: { start: T0 + 3e6, end: T0 + 3e6 + 30 * MINUTE } }),
    ]);
    expect(fast).toMatchObject({ verificationStatus: 'flagged', flags: ['implausible_pace'] });
    expect(normal).toMatchObject({ verificationStatus: 'unverified', flags: [] });
  });

  it('flags the weaker side of a body/screen conflict', () => {
    const [run, screen] = assessActivities([
      activity({ id: 'run', evidenceLevel: 'self_reported' }),
      activity({ id: 'screen', canonicalType: 'creative_session', evidenceLevel: 'observed' }),
    ]);
    expect(run!.flags).toEqual(['conflicting_overlap']);
    expect(screen!.flags).toEqual([]);
  });

  it('rate-limits self-reported logs per local day', () => {
    const logs = Array.from({ length: 8 }, (_, i) =>
      activity({
        id: `log${i}`,
        canonicalType: 'workout',
        evidenceLevel: 'self_reported',
        interval: { start: T0 + i * 40 * MINUTE, end: T0 + i * 40 * MINUTE + 30 * MINUTE },
      }),
    );
    const flagged = assessActivities(logs).filter((a) => a.flags.includes('manual_rate_limit'));
    expect(flagged.map((a) => a.id)).toEqual(['log6', 'log7']);
  });
});

describe('corrections', () => {
  it('confirms, recategorizes and discards without changing evidence', () => {
    const base = activity({ id: 'a', canonicalType: 'digital_session', evidenceLevel: 'observed' });
    expect(applyCorrection(base, { kind: 'confirm' })).toMatchObject({
      userConfirmation: 'confirmed',
      evidenceLevel: 'observed',
    });
    expect(applyCorrection(base, { kind: 'recategorize', type: 'creative_session', category: 'video-editing' }))
      .toMatchObject({ canonicalType: 'creative_session', userConfirmation: 'corrected', context: { appCategory: 'video-editing' } });
    expect(applyCorrection(base, { kind: 'discard' }).userConfirmation).toBe('discarded');
  });

  it('puts flagged and low-confidence items first in the queue', () => {
    const queue = correctionQueue([
      activity({ id: 'confident', confidence: 0.9 }),
      activity({ id: 'unsure', confidence: 0.4 }),
      activity({ id: 'flagged', confidence: 0.95, verificationStatus: 'flagged' }),
      activity({ id: 'done', userConfirmation: 'confirmed' }),
    ]);
    expect(queue.map((a) => a.id)).toEqual(['flagged', 'unsure', 'confident']);
  });
});
