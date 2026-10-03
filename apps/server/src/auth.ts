import { randomUUID } from 'node:crypto';
import { hmac, newSignInCode, newToken, safeEqualHex, sha256 } from './crypto.js';
import { transaction, type Db, type Queryable } from './db.js';
import { ACCOUNT_COLUMNS, normalizeEmail, toAccount, type Account, type AccountRow } from './model.js';
import { AppError, tooMany, unauthorized, type Mailer } from './support.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SIGN_IN_CODE_TTL = 10 * MINUTE;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_SENDS_PER_HOUR = 5;
export const REGISTRATION_TTL = 30 * MINUTE;
/** Sliding: each use (at most hourly) pushes expiry out again. */
export const SESSION_TTL = 30 * DAY;

export interface AuthDeps {
  readonly db: Db;
  readonly mailer: Mailer;
  readonly secret: string;
  readonly now: () => number;
}

export type VerifyResult =
  | { readonly kind: 'session'; readonly token: string; readonly account: Account }
  | { readonly kind: 'registration_required'; readonly registrationToken: string; readonly email: string };

export interface Authenticated {
  readonly account: Account;
  readonly sessionId: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly deviceLabel: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly expiresAt: number;
  readonly current: boolean;
}

const invalidCode = () => new AppError(400, 'invalid_code', 'That code is wrong or has expired. Request a new one.');

/**
 * Passwordless sign-in: an emailed six-digit code. Codes are stored as an
 * HMAC, expire in 10 minutes and allow five attempts; sessions are opaque
 * tokens stored only as SHA-256 hashes.
 */
