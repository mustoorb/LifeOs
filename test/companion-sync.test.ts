import { MINUTE, SECOND } from '@lifeos/contracts';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountClient } from '../apps/companion/src/core/account-client.js';
import { AccountManager, type SecretBox } from '../apps/companion/src/core/account.js';
import { CompanionService } from '../apps/companion/src/core/service.js';
import { LocalStore } from '../apps/companion/src/core/store.js';
import { TEST_DATABASE_URL, createHarness, issueCode, member, type Harness } from '../apps/server/test/harness.js';

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TZ = 'Europe/Paris';

/** Stand-in for the macOS Keychain: reversible, but never the plain token. */
const keychain = (available = true): SecretBox => ({
  available,
  encrypt: (plain) => Buffer.from(`sealed:${plain}`).toString('base64'),
  decrypt: (sealed) => Buffer.from(sealed, 'base64').toString().replace(/^sealed:/, ''),
});

/**
 * The companion's account code against the real server app and a real
 * Postgres: sign-up, consent, settled-only uploads, deletions and sign-out.
 */
describe.skipIf(!TEST_DATABASE_URL)('companion ↔ server', () => {
  let h: Harness;
  let dir: string;
  let store: LocalStore;
  let service: CompanionService;
  let network: { offline: boolean };

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h?.close());

  beforeEach(async () => {
    h.clock.now += DAY; // independent per-hour limits on the server
    dir = await mkdtemp(join(tmpdir(), 'lifeos-sync-'));
    store = new LocalStore(dir, () => TZ);
    service = await CompanionService.open({ store, now: () => h.clock.now, timeZone: () => TZ });
    await service.grantConsent();
    await service.setCategory('com.apple.FinalCut', 'video-editing');
    network = { offline: false };
  });

  const client = () =>
    new AccountClient('http://127.0.0.1:8787', async (input, init) => {
      if (network.offline) throw new TypeError('fetch failed');
      return h.fetch(input, init);
    });

  const open = (secrets = keychain(), svc = service) =>
    AccountManager.open({ store, service: svc, client: client(), secrets, now: () => h.clock.now, timeZone: () => TZ });

  /** Samples every 5 s for `minutes`, starting `startMinutesAgo` before now. */
  const use = (startMinutesAgo: number, minutes: number) =>
    store.appendSamples(
      Array.from({ length: (minutes * 60) / 5 }, (_, i) => ({
        at: h.clock.now - startMinutesAgo * MINUTE + i * 5 * SECOND,
        appId: 'com.apple.FinalCut',
        idle: false,
      })),
    );

  const serverEvents = async () => (await h.db.query<{ event: any }>('SELECT event FROM activity_events ORDER BY starts_at')).rows.map((r) => r.event);

  async function signUpFromCompanion(manager: AccountManager, email: string): Promise<void> {
    const accessCode = await issueCode(h);
    await manager.startSignIn(email);
    expect(manager.view()).toMatchObject({ status: 'awaiting_code', email });
    const code = /\b(\d{6})\b/.exec(h.mailer.last(email)!.text)![1]!;
    await manager.verifyCode(code);
    expect(manager.view()).toMatchObject({ status: 'registration_required', termsVersion: 'terms-2026-10' });
    await expect(manager.register({ accessCode, displayName: 'Ada', birthDate: '1990-04-12', region: 'fr', acceptTerms: false })).rejects.toThrow(/terms/);
    await manager.register({ accessCode, displayName: 'Ada', birthDate: '1990-04-12', region: 'fr', acceptTerms: true });
    expect(manager.view()).toMatchObject({ status: 'signed_in', email, displayName: 'Ada', upload: { enabled: false } });
  }

  it('uploads nothing until uploads are turned on, then only settled sessions', async () => {
    await h.db.query('DELETE FROM activity_events');
    const manager = await open();
    await signUpFromCompanion(manager, 'ada@example.com');

    await use(180, 45); // ended 2h15m ago
    await use(20, 20); // still running
    await manager.sync();
    expect(await serverEvents()).toEqual([]);

    await manager.setUpload(true);
    await manager.sync();
    const consent = await h.db.query("SELECT granted FROM consents WHERE scope = 'desktop_activity' ORDER BY id");
    expect(consent.rows.map((r) => r.granted)).toEqual([true]);

    let events = await serverEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'creative_session', evidenceLevel: 'observed', visibility: 'private', metrics: { activeSeconds: 45 * 60 } });
    expect(manager.view().upload).toMatchObject({ enabled: true, lastResult: { accepted: 1 }, lastError: null });

    // An hour later the running session has ended and settled.
    h.clock.now += HOUR;
    await manager.sync();
    events = await serverEvents();
    expect(events).toHaveLength(2);
    expect(events[1].metrics.activeSeconds).toBe(20 * 60);
    expect(JSON.stringify(events)).not.toMatch(/FinalCut|com\.apple/);

    // Nothing new has settled since: no request, nothing re-sent.
    await manager.sync();
    expect(await serverEvents()).toHaveLength(2);
    h.clock.now += HOUR;
    await manager.sync();
    expect(manager.view().upload.lastResult).toEqual({ accepted: 0, duplicates: 0, rejected: 0 });
  });

  it('sends local deletions to the account, retrying after a network failure', async () => {
    await h.db.query('DELETE FROM activity_events');
    const manager = await open();
    await signUpFromCompanion(manager, 'deleter@example.com');
    await use(120, 30);
    await manager.setUpload(true);
    await manager.sync();
    expect(await serverEvents()).toHaveLength(1);

    network.offline = true;
    await service.forget('today');
    await vi.waitFor(() => expect(manager.view().upload.pendingDeletes).toBe(1));
    await manager.sync();
    expect(manager.view().upload).toMatchObject({ pendingDeletes: 1, lastError: expect.stringMatching(/Could not reach LifeOS/) });
    expect(await serverEvents()).toHaveLength(1);

    network.offline = false;
    await manager.sync();
    expect(manager.view().upload.pendingDeletes).toBe(0);
    expect(await serverEvents()).toEqual([]);
  });

  it('keeps the session across restarts only when it can be stored securely', async () => {
    const manager = await open();
    await signUpFromCompanion(manager, 'restart@example.com');
    await manager.setUpload(true);

    const file = await readFile(join(dir, 'account.json'), 'utf8');
    expect(file).not.toMatch(/lo_s_/);
    const reopened = await open(keychain(), await CompanionService.open({ store, now: () => h.clock.now, timeZone: () => TZ }));
    expect(reopened.view()).toMatchObject({ status: 'signed_in', email: 'restart@example.com', upload: { enabled: true } });

    // Without a keychain the token is never written, so a restart signs out.
    const insecure = await open(keychain(false));
    await insecure.startSignIn('restart@example.com');
    await insecure.verifyCode(/\b(\d{6})\b/.exec(h.mailer.last('restart@example.com')!.text)![1]!);
    expect(insecure.view()).toMatchObject({ status: 'signed_in', staysSignedIn: false });
    expect(await readFile(join(dir, 'account.json'), 'utf8')).toContain('"sealedToken": null');
    expect((await open(keychain(false))).view().status).toBe('signed_out');
  });

  it('signs out locally when the server ends the session', async () => {
    const manager = await open();
    await signUpFromCompanion(manager, 'revoked@example.com');
    await h.db.query('UPDATE sessions SET revoked_at = now()');
    await manager.sync();
    expect(manager.view()).toMatchObject({ status: 'signed_out', notice: expect.stringMatching(/session ended/) });
  });

  it('records turning uploads off, even when offline at the time', async () => {
    const manager = await open();
    await signUpFromCompanion(manager, 'offline@example.com');
    await manager.setUpload(true);

    network.offline = true;
    await manager.setUpload(false);
    expect(manager.view().upload.enabled).toBe(false);
    const latest = async () =>
      (await h.db.query(
        "SELECT c.granted FROM consents c JOIN accounts a ON a.id = c.account_id WHERE a.email = 'offline@example.com' ORDER BY c.id DESC LIMIT 1",
      )).rows[0].granted;
    expect(await latest()).toBe(true);

    network.offline = false;
    await manager.sync();
    expect(await latest()).toBe(false);
  });

  it('signs existing members straight in', async () => {
    await member(h, 'existing@example.com');
    const manager = await open();
    await manager.startSignIn('existing@example.com');
    await manager.verifyCode(/\b(\d{6})\b/.exec(h.mailer.last('existing@example.com')!.text)![1]!);
    expect(manager.view()).toMatchObject({ status: 'signed_in', email: 'existing@example.com' });
    const devices = await h.db.query(
      "SELECT device_label FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.email = 'existing@example.com' ORDER BY s.created_at",
    );
    expect(devices.rows.at(-1).device_label).toBe('LifeOS Companion · macOS');
  });

  it('explains wrong codes and unreachable servers', async () => {
    const manager = await open();
    await manager.startSignIn('typo@example.com');
    await expect(manager.verifyCode('000000')).rejects.toThrow(/wrong or has expired/);
    network.offline = true;
    await expect(manager.startSignIn('typo@example.com')).rejects.toThrow(/Could not reach LifeOS/);
  });
});
