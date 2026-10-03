import { MINUTE, type DerivedActivity } from '@lifeos/contracts';

/** Monday 2026-10-05 09:00 in Paris. */
export const T0 = Date.UTC(2026, 9, 5, 7, 0);
export const TZ = 'Europe/Paris';

let counter = 0;

export function activity(overrides: Partial<DerivedActivity> = {}): DerivedActivity {
  const id = overrides.id ?? `act-${++counter}`;
  return {
    id,
    userId: 'u1',
    eventIds: [id],
    duplicateGroupId: `dup:${id}`,
    canonicalType: 'digital_session',
    interval: { start: T0, end: T0 + 50 * MINUTE },
    timeZone: TZ,
    metrics: {},
    context: { tags: [] },
    evidenceLevel: 'observed',
    confidence: 0.7,
    verificationStatus: 'unverified',
    userConfirmation: 'pending',
    visibility: 'private',
    flags: [],
    ...overrides,
  };
}

/** An activity of `minutes` starting `offsetMinutes` after T0. */
export function at(offsetMinutes: number, minutes: number, overrides: Partial<DerivedActivity> = {}): DerivedActivity {
  return activity({
    interval: { start: T0 + offsetMinutes * MINUTE, end: T0 + (offsetMinutes + minutes) * MINUTE },
    ...overrides,
  });
}
