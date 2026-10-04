import {
  DAY,
  PHYSICAL_TYPES,
  addDays,
  localDateKey,
  localDayWindow,
  localWeekWindow,
  weekStartKey,
  type ActivityType,
  type Instant,
} from '@lifeos/contracts';
import {
  ELIGIBLE_SKILLS,
  RULESET_V1,
  SKILL_TREE,
  activityMinutes,
  domainOf,
  evaluateQuest,
  summarizeProgress,
  type Domain,
  type GameAward,
  type QuestCriterion,
  type SkillId,
} from '@lifeos/eclipse';
import { MANUAL_LOG, normalizeObservation, type Correction } from '@lifeos/promethee';
import { randomUUID } from 'node:crypto';
import { computeBadges, loadBadgeFacts } from './badges.js';
import { transaction, type Db } from './db.js';
import { GameEngine, currentSeason, loadActivities, loadAwards, loadQuests, type StoredActivity, type StoredQuest } from './game.js';
import type { ActivityView, CriterionView, HomeView, ProgressView, QuestView, RecapView } from './home-types.js';
import { isTimeZone, type Account } from './model.js';
import { AppError, audit, notFound } from './support.js';

export const MAX_PRIORITIES = 3;

const FLAG_REASONS: Record<string, string> = {
  implausible_pace: 'The pace looks faster than people usually move.',
  implausible_steps: 'The step count looks unusually high.',
  conflicting_overlap: 'This overlaps another activity at the same time.',
  manual_rate_limit: 'Many manual entries were logged on this day.',
};

const UNIT: Record<QuestCriterion['metric'], string> = {
  sessions: 'sessions',
  minutes: 'minutes',
  distinct_days: 'days',
  distinct_types: 'kinds of activity',
};

/** Activity types a member may log by hand: physical life, plus learning and making. */
export const MANUAL_TYPES = ['workout', 'walk', 'run', 'ride', 'outdoor_session', 'learning_session', 'creative_session'] as const;

export interface ManualLogInput {
  readonly type: (typeof MANUAL_TYPES)[number];
  readonly start: Instant;
  readonly end: Instant;
  readonly distanceM?: number;
}

/** The ECLIPSE home (blueprint §4 daily loop, §5 life dashboard, §11–12). */
export class HomeService {
  constructor(
    private readonly db: Db,
    private readonly engine: GameEngine,
    private readonly now: () => Instant,
  ) {}

  /** Clients report the member's zone; "today" and "this week" follow it. */
  async useTimeZone(account: Account, timeZone: string | undefined): Promise<Account> {
    if (!timeZone || timeZone === account.timeZone) return account;
    if (!isTimeZone(timeZone)) throw new AppError(422, 'invalid_time_zone', 'Unknown time zone');
    await this.db.query('UPDATE accounts SET time_zone = $2 WHERE id = $1', [account.id, timeZone]);
    return { ...account, timeZone };
  }

  async home(account: Account): Promise<HomeView> {
    await this.engine.refresh(account.id);
    const now = this.now();
    const tz = account.timeZone;
    const today = localDateKey(now, tz);
    const day = localDayWindow(today, tz);
    const week = localWeekWindow(weekStartKey(today), tz);

    const [awards, weekActivities, reviewable, quests, priorities, season, badgeFacts] = await Promise.all([
      loadAwards(this.db, account.id),
      loadActivities(this.db, account.id, week.start, week.end),
      loadActivities(this.db, account.id, now - 7 * DAY, now + 1),
      loadQuests(this.db, account.id, day.start, day.end),
      this.priorities(account.id, today),
      currentSeason(this.db, account.id, now),
      loadBadgeFacts(this.db, account.id),
    ]);
    const awardFor = latestActivityAwards(awards);
    const view = (activity: StoredActivity) => activityView(activity, awardFor.get(activity.id) ?? null);
    const progress = progressView(awards);

    return {
      account: { displayName: account.displayName, timeZone: tz },
      today: { dateKey: today, window: day },
      progress,
      priorities,
      // Today's quest first, then the week's.
      quests: quests
        .map((quest) => questView(quest, weekActivities, awards, now))
        .sort((a, b) => Number(a.kind !== 'daily') - Number(b.kind !== 'daily')),
      activities: weekActivities
        .filter((activity) => activity.interval.start < day.end && activity.interval.end > day.start)
        .map(view),
      review: reviewable.map(view).filter((activity) => activity.needsReview),
      recentAwards: awards
        .slice(-12)
        .reverse()
        .map((award) => ({
          id: award.id,
          at: award.createdAt,
          kind: award.awardType,
          xp: award.xp,
          status: award.status,
          explanation: award.explanation,
          reversalReason: award.reversal?.reason ?? null,
        })),
      season,
      badges: computeBadges({
        ...badgeFacts,
        activityAwards: [...awardFor.values()].filter((award) => award.status === 'awarded' || award.status === 'provisional'),
        progress,
      }),
    };
  }

