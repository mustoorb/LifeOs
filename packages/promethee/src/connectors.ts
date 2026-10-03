import type {
  ActivityType,
  Confidence,
  DeviceClass,
  EvidenceLevel,
  ImportMethod,
  MetricKey,
  SourceKind,
} from '@lifeos/contracts';
import type { ConsentScope } from './consent.js';

/**
 * Declarative connector capabilities (blueprint §17). A new source is added by
 * describing what it can provide, never by special-casing it elsewhere.
 * Vendor connectors are added here only once their validation gate clears.
 */
export interface ConnectorDescriptor {
  readonly id: string;
  readonly sourceKind: SourceKind;
  readonly importMethod: ImportMethod;
  readonly deviceClass?: DeviceClass;
  readonly baselineEvidence: EvidenceLevel;
  readonly baselineConfidence: Confidence;
  readonly emitsTypes: readonly ActivityType[];
  readonly providesMetrics: readonly MetricKey[];
  readonly requiredConsent: readonly ConsentScope[];
}

/** Metrics that may only be kept when the user has granted the matching scope. */
export const SENSITIVE_METRIC_SCOPES: Partial<Record<MetricKey, ConsentScope>> = {
  heartRateSummary: 'health_workouts',
  activeCalories: 'health_workouts',
};

export const DESKTOP_COMPANION: ConnectorDescriptor = {
  id: 'desktop-companion',
  sourceKind: 'desktop_companion',
  importMethod: 'local_observation',
  deviceClass: 'desktop',
  baselineEvidence: 'observed',
  baselineConfidence: 0.7,
  emitsTypes: ['digital_session', 'learning_session', 'creative_session'],
  providesMetrics: ['activeSeconds'],
  requiredConsent: ['desktop_activity'],
};

/** Manual logging, including manual workouts until a fitness source is validated. */
export const MANUAL_LOG: ConnectorDescriptor = {
  id: 'manual-log',
  sourceKind: 'manual',
  importMethod: 'user_entry',
  baselineEvidence: 'self_reported',
  baselineConfidence: 0.5,
  emitsTypes: [
    'workout',
    'walk',
    'run',
    'ride',
    'outdoor_session',
    'learning_session',
    'creative_session',
    'digital_session',
    'manual_log',
    'other',
  ],
  providesMetrics: ['distanceM', 'steps', 'elevationM'],
  requiredConsent: [],
};

export function defineConnector(descriptor: ConnectorDescriptor): ConnectorDescriptor {
  if (!descriptor.id.trim()) throw new Error('Connector id is required');
  if (descriptor.emitsTypes.length === 0) {
    throw new Error(`Connector ${descriptor.id} must emit at least one activity type`);
  }
  if (descriptor.baselineConfidence < 0 || descriptor.baselineConfidence > 1) {
    throw new Error(`Connector ${descriptor.id} baselineConfidence must be within [0, 1]`);
  }
  if (descriptor.sourceKind === 'manual' && descriptor.baselineEvidence !== 'self_reported') {
    throw new Error(`Manual connector ${descriptor.id} cannot claim more than self_reported evidence`);
  }
  if (descriptor.baselineEvidence === 'corroborated' || descriptor.baselineEvidence === 'reviewed') {
    // Tiers 3 and 4 are earned by deduplication or human review, never asserted by a source.
    throw new Error(`Connector ${descriptor.id} cannot assert ${descriptor.baselineEvidence} evidence`);
  }
  return descriptor;
}
