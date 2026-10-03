import {
  DAY,
  DIGITAL_TYPES,
  HOUR,
  PHYSICAL_TYPES,
  clipInterval,
  durationMs,
  evidenceRank,
  localDateKey,
  meetsEvidence,
  type ActivityType,
  type DerivedActivity,
  type EvidenceLevel,
  type Instant,
  type Interval,
  type Visibility,
} from '@lifeos/contracts';
import type { SkillId } from './skills.js';
import { activityMinutes, type GameAward } from './xp.js';

export type QuestKind = 'daily' | 'weekly' | 'personal' | 'skill' | 'guild' | 'challenge' | 'seasonal';

/** Constrained rule builder (blueprint §12): every criterion must hold. */
export type QuestCriterion =
  | { readonly metric: 'sessions'; readonly count: number }
  | { readonly metric: 'minutes'; readonly minutes: number }
  | { readonly metric: 'distinct_days'; readonly days: number }
  | { readonly metric: 'distinct_types'; readonly count: number };

export interface QuestEligibility {
  readonly types?: readonly ActivityType[];
  readonly minEvidence: EvidenceLevel;
  readonly minSessionMinutes: number;
  /** e.g. `focus`, set by an explicit focus block on the desktop companion. */
  readonly requiredTag?: string;
}

/** intent + target + timeframe + eligible evidence + completion rule + reward + privacy mode */
export interface QuestDefinition {
  readonly id: string;
  readonly kind: QuestKind;
  readonly title: string;
  readonly intent: string;
  readonly window: Interval;
  readonly criteria: readonly QuestCriterion[];
  readonly eligibility: QuestEligibility;
  readonly reward: { readonly xp: number; readonly skill: SkillId };
  readonly privacy: Visibility;
  readonly ruleVersion: string;
  readonly moderation: 'not_required' | 'pending' | 'approved' | 'rejected';
}

export const QUEST_RULE_VERSION = 'quest-v1';

const MAX_WINDOW: Record<QuestKind, number> = {
  daily: DAY + HOUR, // tolerate DST transitions
  weekly: 7 * DAY + HOUR,
  personal: 28 * DAY,
  skill: 28 * DAY,
  guild: 28 * DAY,
  challenge: 28 * DAY,
  seasonal: 12 * 7 * DAY + HOUR,
};

const MAX_REWARD: Record<QuestKind, number> = {
  daily: 25,
  weekly: 100,
  personal: 100,
  skill: 100,
  guild: 100,
  challenge: 150,
  seasonal: 300,
};

export function validateQuest(quest: QuestDefinition): string[] {
  const errors: string[] = [];
  const length = durationMs(quest.window);
  if (length <= 0) errors.push('Quest window must have positive length');
  if (length > MAX_WINDOW[quest.kind]) errors.push(`A ${quest.kind} quest cannot run longer than its timeframe`);
  if (quest.criteria.length === 0) errors.push('Quest needs at least one criterion');
  for (const criterion of quest.criteria) {
    const target = criterionTarget(criterion);
    if (!Number.isInteger(target) || target <= 0) errors.push(`${criterion.metric} target must be a positive integer`);
  }
  if (quest.reward.xp < 0 || quest.reward.xp > MAX_REWARD[quest.kind]) {
    errors.push(`${quest.kind} reward must be between 0 and ${MAX_REWARD[quest.kind]} XP`);
  }
  if (quest.kind === 'challenge' && !meetsEvidence(quest.eligibility.minEvidence, 'observed')) {
    errors.push('Challenges cannot accept self-reported evidence');
  }
  if ((quest.kind === 'challenge' || quest.privacy === 'public_summary') && quest.moderation === 'not_required') {
    errors.push('Public quests require moderation before discovery');
  }
  return errors;
}

export function isDiscoverable(quest: QuestDefinition): boolean {
  return validateQuest(quest).length === 0 && quest.moderation !== 'pending' && quest.moderation !== 'rejected';
}

