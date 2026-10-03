import {
  MINUTE,
  durationMs,
  localDateKey,
  type ActivityType,
  type DerivedActivity,
  type EvidenceLevel,
  type Instant,
} from '@lifeos/contracts';
import { ACCOUNT_CURVE, SKILL_CURVE, levelForXp, type LevelProgress } from './levels.js';
import { SKILLS, resolveAllocation, type SkillAllocationChoice, type SkillId } from './skills.js';

/**
 * XP is non-transferable and has no cash value (blueprint §11). Every award
 * records the rule version and evidence it came from so it can be explained,
 * reversed or recomputed.
 */
export type AwardStatus = 'pending' | 'provisional' | 'awarded' | 'reversed' | 'appealed';

export interface SkillAllocation {
  readonly skill: SkillId;
  readonly xp: number;
}

export interface AwardBasis {
  readonly activityType: ActivityType;
  readonly minutes: number;
  readonly evidenceLevel: EvidenceLevel;
}

export interface GameAward {
  readonly id: string;
  readonly userId: string;
  readonly awardType: 'activity' | 'quest_completion';
  readonly activityId?: string;
  readonly questId?: string;
  readonly seasonId?: string;
  readonly localDate: string;
  readonly xp: number;
  readonly skillAllocations: readonly SkillAllocation[];
  readonly ruleVersion: string;
  readonly status: AwardStatus;
  readonly basis?: AwardBasis;
  readonly explanation: readonly string[];
  readonly createdAt: Instant;
  readonly reversal?: { readonly at: Instant; readonly reason: string };
}

export interface XpRuleset {
  readonly version: string;
  readonly xpPerMinute: Readonly<Record<ActivityType, number>>;
  readonly evidenceMultiplier: Readonly<Record<EvidenceLevel, number>>;
  /** Maximum XP from one activity. */
  readonly sessionCap: number;
  /** Maximum activity XP per skill per local day. */
  readonly dailyCapPerSkill: number;
  /** Minutes of one type per local day beyond which XP is reduced. */
  readonly diminishingAfterMinutes: number;
  readonly diminishingFactor: number;
  /** Below this, unconfirmed activities are held as pending. */
  readonly minConfidence: number;
  /** Evidence tiers whose XP counts for personal progress only. */
  readonly provisionalEvidence: readonly EvidenceLevel[];
}

/** Initial numbers; all of them are configuration, not code (blueprint §11). */
export const RULESET_V1: XpRuleset = {
  version: 'xp-v1',
  xpPerMinute: {
    digital_session: 0.5,
    learning_session: 0.6,
    creative_session: 0.6,
    workout: 1,
    walk: 0.6,
    run: 1,
    ride: 0.8,
    outdoor_session: 0.6,
    manual_log: 0.3,
    other: 0.3,
  },
  evidenceMultiplier: {
    self_reported: 0.5,
    observed: 1,
    connected: 1,
    corroborated: 1.1,
    reviewed: 1.1,
  },
  sessionCap: 120,
  dailyCapPerSkill: 200,
  diminishingAfterMinutes: 180,
  diminishingFactor: 0.25,
  minConfidence: 0.4,
  provisionalEvidence: ['self_reported'],
};

export interface AwardOptions {
  readonly ruleset: XpRuleset;
  /** The user's existing awards; used for caps, diminishing returns and idempotency. */
  readonly ledger: readonly GameAward[];
  readonly allocation?: SkillAllocationChoice;
  readonly seasonId?: string;
  readonly now: Instant;
}

export type AwardResult =
  | { readonly kind: 'award'; readonly award: GameAward }
  | {
      readonly kind: 'skipped';
      readonly reason: 'discarded' | 'rejected' | 'already_awarded' | 'no_active_time';
    };

/** Counted towards totals. Pending/appealed are visible but not counted. */
const COUNTED: ReadonlySet<AwardStatus> = new Set(['awarded', 'provisional']);

export function activityMinutes(activity: DerivedActivity): number {
  const activeMs =
    activity.metrics.activeSeconds !== undefined
      ? activity.metrics.activeSeconds * 1000
      : durationMs(activity.interval);
  return Math.floor(activeMs / MINUTE);
}

