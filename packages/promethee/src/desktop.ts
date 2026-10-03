import {
  MINUTE,
  SECOND,
  durationMs,
  overlapMs,
  type ActivityType,
  type Instant,
  type Interval,
} from '@lifeos/contracts';
import type { SourceObservation } from './normalize.js';

/**
 * One local foreground sample from the desktop companion. The shape is the
 * privacy boundary: app identity and idle state only — no window titles,
 * keystrokes, screenshots, clipboard or URLs (blueprint §16.2, §18.2).
 */
export interface ForegroundSample {
  readonly at: Instant;
  readonly appId: string;
  readonly idle: boolean;
}

export interface DesktopTrackingSettings {
  /** Expected sampling cadence; a sample covers at most this long. */
  readonly sampleIntervalMs: number;
  /** User-controlled mapping. Apps without a mapping are not tracked. */
  readonly categoryByApp: Readonly<Record<string, string>>;
  /** Per-app exclusions; these win over any category mapping. */
  readonly deniedApps: readonly string[];
  /** Category → canonical type. Unlisted categories become `digital_session`. */
  readonly typeByCategory: Readonly<Partial<Record<string, ActivityType>>>;
  /** Periods where the user pressed pause. */
  readonly pauses: readonly Interval[];
  /** Gaps up to this long inside one category are merged into one session. */
  readonly mergeGapMs: number;
  readonly minSessionMs: number;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopTrackingSettings = {
  sampleIntervalMs: 5 * SECOND,
  categoryByApp: {},
  deniedApps: [],
  typeByCategory: {},
  pauses: [],
  mergeGapMs: 3 * MINUTE,
  minSessionMs: 5 * MINUTE,
};

export interface DesktopSession {
  readonly interval: Interval;
  readonly appCategory: string;
  readonly type: ActivityType;
  readonly activeSeconds: number;
  readonly taskId?: string;
  readonly focus: boolean;
}

/** An explicit focus block the user started and stopped (blueprint §18.3). */
export interface FocusBlock {
  readonly interval: Interval;
  readonly taskId?: string;
}

/**
 * Runs locally on the device: turns raw samples into category sessions so
 * only derived intervals ever need to leave the machine.
 */
export function aggregateDesktopSamples(
  samples: readonly ForegroundSample[],
  settings: DesktopTrackingSettings = DEFAULT_DESKTOP_SETTINGS,
): DesktopSession[] {
  const denied = new Set(settings.deniedApps);
  const sorted = [...samples].sort((a, b) => a.at - b.at);

  const pieces: { interval: Interval; category: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const sample = sorted[i]!;
    if (sample.idle || denied.has(sample.appId)) continue;
    const category = settings.categoryByApp[sample.appId];
    if (!category) continue;
    const next = sorted[i + 1];
    const end = Math.min(sample.at + settings.sampleIntervalMs, next ? next.at : Infinity);
    if (end <= sample.at) continue;
    for (const interval of subtractIntervals({ start: sample.at, end }, settings.pauses)) {
      pieces.push({ interval, category });
    }
  }

  const sessions: { interval: { start: number; end: number }; category: string; activeMs: number }[] = [];
  for (const piece of pieces) {
    const current = sessions[sessions.length - 1];
    if (
      current &&
      current.category === piece.category &&
      piece.interval.start - current.interval.end <= settings.mergeGapMs
    ) {
      current.interval.end = piece.interval.end;
      current.activeMs += durationMs(piece.interval);
    } else {
      sessions.push({
        interval: { ...piece.interval },
        category: piece.category,
        activeMs: durationMs(piece.interval),
      });
    }
  }

  return sessions
    .filter((session) => session.activeMs >= settings.minSessionMs)
    .map((session) => ({
      interval: session.interval,
      appCategory: session.category,
      type: settings.typeByCategory[session.category] ?? 'digital_session',
      activeSeconds: Math.round(session.activeMs / SECOND),
      focus: false,
    }));
}

/**
 * Associates sessions with the user's explicit focus blocks. Automatic
 * classification stays a suggestion; the block only adds intent.
 */
export function applyFocusBlocks(
  sessions: readonly DesktopSession[],
  blocks: readonly FocusBlock[],
): DesktopSession[] {
  return sessions.map((session) => {
    const block = blocks.find(
      (candidate) => overlapMs(candidate.interval, session.interval) * 2 >= durationMs(session.interval),
    );
    if (!block) return session;
    return { ...session, focus: true, ...(block.taskId ? { taskId: block.taskId } : {}) };
  });
}

/** "Delete last hour/day": drops local samples inside `range`. */
export function forgetSamples(samples: readonly ForegroundSample[], range: Interval): ForegroundSample[] {
  return samples.filter((sample) => sample.at < range.start || sample.at >= range.end);
}

export function desktopSessionToObservation(session: DesktopSession, timeZone: string): SourceObservation {
  return {
    sourceEventId: `desktop:${session.appCategory}:${session.interval.start}`,
    type: session.type,
    interval: session.interval,
    timeZone,
    metrics: { activeSeconds: session.activeSeconds },
    context: {
      appCategory: session.appCategory,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      tags: session.focus ? ['focus'] : [],
    },
  };
}

function subtractIntervals(base: Interval, holes: readonly Interval[]): Interval[] {
  let remaining: Interval[] = [base];
  for (const hole of holes) {
    const next: Interval[] = [];
    for (const part of remaining) {
      if (overlapMs(part, hole) === 0) {
        next.push(part);
        continue;
      }
      if (hole.start > part.start) next.push({ start: part.start, end: hole.start });
      if (hole.end < part.end) next.push({ start: hole.end, end: part.end });
    }
    remaining = next;
  }
  return remaining;
}
