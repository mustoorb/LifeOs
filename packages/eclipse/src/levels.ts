/**
 * Level curve: XP required to reach `level` is `scale × (level − 1)^1.5`,
 * so early levels come quickly and later ones reward sustained investment.
 */
export interface LevelCurve {
  readonly scale: number;
  readonly exponent: number;
}

export const ACCOUNT_CURVE: LevelCurve = { scale: 100, exponent: 1.5 };
export const SKILL_CURVE: LevelCurve = { scale: 50, exponent: 1.5 };

export function xpForLevel(level: number, curve: LevelCurve): number {
  if (level <= 1) return 0;
  return Math.round(curve.scale * (level - 1) ** curve.exponent);
}

export interface LevelProgress {
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
}

export function levelForXp(xp: number, curve: LevelCurve): LevelProgress {
  const total = Math.max(0, Math.floor(xp));
  let level = Math.max(1, Math.floor((total / curve.scale) ** (1 / curve.exponent)) + 1);
  // Correct for floating-point drift around boundaries.
  while (xpForLevel(level + 1, curve) <= total) level++;
  while (level > 1 && xpForLevel(level, curve) > total) level--;
  const floor = xpForLevel(level, curve);
  return {
    level,
    xpIntoLevel: total - floor,
    xpForNextLevel: xpForLevel(level + 1, curve) - floor,
  };
}
