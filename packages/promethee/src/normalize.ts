import {
  HOUR,
  MINUTE,
  durationMs,
  isValidInterval,
  type ActivityContext,
  type ActivityEvent,
  type ActivityMetrics,
  type ActivityType,
  type Instant,
  type Interval,
  type MetricKey,
  type Visibility,
} from '@lifeos/contracts';
import { consentAt, hasConsent, type ConsentLedger } from './consent.js';
import { SENSITIVE_METRIC_SCOPES, type ConnectorDescriptor } from './connectors.js';

/** What a connector hands to ingestion, before validation. */
export interface SourceObservation {
  readonly sourceEventId: string;
  readonly type: ActivityType;
  readonly interval: Interval;
  readonly timeZone: string;
  readonly occurredAt?: Instant;
  readonly metrics?: ActivityMetrics;
  readonly context?: Partial<ActivityContext>;
  readonly visibility?: Visibility;
  readonly rawReference?: string;
}

export interface NormalizeInput {
  readonly userId: string;
  readonly observation: SourceObservation;
  readonly connector: ConnectorDescriptor;
  readonly consent: ConsentLedger;
  readonly receivedAt: Instant;
}

export type NormalizeRejection =
  | 'missing_consent'
  | 'unsupported_type'
  | 'invalid_interval'
  | 'future_interval'
  | 'duration_out_of_bounds'
  | 'invalid_time_zone';

export type NormalizeResult =
  | { readonly ok: true; readonly event: ActivityEvent; readonly droppedMetrics: readonly DroppedMetric[] }
  | { readonly ok: false; readonly reason: NormalizeRejection; readonly detail: string };

export interface DroppedMetric {
  readonly metric: MetricKey;
  readonly reason: 'not_declared_by_connector' | 'invalid_value' | 'missing_consent';
}

/** Realistic duration bounds per type (anti-cheat, blueprint §10). */
export const DURATION_BOUNDS: Record<ActivityType, { readonly min: number; readonly max: number }> = {
  digital_session: { min: MINUTE, max: 12 * HOUR },
  learning_session: { min: MINUTE, max: 12 * HOUR },
  creative_session: { min: MINUTE, max: 12 * HOUR },
  workout: { min: MINUTE, max: 6 * HOUR },
  walk: { min: MINUTE, max: 10 * HOUR },
  run: { min: MINUTE, max: 10 * HOUR },
  ride: { min: MINUTE, max: 16 * HOUR },
  outdoor_session: { min: MINUTE, max: 16 * HOUR },
  manual_log: { min: MINUTE, max: 6 * HOUR },
  other: { min: MINUTE, max: 12 * HOUR },
};

/** Tolerated device clock skew when rejecting intervals that end in the future. */
export const MAX_CLOCK_SKEW_MS = 5 * MINUTE;

export function eventIdFor(userId: string, connectorId: string, sourceEventId: string): string {
  // Deterministic, so re-ingesting the same source event is idempotent.
  return `evt:${userId}:${connectorId}:${sourceEventId}`;
}

