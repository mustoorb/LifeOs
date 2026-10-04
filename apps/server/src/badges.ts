import { PHYSICAL_TYPES } from '@lifeos/contracts';
import { domainOf, type GameAward, type SkillId } from '@lifeos/eclipse';
import type { Queryable } from './db.js';
import type { BadgeView, ProgressView } from './home-types.js';

/**
 * Badges mark real milestones. They are derived from the XP ledger and the
 * member's own records on every request, so a correction or deletion that
 * removes the evidence also removes the badge. Nothing is stored.
 */

export interface BadgeFacts {
  /** Live activity awards: the latest award per activity, excluding reversed and held ones. */
  readonly activityAwards: readonly GameAward[];
  /** Completed quests, by template. */
  readonly questsCompleted: Readonly<Record<string, number>>;
  readonly prioritiesDone: number;
  readonly corrections: number;
  readonly foundingMember: boolean;
  readonly progress: ProgressView;
}

interface BadgeRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly target: number;
  readonly measure: (facts: BadgeFacts) => number;
}

const countTypes = (facts: BadgeFacts, types: ReadonlySet<string>) =>
  facts.activityAwards.filter((award) => award.basis && types.has(award.basis.activityType)).length;

export const BADGES: readonly BadgeRule[] = [
  { id: 'first-light', name: 'First Light', description: 'Earn your first XP.', target: 1, measure: (f) => f.activityAwards.length },
  { id: 'deep-focus', name: 'Deep Focus', description: 'Complete a daily focus quest.', target: 1, measure: (f) => f.questsCompleted['daily-focus'] ?? 0 },
  { id: 'in-motion', name: 'In Motion', description: 'Get moving 10 times: workouts, walks, runs or rides.', target: 10, measure: (f) => countTypes(f, PHYSICAL_TYPES) },
  { id: 'open-sky', name: 'Open Sky', description: 'Spend time outside 5 times.', target: 5, measure: (f) => countTypes(f, new Set(['walk', 'outdoor_session'])) },
  { id: 'mission-control', name: 'Mission Control', description: 'Complete 5 quests.', target: 5, measure: (f) => Object.values(f.questsCompleted).reduce((a, b) => a + b, 0) },
  { id: 'clear-intent', name: 'Clear Intent', description: 'Finish 10 of your daily priorities.', target: 10, measure: (f) => f.prioritiesDone },
  { id: 'true-north', name: 'True North', description: 'Review or correct an activity, keeping your record honest.', target: 1, measure: (f) => f.corrections },
  { id: 'long-haul', name: 'Long Haul', description: 'Put 10 hours of effort on the record.', target: 600, measure: (f) => Math.round(f.activityAwards.reduce((sum, a) => sum + (a.basis?.minutes ?? 0), 0)) },
  {
    id: 'full-orbit',
    name: 'Full Orbit',
    description: 'Earn XP in all four domains: mind, craft, body and world.',
    target: 4,
    measure: (f) => new Set(f.activityAwards.flatMap((a) => a.skillAllocations.map((s) => domainOf(s.skill as SkillId)))).size,
  },
  {
    id: 'constellation',
    name: 'Constellation',
    description: 'Reach level 2 in six different skills.',
    target: 6,
    measure: (f) => f.progress.domains.flatMap((d) => d.skills).filter((s) => s.level >= 2).length,
  },
  { id: 'rising-star', name: 'Rising Star', description: 'Reach level 5.', target: 5, measure: (f) => f.progress.level },
  { id: 'founding-crew', name: 'Founding Crew', description: 'Join LifeOS in its founding season.', target: 1, measure: (f) => (f.foundingMember ? 1 : 0) },
];

export function computeBadges(facts: BadgeFacts): BadgeView[] {
  return BADGES.map((rule) => {
    const current = Math.min(rule.target, Math.max(0, rule.measure(facts)));
    return { id: rule.id, name: rule.name, description: rule.description, earned: current >= rule.target, current, target: rule.target };
  });
}

/** Loads what badges need beyond the awards the caller already has. */
export async function loadBadgeFacts(db: Queryable, accountId: string): Promise<Omit<BadgeFacts, 'activityAwards' | 'progress'>> {
  const [quests, priorities, corrections, founding] = await Promise.all([
    db.query<{ template: string; count: string }>(
      `SELECT q.template, count(DISTINCT q.id) AS count FROM quests q
       JOIN game_awards g ON g.quest_id = q.id AND g.status <> 'reversed'
       WHERE q.account_id = $1 GROUP BY q.template`,
      [accountId],
    ),
    db.query<{ count: string }>('SELECT count(*) FROM priorities WHERE account_id = $1 AND done_at IS NOT NULL', [accountId]),
    db.query<{ count: string }>('SELECT count(*) FROM activity_corrections WHERE account_id = $1', [accountId]),
    db.query("SELECT 1 FROM season_enrollments WHERE account_id = $1 AND campaign = 'founding' LIMIT 1", [accountId]),
  ]);
  return {
    questsCompleted: Object.fromEntries(quests.rows.map((row) => [row.template, Number(row.count)])),
    prioritiesDone: Number(priorities.rows[0]?.count ?? 0),
    corrections: Number(corrections.rows[0]?.count ?? 0),
    foundingMember: founding.rows.length > 0,
  };
}
