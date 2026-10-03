import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db.js';
import { TEST_DATABASE_URL, adminToken, createHarness, issueCode, member, signUp, type Harness } from './harness.js';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

describe('config', () => {
  const base = { DATABASE_URL: 'postgres://x', LIFEOS_SECRET: 'x'.repeat(32) };
  it('requires a database, a long secret and a real mailer in production', () => {
    expect(loadConfig(base)).toMatchObject({ port: 8787, host: '127.0.0.1', trustProxy: false });
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, LIFEOS_SECRET: 'short' })).toThrow(/LIFEOS_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/production mailer/);
    expect(() => loadConfig({ ...base, PORT: '99999' })).toThrow(/PORT/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('admin, activity and HTTP', () => {
  let h: Harness;
  let admin: string;
  beforeAll(async () => {
    h = await createHarness();
    admin = await adminToken(h);
  });
  afterAll(() => h?.close());
  beforeEach(() => {
    h.clock.now += DAY;
  });

  it('runs migrations once', async () => {
    expect(await migrate(h.db)).toEqual([]);
  });

  it('keeps admin routes behind the admin role', async () => {
    const token = await member(h, 'plain@example.com');
    expect((await h.request('GET', '/v1/admin/access-codes', { token })).status).toBe(403);
    expect((await h.request('GET', '/v1/admin/access-codes')).status).toBe(401);
    expect((await h.request('GET', '/v1/admin/access-codes', { token: admin })).status).toBe(200);
  });

  it('issues, lists and revokes access codes', async () => {
    const issued = await h.json('POST', '/v1/admin/access-codes', {
      token: admin,
      body: { type: 'partner', campaign: 'creator-x', count: 3, maxRedemptions: 25, expiresAt: h.clock.now + 30 * DAY },
    });
    expect(issued.status).toBe(201);
    expect(issued.body).toHaveLength(3);
    expect(issued.body[0]).toMatchObject({ type: 'partner', campaign: 'creator-x', maxRedemptions: 25, redemptions: 0, minAge: 18 });

    const listed = await h.json('GET', '/v1/admin/access-codes?campaign=creator-x', { token: admin });
    expect(listed.body.map((c: any) => c.code).sort()).toEqual(issued.body.map((c: any) => c.code).sort());

    const code = issued.body[0].code;
    const revoked = await h.json('POST', `/v1/admin/access-codes/${code.toLowerCase()}/revoke`, { token: admin });
    expect(revoked.body.revokedAt).toBe(h.clock.now);
    expect((await signUp(h, 'late@example.com', code)).body.error.code).toBe('access_code_revoked');

    const bad = await h.json('POST', '/v1/admin/access-codes', {
      token: admin,
      body: { type: 'friend_invite', campaign: 'x', count: 1, maxRedemptions: 1 },
    });
    expect(bad.status).toBe(422);
    const expired = await h.json('POST', '/v1/admin/access-codes', {
      token: admin,
      body: { type: 'founding', campaign: 'founding', count: 1, maxRedemptions: 1, expiresAt: h.clock.now - 1 },
    });
    expect(expired.body.error.code).toBe('invalid_expiry');
  });

  it('validates seasons and enrolls new members in their campaign’s season', async () => {
    const tooShort = await h.json('POST', '/v1/admin/seasons', {
      token: admin,
      body: { id: 'short', name: 'Short', startsAt: h.clock.now, endsAt: h.clock.now + 14 * DAY, campaigns: ['beta'], xpRulesetVersion: 'xp-v1' },
    });
    expect(tooShort).toMatchObject({ status: 422, body: { error: { code: 'invalid_season' } } });

    const created = await h.json('POST', '/v1/admin/seasons', {
      token: admin,
      body: { id: 'beta-1', name: 'Beta', startsAt: h.clock.now + DAY, endsAt: h.clock.now + 43 * DAY, campaigns: ['beta'], xpRulesetVersion: 'xp-v1' },
    });
    expect(created.status).toBe(201);
    expect((await h.json('POST', '/v1/admin/seasons', { token: admin, body: { id: 'beta-1', name: 'Again', startsAt: h.clock.now + DAY, endsAt: h.clock.now + 43 * DAY, campaigns: ['beta'], xpRulesetVersion: 'xp-v1' } })).status).toBe(409);

    // An upcoming season counts: members join before it starts.
    const joined = await signUp(h, 'beta@example.com', await issueCode(h, { campaign: 'beta' }));
    const me = await h.json('GET', '/v1/me', { token: joined.body.token });
    expect(me.body.enrollments.map((e: any) => e.seasonId)).toEqual(['beta-1']);
  });

  it('lets admins promote members and see an audit trail without emails', async () => {
    const accounts = await h.json('GET', '/v1/admin/accounts', { token: admin });
    const target = accounts.body.find((a: any) => a.email === 'plain@example.com');
    expect((await h.request('PUT', `/v1/admin/accounts/${target.id}/role`, { token: admin, body: { role: 'admin' } })).status).toBe(204);

    const audit = await h.json('GET', '/v1/admin/audit?limit=200', { token: admin });
    const actions = audit.body.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['role.changed', 'access_codes.issued', 'access_code.revoked', 'season.created', 'account.created']));
    expect(JSON.stringify(audit.body)).not.toContain('@');
  });

  describe('desktop activity ingestion', () => {
    const upload = (start: number, extra: Record<string, unknown> = {}) => ({
      format: 'lifeos.desktop-activity',
      version: 1,
      generatedAt: start,
      events: [
        {
          // Fields a client might try to set are ignored and recomputed.
          id: 'evt:someone-else:x',
          userId: 'someone-else',
          evidenceLevel: 'reviewed',
          confidence: 1,
          visibility: 'public_summary',
          sourceEventId: `desktop:video-editing:${start}`,
          type: 'creative_session',
          interval: { start, end: start + 45 * 60_000 },
          timeZone: 'Europe/Paris',
          metrics: { activeSeconds: 2700 },
          context: { appCategory: 'video-editing', tags: ['focus'] },
          ...extra,
        },
      ],
    });

    it('requires upload consent on the account', async () => {
      const token = await member(h, 'noconsent@example.com');
      const result = await h.json('POST', '/v1/me/activity/desktop', { token, body: upload(h.clock.now - 2 * HOUR) });
      expect(result).toMatchObject({ status: 403, body: { error: { code: 'consent_required' } } });
    });

    it('re-validates events, stores them idempotently, and lets the member list and delete them', async () => {
      const token = await member(h, 'uploader@example.com');
      const me = await h.json('GET', '/v1/me', { token });
      await h.json('PUT', '/v1/me/consents/desktop_activity', { token, body: { granted: true } });

      const start = h.clock.now - 2 * HOUR;
      const first = await h.json('POST', '/v1/me/activity/desktop', { token, body: upload(start) });
      expect(first.body).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
      const second = await h.json('POST', '/v1/me/activity/desktop', { token, body: upload(start) });
      expect(second.body).toEqual({ accepted: 0, duplicates: 1, rejected: [] });

      const future = await h.json('POST', '/v1/me/activity/desktop', { token, body: upload(h.clock.now + HOUR) });
      expect(future.body.rejected).toEqual([{ sourceEventId: expect.any(String), reason: 'future_interval' }]);

      const listed = await h.json('GET', `/v1/me/activity?from=${start - HOUR}&to=${h.clock.now}`, { token });
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({
        userId: me.body.id,
        evidenceLevel: 'observed',
        confidence: 0.7,
        visibility: 'private',
        type: 'creative_session',
        context: { appCategory: 'video-editing', tags: ['focus'] },
        provenance: { connector: 'desktop-companion' },
        consentVersion: 'desktop_activity@privacy-2026-10',
      });
      expect(listed.body[0].id).toContain(me.body.id);

      // Another member never sees it.
      const other = await member(h, 'other@example.com');
      expect((await h.json('GET', `/v1/me/activity?from=0&to=${h.clock.now}`, { token: other })).body).toEqual([]);

      const deleted = await h.json('DELETE', `/v1/me/activity?from=${start - HOUR}&to=${h.clock.now}`, { token });
      expect(deleted.body).toEqual({ deleted: 1 });
    });

    it('rejects malformed uploads', async () => {
      const token = await member(h, 'malformed@example.com');
      const bad = await h.json('POST', '/v1/me/activity/desktop', { token, body: upload(h.clock.now, { type: 'teleport' }) });
      expect(bad).toMatchObject({ status: 422, body: { error: { code: 'invalid_request' } } });
    });
  });

  describe('HTTP hardening', () => {
    it('answers with JSON errors, security headers and size limits', async () => {
      const health = await h.request('GET', '/v1/health');
      expect(health.headers.get('x-content-type-options')).toBe('nosniff');
      expect(health.headers.get('x-frame-options')).toBe('SAMEORIGIN');

      expect((await h.json('POST', '/v1/auth/start', { body: undefined })).status).toBe(400);
      expect((await h.request('POST', '/v1/auth/start', { raw: '{nope' })).status).toBe(400);
      expect((await h.json('POST', '/v1/auth/start', { body: { email: 'not-an-email' } })).body.error.code).toBe('invalid_email');
      expect((await h.request('GET', '/v1/unknown')).status).toBe(404);
      expect((await h.request('GET', '/v1/me')).status).toBe(401);
      expect((await h.request('GET', '/v1/me', { token: 'lo_s_forged' })).status).toBe(401);

      const huge = await h.request('POST', '/v1/auth/start', { raw: JSON.stringify({ email: 'x'.repeat(3 * 1024 * 1024) }) });
      expect(huge.status).toBe(413);
    });
  });
});

