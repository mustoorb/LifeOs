import type { ActivityType } from '@lifeos/contracts';

/** Starter skill tree (blueprint §11). */
export const SKILL_TREE = {
  mind: ['learning', 'focus', 'reflection'],
  craft: ['creation', 'communication', 'business'],
  body: ['strength', 'endurance', 'mobility', 'recovery'],
  world: ['adventure', 'community', 'discipline'],
} as const;

export type Domain = keyof typeof SKILL_TREE;
export type SkillId = (typeof SKILL_TREE)[Domain][number];

export const SKILLS: readonly SkillId[] = Object.values(SKILL_TREE).flat();

export function domainOf(skill: SkillId): Domain {
  for (const [domain, skills] of Object.entries(SKILL_TREE) as [Domain, readonly SkillId[]][]) {
    if (skills.includes(skill)) return domain;
  }
  throw new Error(`Unknown skill ${skill}`);
}

/**
 * Skills an activity type can reasonably feed. The first entry is the default;
 * the user may split XP across any of the others (blueprint §11).
 */
export const ELIGIBLE_SKILLS: Record<ActivityType, readonly SkillId[]> = {
  digital_session: ['focus', 'business', 'communication'],
  learning_session: ['learning', 'focus'],
  creative_session: ['creation', 'focus'],
  workout: ['strength', 'endurance', 'mobility'],
  walk: ['endurance', 'recovery', 'adventure'],
  run: ['endurance'],
  ride: ['endurance', 'adventure'],
  outdoor_session: ['adventure', 'recovery'],
  manual_log: ['discipline'],
  other: ['discipline'],
};

/** Requested split of one award across skills; weights are relative. */
export type SkillAllocationChoice = Readonly<Partial<Record<SkillId, number>>>;

/**
 * Normalizes a user's allocation into weights summing to 1, restricted to
 * eligible skills. Falls back to the type's default skill.
 */
export function resolveAllocation(
  type: ActivityType,
  choice?: SkillAllocationChoice,
): { skill: SkillId; weight: number }[] {
  const eligible = ELIGIBLE_SKILLS[type];
  const entries = Object.entries(choice ?? {}).filter(
    (entry): entry is [SkillId, number] =>
      eligible.includes(entry[0] as SkillId) && Number.isFinite(entry[1]) && (entry[1] as number) > 0,
  );
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (entries.length === 0 || total <= 0) return [{ skill: eligible[0]!, weight: 1 }];
  return entries.map(([skill, weight]) => ({ skill, weight: weight / total }));
}
