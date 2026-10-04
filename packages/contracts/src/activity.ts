import type { Confidence, EvidenceLevel, UserConfirmation, VerificationStatus } from './evidence.js';
import type { Instant, Interval } from './time.js';

export const ACTIVITY_TYPES = [
  'digital_session',
  'workout',
  'walk',
  'run',
  'ride',
  'outdoor_session',
  'learning_session',
  'creative_session',
  'manual_log',
  'other',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const PHYSICAL_TYPES: ReadonlySet<ActivityType> = new Set([
  'workout',
  'walk',
  'run',
  'ride',
  'outdoor_session',
]);

export const DIGITAL_TYPES: ReadonlySet<ActivityType> = new Set([
  'digital_session',
  'learning_session',
  'creative_session',
]);

/**
 * Capability-based metrics. Every field is optional and absence means
 * "not provided by this source" — it must never be read as zero.
 *
 * Deliberately absent: keystrokes, window titles, screen/clipboard content,
 * routes. See blueprint §16.2.
 */
export interface ActivityMetrics {
  readonly activeSeconds?: number;
  readonly distanceM?: number;
  readonly steps?: number;
  readonly elevationM?: number;
  readonly activeCalories?: number;
  readonly heartRateSummary?: {
    readonly avgBpm?: number;
    readonly maxBpm?: number;
  };
}

export type MetricKey = keyof ActivityMetrics;

export interface ActivityContext {
  /** User-mapped category of a desktop app, never the window title. */
  readonly appCategory?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  /** Calendar label is context, not proof (blueprint §10). */
  readonly calendarCategory?: string;
  readonly tags: readonly string[];
}

export type SourceKind = 'desktop_companion' | 'mobile_companion' | 'vendor_connector' | 'manual';

export type ImportMethod = 'local_observation' | 'oauth_sync' | 'device_sync' | 'user_entry';

export type DeviceClass = 'desktop' | 'phone' | 'watch' | 'ring' | 'bike_computer' | 'other';

export interface Provenance {
  readonly sourceKind: SourceKind;
  /** Connector id, e.g. `desktop-companion` or `manual-log`. */
  readonly connector: string;
  readonly importMethod: ImportMethod;
  readonly deviceClass?: DeviceClass;
}

/** Ordered from most to least restrictive. */
export const VISIBILITIES = ['private', 'friends', 'guild', 'public_summary'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export function mostRestrictiveVisibility(values: readonly Visibility[]): Visibility {
  let best: Visibility = 'public_summary';
  for (const value of values) {
    if (VISIBILITIES.indexOf(value) < VISIBILITIES.indexOf(best)) best = value;
  }
  return values.length === 0 ? 'private' : best;
}

export type RetentionPolicy = 'standard' | 'sensitive';

/** An immutable, normalized source event (blueprint §9). Never overwritten. */
export interface ActivityEvent {
  readonly id: string;
  readonly userId: string;
  readonly sourceId: string;
  readonly sourceEventId: string;
  readonly occurredAt: Instant;
  readonly receivedAt: Instant;
  readonly type: ActivityType;
  readonly interval: Interval;
  readonly timeZone: string;
  readonly metrics: ActivityMetrics;
  readonly context: ActivityContext;
  readonly provenance: Provenance;
  readonly visibility: Visibility;
  readonly evidenceLevel: EvidenceLevel;
  readonly confidence: Confidence;
  /** Pointer into the restricted raw-event vault, if anything was kept. */
  readonly rawReference?: string;
  readonly consentVersion: string;
  readonly retentionPolicy: RetentionPolicy;
}

/**
 * A qualified activity: one or more source events merged into a single claim.
 * This is the only shape ECLIPSE consumes from PROMETHEE.
 */
export interface DerivedActivity {
  readonly id: string;
  readonly userId: string;
  readonly eventIds: readonly string[];
  readonly duplicateGroupId: string;
  readonly canonicalType: ActivityType;
  readonly interval: Interval;
  readonly timeZone: string;
  readonly metrics: ActivityMetrics;
  readonly context: ActivityContext;
  readonly evidenceLevel: EvidenceLevel;
  readonly confidence: Confidence;
  readonly verificationStatus: VerificationStatus;
  readonly userConfirmation: UserConfirmation;
  readonly visibility: Visibility;
  /** Machine-readable reasons when `verificationStatus` is `flagged`. */
  readonly flags: readonly string[];
}
