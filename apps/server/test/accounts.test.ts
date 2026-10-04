import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CODE_ATTEMPTS, MAX_SENDS_PER_HOUR, SESSION_TTL } from '../src/auth.js';
import { INVITE_QUOTA } from '../src/accounts.js';
import { TERMS_VERSION } from '../src/model.js';
import { ADULT, T0, TEST_DATABASE_URL, createHarness, issueCode, member, requestCode, signUp, type Harness } from './harness.js';

const DAY = 24 * 60 * 60_000;

describe.skipIf(!TEST_DATABASE_URL)('accounts and sign-in', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.services.admin.createSeason({ kind: 'cli' }, {
      id: 'founding-1',
      name: 'Founding Season',
      startsAt: T0 - DAY,
      endsAt: T0 + 41 * DAY,
      campaigns: ['founding'],
      xpRulesetVersion: 'xp-v1',
    });
  });
  afterAll(() => h?.close());
  beforeEach(() => {
    h.clock.now += DAY; // keeps per-hour limits independent between tests
  });

  it('signs up with an emailed code and an access code, privately and opted out of ranking', async () => {
    const code = await issueCode(h);
    const result = await signUp(h, 'Ada@Example.com', code);
    expect(result.status).toBe(201);
    expect(result.body.token).toMatch(/^lo_s_/);
    expect(result.body.account).toMatchObject({ email: 'ada@example.com', displayName: 'Ada', region: 'FR', campaign: 'founding', role: 'member' });

    const me = await h.json('GET', '/v1/me', { token: result.body.token });
    expect(me.body.privacy).toEqual({ profileVisibility: 'private', defaultActivityVisibility: 'private' });
    expect(me.body.enrollments).toEqual([
      expect.objectContaining({ seasonId: 'founding-1', leaderboardOptIn: false, bracket: 'founding' }),
    ]);

    // Nothing personal reaches the audit log or the accounts table beyond what's needed.
    const audit = await h.db.query("SELECT details::text FROM audit_log WHERE action = 'account.created'");
    expect(audit.rows[0].details).not.toContain('example.com');
    const columns = await h.db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts'");
    expect(columns.rows.map((r) => r.column_name)).not.toContain('birth_date');
  });

  it('stores sign-in codes and session tokens only as hashes', async () => {
    const code = await requestCode(h, 'hash@example.com');
    const stored = await h.db.query("SELECT code_hash FROM sign_in_challenges WHERE email = 'hash@example.com'");
    expect(stored.rows[0].code_hash).not.toContain(code);

    const token = await member(h, 'tokens@example.com');
    const sessions = await h.db.query('SELECT token_hash FROM sessions');
    expect(sessions.rows.every((row) => !row.token_hash.includes(token.slice(5)))).toBe(true);
  });

  it('keeps the registration ticket usable when the access code is rejected', async () => {
    const email = 'retry@example.com';
    const code = await requestCode(h, email);
    const verified = await h.json('POST', '/v1/auth/verify', { body: { email, code } });
    const base = {
      registrationToken: verified.body.registrationToken,
      birthDate: ADULT,
      region: 'FR',
      displayName: 'Retry',
      acceptedTerms: TERMS_VERSION,
    };
    expect((await h.json('POST', '/v1/accounts', { body: { ...base, accessCode: 'ZZZZ-ZZZZ' } })).body.error.code).toBe('invalid_access_code');
    expect((await h.json('POST', '/v1/accounts', { body: { ...base, accessCode: await issueCode(h), acceptedTerms: 'terms-2020' } })).body.error.code).toBe('terms_outdated');
    const minor = await h.json('POST', '/v1/accounts', { body: { ...base, accessCode: await issueCode(h), birthDate: '2010-01-01' } });
    expect(minor).toMatchObject({ status: 422, body: { error: { code: 'access_code_age_ineligible' } } });
    const regional = await h.json('POST', '/v1/accounts', { body: { ...base, accessCode: await issueCode(h, { regions: ['DE'] }) } });
    expect(regional.body.error.code).toBe('access_code_region_ineligible');

    const ok = await h.json('POST', '/v1/accounts', { body: { ...base, accessCode: await issueCode(h) } });
    expect(ok.status).toBe(201);
    // A ticket works once.
    const again = await h.json('POST', '/v1/accounts', { body: { ...base, accessCode: await issueCode(h) } });
    expect(again).toMatchObject({ status: 410, body: { error: { code: 'registration_expired' } } });
  });

  it('never lets a single-use code be redeemed twice, even concurrently', async () => {
    const code = await issueCode(h, { maxRedemptions: 1 });
    const results = await Promise.all(['race1@example.com', 'race2@example.com', 'race3@example.com'].map((email) => signUp(h, email, code)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
    expect(results.filter((r) => r.status === 422).map((r) => r.body.error.code)).toEqual(['access_code_exhausted', 'access_code_exhausted']);
  });

  it('locks a sign-in code after too many wrong guesses, and expires it', async () => {
    const email = 'guess@example.com';
    await member(h, email);
    const code = await requestCode(h, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect((await h.json('POST', '/v1/auth/verify', { body: { email, code: wrong } })).body.error.code).toBe('invalid_code');
    }
    expect((await h.json('POST', '/v1/auth/verify', { body: { email, code } })).status).toBe(400);

    const fresh = await requestCode(h, email);
    h.clock.now += 11 * 60_000;
    expect((await h.json('POST', '/v1/auth/verify', { body: { email, code: fresh } })).status).toBe(400);
  });

  it('limits how many codes one email can receive per hour', async () => {
    const email = 'flood@example.com';
    for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) await requestCode(h, email);
    expect((await h.request('POST', '/v1/auth/start', { body: { email } })).status).toBe(429);
    h.clock.now += 61 * 60_000;
    expect((await h.request('POST', '/v1/auth/start', { body: { email } })).status).toBe(202);
  });

  it('signs existing members in, lists devices and revokes them', async () => {
    const email = 'devices@example.com';
    const first = await member(h, email);
    const code = await requestCode(h, email);
    const second = await h.json('POST', '/v1/auth/verify', { body: { email, code, deviceLabel: 'Phone' } });
    expect(second.body).toMatchObject({ status: 'signed_in', account: { email } });

    const sessions = await h.json('GET', '/v1/me/sessions', { token: first });
    expect(sessions.body.map((s: any) => [s.deviceLabel, s.current])).toEqual(
      expect.arrayContaining([['Test Mac', true], ['Phone', false]]),
    );
    const phone = sessions.body.find((s: any) => !s.current);
    expect((await h.request('DELETE', `/v1/me/sessions/${phone.id}`, { token: first })).status).toBe(204);
    expect((await h.request('GET', '/v1/me', { token: second.body.token })).status).toBe(401);

    expect((await h.request('POST', '/v1/auth/logout', { token: first })).status).toBe(204);
    expect((await h.request('GET', '/v1/me', { token: first })).status).toBe(401);
  });

  it('expires sessions that go unused', async () => {
    const token = await member(h, 'idle@example.com');
    h.clock.now += SESSION_TTL - DAY;
    expect((await h.request('GET', '/v1/me', { token })).status).toBe(200); // slides forward
    h.clock.now += SESSION_TTL - DAY;
    expect((await h.request('GET', '/v1/me', { token })).status).toBe(200);
    h.clock.now += SESSION_TTL + 1;
    expect((await h.request('GET', '/v1/me', { token })).status).toBe(401);
  });

  it('updates privacy settings and leaderboard opt-in', async () => {
    await h.services.admin.createSeason({ kind: 'cli' }, {
      id: 'privacy-1',
      name: 'Privacy',
      startsAt: h.clock.now,
      endsAt: h.clock.now + 42 * DAY,
      campaigns: ['privacy'],
      xpRulesetVersion: 'xp-v1',
    });
    const token = (await signUp(h, 'privacy@example.com', await issueCode(h, { campaign: 'privacy' }))).body.token;
    const updated = await h.json('PATCH', '/v1/me', { token, body: { privacy: { profileVisibility: 'friends' } } });
    expect(updated.body.privacy).toEqual({ profileVisibility: 'friends', defaultActivityVisibility: 'private' });
    expect((await h.json('PATCH', '/v1/me', { token, body: { privacy: { profileVisibility: 'public' } } })).status).toBe(422);

    const opted = await h.json('PUT', '/v1/me/enrollments/privacy-1', { token, body: { leaderboardOptIn: true } });
    expect(opted.body.enrollments[0].leaderboardOptIn).toBe(true);
    expect((await h.json('PUT', '/v1/me/enrollments/nope', { token, body: { leaderboardOptIn: true } })).status).toBe(404);
  });

  it('gives each member a small quota of single-use friend invites into their cohort', async () => {
    const token = await member(h, 'host@example.com');
    const invites: any[] = [];
    for (let i = 0; i < INVITE_QUOTA; i++) invites.push((await h.json('POST', '/v1/me/invites', { token })).body);
    expect(invites.every((invite) => invite.type === 'friend_invite' && invite.maxRedemptions === 1)).toBe(true);
    expect((await h.json('POST', '/v1/me/invites', { token })).body.error.code).toBe('invite_quota');

    const friend = await signUp(h, 'friend@example.com', invites[0].code);
    expect(friend.body.account.campaign).toBe('founding');
    // A used invite frees a slot.
    expect((await h.json('POST', '/v1/me/invites', { token })).status).toBe(201);
    const listed = await h.json('GET', '/v1/me/invites', { token });
    expect(listed.body.find((i: any) => i.code === invites[0].code).redemptions).toBe(1);
  });

  it('exports all of a member’s data and deletes the account on request', async () => {
    const accessCode = await issueCode(h, { maxRedemptions: 1 });
    const signed = await signUp(h, 'leaving@example.com', accessCode);
    const token = signed.body.token;
    await h.json('PUT', '/v1/me/consents/desktop_activity', { token, body: { granted: true } });

    const exported = await h.json('GET', '/v1/me/export', { token });
    expect(exported.body).toMatchObject({
      format: 'lifeos.account-export',
      profile: { email: 'leaving@example.com' },
      consents: [expect.objectContaining({ scope: 'desktop_activity', granted: true })],
      sessions: [expect.objectContaining({ current: true })],
    });

    expect((await h.json('DELETE', '/v1/me', { token, body: { confirmEmail: 'wrong@example.com' } })).status).toBe(422);
    expect((await h.request('DELETE', '/v1/me', { token, body: { confirmEmail: 'Leaving@example.com' } })).status).toBe(204);
    expect((await h.request('GET', '/v1/me', { token })).status).toBe(401);
    expect((await h.db.query("SELECT 1 FROM accounts WHERE email = 'leaving@example.com'")).rowCount).toBe(0);
    expect((await h.db.query('SELECT 1 FROM consents WHERE account_id = $1', [signed.body.account.id])).rowCount).toBe(0);

    // The redemption still counts, so deleting an account can't reopen a code.
    expect((await signUp(h, 'reuse@example.com', accessCode)).body.error.code).toBe('access_code_exhausted');
    // The deleted email can sign up again later with a new code.
    expect((await signUp(h, 'leaving@example.com', await issueCode(h))).status).toBe(201);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('behind a trusted proxy', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ trustProxy: true });
  });
  afterAll(() => h?.close());

  it('rate-limits by the address the proxy appended, so a forged X-Forwarded-For does not help', async () => {
    const start = (i: number, forwarded: string) =>
      h.request('POST', '/v1/auth/start', { body: { email: `ip${i}@example.com` }, headers: { 'x-forwarded-for': forwarded } });
    let i = 0;
    for (; i < 20; i++) expect((await start(i, `10.0.0.${i}, 203.0.113.7`)).status).toBe(202);
    expect((await start(i++, '10.0.0.99, 203.0.113.7')).status).toBe(429);
    expect((await start(i++, '203.0.113.8')).status).toBe(202);
  });
});