export interface QuestEvaluation {
  readonly questId: string;
  readonly complete: boolean;
  /** 0..1, the weakest criterion's progress. */
  readonly progress: number;
  readonly criteria: readonly { readonly criterion: QuestCriterion; readonly current: number; readonly required: number }[];
  readonly qualifyingActivityIds: readonly string[];
  readonly lowestEvidence: EvidenceLevel | null;
}

export function qualifiesForQuest(activity: DerivedActivity, quest: QuestDefinition): boolean {
  const { eligibility } = quest;
  if (activity.userConfirmation === 'discarded') return false;
  if (activity.verificationStatus === 'flagged' || activity.verificationStatus === 'rejected') return false;
  if (!meetsEvidence(activity.evidenceLevel, eligibility.minEvidence)) return false;
  if (eligibility.types && !eligibility.types.includes(activity.canonicalType)) return false;
  if (eligibility.requiredTag && !activity.context.tags.includes(eligibility.requiredTag)) return false;
  const minutes = minutesInWindow(activity, quest.window);
  return minutes > 0 && minutes >= eligibility.minSessionMinutes;
}

export function evaluateQuest(quest: QuestDefinition, activities: readonly DerivedActivity[]): QuestEvaluation {
  const qualifying = activities.filter((activity) => qualifiesForQuest(activity, quest));
  const criteria = quest.criteria.map((criterion) => ({
    criterion,
    current: measure(criterion, qualifying, quest.window),
    required: criterionTarget(criterion),
  }));
  const progress = Math.min(1, ...criteria.map(({ current, required }) => Math.min(1, current / required)));
  const lowest = qualifying.reduce<EvidenceLevel | null>(
    (low, activity) =>
      low === null || evidenceRank(activity.evidenceLevel) < evidenceRank(low) ? activity.evidenceLevel : low,
    null,
  );
  return {
    questId: quest.id,
    complete: criteria.length > 0 && criteria.every(({ current, required }) => current >= required),
    progress: criteria.length > 0 ? progress : 0,
    criteria,
    qualifyingActivityIds: qualifying.map((activity) => activity.id),
    lowestEvidence: lowest,
  };
}

/**
 * Guild quests pool contributions while preserving individual privacy: only
 * the aggregate and the number of contributors are returned.
 */
export function evaluatePooledQuest(
  quest: QuestDefinition,
  activitiesByMember: ReadonlyMap<string, readonly DerivedActivity[]>,
): { readonly complete: boolean; readonly progress: number; readonly contributors: number } {
  const pooled: DerivedActivity[] = [];
  let contributors = 0;
  for (const activities of activitiesByMember.values()) {
    const qualifying = activities.filter((activity) => qualifiesForQuest(activity, quest));
    if (qualifying.length > 0) contributors++;
    pooled.push(...qualifying);
  }
  const { complete, progress } = evaluateQuest(quest, pooled);
  return { complete, progress, contributors };
}

export function questCompletionAward(
  quest: QuestDefinition,
  evaluation: QuestEvaluation,
  options: { userId: string; ledger: readonly GameAward[]; now: Instant; timeZone: string; seasonId?: string },
): GameAward | null {
  if (!evaluation.complete || evaluation.questId !== quest.id) return null;
  const alreadyAwarded = options.ledger.some(
    (award) =>
      award.userId === options.userId &&
      award.awardType === 'quest_completion' &&
      award.questId === quest.id &&
      award.status !== 'reversed',
  );
  if (alreadyAwarded) return null;

  const provisional = evaluation.lowestEvidence === null || evaluation.lowestEvidence === 'self_reported';
  return {
    id: `award:quest:${quest.id}:${options.userId}:${options.now}`,
    userId: options.userId,
    awardType: 'quest_completion',
    questId: quest.id,
    ...(options.seasonId ? { seasonId: options.seasonId } : {}),
    localDate: localDateKey(options.now, options.timeZone),
    xp: quest.reward.xp,
    skillAllocations: quest.reward.xp > 0 ? [{ skill: quest.reward.skill, xp: quest.reward.xp }] : [],
    ruleVersion: quest.ruleVersion,
    status: provisional ? 'provisional' : 'awarded',
    explanation: [
      `+${quest.reward.xp} quest bonus: ${quest.title}`,
      `${evaluation.qualifyingActivityIds.length} qualifying activit${evaluation.qualifyingActivityIds.length === 1 ? 'y' : 'ies'}`,
      ...(provisional ? ['Provisional: includes self-reported evidence'] : []),
    ],
    createdAt: options.now,
  };
}

