import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
/** Anything that can run a query: the pool or a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle connection dropped by the server (restart, failover) must not crash the process.
  pool.on('error', (error) => console.error('[db] idle connection error:', error.message));
  return pool;
}

export async function transaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Forward-only migrations. Each entry runs once, in order, inside a
 * transaction, guarded by an advisory lock so concurrent starts are safe.
 */
export const MIGRATIONS: readonly { readonly id: number; readonly name: string; readonly sql: string }[] = [
  {
    id: 1,
    name: 'accounts, auth, access codes, seasons',
    sql: `
      CREATE TABLE accounts (
        id uuid PRIMARY KEY,
        email text NOT NULL UNIQUE,
        display_name text NOT NULL,
        role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
        region text NOT NULL,
        campaign text NOT NULL,
        terms_version text NOT NULL,
        -- Only the fact that the age gate passed is kept, never the birth date.
        age_gate_passed_at timestamptz NOT NULL,
        privacy jsonb NOT NULL,
        created_at timestamptz NOT NULL
      );

      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        device_label text NOT NULL,
        created_at timestamptz NOT NULL,
        last_used_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      );
      CREATE INDEX sessions_account ON sessions(account_id);

      CREATE TABLE sign_in_challenges (
        email text PRIMARY KEY,
        code_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        window_start timestamptz NOT NULL,
        sends_in_window integer NOT NULL
      );

      CREATE TABLE registration_tickets (
        token_hash text PRIMARY KEY,
        email text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz
      );

      CREATE TABLE access_codes (
        code text PRIMARY KEY,
        type text NOT NULL,
        campaign text NOT NULL,
        created_at timestamptz NOT NULL,
        expires_at timestamptz,
        max_redemptions integer NOT NULL CHECK (max_redemptions > 0),
        min_age integer NOT NULL CHECK (min_age >= 18),
        regions text[],
        issued_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
        revoked_at timestamptz
      );
      CREATE INDEX access_codes_campaign ON access_codes(campaign);
      CREATE INDEX access_codes_issued_by ON access_codes(issued_by);

      -- Kept when an account is deleted so a redemption cap can't be reopened.
      CREATE TABLE access_code_redemptions (
        id bigserial PRIMARY KEY,
        code text NOT NULL REFERENCES access_codes(code),
        account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
        redeemed_at timestamptz NOT NULL
      );
      CREATE INDEX redemptions_code ON access_code_redemptions(code);

      CREATE TABLE seasons (
        id text PRIMARY KEY,
        name text NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
        xp_ruleset_version text NOT NULL,
        quest_ids text[] NOT NULL DEFAULT '{}',
        campaigns text[] NOT NULL,
        leaderboard jsonb NOT NULL
      );

      CREATE TABLE season_enrollments (
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        season_id text NOT NULL REFERENCES seasons(id),
        enrolled_at timestamptz NOT NULL,
        campaign text NOT NULL,
        leaderboard_opt_in boolean NOT NULL DEFAULT false,
        bracket text NOT NULL,
        PRIMARY KEY (account_id, season_id)
      );

      -- Append-only consent ledger, mirroring @lifeos/promethee.
      CREATE TABLE consents (
        id bigserial PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        scope text NOT NULL,
        granted boolean NOT NULL,
        at timestamptz NOT NULL,
        policy_version text NOT NULL
      );
      CREATE INDEX consents_account ON consents(account_id);

      -- Immutable, normalized source events. Re-ingesting the same id is a no-op.
      CREATE TABLE activity_events (
        id text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        type text NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        event jsonb NOT NULL
      );
      CREATE INDEX activity_events_account_time ON activity_events(account_id, starts_at);

      -- Who did what, without personal data: actors and targets are opaque ids.
      CREATE TABLE audit_log (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL,
        actor text NOT NULL,
        action text NOT NULL,
        target text,
        details jsonb NOT NULL DEFAULT '{}'
      );
    `,
  },
  {
    id: 2,
    name: 'ECLIPSE home: activities, corrections, awards, quests, priorities, recaps',
    sql: `
      -- Local "today" and "this week" need the member's zone; set by the clients.
      ALTER TABLE accounts ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';

      -- Derived from activity_events by @lifeos/promethee; rebuilt on every refresh.
      CREATE TABLE activities (
        id text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        activity jsonb NOT NULL
      );
      CREATE INDEX activities_account_time ON activities(account_id, starts_at);

      -- The member's corrections, anchored to a source event so they survive re-derivation.
      CREATE TABLE activity_corrections (
        id bigserial PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        event_id text NOT NULL,
        correction jsonb NOT NULL,
        at timestamptz NOT NULL
      );
      CREATE INDEX activity_corrections_account ON activity_corrections(account_id);

      -- The XP ledger. Rows change only from awarded/pending/provisional to reversed.
      CREATE TABLE game_awards (
        id text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        award_type text NOT NULL,
        activity_id text,
        activity_starts_at timestamptz,
        quest_id text,
        status text NOT NULL,
        xp integer NOT NULL,
        created_at timestamptz NOT NULL,
        award jsonb NOT NULL
      );
      CREATE INDEX game_awards_account ON game_awards(account_id, created_at);

      CREATE TABLE quests (
        id text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        template text NOT NULL,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        skipped_at timestamptz,
        definition jsonb NOT NULL
      );
      CREATE INDEX quests_account_time ON quests(account_id, ends_at);

      -- Up to three things the member intends to do on a given local day.
      CREATE TABLE priorities (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        local_date text NOT NULL,
        text text NOT NULL,
        skill text,
        position integer NOT NULL,
        done_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE INDEX priorities_account_date ON priorities(account_id, local_date);

      -- "Did this recap represent your week?" — half of the north-star metric.
      CREATE TABLE recap_feedback (
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        week_start text NOT NULL,
        accurate boolean NOT NULL,
        at timestamptz NOT NULL,
        PRIMARY KEY (account_id, week_start)
      );
    `,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  return transaction(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(4242001)');
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await tx.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.id));
    const ran: number[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await tx.query(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [migration.id, migration.name]);
      ran.push(migration.id);
    }
    return ran;
  });
}

export const toDate = (ms: number): Date => new Date(ms);
export const toMs = (value: Date | null): number | null => (value === null ? null : value.getTime());
