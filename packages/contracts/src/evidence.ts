/**
 * Evidence tiers (blueprint §10). Inference is never "truth": each tier is a
 * statement about how a claim was obtained, and game rules gate on it.
 */
export const EVIDENCE_LEVELS = [
  'self_reported', // 0: manual log
  'observed', // 1: desktop active-duration session
  'connected', // 2: authorized provider's completed workout
  'corroborated', // 3: multiple independent signals agree
  'reviewed', // 4: anomaly checks + required human review
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export function evidenceRank(level: EvidenceLevel): number {
  return EVIDENCE_LEVELS.indexOf(level);
}

export function meetsEvidence(level: EvidenceLevel, minimum: EvidenceLevel): boolean {
  return evidenceRank(level) >= evidenceRank(minimum);
}

export function maxEvidence(levels: readonly EvidenceLevel[]): EvidenceLevel {
  let best: EvidenceLevel = 'self_reported';
  for (const level of levels) {
    if (evidenceRank(level) > evidenceRank(best)) best = level;
  }
  return best;
}

/** System-side verification state, independent of what the user said. */
export type VerificationStatus = 'unverified' | 'verified' | 'flagged' | 'rejected';

/** What the user did with the inference in the correction queue. */
export type UserConfirmation = 'pending' | 'confirmed' | 'corrected' | 'discarded';

/** Probability-like score in `[0, 1]`. */
export type Confidence = number;

export function clampConfidence(value: number): Confidence {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
