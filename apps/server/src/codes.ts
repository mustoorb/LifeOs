import { createAccessCode, normalizeCode, type AccessCode, type AccessCodeType } from '@lifeos/eclipse';
import type { Queryable } from './db.js';

interface CodeRow {
  code: string;
  type: AccessCodeType;
  campaign: string;
  created_at: Date;
  expires_at: Date | null;
  max_redemptions: number;
  min_age: number;
  regions: string[] | null;
  issued_by: string | null;
  revoked_at: Date | null;
  redeemed_by: (string | null)[];
}

const SELECT = `
  SELECT c.code, c.type, c.campaign, c.created_at, c.expires_at, c.max_redemptions, c.min_age,
         c.regions, c.issued_by, c.revoked_at,
         COALESCE(array_agg(r.account_id ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '{}') AS redeemed_by
  FROM access_codes c LEFT JOIN access_code_redemptions r ON r.code = c.code`;

function toAccessCode(row: CodeRow): AccessCode {
  return {
    code: row.code,
    type: row.type,
    campaign: row.campaign,
    createdAt: row.created_at.getTime(),
    ...(row.expires_at ? { expiresAt: row.expires_at.getTime() } : {}),
    maxRedemptions: row.max_redemptions,
    // Redemptions by since-deleted accounts still count toward the cap.
    redeemedBy: row.redeemed_by.map((id, i) => id ?? `deleted-account-${i}`),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.getTime() } : {}),
    minAge: row.min_age,
    ...(row.regions ? { regions: row.regions } : {}),
    ...(row.issued_by ? { issuedBy: row.issued_by } : {}),
  };
}

/** Loads a code; with `lock`, holds a row lock until the transaction ends. */
export async function loadCode(db: Queryable, input: string, lock = false): Promise<AccessCode | null> {
  const code = normalizeCode(input);
  if (lock) await db.query('SELECT 1 FROM access_codes WHERE code = $1 FOR UPDATE', [code]);
  const { rows } = await db.query<CodeRow>(`${SELECT} WHERE c.code = $1 GROUP BY c.code`, [code]);
  return rows[0] ? toAccessCode(rows[0]) : null;
}

export async function listCodes(db: Queryable, filter: { campaign?: string; issuedBy?: string }): Promise<AccessCode[]> {
  const { rows } = await db.query<CodeRow>(
    `${SELECT}
     WHERE ($1::text IS NULL OR c.campaign = $1) AND ($2::uuid IS NULL OR c.issued_by = $2)
     GROUP BY c.code ORDER BY c.created_at DESC, c.code LIMIT 1000`,
    [filter.campaign ?? null, filter.issuedBy ?? null],
  );
  return rows.map(toAccessCode);
}

/** Creates and stores a new code, retrying on the (astronomically rare) collision. */
export async function insertCode(db: Queryable, input: Parameters<typeof createAccessCode>[0]): Promise<AccessCode> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = createAccessCode(input);
    const result = await db.query(
      `INSERT INTO access_codes (code, type, campaign, created_at, expires_at, max_redemptions, min_age, regions, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (code) DO NOTHING`,
      [
        code.code,
        code.type,
        code.campaign,
        new Date(code.createdAt),
        code.expiresAt === undefined ? null : new Date(code.expiresAt),
        code.maxRedemptions,
        code.minAge,
        code.regions ?? null,
        code.issuedBy ?? null,
      ],
    );
    if (result.rowCount === 1) return code;
  }
  throw new Error('Could not generate a unique access code');
}

export async function recordRedemption(db: Queryable, code: string, accountId: string, at: number): Promise<void> {
  await db.query('INSERT INTO access_code_redemptions (code, account_id, redeemed_at) VALUES ($1, $2, $3)', [
    code,
    accountId,
    new Date(at),
  ]);
}

export interface CodeSummary {
  readonly code: string;
  readonly type: AccessCodeType;
  readonly campaign: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly maxRedemptions: number;
  readonly redemptions: number;
  readonly minAge: number;
  readonly regions: readonly string[] | null;
}

/** What callers see: counts, never who redeemed a code. */
export function summarizeCode(code: AccessCode): CodeSummary {
  return {
    code: code.code,
    type: code.type,
    campaign: code.campaign,
    createdAt: code.createdAt,
    expiresAt: code.expiresAt ?? null,
    revokedAt: code.revokedAt ?? null,
    maxRedemptions: code.maxRedemptions,
    redemptions: code.redeemedBy.length,
    minAge: code.minAge,
    regions: code.regions ?? null,
  };
}
