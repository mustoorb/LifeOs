import { MINUTE, SECOND, type ActivityType } from '@lifeos/contracts';
import type { DesktopTrackingSettings } from '@lifeos/promethee';

/** Categories the user can assign apps to. Kept short on purpose. */
export const CATEGORIES = [
  'coding',
  'writing',
  'design',
  'video-editing',
  'audio-production',
  'learning',
  'research',
  'planning',
  'communication',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_TYPES: Readonly<Record<Category, ActivityType>> = {
  coding: 'digital_session',
  writing: 'creative_session',
  design: 'creative_session',
  'video-editing': 'creative_session',
  'audio-production': 'creative_session',
  learning: 'learning_session',
  research: 'learning_session',
  planning: 'digital_session',
  communication: 'digital_session',
};

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export interface CompanionSettings {
  readonly version: 1;
  /** User-controlled app → category mapping. Unmapped apps never produce sessions. */
  readonly categoryByApp: Readonly<Record<string, Category>>;
  /** Excluded apps are not recorded at all, not even locally. */
  readonly deniedApps: readonly string[];
  readonly sampleIntervalSec: number;
  /** No input for this long counts as idle, retroactively. */
  readonly idleThresholdSec: number;
  /** Raw samples older than this are deleted from the Mac. */
  readonly retentionDays: number;
  readonly mergeGapMin: number;
  readonly minSessionMin: number;
}

export const DEFAULT_SETTINGS: CompanionSettings = {
  version: 1,
  categoryByApp: {},
  deniedApps: [],
  sampleIntervalSec: 5,
  idleThresholdSec: 120,
  retentionDays: 30,
  mergeGapMin: 3,
  minSessionMin: 5,
};

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.\-_]{0,254}$/;

export function isBundleId(value: unknown): value is string {
  return typeof value === 'string' && BUNDLE_ID.test(value);
}

/** Tolerant parse of a settings file: bad fields fall back to defaults. */
export function parseSettings(raw: unknown): CompanionSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mapping: Record<string, Category> = {};
  if (input.categoryByApp && typeof input.categoryByApp === 'object') {
    for (const [app, category] of Object.entries(input.categoryByApp as Record<string, unknown>)) {
      if (isBundleId(app) && isCategory(category)) mapping[app] = category;
    }
  }
  const denied = Array.isArray(input.deniedApps) ? [...new Set(input.deniedApps.filter(isBundleId))] : [];
  for (const app of denied) delete mapping[app];

  return {
    version: 1,
    categoryByApp: mapping,
    deniedApps: denied,
    sampleIntervalSec: intIn(input.sampleIntervalSec, 1, 60, DEFAULT_SETTINGS.sampleIntervalSec),
    idleThresholdSec: intIn(input.idleThresholdSec, 30, 1800, DEFAULT_SETTINGS.idleThresholdSec),
    retentionDays: intIn(input.retentionDays, 1, 365, DEFAULT_SETTINGS.retentionDays),
    mergeGapMin: intIn(input.mergeGapMin, 0, 30, DEFAULT_SETTINGS.mergeGapMin),
    minSessionMin: intIn(input.minSessionMin, 1, 60, DEFAULT_SETTINGS.minSessionMin),
  };
}

export function toTrackingSettings(settings: CompanionSettings): DesktopTrackingSettings {
  return {
    sampleIntervalMs: settings.sampleIntervalSec * SECOND,
    categoryByApp: settings.categoryByApp,
    deniedApps: settings.deniedApps,
    typeByCategory: CATEGORY_TYPES,
    pauses: [],
    mergeGapMs: settings.mergeGapMin * MINUTE,
    minSessionMs: settings.minSessionMin * MINUTE,
  };
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