export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  /** Always succeeds silently for unknown emails, so it can't be used to probe accounts. */
  async startSignIn(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const now = this.deps.now();
    const code = newSignInCode();
    await transaction(this.deps.db, async (tx) => {
      const { rows } = await tx.query<{ window_start: Date; sends_in_window: number }>(
        'SELECT window_start, sends_in_window FROM sign_in_challenges WHERE email = $1 FOR UPDATE',
        [email],
      );
      const existing = rows[0];
      const sameWindow = existing && now - existing.window_start.getTime() < HOUR;
      if (sameWindow && existing.sends_in_window >= MAX_SENDS_PER_HOUR) throw tooMany();
      await tx.query(
        `INSERT INTO sign_in_challenges (email, code_hash, expires_at, attempts, window_start, sends_in_window)
         VALUES ($1, $2, $3, 0, $4, $5)
         ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = $3, attempts = 0, window_start = $4, sends_in_window = $5`,
        [
          email,
          this.codeHash(email, code),
          new Date(now + SIGN_IN_CODE_TTL),
          sameWindow ? existing.window_start : new Date(now),
          sameWindow ? existing.sends_in_window + 1 : 1,
        ],
      );
    });
    await this.deps.mailer.send({
      to: email,
      subject: `Your LifeOS sign-in code: ${code}`,
      text: `Your LifeOS sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
    });
  }

  async verify(rawEmail: string, code: string, deviceLabel: string): Promise<VerifyResult> {
    const email = normalizeEmail(rawEmail);
    const now = this.deps.now();
    // Failed attempts must be committed, so the outcome is decided first and thrown after.
    const outcome = await transaction(this.deps.db, async (tx) => {
      const { rows } = await tx.query<{ code_hash: string; expires_at: Date; attempts: number }>(
        'SELECT code_hash, expires_at, attempts FROM sign_in_challenges WHERE email = $1 FOR UPDATE',
        [email],
      );
      const challenge = rows[0];
      if (!challenge || challenge.expires_at.getTime() <= now) return { ok: false as const };
      if (!/^\d{6}$/.test(code) || !safeEqualHex(challenge.code_hash, this.codeHash(email, code))) {
        if (challenge.attempts + 1 >= MAX_CODE_ATTEMPTS) {
          await tx.query('DELETE FROM sign_in_challenges WHERE email = $1', [email]);
        } else {
          await tx.query('UPDATE sign_in_challenges SET attempts = attempts + 1 WHERE email = $1', [email]);
        }
        return { ok: false as const };
      }
      await tx.query('DELETE FROM sign_in_challenges WHERE email = $1', [email]);

      const account = await tx.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE email = $1`, [email]);
      if (account.rows[0]) {
        const token = await this.createSession(tx, account.rows[0].id, deviceLabel);
        return { ok: true as const, result: { kind: 'session' as const, token, account: toAccount(account.rows[0]) } };
      }
      const registrationToken = newToken('lo_reg');
      await tx.query('INSERT INTO registration_tickets (token_hash, email, expires_at) VALUES ($1, $2, $3)', [
        sha256(registrationToken),
        email,
        new Date(now + REGISTRATION_TTL),
      ]);
      return { ok: true as const, result: { kind: 'registration_required' as const, registrationToken, email } };
    });
    if (!outcome.ok) throw invalidCode();
    return outcome.result;
  }

  /** Marks a registration ticket used and returns its verified email. */
  async consumeRegistration(tx: Queryable, token: string): Promise<string> {
    const { rows } = await tx.query<{ email: string }>(
      `UPDATE registration_tickets SET used_at = $2
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
       RETURNING email`,
      [sha256(token), new Date(this.deps.now())],
    );
    if (!rows[0]) throw new AppError(410, 'registration_expired', 'Your sign-up link expired. Sign in again to continue.');
    return rows[0].email;
  }

  async createSession(tx: Queryable, accountId: string, deviceLabel: string): Promise<string> {
    const now = this.deps.now();
    const token = newToken('lo_s');
    await tx.query(
      `INSERT INTO sessions (id, account_id, token_hash, device_label, created_at, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [randomUUID(), accountId, sha256(token), deviceLabel, new Date(now), new Date(now + SESSION_TTL)],
    );
    return token;
  }

  async authenticate(token: string | undefined): Promise<Authenticated> {
    if (!token || !token.startsWith('lo_s_') || token.length > 100) throw unauthorized();
    const now = this.deps.now();
    const { rows } = await this.deps.db.query<AccountRow & { session_id: string; last_used_at: Date }>(
      `SELECT s.id AS session_id, s.last_used_at, ${ACCOUNT_COLUMNS.split(', ').map((c) => `a.${c}`).join(', ')}
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [sha256(token), new Date(now)],
    );
    const row = rows[0];
    if (!row) throw unauthorized();
    if (now - row.last_used_at.getTime() > HOUR) {
      await this.deps.db.query('UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1', [
        row.session_id,
        new Date(now),
        new Date(now + SESSION_TTL),
      ]);
    }
    return { account: toAccount(row), sessionId: row.session_id };
  }

  async listSessions(accountId: string, currentId: string): Promise<SessionInfo[]> {
    const { rows } = await this.deps.db.query<{
      id: string;
      device_label: string;
      created_at: Date;
      last_used_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, device_label, created_at, last_used_at, expires_at FROM sessions
       WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_used_at DESC`,
      [accountId, new Date(this.deps.now())],
    );
    return rows.map((row) => ({
      id: row.id,
      deviceLabel: row.device_label,
      createdAt: row.created_at.getTime(),
      lastUsedAt: row.last_used_at.getTime(),
      expiresAt: row.expires_at.getTime(),
      current: row.id === currentId,
    }));
  }

  async revokeSession(accountId: string, sessionId: string): Promise<void> {
    const result = await this.deps.db.query(
      'UPDATE sessions SET revoked_at = $3 WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL',
      [sessionId, accountId, new Date(this.deps.now())],
    );
    if (result.rowCount === 0) throw new AppError(404, 'not_found', 'Session not found');
  }

  private codeHash(email: string, code: string): string {
    return hmac(this.deps.secret, `sign-in:${email}:${code}`);
  }
}