export function normalizeObservation(input: NormalizeInput): NormalizeResult {
  const { userId, observation, connector, consent, receivedAt } = input;

  for (const scope of connector.requiredConsent) {
    if (!hasConsent(consent, scope, receivedAt)) {
      return reject('missing_consent', `No active "${scope}" consent for ${connector.id}`);
    }
  }
  if (!connector.emitsTypes.includes(observation.type)) {
    return reject('unsupported_type', `${connector.id} does not emit ${observation.type}`);
  }
  if (!isValidInterval(observation.interval)) {
    return reject('invalid_interval', 'Interval must be finite with end after start');
  }
  if (observation.interval.end > receivedAt + MAX_CLOCK_SKEW_MS) {
    return reject('future_interval', 'Interval ends in the future');
  }
  const bounds = DURATION_BOUNDS[observation.type];
  const duration = durationMs(observation.interval);
  if (duration < bounds.min || duration > bounds.max) {
    return reject('duration_out_of_bounds', `${observation.type} lasting ${duration}ms is outside bounds`);
  }
  if (!isValidTimeZone(observation.timeZone)) {
    return reject('invalid_time_zone', `Unknown time zone "${observation.timeZone}"`);
  }

  const { metrics, dropped } = filterMetrics(observation.metrics ?? {}, connector, consent, receivedAt, duration);
  const sensitive = Object.keys(metrics).some((key) => key in SENSITIVE_METRIC_SCOPES);
  const consentVersion =
    connector.requiredConsent
      .map((scope) => `${scope}@${consentAt(consent, scope, receivedAt)?.policyVersion}`)
      .join(',') || 'none';

  const event: ActivityEvent = {
    id: eventIdFor(userId, connector.id, observation.sourceEventId),
    userId,
    sourceId: connector.id,
    sourceEventId: observation.sourceEventId,
    occurredAt: observation.occurredAt ?? observation.interval.end,
    receivedAt,
    type: observation.type,
    interval: { start: observation.interval.start, end: observation.interval.end },
    timeZone: observation.timeZone,
    metrics,
    context: normalizeContext(observation.context, connector, hasConsent(consent, 'calendar', receivedAt)),
    provenance: {
      sourceKind: connector.sourceKind,
      connector: connector.id,
      importMethod: connector.importMethod,
      ...(connector.deviceClass ? { deviceClass: connector.deviceClass } : {}),
    },
    // Private by default (blueprint §16.4).
    visibility: observation.visibility ?? 'private',
    evidenceLevel: connector.baselineEvidence,
    confidence: connector.baselineConfidence,
    ...(observation.rawReference ? { rawReference: observation.rawReference } : {}),
    consentVersion,
    retentionPolicy: sensitive ? 'sensitive' : 'standard',
  };
  return { ok: true, event, droppedMetrics: dropped };
}

function reject(reason: NormalizeRejection, detail: string): NormalizeResult {
  return { ok: false, reason, detail };
}

function filterMetrics(
  input: ActivityMetrics,
  connector: ConnectorDescriptor,
  consent: ConsentLedger,
  at: Instant,
  durationMsValue: number,
): { metrics: ActivityMetrics; dropped: DroppedMetric[] } {
  const kept: Record<string, unknown> = {};
  const dropped: DroppedMetric[] = [];

  for (const key of Object.keys(input) as MetricKey[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!connector.providesMetrics.includes(key)) {
      dropped.push({ metric: key, reason: 'not_declared_by_connector' });
      continue;
    }
    const scope = SENSITIVE_METRIC_SCOPES[key];
    if (scope && !hasConsent(consent, scope, at)) {
      dropped.push({ metric: key, reason: 'missing_consent' });
      continue;
    }
    if (key === 'heartRateSummary') {
      const hr = value as NonNullable<ActivityMetrics['heartRateSummary']>;
      const summary: Record<string, number> = {};
      if (isPlausibleBpm(hr.avgBpm)) summary.avgBpm = hr.avgBpm;
      if (isPlausibleBpm(hr.maxBpm)) summary.maxBpm = hr.maxBpm;
      if (Object.keys(summary).length === 0) {
        dropped.push({ metric: key, reason: 'invalid_value' });
      } else {
        kept[key] = summary;
      }
      continue;
    }
    const numeric = value as number;
    const invalid =
      !Number.isFinite(numeric) ||
      numeric < 0 ||
      (key === 'activeSeconds' && numeric * 1000 > durationMsValue);
    if (invalid) {
      dropped.push({ metric: key, reason: 'invalid_value' });
      continue;
    }
    kept[key] = numeric;
  }
  return { metrics: kept as ActivityMetrics, dropped };
}

function isPlausibleBpm(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 25 && value <= 250;
}

function normalizeContext(
  context: Partial<ActivityContext> | undefined,
  connector: ConnectorDescriptor,
  calendarAllowed: boolean,
): ActivityContext {
  const tags = [...new Set((context?.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return {
    // Only the desktop companion may describe an app category.
    ...(context?.appCategory && connector.sourceKind === 'desktop_companion'
      ? { appCategory: context.appCategory }
      : {}),
    ...(context?.taskId ? { taskId: context.taskId } : {}),
    ...(context?.projectId ? { projectId: context.projectId } : {}),
    ...(context?.calendarCategory && calendarAllowed ? { calendarCategory: context.calendarCategory } : {}),
    tags,
  };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
