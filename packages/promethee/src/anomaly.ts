import {
  DIGITAL_TYPES,
  HOUR,
  MINUTE,
  PHYSICAL_TYPES,
  durationMs,
  evidenceRank,
  localDateKey,
  overlapMs,
  type ActivityType,
  type DerivedActivity,
} from '@lifeos/contracts';

export type AnomalyFlag = 'implausible_pace' | 'implausible_steps' | 'conflicting_overlap' | 'manual_rate_limit';

export interface AnomalyPolicy {
  /** Average speed ceilings, km/h. */
  readonly maxSpeedKmh: Readonly<Partial<Record<ActivityType, number>>>;
  readonly maxStepsPerMinute: number;
  readonly maxSelfReportedPerDay: number;
}

export const DEFAULT_ANOMALY_POLICY: AnomalyPolicy = {
  maxSpeedKmh: { walk: 9, run: 25, ride: 70 },
  maxStepsPerMinute: 250,
  maxSelfReportedPerDay: 6,
};

/**
 * Flags activities for review. Flags never delete anything or accuse anyone:
 * a flagged activity lands in the correction queue and its XP is held.
 */
export function assessActivities(
  activities: readonly DerivedActivity[],
  policy: AnomalyPolicy = DEFAULT_ANOMALY_POLICY,
): DerivedActivity[] {
  const live = activities.filter((activity) => activity.userConfirmation !== 'discarded');
  const flags = new Map<string, Set<AnomalyFlag>>();
  const add = (id: string, flag: AnomalyFlag) => flags.set(id, (flags.get(id) ?? new Set()).add(flag));

  for (const activity of live) {
    const hours = durationMs(activity.interval) / HOUR;
    const maxSpeed = policy.maxSpeedKmh[activity.canonicalType];
    const distance = activity.metrics.distanceM;
    if (maxSpeed !== undefined && distance !== undefined && hours > 0 && distance / 1000 / hours > maxSpeed) {
      add(activity.id, 'implausible_pace');
    }
    const steps = activity.metrics.steps;
    const minutes = durationMs(activity.interval) / MINUTE;
    if (steps !== undefined && minutes > 0 && steps / minutes > policy.maxStepsPerMinute) {
      add(activity.id, 'implausible_steps');
    }
  }

  // A physical activity and an active desktop session cannot both fill the same time.
  const physical = live.filter((activity) => PHYSICAL_TYPES.has(activity.canonicalType));
  const digital = live.filter((activity) => DIGITAL_TYPES.has(activity.canonicalType));
  for (const body of physical) {
    for (const screen of digital) {
      const shorter = Math.min(durationMs(body.interval), durationMs(screen.interval));
      if (overlapMs(body.interval, screen.interval) * 2 < shorter) continue;
      const diff = evidenceRank(body.evidenceLevel) - evidenceRank(screen.evidenceLevel);
      if (diff <= 0) add(body.id, 'conflicting_overlap');
      if (diff >= 0) add(screen.id, 'conflicting_overlap');
    }
  }

  const selfReportedByDay = new Map<string, DerivedActivity[]>();
  for (const activity of live) {
    if (activity.evidenceLevel !== 'self_reported') continue;
    const key = `${activity.userId}|${localDateKey(activity.interval.start, activity.timeZone)}`;
    selfReportedByDay.set(key, [...(selfReportedByDay.get(key) ?? []), activity]);
  }
  for (const day of selfReportedByDay.values()) {
    day
      .sort((a, b) => a.interval.start - b.interval.start)
      .slice(policy.maxSelfReportedPerDay)
      .forEach((activity) => add(activity.id, 'manual_rate_limit'));
  }

  return activities.map((activity) => {
    const found = flags.get(activity.id);
    if (!found) return activity;
    return {
      ...activity,
      verificationStatus: activity.verificationStatus === 'rejected' ? 'rejected' : 'flagged',
      flags: [...new Set([...activity.flags, ...found])].sort(),
    };
  });
}