export function computeActivityAward(activity: DerivedActivity, options: AwardOptions): AwardResult {
  const { ruleset, now } = options;
  if (activity.userConfirmation === 'discarded') return { kind: 'skipped', reason: 'discarded' };
  if (activity.verificationStatus === 'rejected') return { kind: 'skipped', reason: 'rejected' };

  const ledger = options.ledger.filter((award) => award.userId === activity.userId && award.status !== 'reversed');
  if (ledger.some((award) => award.awardType === 'activity' && award.activityId === activity.id)) {
    return { kind: 'skipped', reason: 'already_awarded' };
  }
  const minutes = activityMinutes(activity);
  if (minutes <= 0) return { kind: 'skipped', reason: 'no_active_time' };

  const type = activity.canonicalType;
  const localDate = localDateKey(activity.interval.start, activity.timeZone);
  const sameDay = ledger.filter((award) => award.awardType === 'activity' && award.localDate === localDate);
  const explanation: string[] = [];

  // Diminishing returns on repeating the same type within a day.
  const priorMinutes = sameDay
    .filter((award) => award.basis?.activityType === type)
    .reduce((sum, award) => sum + (award.basis?.minutes ?? 0), 0);
  const freshMinutes = Math.max(0, Math.min(minutes, ruleset.diminishingAfterMinutes - priorMinutes));
  const tiredMinutes = minutes - freshMinutes;
  const effectiveMinutes = freshMinutes + tiredMinutes * ruleset.diminishingFactor;

  const multiplier = ruleset.evidenceMultiplier[activity.evidenceLevel];
  explanation.push(
    `${minutes} min ${words(type)}; ${words(activity.evidenceLevel)} evidence ${multiplier.toFixed(1)}×`,
  );
  if (tiredMinutes > 0) {
    explanation.push(
      `${tiredMinutes} min past ${ruleset.diminishingAfterMinutes} min of ${words(type)} today count ${ruleset.diminishingFactor}×`,
    );
  }

  let raw = effectiveMinutes * ruleset.xpPerMinute[type] * multiplier;
  if (raw > ruleset.sessionCap) {
    explanation.push(`Session cap: ${Math.round(raw)} → ${ruleset.sessionCap} XP`);
    raw = ruleset.sessionCap;
  }

  // Split across skills, then apply each skill's daily cap.
  const split = splitInteger(Math.round(raw), resolveAllocation(type, options.allocation));
  const allocations: SkillAllocation[] = [];
  for (const { skill, xp } of split) {
    const usedToday = sameDay
      .flatMap((award) => award.skillAllocations)
      .filter((allocation) => allocation.skill === skill)
      .reduce((sum, allocation) => sum + allocation.xp, 0);
    const allowed = Math.max(0, Math.min(xp, ruleset.dailyCapPerSkill - usedToday));
    if (allowed < xp) {
      explanation.push(`Daily ${label(skill)} cap (${ruleset.dailyCapPerSkill}): ${xp} → ${allowed} XP`);
    }
    if (allowed > 0) allocations.push({ skill, xp: allowed });
  }
  const xp = allocations.reduce((sum, allocation) => sum + allocation.xp, 0);

  const userVouched = activity.userConfirmation === 'confirmed' || activity.userConfirmation === 'corrected';
  let status: AwardStatus = 'awarded';
  if (activity.verificationStatus === 'flagged') {
    status = 'pending';
    explanation.push(`Held for review: ${activity.flags.join(', ') || 'flagged'}`);
  } else if (activity.confidence < ruleset.minConfidence && !userVouched) {
    status = 'pending';
    explanation.push('Held until you confirm this activity');
  } else if (ruleset.provisionalEvidence.includes(activity.evidenceLevel)) {
    status = 'provisional';
    explanation.push('Provisional: counts for personal progress, not competition');
  }

  const headline = allocations.map((allocation) => `${allocation.xp} ${label(allocation.skill)} XP`).join(' + ');
  explanation.unshift(headline || '0 XP');

  return {
    kind: 'award',
    award: {
      id: `award:${activity.id}:${ruleset.version}:${now}`,
      userId: activity.userId,
      awardType: 'activity',
      activityId: activity.id,
      ...(options.seasonId ? { seasonId: options.seasonId } : {}),
      localDate,
      xp,
      skillAllocations: allocations,
      ruleVersion: ruleset.version,
      status,
      basis: { activityType: type, minutes, evidenceLevel: activity.evidenceLevel },
      explanation,
      createdAt: now,
    },
  };
}

