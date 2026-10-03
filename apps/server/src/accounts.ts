import { enrollInSeason, redeemAccessCode, type RedemptionFailure } from '@lifeos/eclipse';
import { CONSENT_SCOPES, type ConsentLedger, type ConsentScope } from '@lifeos/promethee';
import { randomUUID } from 'node:crypto';
import type { AuthService, SessionInfo } from './auth.js';
import { insertCode, listCodes, loadCode, recordRedemption, summarizeCode, type CodeSummary } from './codes.js';
import { transaction, type Db, type Queryable } from './db.js';
import {
  ACCOUNT_COLUMNS,
  DEFAULT_PRIVACY,
  PRIVACY_POLICY_VERSION,
  TERMS_VERSION,
  ageOn,
  findAccount,
  toAccount,
  type Account,
  type AccountRow,
  type PrivacySettings,
} from './model.js';
import { insertEnrollment, listEnrollments, seasonForCampaign, type EnrollmentView } from './seasons.js';
import { AppError, audit, notFound } from './support.js';

/** Friend invites each member may have outstanding at once. */
export const INVITE_QUOTA = 3;
export const INVITE_TTL = 14 * 24 * 60 * 60_000;

export interface RegisterInput {
  readonly registrationToken: string;
  readonly accessCode: string;
  readonly birthDate: string;
  readonly region: string;
  readonly displayName: string;
  readonly acceptedTerms: string;
  readonly deviceLabel: string;
}

export interface Profile extends Account {
  readonly enrollments: readonly EnrollmentView[];
}