  // --- the member's corrections -------------------------------------------------

  async correct(account: Account, activityId: string, correction: Correction): Promise<void> {
    const { rows } = await this.db.query<{ activity: StoredActivity }>('SELECT activity FROM activities WHERE id = $1 AND account_id = $2', [
      activityId,
      account.id,
    ]);
    const activity = rows[0]?.activity;
    if (!activity) throw notFound('Activity');
    await this.db.query('INSERT INTO activity_corrections (account_id, event_id, correction, at) VALUES ($1, $2, $3, $4)', [
      account.id,
      activity.eventIds[0],
      JSON.stringify(correction),
      new Date(this.now()),
    ]);
    await audit(this.db, this.now(), { kind: 'account', id: account.id }, 'activity.corrected', activityId, { kind: correction.kind });
    await this.engine.refresh(account.id);
  }

  // --- manual logging ---------------------------------------------------------------

  /** Self-reported evidence: counts for personal progress, provisionally (blueprint §10 tier 0). */
  async logManual(account: Account, input: ManualLogInput): Promise<void> {
    const now = this.now();
    const result = normalizeObservation({
      userId: account.id,
      observation: {
        sourceEventId: randomUUID(),
        type: input.type,
        interval: { start: input.start, end: input.end },
        timeZone: account.timeZone,
        ...(input.distanceM !== undefined ? { metrics: { distanceM: input.distanceM } } : {}),
        visibility: account.privacy.defaultActivityVisibility,
      },
      connector: MANUAL_LOG,
      consent: [],
      receivedAt: now,
    });
    if (!result.ok) throw new AppError(422, `invalid_log_${result.reason}`, manualMessage(result.reason));
    const event = result.event;
    await transaction(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO activity_events (id, account_id, type, starts_at, ends_at, received_at, event) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.id, account.id, event.type, new Date(event.interval.start), new Date(event.interval.end), new Date(now), JSON.stringify(event)],
      );
      await audit(tx, now, { kind: 'account', id: account.id }, 'activity.logged', account.id, { type: event.type });
    });
    await this.engine.refresh(account.id);
  }

  // --- priorities -----------------------------------------------------------------

  async priorities(accountId: string, dateKey: string) {
    const { rows } = await this.db.query<{ id: string; text: string; skill: string | null; done_at: Date | null }>(
      'SELECT id, text, skill, done_at FROM priorities WHERE account_id = $1 AND local_date = $2 ORDER BY position',
      [accountId, dateKey],
    );
    return rows.map((row) => ({ id: row.id, text: row.text, skill: row.skill as SkillId | null, done: row.done_at !== null }));
  }

  async addPriority(account: Account, text: string, skill: SkillId | null): Promise<void> {
    const today = localDateKey(this.now(), account.timeZone);
    await transaction(this.db, async (tx) => {
      await tx.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
      const { rows } = await tx.query<{ count: string }>('SELECT count(*) FROM priorities WHERE account_id = $1 AND local_date = $2', [
        account.id,
        today,
      ]);
      if (Number(rows[0]!.count) >= MAX_PRIORITIES) {
        throw new AppError(409, 'too_many_priorities', `Pick at most ${MAX_PRIORITIES} priorities for a day. Fewer is fine.`);
      }
      const { rows: last } = await tx.query<{ position: number | null }>(
        'SELECT max(position) AS position FROM priorities WHERE account_id = $1 AND local_date = $2',
        [account.id, today],
      );
      await tx.query(
        'INSERT INTO priorities (id, account_id, local_date, text, skill, position, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [randomUUID(), account.id, today, text, skill, (last[0]?.position ?? -1) + 1, new Date(this.now())],
      );
    });
  }

  async setPriorityDone(accountId: string, id: string, done: boolean): Promise<void> {
    const result = await this.db.query('UPDATE priorities SET done_at = $3 WHERE id = $1 AND account_id = $2', [
      id,
      accountId,
      done ? new Date(this.now()) : null,
    ]);
    if (result.rowCount === 0) throw notFound('Priority');
  }

  async deletePriority(accountId: string, id: string): Promise<void> {
    const result = await this.db.query('DELETE FROM priorities WHERE id = $1 AND account_id = $2', [id, accountId]);
    if (result.rowCount === 0) throw notFound('Priority');
  }

  // --- quests -------------------------------------------------------------------------

  async skipQuest(account: Account, questId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE quests SET skipped_at = $3 WHERE id = $1 AND account_id = $2 AND skipped_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM game_awards g WHERE g.quest_id = quests.id AND g.status <> 'reversed')`,
      [questId, account.id, new Date(this.now())],
    );
    if (result.rowCount === 0) throw new AppError(409, 'cannot_skip', 'This quest is already complete or skipped.');
  }

  // --- weekly recap -------------------------------------------------------------------

  /** A private look back at one week: intent vs evidence, without judgment (blueprint §4 weekly loop). */
  async recap(account: Account, weekStart?: string): Promise<RecapView> {
    await this.engine.refresh(account.id);
    const tz = account.timeZone;
    const start = weekStart ? weekStartKey(weekStart) : weekStartKey(localDateKey(this.now(), tz));
    const window = localWeekWindow(start, tz);
    const previous = localWeekWindow(addDays(start, -7), tz);
    const keys = Array.from({ length: 7 }, (_, i) => addDays(start, i));

    const [activities, previousActivities, awards, quests, feedback, priorities, corrections] = await Promise.all([
      loadActivities(this.db, account.id, window.start, window.end),
      loadActivities(this.db, account.id, previous.start, previous.end),
      loadAwards(this.db, account.id),
      loadQuests(this.db, account.id, window.start, window.end),
      this.db.query<{ accurate: boolean }>('SELECT accurate FROM recap_feedback WHERE account_id = $1 AND week_start = $2', [account.id, start]),
      this.db.query<{ planned: string; done: string }>(
        'SELECT count(*) AS planned, count(done_at) AS done FROM priorities WHERE account_id = $1 AND local_date = ANY($2)',
        [account.id, keys],
      ),
      this.db.query<{ count: string }>('SELECT count(*) FROM activity_corrections WHERE account_id = $1 AND at >= $2 AND at < $3', [
        account.id,
        new Date(window.start),
        new Date(window.end),
      ]),
    ]);

    const counted = (list: StoredActivity[]) =>
      list.filter((a) => a.userConfirmation !== 'discarded' && a.verificationStatus !== 'rejected');
    // An activity belongs to the local day it started on.
    const inWeek = counted(activities).filter((a) => keys.includes(localDateKey(a.interval.start, tz)));
    const minutesOf = (list: StoredActivity[]) => list.reduce((sum, a) => sum + activityMinutes(a), 0);

    const days = keys.map((dateKey) => ({ dateKey, minutes: minutesOf(inWeek.filter((a) => localDateKey(a.interval.start, tz) === dateKey)) }));
    const domainMinutes = new Map<Domain, number>();
    for (const activity of inWeek) {
      const domain = domainOf(ELIGIBLE_SKILLS[activity.canonicalType][0]!);
      domainMinutes.set(domain, (domainMinutes.get(domain) ?? 0) + activityMinutes(activity));
    }
    const weekAwards = awards.filter((a) => keys.includes(a.localDate) && (a.status === 'awarded' || a.status === 'provisional'));
    const domainXp = new Map<Domain, number>();
    for (const award of weekAwards) {
      for (const allocation of award.skillAllocations) {
        const domain = domainOf(allocation.skill);
        domainXp.set(domain, (domainXp.get(domain) ?? 0) + allocation.xp);
      }
    }

    const questItems = quests.map((quest) => {
      const done = awards.some((a) => a.awardType === 'quest_completion' && a.questId === quest.id && a.status !== 'reversed');
      return { title: quest.definition.title, status: done ? ('complete' as const) : quest.skippedAt ? ('skipped' as const) : ('open' as const) };
    });
    const totalMinutes = minutesOf(inWeek);
    const previousMinutes = minutesOf(
      counted(previousActivities).filter((a) => a.interval.start >= previous.start && a.interval.start < previous.end),
    );

    return {
      weekStart: start,
      weekEnd: keys[6]!,
      window,
      totals: { minutes: totalMinutes, sessions: inWeek.length, xp: weekAwards.reduce((sum, a) => sum + a.xp, 0) },
      previousWeekMinutes: previousMinutes,
      days,
      domains: (Object.keys(SKILL_TREE) as Domain[]).map((domain) => ({
        domain,
        minutes: domainMinutes.get(domain) ?? 0,
        xp: domainXp.get(domain) ?? 0,
      })),
      quests: { completed: questItems.filter((q) => q.status === 'complete').length, offered: questItems.length, items: questItems },
      priorities: { planned: Number(priorities.rows[0]!.planned), done: Number(priorities.rows[0]!.done) },
      corrections: Number(corrections.rows[0]!.count),
      notes: recapNotes({ days, totalMinutes, previousMinutes, inWeek, questItems, tz }),
      feedback: feedback.rows[0]?.accurate ?? null,
    };
  }

  async recapFeedback(account: Account, weekStart: string, accurate: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO recap_feedback (account_id, week_start, accurate, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, week_start) DO UPDATE SET accurate = $3, at = $4`,
      [account.id, weekStartKey(weekStart), accurate, new Date(this.now())],
    );
  }
}

