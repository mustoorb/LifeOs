import {
  DIGITAL_TYPES,
  PHYSICAL_TYPES,
  clampConfidence,
  durationMs,
  evidenceRank,
  maxEvidence,
  meetsEvidence,
  mostRestrictiveVisibility,
  overlapMs,
  type ActivityEvent,
  type ActivityMetrics,
  type ActivityType,
  type DerivedActivity,
  type EvidenceLevel,
  type MetricKey,
} from '@lifeos/contracts';

/** Two events are duplicates when they overlap this share of the shorter one. */
export const DUPLICATE_OVERLAP_RATIO = 0.5;

const GENERIC_TYPES: ReadonlySet<ActivityType> = new Set(['manual_log', 'other']);

export function typesCompatible(a: ActivityType, b: ActivityType): boolean {
  if (a === b || GENERIC_TYPES.has(a) || GENERIC_TYPES.has(b)) return true;
  return (PHYSICAL_TYPES.has(a) && PHYSICAL_TYPES.has(b)) || (DIGITAL_TYPES.has(a) && DIGITAL_TYPES.has(b));
}

export function isDuplicatePair(a: ActivityEvent, b: ActivityEvent): boolean {
  if (a.userId !== b.userId || !typesCompatible(a.type, b.type)) return false;
  const shorter = Math.min(durationMs(a.interval), durationMs(b.interval));
  return shorter > 0 && overlapMs(a.interval, b.interval) >= shorter * DUPLICATE_OVERLAP_RATIO;
}

/**
 * Groups duplicate source events and merges each group into one
 * DerivedActivity. Source events are never mutated: the derived activity keeps
 * references to every event it was built from.
 */
export function deduplicate(events: readonly ActivityEvent[]): DerivedActivity[] {
  const unique = [...new Map(events.map((event) => [event.id, event])).values()];
  const sorted = unique.sort((a, b) => a.interval.start - b.interval.start || a.id.localeCompare(b.id));

  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };

  // Sweep: only events whose start precedes the current end can overlap.
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j]!.interval.start < sorted[i]!.interval.end; j++) {
      if (isDuplicatePair(sorted[i]!, sorted[j]!)) parent[find(j)] = find(i);
    }
  }

  const groups = new Map<number, ActivityEvent[]>();
  sorted.forEach((event, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), event]);
  });
  return [...groups.values()].map(mergeGroup);
}

function rankEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort(
    (a, b) =>
      evidenceRank(b.evidenceLevel) - evidenceRank(a.evidenceLevel) ||
      b.confidence - a.confidence ||
      durationMs(b.interval) - durationMs(a.interval) ||
      a.id.localeCompare(b.id),
  );
}

export function mergeGroup(group: readonly ActivityEvent[]): DerivedActivity {
  const ranked = rankEvents(group);
  const primary = ranked[0];
  if (!primary) throw new Error('Cannot merge an empty duplicate group');

  const specific = ranked.find((event) => !GENERIC_TYPES.has(event.type));
  const canonicalType = (specific ?? primary).type;

  // Per metric, take the value from the most trusted event that provides it.
  const metrics: Record<string, unknown> = {};
  for (const event of [...ranked].reverse()) {
    for (const key of Object.keys(event.metrics) as MetricKey[]) {
      if (event.metrics[key] !== undefined) metrics[key] = event.metrics[key];
    }
  }

  const eventIds = group.map((event) => event.id).sort();
  return {
    id: `act:${primary.id}`,
    userId: primary.userId,
    eventIds,
    duplicateGroupId: `dup:${eventIds[0]}`,
    canonicalType,
    interval: primary.interval,
    timeZone: primary.timeZone,
    metrics: metrics as ActivityMetrics,
    context: {
      ...pickFirst(ranked, 'appCategory'),
      ...pickFirst(ranked, 'taskId'),
      ...pickFirst(ranked, 'projectId'),
      ...pickFirst(ranked, 'calendarCategory'),
      tags: [...new Set(ranked.flatMap((event) => event.context.tags))],
    },
    evidenceLevel: groupEvidence(group),
    confidence: groupConfidence(group),
    verificationStatus: 'unverified',
    userConfirmation: 'pending',
    // Merging must never widen what anyone can see.
    visibility: mostRestrictiveVisibility(group.map((event) => event.visibility)),
    flags: [],
  };
}

/**
 * Corroboration (tier 3) is earned, not asserted: it requires at least two
 * independent non-manual sources that each reached `observed` or better.
 */
export function groupEvidence(group: readonly ActivityEvent[]): EvidenceLevel {
  const best = maxEvidence(group.map((event) => event.evidenceLevel));
  const independent = new Set(
    group
      .filter((event) => event.provenance.sourceKind !== 'manual' && meetsEvidence(event.evidenceLevel, 'observed'))
      .map((event) => event.provenance.connector),
  );
  if (independent.size >= 2 && evidenceRank(best) < evidenceRank('corroborated')) return 'corroborated';
  return best;
}

/** Noisy-OR over the best confidence per independent source, capped below 1. */
export function groupConfidence(group: readonly ActivityEvent[]): number {
  const bestPerSource = new Map<string, number>();
  for (const event of group) {
    const key = event.provenance.connector;
    bestPerSource.set(key, Math.max(bestPerSource.get(key) ?? 0, event.confidence));
  }
  let miss = 1;
  for (const confidence of bestPerSource.values()) miss *= 1 - clampConfidence(confidence);
  return Math.min(0.99, clampConfidence(1 - miss));
}

function pickFirst<K extends 'appCategory' | 'taskId' | 'projectId' | 'calendarCategory'>(
  ranked: readonly ActivityEvent[],
  key: K,
): Partial<Record<K, string>> {
  const value = ranked.find((event) => event.context[key])?.context[key];
  return value ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}