export function reverseAward(award: GameAward, reason: string, at: Instant): GameAward {
  if (award.status === 'reversed') throw new Error(`Award ${award.id} is already reversed`);
  return { ...award, status: 'reversed', reversal: { at, reason } };
}

export function appealAward(award: GameAward): GameAward {
  if (award.status !== 'pending' && award.status !== 'reversed') {
    throw new Error(`Only pending or reversed awards can be appealed (got ${award.status})`);
  }
  return { ...award, status: 'appealed' };
}

/**
 * Server-side reconciliation after a correction, re-assessment or rules
 * change: if the live award no longer matches the activity, reverse it and
 * compute a fresh one. Returns the ledger entries to append/replace.
 */
export function reconcileActivity(
  activity: DerivedActivity,
  options: AwardOptions,
): { reversed: GameAward[]; created: GameAward | null } {
  const live = options.ledger.filter(
    (award) => award.awardType === 'activity' && award.activityId === activity.id && award.status !== 'reversed',
  );
  const fresh = computeActivityAward(activity, {
    ...options,
    ledger: options.ledger.filter((award) => !live.includes(award)),
  });
  const next = fresh.kind === 'award' ? fresh.award : null;

  const unchanged =
    live.length === 1 &&
    next !== null &&
    live[0]!.ruleVersion === next.ruleVersion &&
    live[0]!.status === next.status &&
    live[0]!.xp === next.xp &&
    sameBasis(live[0]!.basis, next.basis) &&
    sameAllocations(live[0]!.skillAllocations, next.skillAllocations);
  if (unchanged || (live.length === 0 && next === null)) return { reversed: [], created: null };

  const reason = next === null ? `activity ${fresh.kind === 'skipped' ? fresh.reason : 'changed'}` : 'activity changed';
  return {
    reversed: live.map((award) => reverseAward(award, reason, options.now)),
    created: next,
  };
}

export interface ProgressSummary {
  readonly totalXp: number;
  readonly heldXp: number;
  readonly account: LevelProgress;
  readonly skills: Readonly<Record<SkillId, { readonly xp: number; readonly progress: LevelProgress }>>;
}

/** Personal progress. Provisional XP counts here; it is excluded from competition. */
export function summarizeProgress(awards: readonly GameAward[]): ProgressSummary {
  const skillXp = new Map<SkillId, number>(SKILLS.map((skill) => [skill, 0]));
  let totalXp = 0;
  let heldXp = 0;
  for (const award of awards) {
    if (award.status === 'pending' || award.status === 'appealed') heldXp += award.xp;
    if (!COUNTED.has(award.status)) continue;
    totalXp += award.xp;
    for (const allocation of award.skillAllocations) {
      skillXp.set(allocation.skill, (skillXp.get(allocation.skill) ?? 0) + allocation.xp);
    }
  }
  const skills = Object.fromEntries(
    [...skillXp].map(([skill, xp]) => [skill, { xp, progress: levelForXp(xp, SKILL_CURVE) }]),
  ) as ProgressSummary['skills'];
  return { totalXp, heldXp, account: levelForXp(totalXp, ACCOUNT_CURVE), skills };
}

/** Integer split by weight using largest remainders, so parts sum to `total`. */
function splitInteger(total: number, weights: { skill: SkillId; weight: number }[]): SkillAllocation[] {
  const exact = weights.map(({ skill, weight }) => ({ skill, value: total * weight }));
  const parts = exact.map(({ skill, value }) => ({ skill, xp: Math.floor(value), rest: value - Math.floor(value) }));
  let remainder = total - parts.reduce((sum, part) => sum + part.xp, 0);
  for (const part of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (remainder <= 0) break;
    part.xp += 1;
    remainder -= 1;
  }
  return parts.map(({ skill, xp }) => ({ skill, xp }));
}

function sameBasis(a: AwardBasis | undefined, b: AwardBasis | undefined): boolean {
  return a?.activityType === b?.activityType && a?.minutes === b?.minutes && a?.evidenceLevel === b?.evidenceLevel;
}

function sameAllocations(a: readonly SkillAllocation[], b: readonly SkillAllocation[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.skill === b[i]?.skill && entry.xp === b[i]?.xp);
}

function words(value: string): string {
  return value.replace(/_/g, ' ');
}

function label(value: string): string {
  const text = words(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