// --- view builders ----------------------------------------------------------------

function latestActivityAwards(awards: readonly GameAward[]): Map<string, GameAward> {
  const map = new Map<string, GameAward>();
  for (const award of awards) {
    if (award.awardType !== 'activity' || !award.activityId) continue;
    const current = map.get(award.activityId);
    // Prefer the live award; otherwise show the latest reversal.
    if (!current || award.status !== 'reversed' || current.status === 'reversed') map.set(award.activityId, award);
  }
  return map;
}

function activityView(activity: StoredActivity, award: GameAward | null): ActivityView {
  const flagged = activity.verificationStatus === 'flagged';
  const unsure = activity.confidence < RULESET_V1.minConfidence && activity.userConfirmation === 'pending';
  const needsReview = activity.userConfirmation !== 'discarded' && (flagged || unsure);
  return {
    id: activity.id,
    type: activity.canonicalType,
    category: activity.context.appCategory ?? null,
    tags: activity.context.tags,
    start: activity.interval.start,
    end: activity.interval.end,
    minutes: activityMinutes(activity),
    evidenceLevel: activity.evidenceLevel,
    sources: activity.sources,
    userConfirmation: activity.userConfirmation,
    needsReview,
    reviewReasons: needsReview
      ? [...activity.flags.map((flag) => FLAG_REASONS[flag] ?? flag), ...(unsure ? ['We are not sure about this one.'] : [])]
      : [],
    award: award ? { xp: award.xp, status: award.status, explanation: award.explanation, skills: award.skillAllocations } : null,
    eligibleSkills: ELIGIBLE_SKILLS[activity.canonicalType],
  };
}

