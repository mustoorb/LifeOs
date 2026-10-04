import { HOUR, MINUTE } from '@lifeos/contracts';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_COMPANION,
  MANUAL_LOG,
  consentAt,
  defineConnector,
  eventIdFor,
  grantConsent,
  hasConsent,
  normalizeObservation,
  revokeConsent,
  type ConnectorDescriptor,
  type ConsentLedger,
  type SourceObservation,
} from '../src/index.js';

const T0 = Date.UTC(2026, 9, 5, 9, 0); // Monday 2026-10-05 09:00 UTC
const TZ = 'Europe/Paris';

const WATCH: ConnectorDescriptor = defineConnector({
  id: 'test-watch',
  sourceKind: 'vendor_connector',
  importMethod: 'oauth_sync',
  deviceClass: 'watch',
  baselineEvidence: 'connected',
  baselineConfidence: 0.85,
  emitsTypes: ['run', 'walk', 'workout'],
  providesMetrics: ['distanceM', 'heartRateSummary', 'activeCalories', 'activeSeconds'],
  requiredConsent: ['health_workouts'],
});

function run(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    sourceEventId: 'run-1',
    type: 'run',
    interval: { start: T0, end: T0 + 30 * MINUTE },
    timeZone: TZ,
    metrics: { distanceM: 5000, heartRateSummary: { avgBpm: 150 }, activeCalories: 300 },
    ...overrides,
  };
}

describe('consent ledger', () => {
  it('answers what was agreed at a point in time', () => {
    let ledger: ConsentLedger = [];
    ledger = grantConsent(ledger, 'desktop_activity', T0, 'v1');
    ledger = revokeConsent(ledger, 'desktop_activity', T0 + HOUR, 'v1');

    expect(hasConsent(ledger, 'desktop_activity', T0 - 1)).toBe(false);
    expect(hasConsent(ledger, 'desktop_activity', T0 + MINUTE)).toBe(true);
    expect(hasConsent(ledger, 'desktop_activity', T0 + 2 * HOUR)).toBe(false);
    expect(consentAt(ledger, 'calendar', T0)).toBeNull();
  });
});

describe('connector descriptors', () => {
  it('refuses connectors that assert earned evidence tiers', () => {
    expect(() => defineConnector({ ...WATCH, baselineEvidence: 'corroborated' })).toThrow();
    expect(() => defineConnector({ ...MANUAL_LOG, baselineEvidence: 'observed' })).toThrow();
  });
});

describe('normalizeObservation', () => {
  const healthConsent = grantConsent([], 'health_workouts', T0 - HOUR, 'v1');

  it('rejects events without the connector consent', () => {
    const result = normalizeObservation({
      userId: 'u1',
      observation: run(),
      connector: WATCH,
      consent: [],
      receivedAt: T0 + HOUR,
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_consent' });
  });

  it('produces a private, idempotent event with connector evidence', () => {
    const input = { userId: 'u1', observation: run(), connector: WATCH, consent: healthConsent, receivedAt: T0 + HOUR };
    const first = normalizeObservation(input);
    const second = normalizeObservation({ ...input, receivedAt: T0 + 2 * HOUR });
    if (!first.ok || !second.ok) throw new Error('expected ok');

    expect(first.event.id).toBe(eventIdFor('u1', 'test-watch', 'run-1'));
    expect(second.event.id).toBe(first.event.id);
    expect(first.event.visibility).toBe('private');
    expect(first.event.evidenceLevel).toBe('connected');
    expect(first.event.retentionPolicy).toBe('sensitive');
    expect(first.event.consentVersion).toBe('health_workouts@v1');
  });

  it('keeps absent metrics absent and drops undeclared or unconsented ones', () => {
    const result = normalizeObservation({
      userId: 'u1',
      observation: run({ type: 'walk', metrics: { distanceM: 3000, heartRateSummary: { avgBpm: 110 }, steps: 4000 } }),
      connector: { ...MANUAL_LOG, providesMetrics: ['distanceM', 'heartRateSummary'] },
      consent: [],
      receivedAt: T0 + HOUR,
    });
    if (!result.ok) throw new Error(result.detail);

    expect(result.event.metrics).toEqual({ distanceM: 3000 });
    expect(result.event.metrics.steps).toBeUndefined();
    expect(result.droppedMetrics).toEqual(
      expect.arrayContaining([
        { metric: 'steps', reason: 'not_declared_by_connector' },
        { metric: 'heartRateSummary', reason: 'missing_consent' },
      ]),
    );
    expect(result.event.retentionPolicy).toBe('standard');
  });

  it('rejects future, unsupported, and implausibly long events', () => {
    const base = { userId: 'u1', connector: WATCH, consent: healthConsent, receivedAt: T0 + HOUR };
    expect(normalizeObservation({ ...base, observation: run({ interval: { start: T0, end: T0 + 3 * HOUR } }) }))
      .toMatchObject({ ok: false, reason: 'future_interval' });
    expect(normalizeObservation({ ...base, observation: run({ type: 'ride' }) })).toMatchObject({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(
      normalizeObservation({
        ...base,
        receivedAt: T0 + 20 * HOUR,
        observation: run({ type: 'workout', interval: { start: T0, end: T0 + 7 * HOUR } }),
      }),
    ).toMatchObject({ ok: false, reason: 'duration_out_of_bounds' });
    expect(normalizeObservation({ ...base, observation: run({ timeZone: 'Mars/Olympus' }) })).toMatchObject({
      ok: false,
      reason: 'invalid_time_zone',
    });
  });

  it('only keeps calendar context with calendar consent, and app categories only from the desktop', () => {
    const desktopConsent = grantConsent([], 'desktop_activity', T0 - HOUR, 'v1');
    const observation: SourceObservation = {
      sourceEventId: 'd1',
      type: 'creative_session',
      interval: { start: T0, end: T0 + 50 * MINUTE },
      timeZone: TZ,
      context: { appCategory: 'video-editing', calendarCategory: 'Client work', tags: ['Focus', 'focus'] },
    };
    const withoutCalendar = normalizeObservation({
      userId: 'u1',
      observation,
      connector: DESKTOP_COMPANION,
      consent: desktopConsent,
      receivedAt: T0 + HOUR,
    });
    const withCalendar = normalizeObservation({
      userId: 'u1',
      observation,
      connector: DESKTOP_COMPANION,
      consent: grantConsent(desktopConsent, 'calendar', T0 - HOUR, 'v1'),
      receivedAt: T0 + HOUR,
    });
    const manual = normalizeObservation({
      userId: 'u1',
      observation,
      connector: MANUAL_LOG,
      consent: [],
      receivedAt: T0 + HOUR,
    });
    if (!withoutCalendar.ok || !withCalendar.ok || !manual.ok) throw new Error('expected ok');

    expect(withoutCalendar.event.context).toEqual({ appCategory: 'video-editing', tags: ['focus'] });
    expect(withCalendar.event.context.calendarCategory).toBe('Client work');
    expect(manual.event.context.appCategory).toBeUndefined();
  });
});