const REDEMPTION_MESSAGES: Record<RedemptionFailure, string> = {
  revoked: 'This access code is no longer active.',
  expired: 'This access code has expired.',
  exhausted: 'This access code has been fully used.',
  already_redeemed: 'You have already used this access code.',
  self_invite: 'You cannot use your own invite.',
  age_ineligible: 'LifeOS is for adults only.',
  region_ineligible: 'This access code is not available in your region yet.',
};

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly now: () => number,
  ) {}

  /**
   * Creates an account from a verified email and a valid access code, then
   * signs it in. Everything happens in one transaction: if the code is
   * rejected, the registration ticket stays usable.
   */
  async register(input: RegisterInput): Promise<{ token: string; account: Account }> {
    if (input.acceptedTerms !== TERMS_VERSION) {
      throw new AppError(422, 'terms_outdated', 'Please review and accept the current terms.');
    }
    const now = this.now();
    const age = ageOn(input.birthDate, now);

    return transaction(this.db, async (tx) => {
      const email = await this.auth.consumeRegistration(tx, input.registrationToken);
      const taken = await tx.query('SELECT 1 FROM accounts WHERE email = $1', [email]);
      if (taken.rowCount) throw new AppError(409, 'account_exists', 'An account with this email already exists. Sign in instead.');

      const code = await loadCode(tx, input.accessCode, true);
      if (!code) throw new AppError(422, 'invalid_access_code', 'That access code was not found.');
      const accountId = randomUUID();
      const redemption = redeemAccessCode(code, { userId: accountId, declaredAge: age, region: input.region, now });
      if (!redemption.ok) {
        throw new AppError(422, `access_code_${redemption.reason}`, REDEMPTION_MESSAGES[redemption.reason]);
      }

      const { rows } = await tx.query<AccountRow>(
        `INSERT INTO accounts (id, email, display_name, region, campaign, terms_version, age_gate_passed_at, privacy, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7) RETURNING ${ACCOUNT_COLUMNS}`,
        [accountId, email, input.displayName, input.region, code.campaign, TERMS_VERSION, new Date(now), JSON.stringify(DEFAULT_PRIVACY)],
      );
      await recordRedemption(tx, code.code, accountId, now);

      const season = await seasonForCampaign(tx, code.campaign, now);
      if (season) {
        const enrollment = enrollInSeason(season, [], {
          userId: accountId,
          campaign: code.campaign,
          // Competitive ranking is opt-in (blueprint §13).
          leaderboardOptIn: false,
          bracket: 'founding',
          now,
        });
        if (enrollment.ok) await insertEnrollment(tx, enrollment.enrollment);
      }

      await audit(tx, now, { kind: 'account', id: accountId }, 'account.created', accountId, {
        campaign: code.campaign,
        codeType: code.type,
        seasonId: season?.id ?? null,
      });
      const token = await this.auth.createSession(tx, accountId, input.deviceLabel);
      return { token, account: toAccount(rows[0]!) };
    });
  }

  async profile(accountId: string): Promise<Profile> {
    const account = await findAccount(this.db, accountId);
    if (!account) throw notFound('Account');
    return { ...account, enrollments: await listEnrollments(this.db, accountId) };
  }

  async updateProfile(accountId: string, patch: { displayName?: string; privacy?: Partial<PrivacySettings> }): Promise<Profile> {
    const current = await this.profile(accountId);
    const privacy = { ...current.privacy, ...patch.privacy };
    await this.db.query('UPDATE accounts SET display_name = $2, privacy = $3 WHERE id = $1', [
      accountId,
      patch.displayName ?? current.displayName,
      JSON.stringify(privacy),
    ]);
    if (patch.privacy) {
      await audit(this.db, this.now(), { kind: 'account', id: accountId }, 'privacy.updated', accountId, { privacy });
    }
    return this.profile(accountId);
  }

  async setLeaderboardOptIn(accountId: string, seasonId: string, optIn: boolean): Promise<Profile> {
    const result = await this.db.query(
      'UPDATE season_enrollments SET leaderboard_opt_in = $3 WHERE account_id = $1 AND season_id = $2',
      [accountId, seasonId, optIn],
    );
    if (result.rowCount === 0) throw notFound('Season enrollment');
    await audit(this.db, this.now(), { kind: 'account', id: accountId }, 'leaderboard.opt_in', seasonId, { optIn });
    return this.profile(accountId);
  }

  // --- consent ---------------------------------------------------------------

  async consentLedger(db: Queryable, accountId: string): Promise<ConsentLedger> {
    const { rows } = await db.query<{ scope: ConsentScope; granted: boolean; at: Date; policy_version: string }>(
      'SELECT scope, granted, at, policy_version FROM consents WHERE account_id = $1 ORDER BY id',
      [accountId],
    );
    return rows.map((row) => ({ scope: row.scope, granted: row.granted, at: row.at.getTime(), policyVersion: row.policy_version }));
  }

  consents(accountId: string): Promise<ConsentLedger> {
    return this.consentLedger(this.db, accountId);
  }

  async setConsent(accountId: string, scope: ConsentScope, granted: boolean): Promise<ConsentLedger> {
    if (!CONSENT_SCOPES.includes(scope)) throw new AppError(422, 'invalid_scope', 'Unknown consent scope');
    const now = this.now();
    await this.db.query('INSERT INTO consents (account_id, scope, granted, at, policy_version) VALUES ($1, $2, $3, $4, $5)', [
      accountId,
      scope,
      granted,
      new Date(now),
      PRIVACY_POLICY_VERSION,
    ]);
    await audit(this.db, now, { kind: 'account', id: accountId }, granted ? 'consent.granted' : 'consent.revoked', accountId, { scope });
    return this.consentLedger(this.db, accountId);
  }

  // --- invites ---------------------------------------------------------------

  async issueInvite(account: Account): Promise<CodeSummary> {
    const now = this.now();
    return transaction(this.db, async (tx) => {
      // Serialize invite issuance per account so the quota can't be raced.
      await tx.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
      const open = (await listCodes(tx, { issuedBy: account.id })).filter(
        (code) => !code.revokedAt && (code.expiresAt ?? Infinity) > now && code.redeemedBy.length < code.maxRedemptions,
      );
      if (open.length >= INVITE_QUOTA) {
        throw new AppError(409, 'invite_quota', `You can have ${INVITE_QUOTA} unused invites at a time.`);
      }
      const code = await insertCode(tx, {
        type: 'friend_invite',
        campaign: account.campaign,
        now,
        maxRedemptions: 1,
        expiresAt: now + INVITE_TTL,
        issuedBy: account.id,
      });
      await audit(tx, now, { kind: 'account', id: account.id }, 'invite.issued', code.code);
      return summarizeCode(code);
    });
  }

  async listInvites(accountId: string): Promise<CodeSummary[]> {
    return (await listCodes(this.db, { issuedBy: accountId })).map(summarizeCode);
  }

  // --- data rights -------------------------------------------------------------

  async exportData(accountId: string, sessions: readonly SessionInfo[]): Promise<Record<string, unknown>> {
    const profile = await this.profile(accountId);
    const events = await this.db.query<{ event: unknown }>(
      'SELECT event FROM activity_events WHERE account_id = $1 ORDER BY starts_at',
      [accountId],
    );
    return {
      format: 'lifeos.account-export',
      version: 1,
      exportedAt: this.now(),
      profile,
      consents: await this.consentLedger(this.db, accountId),
      sessions,
      invites: await this.listInvites(accountId),
      activityEvents: events.rows.map((row) => row.event),
      ...(await this.gameData(accountId)),
    };
  }

  private async gameData(accountId: string): Promise<Record<string, unknown>> {
    const rows = async (sql: string) => (await this.db.query(sql, [accountId])).rows;
    return {
      corrections: await rows('SELECT event_id, correction, at FROM activity_corrections WHERE account_id = $1 ORDER BY id'),
      awards: (await rows('SELECT award FROM game_awards WHERE account_id = $1 ORDER BY created_at')).map((r) => r.award),
      quests: await rows('SELECT id, template, starts_at, ends_at, skipped_at FROM quests WHERE account_id = $1 ORDER BY starts_at'),
      priorities: await rows('SELECT local_date, text, skill, done_at, created_at FROM priorities WHERE account_id = $1 ORDER BY created_at'),
      recapFeedback: await rows('SELECT week_start, accurate, at FROM recap_feedback WHERE account_id = $1 ORDER BY week_start'),
    };
  }

  /** Deletes the account and everything that belongs to it, immediately. */
  async deleteAccount(account: Account, confirmEmail: string): Promise<void> {
    if (confirmEmail.trim().toLowerCase() !== account.email) {
      throw new AppError(422, 'confirmation_mismatch', 'Type your account email to confirm deletion.');
    }
    await transaction(this.db, async (tx) => {
      await tx.query('DELETE FROM accounts WHERE id = $1', [account.id]);
      await audit(tx, this.now(), { kind: 'account', id: account.id }, 'account.deleted', account.id);
    });
  }
}
