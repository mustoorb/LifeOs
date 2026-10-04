import { ACTIVITY_TYPES, type ActivityType, type DerivedActivity, type Visibility } from '@lifeos/contracts';

/**
 * User actions from the correction queue (blueprint §5, §10): "We think this
 * was a 45-minute video-editing session. Confirm, recategorize, or discard?"
 *
 * Corrections update the derived claim only; the source events stay intact.
 * Confirming never upgrades the evidence tier — it records the user's word.
 */
export type Correction =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'recategorize'; readonly type: ActivityType; readonly category?: string }
  | { readonly kind: 'discard' }
  | { readonly kind: 'set_visibility'; readonly visibility: Visibility };

export function applyCorrection(activity: DerivedActivity, correction: Correction): DerivedActivity {
  switch (correction.kind) {
    case 'confirm':
      return { ...activity, userConfirmation: 'confirmed' };
    case 'recategorize': {
      if (!ACTIVITY_TYPES.includes(correction.type)) {
        throw new Error(`Unknown activity type ${correction.type}`);
      }
      return {
        ...activity,
        canonicalType: correction.type,
        context: {
          ...activity.context,
          ...(correction.category ? { appCategory: correction.category } : {}),
        },
        userConfirmation: 'corrected',
      };
    }
    case 'discard':
      return { ...activity, userConfirmation: 'discarded' };
    case 'set_visibility':
      return { ...activity, visibility: correction.visibility };
  }
}

/** Activities waiting on the user, flagged ones first. */
export function correctionQueue(activities: readonly DerivedActivity[]): DerivedActivity[] {
  return activities
    .filter((activity) => activity.userConfirmation === 'pending' && activity.verificationStatus !== 'rejected')
    .sort(
      (a, b) =>
        Number(b.verificationStatus === 'flagged') - Number(a.verificationStatus === 'flagged') ||
        a.confidence - b.confidence ||
        a.interval.start - b.interval.start,
    );
}