function progressView(awards: readonly GameAward[]): ProgressView {
  const summary = summarizeProgress(awards);
  return {
    totalXp: summary.totalXp,
    heldXp: summary.heldXp,
    level: summary.account.level,
    xpIntoLevel: summary.account.xpIntoLevel,
    xpForNextLevel: summary.account.xpForNextLevel,
    domains: (Object.entries(SKILL_TREE) as [Domain, readonly SkillId[]][]).map(([domain, skills]) => ({
      domain,
      skills: skills.map((skill) => ({
        skill,
        xp: summary.skills[skill].xp,
        level: summary.skills[skill].progress.level,
        xpIntoLevel: summary.skills[skill].progress.xpIntoLevel,
        xpForNextLevel: summary.skills[skill].progress.xpForNextLevel,
      })),
    })),
  };
}

function questView(quest: StoredQuest, activities: readonly StoredActivity[], awards: readonly GameAward[], now: Instant): QuestView {
  const definition = quest.definition;
  const evaluation = evaluateQuest(definition, activities);
  const completion = awards.find((a) => a.awardType === 'quest_completion' && a.questId === quest.id && a.status !== 'reversed');
  const status = completion ? 'complete' : quest.skippedAt ? 'skipped' : definition.window.end <= now ? 'ended' : 'active';
  const criteria: CriterionView[] = evaluation.criteria.map(({ criterion, current, required }) => ({
    unit: UNIT[criterion.metric],
    current: Math.min(current, required),
    required,
  }));
  return {
    id: quest.id,
    template: quest.template,
    kind: definition.kind,
    title: definition.title,
    intent: definition.intent,
    window: definition.window,
    status,
    progress: evaluation.progress,
    criteria,
    reward: definition.reward,
    provisional: completion?.status === 'provisional',
    minEvidence: definition.eligibility.minEvidence,
  };
}

