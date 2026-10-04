import { FRIEND_LEADERBOARD, validateSeason, type LeaderboardConfig, type Season, type SeasonEnrollment } from '@lifeos/eclipse';
import type { Queryable } from './db.js';
import { AppError } from './support.js';

interface SeasonRow {
  id: string;
  name: string;
  starts_at: Date;
  ends_at: Date;
  xp_ruleset_version: string;
  quest_ids: string[];
  campaigns: string[];
  leaderboard: LeaderboardConfig;
}

const COLUMNS = 'id, name, starts_at, ends_at, xp_ruleset_version, quest_ids, campaigns, leaderboard';

function toSeason(row: SeasonRow): Season {
  return {
    id: row.id,
    name: row.name,
    window: { start: row.starts_at.getTime(), end: row.ends_at.getTime() },
    xpRulesetVersion: row.xp_ruleset_version,
    questIds: row.quest_ids,
    campaigns: row.campaigns,
    leaderboard: row.leaderboard,
  };
}

export async function insertSeason(
  db: Queryable,
  input: Omit<Season, 'leaderboard' | 'questIds'> & { leaderboard?: LeaderboardConfig },
): Promise<Season> {
  const season: Season = { ...input, questIds: [], leaderboard: input.leaderboard ?? FRIEND_LEADERBOARD };
  const errors = validateSeason(season);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(season.id)) errors.push('Season id must be lowercase letters, digits and dashes');
  if (errors.length) throw new AppError(422, 'invalid_season', errors.join('; '));
  const result = await db.query(
    `INSERT INTO seasons (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
    [
      season.id,
      season.name,
      new Date(season.window.start),
      new Date(season.window.end),
      season.xpRulesetVersion,
      season.questIds,
      season.campaigns,
      JSON.stringify(season.leaderboard),
    ],
  );
  if (result.rowCount === 0) throw new AppError(409, 'season_exists', `Season ${season.id} already exists`);
  return season;
}

export async function listSeasons(db: Queryable): Promise<Season[]> {
  const { rows } = await db.query<SeasonRow>(`SELECT ${COLUMNS} FROM seasons ORDER BY starts_at DESC`);
  return rows.map(toSeason);
}

/** The current or next season a campaign's members join. */
export async function seasonForCampaign(db: Queryable, campaign: string, now: number): Promise<Season | null> {
  const { rows } = await db.query<SeasonRow>(
    `SELECT ${COLUMNS} FROM seasons WHERE $1 = ANY(campaigns) AND ends_at > $2 ORDER BY starts_at LIMIT 1`,
    [campaign, new Date(now)],
  );
  return rows[0] ? toSeason(rows[0]) : null;
}

export async function insertEnrollment(db: Queryable, enrollment: SeasonEnrollment): Promise<void> {
  await db.query(
    `INSERT INTO season_enrollments (account_id, season_id, enrolled_at, campaign, leaderboard_opt_in, bracket)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      enrollment.userId,
      enrollment.seasonId,
      new Date(enrollment.enrolledAt),
      enrollment.campaign,
      enrollment.leaderboardOptIn,
      enrollment.bracket,
    ],
  );
}

export interface EnrollmentView {
  readonly seasonId: string;
  readonly seasonName: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly enrolledAt: number;
  readonly leaderboardOptIn: boolean;
  readonly bracket: string;
}

export async function listEnrollments(db: Queryable, accountId: string): Promise<EnrollmentView[]> {
  const { rows } = await db.query<{
    season_id: string;
    name: string;
    starts_at: Date;
    ends_at: Date;
    enrolled_at: Date;
    leaderboard_opt_in: boolean;
    bracket: string;
  }>(
    `SELECT e.season_id, s.name, s.starts_at, s.ends_at, e.enrolled_at, e.leaderboard_opt_in, e.bracket
     FROM season_enrollments e JOIN seasons s ON s.id = e.season_id
     WHERE e.account_id = $1 ORDER BY s.starts_at DESC`,
    [accountId],
  );
  return rows.map((row) => ({
    seasonId: row.season_id,
    seasonName: row.name,
    startsAt: row.starts_at.getTime(),
    endsAt: row.ends_at.getTime(),
    enrolledAt: row.enrolled_at.getTime(),
    leaderboardOptIn: row.leaderboard_opt_in,
    bracket: row.bracket,
  }));
}