// --- Templates from the blueprint -------------------------------------------

const PHYSICAL = [...PHYSICAL_TYPES];
const DIGITAL = [...DIGITAL_TYPES];

/** "Complete one planned 25-minute Focus block." */
export function dailyFocusQuest(id: string, window: Interval): QuestDefinition {
  return {
    id,
    kind: 'daily',
    title: 'Focus block',
    intent: 'Complete one planned 25-minute focus block',
    window,
    criteria: [{ metric: 'sessions', count: 1 }],
    eligibility: { types: DIGITAL, minEvidence: 'observed', minSessionMinutes: 25, requiredTag: 'focus' },
    reward: { xp: 5, skill: 'focus' },
    privacy: 'private',
    ruleVersion: QUEST_RULE_VERSION,
    moderation: 'not_required',
  };
}

/** "Accumulate 150 minutes of movement across three days." */
export function weeklyMovementQuest(id: string, window: Interval): QuestDefinition {
  return {
    id,
    kind: 'weekly',
    title: 'Keep moving',
    intent: 'Accumulate 150 minutes of movement across three days',
    window,
    criteria: [
      { metric: 'minutes', minutes: 150 },
      { metric: 'distinct_days', days: 3 },
    ],
    // Verified manual workouts are allowed until a fitness connector clears its gate.
    eligibility: { types: PHYSICAL, minEvidence: 'self_reported', minSessionMinutes: 10 },
    reward: { xp: 40, skill: 'endurance' },
    privacy: 'private',
    ruleVersion: QUEST_RULE_VERSION,
    moderation: 'not_required',
  };
}

/** Recovery is rewarded too, so the system does not reward burnout. */
export function weeklyRecoveryQuest(id: string, window: Interval): QuestDefinition {
  return {
    id,
    kind: 'weekly',
    title: 'Recharge',
    intent: 'Take two unhurried walks or outdoor sessions this week',
    window,
    criteria: [{ metric: 'sessions', count: 2 }],
    eligibility: { types: ['walk', 'outdoor_session'], minEvidence: 'self_reported', minSessionMinutes: 20 },
    reward: { xp: 25, skill: 'recovery' },
    privacy: 'private',
    ruleVersion: QUEST_RULE_VERSION,
    moderation: 'not_required',
  };
}

function criterionTarget(criterion: QuestCriterion): number {
  switch (criterion.metric) {
    case 'sessions':
    case 'distinct_types':
      return criterion.count;
    case 'minutes':
      return criterion.minutes;
    case 'distinct_days':
      return criterion.days;
  }
}

function measure(criterion: QuestCriterion, activities: readonly DerivedActivity[], window: Interval): number {
  switch (criterion.metric) {
    case 'sessions':
      return activities.length;
    case 'minutes':
      return activities.reduce((sum, activity) => sum + minutesInWindow(activity, window), 0);
    case 'distinct_days':
      return new Set(activities.map((activity) => localDateKey(activity.interval.start, activity.timeZone))).size;
    case 'distinct_types':
      return new Set(activities.map((activity) => activity.canonicalType)).size;
  }
}

/** Active minutes that fall inside the window, pro-rated for partial overlap. */
function minutesInWindow(activity: DerivedActivity, window: Interval): number {
  const clipped = clipInterval(activity.interval, window);
  if (!clipped) return 0;
  const share = durationMs(clipped) / durationMs(activity.interval);
  return Math.floor(activityMinutes(activity) * share);
}
