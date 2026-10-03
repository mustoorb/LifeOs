import type { AccessCodeType, LeaderboardConfig, Season } from '@lifeos/eclipse';
import { insertCode, listCodes, loadCode, summarizeCode, type CodeSummary } from './codes.js';
import { transaction, type Db } from './db.js';
import type { Role } from './model.js';
import { insertSeason, listSeasons } from './seasons.js';
import { AppError, audit, notFound, type Actor } from './support.js';

export interface IssueCodesInput {
  readonly type: Exclude<AccessCodeType, 'friend_invite'>;
  readonly campaign: string;
  readonly count: number;
  readonly maxRedemptions: number;
  readonly expiresAt?: number;
  readonly minAge?: number;
  readonly regions?: readonly string[];
}

export interface SeasonInput {
  readonly id: string;
  readonly name: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly campaigns: readonly string[];
  readonly xpRulesetVersion: string;
  readonly leaderboard?: LeaderboardConfig;
}

export interface AccountSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly campaign: string;
  readonly createdAt: number;
}

export interface AuditEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly details: unknown;
}

/** Operations behind the admin role and the CLI. Every change is audited. */
export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  async issueCodes(actor: Actor, input: IssueCodesInput): Promise<CodeSummary[]> {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 500) {
      throw new AppError(422, 'invalid_count', 'Issue between 1 and 500 codes at a time');
    }
    if (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1 || input.maxRedemptions > 10_000) {
      throw new AppError(422, 'invalid_max_redemptions', 'maxRedemptions must be between 1 and 10000');
    }
    const now = this.now();
    if (input.expiresAt !== undefined && input.expiresAt <= now) {
      throw new AppError(422, 'invalid_expiry', 'expiresAt must be in the future');
    }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(input.campaign)) {
      throw new AppError(422, 'invalid_campaign', 'Campaign must be lowercase letters, digits and dashes');
    }
    return transaction(this.db, async (tx) => {
      const codes: CodeSummary[] = [];
      for (let i = 0; i < input.count; i++) {
        codes.push(
          summarizeCode(
            await insertCode(tx, {
              type: input.type,
              campaign: input.campaign,
              now,
              maxRedemptions: input.maxRedemptions,
              ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
              ...(input.minAge !== undefined ? { minAge: input.minAge } : {}),
              ...(input.regions ? { regions: input.regions } : {}),
            }),
          ),
        );
      }
      await audit(tx, now, actor, 'access_codes.issued', input.campaign, {
        type: input.type,
        count: input.count,
        maxRedemptions: input.maxRedemptions,
      });
      return codes;
    });
  }

  async listCodes(campaign?: string): Promise<CodeSummary[]> {
    return (await listCodes(this.db, campaign ? { campaign } : {})).map(summarizeCode);
  }

  async revokeCode(actor: Actor, input: string): Promise<CodeSummary> {
    const now = this.now();
    return transaction(this.db, async (tx) => {
      const code = await loadCode(tx, input, true);
      if (!code) throw notFound('Access code');
      if (code.revokedAt === undefined) {
        await tx.query('UPDATE access_codes SET revoked_at = $2 WHERE code = $1', [code.code, new Date(now)]);
        await audit(tx, now, actor, 'access_code.revoked', code.code);
      }
      return summarizeCode((await loadCode(tx, code.code))!);
    });
  }

  async createSeason(actor: Actor, input: SeasonInput): Promise<Season> {
    return transaction(this.db, async (tx) => {
      const season = await insertSeason(tx, {
        id: input.id,
        name: input.name,
        window: { start: input.startsAt, end: input.endsAt },
        xpRulesetVersion: input.xpRulesetVersion,
        campaigns: input.campaigns,
        ...(input.leaderboard ? { leaderboard: input.leaderboard } : {}),
      });
      await audit(tx, this.now(), actor, 'season.created', season.id, { campaigns: season.campaigns });
      return season;
    });
  }

  listSeasons(): Promise<Season[]> {
    return listSeasons(this.db);
  }

  async listAccounts(limit = 100, offset = 0): Promise<AccountSummary[]> {
    const { rows } = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      role: Role;
      campaign: string;
      created_at: Date;
    }>('SELECT id, email, display_name, role, campaign, created_at FROM accounts ORDER BY created_at DESC LIMIT $1 OFFSET $2', [
      Math.min(Math.max(limit, 1), 500),
      Math.max(offset, 0),
    ]);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      campaign: row.campaign,
      createdAt: row.created_at.getTime(),
    }));
  }

  /** Grants or removes the admin role, by account id or email. */
  async setRole(actor: Actor, accountIdOrEmail: string, role: Role): Promise<void> {
    const byEmail = accountIdOrEmail.includes('@');
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE accounts SET role = $2 WHERE ${byEmail ? 'email = lower($1)' : 'id::text = $1'} RETURNING id`,
      [accountIdOrEmail, role],
    );
    if (!rows[0]) throw notFound('Account');
    await audit(this.db, this.now(), actor, 'role.changed', rows[0].id, { role });
  }

  async auditLog(limit = 100): Promise<AuditEntry[]> {
    const { rows } = await this.db.query<{
      id: string;
      at: Date;
      actor: string;
      action: string;
      target: string | null;
      details: unknown;
    }>('SELECT id, at, actor, action, target, details FROM audit_log ORDER BY id DESC LIMIT $1', [Math.min(Math.max(limit, 1), 1000)]);
    return rows.map((row) => ({ id: Number(row.id), at: row.at.getTime(), actor: row.actor, action: row.action, target: row.target, details: row.details }));
  }
}
