import type { Instant } from '@lifeos/contracts';

/** Granular, separately requested consent scopes (blueprint §16.1). */
export const CONSENT_SCOPES = [
  'desktop_activity',
  'calendar',
  'health_workouts',
  'location_routes',
  'social_sharing',
] as const;

export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export interface ConsentRecord {
  readonly scope: ConsentScope;
  readonly granted: boolean;
  readonly at: Instant;
  /** Version of the consent text the user saw. */
  readonly policyVersion: string;
}

/**
 * Append-only consent history. Revocation is a new record, so we can always
 * answer "what had the user agreed to when this event was received?".
 */
export type ConsentLedger = readonly ConsentRecord[];

export function grantConsent(
  ledger: ConsentLedger,
  scope: ConsentScope,
  at: Instant,
  policyVersion: string,
): ConsentLedger {
  return [...ledger, { scope, granted: true, at, policyVersion }];
}

export function revokeConsent(
  ledger: ConsentLedger,
  scope: ConsentScope,
  at: Instant,
  policyVersion: string,
): ConsentLedger {
  return [...ledger, { scope, granted: false, at, policyVersion }];
}

/** The effective consent record for `scope` at `at`, or `null` if never asked. */
export function consentAt(ledger: ConsentLedger, scope: ConsentScope, at: Instant): ConsentRecord | null {
  let latest: ConsentRecord | null = null;
  for (const record of ledger) {
    if (record.scope !== scope || record.at > at) continue;
    if (!latest || record.at >= latest.at) latest = record;
  }
  return latest;
}

export function hasConsent(ledger: ConsentLedger, scope: ConsentScope, at: Instant): boolean {
  return consentAt(ledger, scope, at)?.granted === true;
}
