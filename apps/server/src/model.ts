import { z } from 'zod';
import type { Queryable } from './db.js';
import { AppError } from './support.js';

export const TERMS_VERSION = 'terms-2026-10';
export const PRIVACY_POLICY_VERSION = 'privacy-2026-10';

export const PrivacySettings = z.object({
  /** Who can see the profile. Private by default (blueprint §13, §16.4). */
  profileVisibility: z.enum(['private', 'friends']),
  /** Visibility applied to newly ingested activity. */
  defaultActivityVisibility: z.enum(['private', 'friends']),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

export const DEFAULT_PRIVACY: PrivacySettings = { profileVisibility: 'private', defaultActivityVisibility: 'private' };

export type Role = 'member' | 'admin';

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly region: string;
  readonly campaign: string;
  readonly termsVersion: string;
  readonly privacy: PrivacySettings;
  readonly timeZone: string;
  readonly createdAt: number;
}

export interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  region: string;
  campaign: string;
  terms_version: string;
  privacy: unknown;
  time_zone: string;
  created_at: Date;
}

export const ACCOUNT_COLUMNS = 'id, email, display_name, role, region, campaign, terms_version, privacy, time_zone, created_at';

export function toAccount(row: AccountRow): Account {
  const privacy = PrivacySettings.safeParse(row.privacy);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    region: row.region,
    campaign: row.campaign,
    termsVersion: row.terms_version,
    privacy: privacy.success ? privacy.data : DEFAULT_PRIVACY,
    timeZone: row.time_zone,
    createdAt: row.created_at.getTime(),
  };
}

export async function findAccount(db: Queryable, id: string): Promise<Account | null> {
  const { rows } = await db.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new AppError(422, 'invalid_email', 'Enter a valid email address');
  return email;
}

/** Whole years between a `YYYY-MM-DD` birth date and `now` (UTC). */
export function ageOn(birthDate: string, now: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || date.getUTCDate() !== Number(match![3]) || date.getTime() > now) {
    throw new AppError(422, 'invalid_birth_date', 'Enter a valid date of birth');
  }
  const today = new Date(now);
  let age = today.getUTCFullYear() - date.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < date.getUTCMonth() ||
    (today.getUTCMonth() === date.getUTCMonth() && today.getUTCDate() < date.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export function isTimeZone(value: string): boolean {
  if (value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
