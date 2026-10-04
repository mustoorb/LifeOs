import type { Instant } from '@lifeos/contracts';

/**
 * Access codes are an onboarding and community-quality mechanism, not
 * security (blueprint §14). They gate who joins a cohort, nothing more.
 */
export type AccessCodeType = 'founding' | 'friend_invite' | 'partner' | 'staff' | 'recovery';

export interface AccessCode {
  readonly code: string;
  readonly type: AccessCodeType;
  readonly campaign: string;
  readonly createdAt: Instant;
  readonly expiresAt?: Instant;
  readonly maxRedemptions: number;
  readonly redeemedBy: readonly string[];
  readonly revokedAt?: Instant;
  /** Product minimum is 18 (blueprint §3); a campaign may only raise it. */
  readonly minAge: number;
  /** ISO 3166-1 alpha-2 region allow-list; absent means no restriction. */
  readonly regions?: readonly string[];
  /** Who issued a friend invite, so they cannot redeem their own. */
  readonly issuedBy?: string;
}

export const MINIMUM_AGE = 18;

/** Crockford base32: no I, L, O or U, so codes survive being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateCode(random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
  const bytes = random(new Uint8Array(8));
  // 256 is a multiple of 32, so `byte % 32` is unbiased.
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]!);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Canonical form for lookup: tolerant of case, spaces, dashes and look-alikes. */
export function normalizeCode(input: string): string {
  const compact = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export function createAccessCode(input: {
  type: AccessCodeType;
  campaign: string;
  now: Instant;
  maxRedemptions: number;
  expiresAt?: Instant;
  minAge?: number;
  regions?: readonly string[];
  issuedBy?: string;
  random?: (bytes: Uint8Array) => Uint8Array;
}): AccessCode {
  if (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1) {
    throw new Error('maxRedemptions must be a positive integer');
  }
  if (input.expiresAt !== undefined && input.expiresAt <= input.now) {
    throw new Error('expiresAt must be in the future');
  }
  return {
    code: generateCode(input.random),
    type: input.type,
    campaign: input.campaign,
    createdAt: input.now,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    maxRedemptions: input.maxRedemptions,
    redeemedBy: [],
    minAge: Math.max(MINIMUM_AGE, input.minAge ?? MINIMUM_AGE),
    ...(input.regions ? { regions: input.regions.map((region) => region.toUpperCase()) } : {}),
    ...(input.issuedBy ? { issuedBy: input.issuedBy } : {}),
  };
}

export type RedemptionFailure =
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'already_redeemed'
  | 'self_invite'
  | 'age_ineligible'
  | 'region_ineligible';

export type RedemptionResult =
  | { readonly ok: true; readonly code: AccessCode; readonly campaign: string }
  | { readonly ok: false; readonly reason: RedemptionFailure };

export function redeemAccessCode(
  code: AccessCode,
  request: { userId: string; declaredAge: number; region: string; now: Instant },
): RedemptionResult {
  if (code.revokedAt !== undefined && code.revokedAt <= request.now) return fail('revoked');
  if (code.expiresAt !== undefined && request.now >= code.expiresAt) return fail('expired');
  if (code.redeemedBy.includes(request.userId)) return fail('already_redeemed');
  if (code.redeemedBy.length >= code.maxRedemptions) return fail('exhausted');
  if (code.issuedBy === request.userId) return fail('self_invite');
  if (!Number.isFinite(request.declaredAge) || request.declaredAge < Math.max(MINIMUM_AGE, code.minAge)) {
    return fail('age_ineligible');
  }
  if (code.regions && !code.regions.includes(request.region.toUpperCase())) return fail('region_ineligible');
  return {
    ok: true,
    code: { ...code, redeemedBy: [...code.redeemedBy, request.userId] },
    campaign: code.campaign,
  };
}

export function revokeAccessCode(code: AccessCode, now: Instant): AccessCode {
  return code.revokedAt !== undefined ? code : { ...code, revokedAt: now };
}

function fail(reason: RedemptionFailure): RedemptionResult {
  return { ok: false, reason };
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}