function recapNotes(input: {
  days: readonly { dateKey: string; minutes: number }[];
  totalMinutes: number;
  previousMinutes: number;
  inWeek: readonly StoredActivity[];
  questItems: readonly { title: string; status: string }[];
  tz: string;
}): string[] {
  // Supportive, not coercive (blueprint §15): observations, never scores or streaks.
  const notes: string[] = [];
  if (input.totalMinutes === 0) {
    notes.push('Nothing was recorded this week. That is fine — the recap fills in as you go.');
    return notes;
  }
  const longest = [...input.days].sort((a, b) => b.minutes - a.minutes)[0]!;
  if (longest.minutes >= 600) {
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(Date.parse(`${longest.dateKey}T12:00:00Z`));
    notes.push(`${weekday} was a long day (${Math.round(longest.minutes / 60)} hours tracked). Rest counts too.`);
  }
  const moved = input.inWeek.some((a) => PHYSICAL_TYPES.has(a.canonicalType as ActivityType));
  if (!moved) notes.push('No movement was logged this week. Even a short walk counts toward Recovery.');
  if (input.questItems.some((q) => q.title === 'Recharge' && q.status === 'complete')) notes.push('You made time to recharge this week.');
  if (input.previousMinutes > 0) {
    const change = Math.round(((input.totalMinutes - input.previousMinutes) / input.previousMinutes) * 100);
    if (Math.abs(change) >= 10) notes.push(`About ${Math.abs(change)}% ${change > 0 ? 'more' : 'less'} tracked time than the week before.`);
  }
  return notes;
}

function manualMessage(reason: string): string {
  switch (reason) {
    case 'future_interval':
      return 'That time is in the future.';
    case 'duration_out_of_bounds':
      return 'Entries must be between 1 minute and 6 hours.';
    case 'invalid_interval':
      return 'The end must be after the start.';
    default:
      return 'That entry could not be saved.';
  }
}

