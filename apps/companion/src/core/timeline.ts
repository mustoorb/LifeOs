import { MINUTE, SECOND, localDayWindow, type Instant, type Interval } from '@lifeos/contracts';
import {
  aggregateDesktopSamples,
  applyFocusBlocks,
  type DesktopSession,
  type FocusBlock,
  type ForegroundSample,
} from '@lifeos/promethee';
import type { TimelineView, UncategorizedApp } from '../shared/api.js';
import { suggestCategory } from './catalog.js';
import { toTrackingSettings, type CompanionSettings } from './settings.js';

/** A focus block as stored locally; `end` is absent while it is running. */
export interface StoredFocusBlock {
  readonly start: Instant;
  readonly end?: Instant;
}

export function closedFocusBlocks(blocks: readonly StoredFocusBlock[], now: Instant): FocusBlock[] {
  return blocks.map((block) => ({ interval: { start: block.start, end: block.end ?? now } }));
}

/** Category sessions for the given samples, with focus intent applied. */
export function buildSessions(
  samples: readonly ForegroundSample[],
  settings: CompanionSettings,
  focusBlocks: readonly StoredFocusBlock[],
  now: Instant,
): DesktopSession[] {
  return applyFocusBlocks(
    aggregateDesktopSamples(samples, toTrackingSettings(settings)),
    closedFocusBlocks(focusBlocks, now),
  );
}

export function buildTimeline(input: {
  dateKey: string;
  timeZone: string;
  samples: readonly ForegroundSample[];
  settings: CompanionSettings;
  focusBlocks: readonly StoredFocusBlock[];
  appNames: Readonly<Record<string, string>>;
  now: Instant;
}): TimelineView {
  const window = localDayWindow(input.dateKey, input.timeZone);
  const inDay = input.samples.filter((sample) => sample.at >= window.start && sample.at < window.end);
  const sessions = buildSessions(inDay, input.settings, input.focusBlocks, input.now);

  const totals = new Map<string, number>();
  for (const session of sessions) {
    totals.set(session.appCategory, (totals.get(session.appCategory) ?? 0) + session.activeSeconds);
  }

  return {
    dateKey: input.dateKey,
    window,
    sessions: sessions.map((session) => ({
      start: session.interval.start,
      end: session.interval.end,
      category: session.appCategory,
      activityType: session.type,
      activeMinutes: Math.round(session.activeSeconds / 60),
      focus: session.focus,
    })),
    totals: [...totals]
      .map(([category, seconds]) => ({ category, minutes: Math.round(seconds / 60) }))
      .sort((a, b) => b.minutes - a.minutes),
    uncategorized: uncategorizedApps(inDay, input.settings, input.appNames),
    focusBlocks: closedFocusBlocks(input.focusBlocks, input.now)
      .map((block) => clip(block.interval, window))
      .filter((block): block is Interval => block !== null),
  };
}

/** Time spent in apps the user has not categorized yet, so they can decide. */
function uncategorizedApps(
  samples: readonly ForegroundSample[],
  settings: CompanionSettings,
  appNames: Readonly<Record<string, string>>,
): UncategorizedApp[] {
  const unmapped = samples.filter(
    (sample) => !settings.categoryByApp[sample.appId] && !settings.deniedApps.includes(sample.appId),
  );
  const perApp = aggregateDesktopSamples(unmapped, {
    ...toTrackingSettings(settings),
    categoryByApp: Object.fromEntries(unmapped.map((sample) => [sample.appId, sample.appId])),
    typeByCategory: {},
    minSessionMs: 0,
  });
  const seconds = new Map<string, number>();
  for (const session of perApp) {
    seconds.set(session.appCategory, (seconds.get(session.appCategory) ?? 0) + session.activeSeconds);
  }
  return [...seconds]
    .filter(([, total]) => total * SECOND >= MINUTE)
    .map(([appId, total]) => ({
      appId,
      name: appNames[appId] ?? appId,
      minutes: Math.round(total / 60),
      suggestion: suggestCategory(appId) ?? null,
    }))
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
}

function clip(interval: Interval, window: Interval): Interval | null {
  const start = Math.max(interval.start, window.start);
  const end = Math.min(interval.end, window.end);
  return end > start ? { start, end } : null;
}
