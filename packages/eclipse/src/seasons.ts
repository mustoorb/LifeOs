import { DAY, HOUR, durationMs, type Instant, type Interval } from '@lifeos/contracts';
import type { LeaderboardConfig, RankedEntry } from './leaderboard.js';

/** A 6–12 week, access-code cohort season (blueprint §14). */
export interface Season {
  readonly id: string;
  readonly name: string;
  readonly window: Interval;
  readonly xpRulesetVersion: string;
  readonly questIds: readonly string[];
  readonly leaderboard: LeaderboardConfig;
  /** Access-code campaigns whose members may enroll. */
  readonly campaigns: readonly string[];
}

export const MIN_SEASON_MS = 6 * 7 * DAY;
export const MAX_SEASON_MS = 12 * 7 * DAY + HOUR;

export function validateSeason(season: Season): string[] {
  const errors: string[] = [];
  const length = durationMs(season.window);
  if (length < MIN_SEASON_MS - HOUR || length > MAX_SEASON_MS) errors.push('Seasons run 6–12 weeks');
  if (!season.xpRulesetVersion) errors.push('Season must pin an XP ruleset version');
  if (season.campaigns.length === 0) errors.push('Season must name at least one access campaign');
  return errors;
}

export type SeasonStatus = 'upcoming' | 'active' | 'ended';

export function seasonStatus(season: Season, now: Instant): SeasonStatus {
  if (now < season.window.start) return 'upcoming';
  return now < season.window.end ? 'active' : 'ended';
}

export interface SeasonEnrollment {
  readonly userId: string;
  readonly seasonId: string;
  readonly enrolledAt: Instant;
  readonly campaign: string;
  /** Competitive ranking is opt-in every season. */
  readonly leaderboardOptIn: boolean;
  readonly bracket: string;
}

export type EnrollmentResult =
  | { readonly ok: true; readonly enrollment: SeasonEnrollment }
  | { readonly ok: false; readonly reason: 'season_ended' | 'campaign_not_eligible' | 'already_enrolled' };

export function enrollInSeason(
  season: Season,
  existing: readonly SeasonEnrollment[],
  request: { userId: string; campaign: string; leaderboardOptIn: boolean; bracket: string; now: Instant },
): EnrollmentResult {
  if (seasonStatus(season, request.now) === 'ended') return { ok: false, reason: 'season_ended' };
  if (!season.campaigns.includes(request.campaign)) return { ok: false, reason: 'campaign_not_eligible' };
  if (existing.some((enrollment) => enrollment.seasonId === season.id && enrollment.userId === request.userId)) {
    return { ok: false, reason: 'already_enrolled' };
  }
  return {
    ok: true,
    enrollment: {
      userId: request.userId,
      seasonId: season.id,
      enrolledAt: request.now,
      campaign: request.campaign,
      leaderboardOptIn: request.leaderboardOptIn,
      bracket: request.bracket,
    },
  };
}

export interface SeasonArchive {
  readonly seasonId: string;
  readonly name: string;
  readonly window: Interval;
  readonly xpRulesetVersion: string;
  readonly archivedAt: Instant;
  readonly finalStandings: Readonly<Record<string, readonly RankedEntry[]>>;
  readonly participants: number;
}

/**
 * Freezes final standings at season end. Rollover resets only season score,
 * rank and challenge eligibility: levels, history, cosmetics and the friend
 * graph live outside the season and are untouched. Members carry forward
 * only by enrolling (opting in) to the next season.
 */
export function archiveSeason(
  season: Season,
  standings: ReadonlyMap<string, readonly RankedEntry[]>,
  enrollments: readonly SeasonEnrollment[],
  now: Instant,
): SeasonArchive {
  if (seasonStatus(season, now) !== 'ended') throw new Error(`Season ${season.id} has not ended`);
  return {
    seasonId: season.id,
    name: season.name,
    window: season.window,
    xpRulesetVersion: season.xpRulesetVersion,
    archivedAt: now,
    finalStandings: Object.fromEntries(standings),
    participants: enrollments.filter((enrollment) => enrollment.seasonId === season.id).length,
  };
}
