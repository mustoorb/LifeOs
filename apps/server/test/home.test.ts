import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, createHarness, member, requestCode, issueCode, type Harness } from './harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TZ = 'Europe/Paris';

describe.skipIf(!TEST_DATABASE_URL)('ECLIPSE home', () => {
  let h: Harness;
  let webDir: string;
  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'lifeos-web-'));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>LifeOS</title><script src="app.js"></script>');
    await writeFile(join(webDir, 'app.js'), 'console.log("hi")');
    h = await createHarness({ webDir });
    h.clock.now = Date.UTC(2026, 9, 5, 9, 0); // a Monday
  });
  afterAll(() => h?.close());
  beforeEach(() => {
    // Jump to the next Monday, 09:00 UTC (11:00 in Paris): a fresh week per test.
    const day = new Date(h.clock.now);
    const daysToMonday = ((8 - day.getUTCDay()) % 7) || 7;
    h.clock.now = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + daysToMonday, 9);
  });

  async function newMember(email: string): Promise<string> {
    const token = await member(h, email);
    expect((await h.json('GET', `/v1/home?tz=${TZ}`, { token })).status).toBe(200);
    return token;
  }

  async function upload(token: string, minutesAgo: number, minutes: number, tags: string[] = ['focus'], type = 'digital_session') {
    await h.json('PUT', '/v1/me/consents/desktop_activity', { token, body: { granted: true } });
    const start = h.clock.now - minutesAgo * MINUTE;
    const result = await h.json('POST', '/v1/me/activity/desktop', {
      token,
      body: {
        format: 'lifeos.desktop-activity',
        version: 1,
        events: [
          {
            sourceEventId: `desktop:coding:${start}`,
            type,
            interval: { start, end: start + minutes * MINUTE },
            timeZone: TZ,
            metrics: { activeSeconds: minutes * 60 },
            context: { appCategory: 'coding', tags },
          },
        ],
      },
    });
    expect(result.body.accepted).toBe(1);
  }

  const home = async (token: string) => (await h.json('GET', '/v1/home', { token })).body;
  const quest = (view: any, template: string) => view.quests.find((q: any) => q.template === template);

  it('turns an uploaded focus session into explained XP and a completed daily quest', async () => {
    const token = await newMember('focus@example.com');
    let view = await home(token);
    expect(view.today.dateKey).toBe('2026-10-12');
    expect(view.quests.map((q: any) => [q.template, q.status])).toEqual([
      ['daily-focus', 'active'],
      ['weekly-movement', 'active'],
      ['weekly-recovery', 'active'],
    ]);

    await upload(token, 80, 50);
    view = await home(token);
    expect(view.activities).toHaveLength(1);
    expect(view.activities[0]).toMatchObject({
      type: 'digital_session',
      category: 'coding',
      minutes: 50,
      evidenceLevel: 'observed',
      sources: ['desktop-companion'],
      needsReview: false,
      award: { xp: 25, status: 'awarded', explanation: ['25 Focus XP', '50 min digital session; observed evidence 1.0×'] },
    });
    expect(quest(view, 'daily-focus')).toMatchObject({ status: 'complete', progress: 1, provisional: false });
    expect(view.progress).toMatchObject({ totalXp: 30, heldXp: 0, level: 1 });
    expect(view.progress.domains[0]).toMatchObject({ domain: 'mind', skills: expect.arrayContaining([expect.objectContaining({ skill: 'focus', xp: 30 })]) });
    expect(view.recentAwards[0]).toMatchObject({ kind: 'quest_completion', xp: 5, explanation: ['+5 quest bonus: Focus block', '1 qualifying activity'] });

    // Refreshing again changes nothing.
    expect((await home(token)).progress.totalXp).toBe(30);
  });

  it('applies corrections: discard reverses XP and the quest bonus; recategorize re-awards', async () => {
    const token = await newMember('corrector@example.com');
    await upload(token, 80, 50);
    let view = await home(token);
    const id = view.activities[0].id;

    expect((await h.request('POST', `/v1/me/activities/${id}/correction`, { token, body: { kind: 'recategorize', type: 'creative_session' } })).status).toBe(204);
    view = await home(token);
    expect(view.activities[0]).toMatchObject({ type: 'creative_session', userConfirmation: 'corrected', award: { xp: 30, explanation: ['30 Creation XP', expect.any(String)] } });
    expect(view.progress.totalXp).toBe(35);
    expect(view.recentAwards.some((a: any) => a.status === 'reversed' && a.reversalReason === 'activity changed')).toBe(true);

    await h.request('POST', `/v1/me/activities/${id}/correction`, { token, body: { kind: 'discard' } });
    view = await home(token);
    expect(view.progress.totalXp).toBe(0);
    expect(quest(view, 'daily-focus').status).toBe('active');
    expect(view.recentAwards.filter((a: any) => a.status === 'reversed').map((a: any) => a.reversalReason)).toEqual(
      expect.arrayContaining(['activity discarded', 'quest no longer complete']),
    );

    const other = await newMember('stranger@example.com');
    expect((await h.request('POST', `/v1/me/activities/${id}/correction`, { token: other, body: { kind: 'confirm' } })).status).toBe(404);
    expect((await h.json('POST', `/v1/me/activities/${id}/correction`, { token, body: { kind: 'explode' } })).status).toBe(422);
  });

  it('logs workouts by hand as provisional XP that counts toward the weekly quests', async () => {
    const token = await newMember('runner@example.com');
    const log = (body: Record<string, unknown>) => h.json('POST', '/v1/me/activity/manual', { token, body });
    for (let day = 0; day < 3; day++) {
      expect((await log({ type: 'run', start: h.clock.now - 3 * HOUR, end: h.clock.now - 3 * HOUR + 50 * MINUTE, distanceM: 8000 })).status).toBe(201);
      if (day < 2) h.clock.now += DAY;
    }
    await log({ type: 'walk', start: h.clock.now - 2 * HOUR, end: h.clock.now - 2 * HOUR + 30 * MINUTE });
    await log({ type: 'walk', start: h.clock.now - HOUR, end: h.clock.now - 30 * MINUTE });

    const view = await home(token);
    expect(view.activities.find((a: any) => a.type === 'run')).toMatchObject({
      evidenceLevel: 'self_reported',
      sources: ['manual-log'],
      award: { xp: 25, status: 'provisional' },
    });
    expect(quest(view, 'weekly-movement')).toMatchObject({ status: 'complete', provisional: true, criteria: [{ unit: 'minutes', current: 150, required: 150 }, { unit: 'days', current: 3, required: 3 }] });
    expect(quest(view, 'weekly-recovery').status).toBe('complete');

    expect((await log({ type: 'run', start: h.clock.now + HOUR, end: h.clock.now + 2 * HOUR })).body.error.code).toBe('invalid_log_future_interval');
    expect((await log({ type: 'digital_session', start: h.clock.now - HOUR, end: h.clock.now })).status).toBe(422);
  });

  it('holds implausible or conflicting entries for review instead of awarding them', async () => {
    const token = await newMember('review@example.com');
    await h.json('POST', '/v1/me/activity/manual', {
      token,
      body: { type: 'run', start: h.clock.now - 2 * HOUR, end: h.clock.now - 2 * HOUR + 30 * MINUTE, distanceM: 30_000 },
    });
    const view = await home(token);
    expect(view.review).toHaveLength(1);
    expect(view.review[0]).toMatchObject({ needsReview: true, reviewReasons: ['The pace looks faster than people usually move.'], award: { status: 'pending' } });
    expect(view.progress).toMatchObject({ totalXp: 0, heldXp: 15 }); // 30 min × 0.5 self-reported
  });

  it('reverses XP when uploaded activity is deleted', async () => {
    const token = await newMember('deleter@example.com');
    await upload(token, 80, 50);
    expect((await home(token)).progress.totalXp).toBe(30);
    await h.json('DELETE', `/v1/me/activity?from=${h.clock.now - DAY}&to=${h.clock.now}`, { token });
    const view = await home(token);
    expect(view.activities).toEqual([]);
    expect(view.progress.totalXp).toBe(0);
  });

  it('keeps at most three priorities a day, privately', async () => {
    const token = await newMember('planner@example.com');
    for (const text of ['Edit the reel', 'Run 5k', 'Call mum']) {
      expect((await h.request('POST', '/v1/me/priorities', { token, body: { text, skill: text === 'Run 5k' ? 'endurance' : null } })).status).toBe(201);
    }
    expect((await h.json('POST', '/v1/me/priorities', { token, body: { text: 'One more' } })).body.error.code).toBe('too_many_priorities');
    let view = await home(token);
    expect(view.priorities.map((p: any) => [p.text, p.skill, p.done])).toEqual([
      ['Edit the reel', null, false],
      ['Run 5k', 'endurance', false],
      ['Call mum', null, false],
    ]);
    const [first, second] = view.priorities;
    await h.request('PATCH', `/v1/me/priorities/${first.id}`, { token, body: { done: true } });
    await h.request('DELETE', `/v1/me/priorities/${second.id}`, { token });
    view = await home(token);
    expect(view.priorities.map((p: any) => [p.text, p.done])).toEqual([['Edit the reel', true], ['Call mum', false]]);

    const other = await newMember('nosy@example.com');
    expect((await h.request('PATCH', `/v1/me/priorities/${first.id}`, { token: other, body: { done: false } })).status).toBe(404);
    // A new day starts empty.
    h.clock.now += DAY;
    expect((await home(token)).priorities).toEqual([]);
  });

  it('lets members skip open quests but not completed ones', async () => {
    const token = await newMember('skipper@example.com');
    await upload(token, 80, 50);
    const view = await home(token);
    expect((await h.json('POST', `/v1/me/quests/${encodeURIComponent(quest(view, 'daily-focus').id)}/skip`, { token })).body.error.code).toBe('cannot_skip');
    expect((await h.request('POST', `/v1/me/quests/${encodeURIComponent(quest(view, 'weekly-recovery').id)}/skip`, { token })).status).toBe(204);
    expect(quest(await home(token), 'weekly-recovery').status).toBe('skipped');
  });

  it('builds a private weekly recap and records whether it felt accurate', async () => {
    const token = await newMember('recap@example.com');
    await upload(token, 80, 50);
    await h.request('POST', '/v1/me/priorities', { token, body: { text: 'Ship it' } });
    h.clock.now += DAY;
    await upload(token, 200, 90, [], 'learning_session');

    const monday = new Date(h.clock.now - DAY).toISOString().slice(0, 10);
    const recap = (await h.json('GET', '/v1/recap', { token })).body;
    expect(recap).toMatchObject({
      weekStart: monday,
      totals: { minutes: 140, sessions: 2, xp: 25 + 5 + 54 },
      priorities: { planned: 1, done: 0 },
      // Two days' focus quests plus the two weekly quests.
      quests: { completed: 1, offered: 4 },
      feedback: null,
    });
    expect(recap.days.slice(0, 2).map((d: any) => d.minutes)).toEqual([50, 90]);
    expect(recap.domains.find((d: any) => d.domain === 'mind')).toEqual({ domain: 'mind', minutes: 140, xp: 84 });
    expect(recap.notes).toContain('No movement was logged this week. Even a short walk counts toward Recovery.');

    // Any day of the week identifies it.
    const wednesday = new Date(h.clock.now + DAY).toISOString().slice(0, 10);
    const lastWeek = new Date(h.clock.now - 8 * DAY).toISOString().slice(0, 10);
    expect((await h.request('PUT', `/v1/recap/${wednesday}/feedback`, { token, body: { accurate: true } })).status).toBe(204);
    expect((await h.json('GET', `/v1/recap?week=${monday}`, { token })).body.feedback).toBe(true);
    expect((await h.json('GET', `/v1/recap?week=${lastWeek}`, { token })).body).toMatchObject({ totals: { minutes: 0 }, feedback: null });
    expect((await h.json('GET', '/v1/home?tz=Mars/Olympus', { token })).status).toBe(422);
  });

  describe('web client', () => {
    it('signs in with an HttpOnly cookie and refuses cookie writes without the client header', async () => {
      const email = 'web@example.com';
      await member(h, email);
      const code = await requestCode(h, email);
      const response = await h.request('POST', '/v1/auth/verify', { body: { email, code }, headers: { 'x-lifeos-client': 'web' } });
      const cookie = response.headers.get('set-cookie')!;
      expect(cookie).toMatch(/^lifeos_session=lo_s_/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      const body = (await response.json()) as { token?: string; account: { email: string } };
      expect(body.token).toBeUndefined();
      expect(body.account.email).toBe(email);

      const session = cookie.split(';')[0]!;
      expect((await h.json('GET', '/v1/auth/session')).body).toEqual({ signedIn: false });
      expect((await h.json('GET', '/v1/auth/session', { headers: { cookie: session } })).body).toMatchObject({ signedIn: true });
      expect((await h.request('GET', '/v1/home', { headers: { cookie: session } })).status).toBe(200);
      const forged = await h.request('POST', '/v1/me/priorities', { headers: { cookie: session }, body: { text: 'csrf' } });
      expect(forged.status).toBe(403);
      expect((await h.request('POST', '/v1/me/priorities', { headers: { cookie: session, 'x-lifeos-client': 'web' }, body: { text: 'ok' } })).status).toBe(201);

      const out = await h.request('POST', '/v1/auth/logout', { headers: { cookie: session, 'x-lifeos-client': 'web' } });
      expect(out.status).toBe(204);
      expect(out.headers.get('set-cookie')).toMatch(/lifeos_session=;.*Max-Age=0/);
      expect((await h.request('GET', '/v1/home', { headers: { cookie: session } })).status).toBe(401);
    });

    it('registers new web members with a cookie too', async () => {
      const email = 'newweb@example.com';
      const code = await requestCode(h, email);
      const verified = await h.json('POST', '/v1/auth/verify', { body: { email, code } });
      const response = await h.request('POST', '/v1/accounts', {
        headers: { 'x-lifeos-client': 'web' },
        body: {
          registrationToken: verified.body.registrationToken,
          accessCode: await issueCode(h),
          birthDate: '1990-01-01',
          region: 'FR',
          displayName: 'Web',
          acceptedTerms: verified.body.termsVersion,
        },
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
      expect(((await response.json()) as { token?: string }).token).toBeUndefined();
    });

    it('serves the client with a strict content security policy', async () => {
      const page = await h.request('GET', '/');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(page.headers.get('content-security-policy')).toMatch(/default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
      expect((await h.request('GET', '/app.js')).headers.get('content-type')).toMatch(/javascript/);
      expect((await h.request('GET', '/../../etc/passwd')).status).toBe(404);
    });
  });
});
