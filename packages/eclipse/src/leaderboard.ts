import {
  DAY,
  clipInterval,
  meetsEvidence,
  type DerivedActivity,
  type EvidenceLevel,
  type Interval,
} from '@lifeos/contracts';
import type { GameAward } from './xp.js';

export type LeaderboardScope = 'friends' | 'guild' | 'country' | 'global';

/**
 * Competitive rank is separate from personal record (blueprint §13): it uses
 * a bounded seasonal score, never lifetime XP, raw hours or steps.
 */
export interface LeaderboardConfig {
  readonly scope: LeaderboardScope;
  readonly minEvidence: EvidenceLevel;
  readonly pointsPerQuest: number;
  /** Per distinct activity type, up to `maxDistinctTypes`. */
  readonly pointsPerType: number;
  readonly maxDistinctTypes: number;
  /** Per season week with at least one eligible activity. */
  readonly pointsPerActiveWeek: number;
  readonly maxScore: number;
}

export const FRIEND_LEADERBOARD: LeaderboardConfig = {
  scope: 'friends',
  minEvidence: 'observed',
  pointsPerQuest: 10,
  pointsPerType: 5,
  maxDistinctTypes: 5,
  pointsPerActiveWeek: 10,
  maxScore: 500,
};

export interface SeasonScore {
  readonly score: number;
  readonly completedQuests: number;
  readonly distinctTypes: number;
  readonly activeWeeks: number;
}

export function computeSeasonScore(
  seasonId: string,
  seasonWindow: Interval,
  config: LeaderboardConfig,
  awards: readonly GameAward[],
  activities: readonly DerivedActivity[],
): SeasonScore {
  // Provisional (self-reported) completions never count competitively.
  const completedQuests = new Set(
    awards
      .filter(
        (award) => award.awardType === 'quest_completion' && award.seasonId === seasonId && award.status === 'awarded',
      )
      .map((award) => award.questId),
  ).size;

  const eligible = activities.filter(
    (activity) =>
      activity.userConfirmation !== 'discarded' &&
      activity.verificationStatus !== 'flagged' &&
      activity.verificationStatus !== 'rejected' &&
      meetsEvidence(activity.evidenceLevel, config.minEvidence) &&
      clipInterval(activity.interval, seasonWindow) !== null,
  );
  const distinctTypes = Math.min(
    config.maxDistinctTypes,
    new Set(eligible.map((activity) => activity.canonicalType)).size,
  );
  const activeWeeks = new Set(
    eligible.map((activity) =>
      Math.floor((Math.max(activity.interval.start, seasonWindow.start) - seasonWindow.start) / (7 * DAY)),
    ),
  ).size;

  const raw =
    completedQuests * config.pointsPerQuest +
    distinctTypes * config.pointsPerType +
    activeWeeks * config.pointsPerActiveWeek;
  return { score: Math.min(config.maxScore, raw), completedQuests, distinctTypes, activeWeeks };
}

export interface LeaderboardEntry {
  readonly userId: string;
  /** Declared tier or play style; never an inferred sensitive characteristic. */
  readonly bracket: string;
  readonly score: number;
  readonly optedIn: boolean;
  /** False while disqualified or under review. */
  readonly eligible: boolean;
}

export interface RankedEntry {
  readonly userId: string;
  readonly score: number;
  readonly rank: number;
}

/**
 * Ranks opted-in, eligible accounts within each bracket. Ties share a rank
 * (standard competition ranking: 1, 2, 2, 4); display order within a tie is
 * by user id so it is stable and not gameable.
 */
export function rankLeaderboard(entries: readonly LeaderboardEntry[]): Map<string, RankedEntry[]> {
  const brackets = new Map<string, LeaderboardEntry[]>();
  for (const entry of entries) {
    if (!entry.optedIn || !entry.eligible) continue;
    brackets.set(entry.bracket, [...(brackets.get(entry.bracket) ?? []), entry]);
  }
  const ranked = new Map<string, RankedEntry[]>();
  for (const [bracket, members] of brackets) {
    const sorted = [...members].sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
    let rank = 0;
    ranked.set(
      bracket,
      sorted.map((entry, i) => {
        if (i === 0 || entry.score !== sorted[i - 1]!.score) rank = i + 1;
        return { userId: entry.userId, score: entry.score, rank };
      }),
    );
  }
  return ranked;
}
