import {
  DAY,
  localDateKey,
  localDayWindow,
  localWeekWindow,
  weekStartKey,
  type ActivityEvent,
  type DerivedActivity,
  type Instant,
} from '@lifeos/contracts';
import {
  RULESET_V1,
  dailyFocusQuest,
  evaluateQuest,
  questCompletionAward,
  reconcileActivity,
  reverseAward,
  weeklyMovementQuest,
  weeklyRecoveryQuest,
  type GameAward,
  type QuestDefinition,
} from '@lifeos/eclipse';
import { applyCorrection, assessActivities, deduplicate, type Correction } from '@lifeos/promethee';
import { transaction, type Db, type Queryable } from './db.js';
import { findAccount, type Account } from './model.js';

/** How far back each refresh re-derives activities and reconciles XP. */
export const DERIVE_WINDOW = 35 * DAY;

export const QUEST_TEMPLATES = {
  'daily-focus': dailyFocusQuest,
  'weekly-movement': weeklyMovementQuest,
  'weekly-recovery': weeklyRecoveryQuest,
} as const;
export type QuestTemplate = keyof typeof QUEST_TEMPLATES;

/** A derived activity as stored, with the connectors its events came from. */
export type StoredActivity = DerivedActivity & { readonly sources: readonly string[] };

export interface StoredQuest {
  readonly id: string;
  readonly template: QuestTemplate;
  readonly skippedAt: number | null;
  readonly definition: QuestDefinition;
}

export async function loadAwards(db: Queryable, accountId: string): Promise<GameAward[]> {
  const { rows } = await db.query<{ award: GameAward }>('SELECT award FROM game_awards WHERE account_id = $1 ORDER BY created_at, id', [
    accountId,
  ]);
  return rows.map((row) => row.award);
}

export async function loadActivities(db: Queryable, accountId: string, from: Instant, to: Instant): Promise<StoredActivity[]> {
  const { rows } = await db.query<{ activity: StoredActivity }>(
    'SELECT activity FROM activities WHERE account_id = $1 AND ends_at > $2 AND starts_at < $3 ORDER BY starts_at',
    [accountId, new Date(from), new Date(to)],
  );
  return rows.map((row) => row.activity);
}

export async function loadQuests(db: Queryable, accountId: string, from: Instant, to: Instant): Promise<StoredQuest[]> {
  const { rows } = await db.query<{ id: string; template: QuestTemplate; skipped_at: Date | null; definition: QuestDefinition }>(
    'SELECT id, template, skipped_at, definition FROM quests WHERE account_id = $1 AND ends_at > $2 AND starts_at < $3 ORDER BY starts_at, id',
    [accountId, new Date(from), new Date(to)],
  );
  return rows.map((row) => ({ id: row.id, template: row.template, skippedAt: row.skipped_at?.getTime() ?? null, definition: row.definition }));
}

/** The season the account is enrolled in right now, if any. */
export async function currentSeason(db: Queryable, accountId: string, now: Instant) {
  const { rows } = await db.query<{ id: string; name: string; ends_at: Date; leaderboard_opt_in: boolean }>(
    `SELECT s.id, s.name, s.ends_at, e.leaderboard_opt_in FROM season_enrollments e JOIN seasons s ON s.id = e.season_id
     WHERE e.account_id = $1 AND s.starts_at <= $2 AND s.ends_at > $2 ORDER BY s.starts_at DESC LIMIT 1`,
    [accountId, new Date(now)],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, endsAt: row.ends_at.getTime(), leaderboardOptIn: row.leaderboard_opt_in } : null;
}

function applyCorrections(activity: DerivedActivity, corrections: readonly { event_id: string; correction: Correction }[]): DerivedActivity {
  return corrections
    .filter((entry) => activity.eventIds.includes(entry.event_id))
    .reduce((current, entry) => applyCorrection(current, entry.correction), activity);
}

/**
 * Turns an account's stored evidence into game state (blueprint §4, §8, §11):
 * events → derived activities (dedupe, the member's corrections, anomaly
 * checks) → reconciled XP awards → quests and quest bonuses. Awards are never
 * edited in place except to be reversed, so every change is explainable.
 */
export class GameEngine {
  constructor(
    private readonly db: Db,
    private readonly now: () => Instant,
  ) {}

  /** Idempotent. Serialized per account by an advisory lock. */
  async refresh(accountId: string): Promise<void> {
    const now = this.now();
    await transaction(this.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountId]);
      const account = await findAccount(tx, accountId);
      if (!account) return;
      const since = now - DERIVE_WINDOW;

      const events = (
        await tx.query<{ event: ActivityEvent }>('SELECT event FROM activity_events WHERE account_id = $1 AND ends_at > $2', [
          accountId,
          new Date(since),
        ])
      ).rows.map((row) => row.event);
      const connectorOf = new Map(events.map((event) => [event.id, event.provenance.connector]));
      const corrections = (
        await tx.query<{ event_id: string; correction: Correction }>(
          'SELECT event_id, correction FROM activity_corrections WHERE account_id = $1 ORDER BY id',
          [accountId],
        )
      ).rows;
      const activities: StoredActivity[] = assessActivities(deduplicate(events).map((a) => applyCorrections(a, corrections))).map(
        (activity) => ({ ...activity, sources: [...new Set(activity.eventIds.map((id) => connectorOf.get(id) ?? 'unknown'))] }),
      );

      await tx.query('DELETE FROM activities WHERE account_id = $1 AND ends_at > $2', [accountId, new Date(since)]);
      for (const activity of activities) {
        await tx.query(
          `INSERT INTO activities (id, account_id, starts_at, ends_at, activity) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET starts_at = $3, ends_at = $4, activity = $5`,
          [activity.id, accountId, new Date(activity.interval.start), new Date(activity.interval.end), JSON.stringify(activity)],
        );
      }

      const season = await currentSeason(tx, accountId, now);
      const ledger = await loadAwards(tx, accountId);
      const write = new AwardWriter(tx, accountId, ledger);

      for (const activity of activities) {
        const { reversed, created } = reconcileActivity(activity, {
          ruleset: RULESET_V1,
          ledger: write.ledger,
          now,
          ...(season ? { seasonId: season.id } : {}),
        });
        for (const award of reversed) await write.replace(award);
        if (created) await write.insert(created, activity.interval.start);
      }

      // Awards whose activity no longer exists (its events were deleted).
      const present = new Set(activities.map((activity) => activity.id));
      const { rows: orphans } = await tx.query<{ id: string }>(
        `SELECT id FROM game_awards WHERE account_id = $1 AND award_type = 'activity' AND status <> 'reversed'
         AND activity_starts_at > $2`,
        [accountId, new Date(since + DAY)],
      );
      for (const { id } of orphans) {
        const award = write.ledger.find((entry) => entry.id === id);
        if (award && award.activityId && !present.has(award.activityId)) {
          await write.replace(reverseAward(award, 'activity removed', now));
        }
      }

      await this.ensureQuests(tx, account, now);
      for (const quest of await loadQuests(tx, accountId, now - DAY, now + 1)) {
        if (quest.skippedAt !== null) continue;
        const evaluation = evaluateQuest(quest.definition, activities);
        const existing = write.ledger.find(
          (award) => award.awardType === 'quest_completion' && award.questId === quest.id && award.status !== 'reversed',
        );
        if (evaluation.complete && !existing) {
          const award = questCompletionAward(quest.definition, evaluation, {
            userId: accountId,
            ledger: write.ledger,
            now,
            timeZone: account.timeZone,
            ...(season ? { seasonId: season.id } : {}),
          });
          if (award) await write.insert(award, null);
        } else if (!evaluation.complete && existing) {
          await write.replace(reverseAward(existing, 'quest no longer complete', now));
        }
      }
    });
  }

  /** Today's daily quest and this week's weekly quests, in the member's zone. */
  private async ensureQuests(tx: Queryable, account: Account, now: Instant): Promise<void> {
    const today = localDateKey(now, account.timeZone);
    const week = weekStartKey(today);
    const wanted: { template: QuestTemplate; key: string; window: { start: number; end: number } }[] = [
      { template: 'daily-focus', key: today, window: localDayWindow(today, account.timeZone) },
      { template: 'weekly-movement', key: week, window: localWeekWindow(week, account.timeZone) },
      { template: 'weekly-recovery', key: week, window: localWeekWindow(week, account.timeZone) },
    ];
    for (const { template, key, window } of wanted) {
      const id = `q:${account.id}:${template}:${key}`;
      const definition = QUEST_TEMPLATES[template](id, window);
      await tx.query(
        `INSERT INTO quests (id, account_id, template, starts_at, ends_at, definition) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, account.id, template, new Date(window.start), new Date(window.end), JSON.stringify(definition)],
      );
    }
  }
}

/** Keeps the in-memory ledger and the table in step during one refresh. */
class AwardWriter {
  readonly ledger: GameAward[];

  constructor(
    private readonly tx: Queryable,
    private readonly accountId: string,
    ledger: GameAward[],
  ) {
    this.ledger = ledger;
  }

  async insert(proposed: GameAward, activityStartsAt: Instant | null): Promise<void> {
    // Award ids embed a timestamp; a reversal and its replacement can share one.
    let award = proposed;
    for (let n = 2; this.ledger.some((entry) => entry.id === award.id); n++) award = { ...proposed, id: `${proposed.id}#${n}` };
    await this.tx.query(
      `INSERT INTO game_awards (id, account_id, award_type, activity_id, activity_starts_at, quest_id, status, xp, created_at, award)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        award.id,
        this.accountId,
        award.awardType,
        award.activityId ?? null,
        activityStartsAt === null ? null : new Date(activityStartsAt),
        award.questId ?? null,
        award.status,
        award.xp,
        new Date(award.createdAt),
        JSON.stringify(award),
      ],
    );
    this.ledger.push(award);
  }

  async replace(award: GameAward): Promise<void> {
    await this.tx.query('UPDATE game_awards SET status = $3, award = $4 WHERE id = $1 AND account_id = $2', [
      award.id,
      this.accountId,
      award.status,
      JSON.stringify(award),
    ]);
    const index = this.ledger.findIndex((entry) => entry.id === award.id);
    if (index >= 0) this.ledger[index] = award;
  }
}
