import { HOUR, MINUTE, SECOND } from '@lifeos/contracts';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompanionService, MAX_FOCUS_MS } from '../src/core/service.js';
import { LocalStore } from '../src/core/store.js';

const T0 = Date.UTC(2026, 9, 5, 7, 0); // 09:00 in Paris
const TZ = 'Europe/Paris';

let dir: string;
let now: number;
let store: LocalStore;

async function open(): Promise<CompanionService> {
  store = new LocalStore(dir, () => TZ);
  return CompanionService.open({ store, now: () => now, timeZone: () => TZ });
}

/** Simulates the main-process sampler: one tick every 5 s. */
async function use(service: CompanionService, appId: string, minutes: number, appName = appId): Promise<void> {
  const end = now + minutes * MINUTE;
  for (; now < end; now += 5 * SECOND) await service.tick({ appId, appName, idleSeconds: 0 });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lifeos-companion-'));
  now = T0;
});

afterEach(() => {
  now = T0;
});

describe('CompanionService', () => {
  it('records nothing until the user grants permission', async () => {
    const service = await open();
    expect(service.status()).toBe('needs_consent');
    await use(service, 'com.ide', 10);
    await service.flush();
    expect(await store.sampleKeys()).toEqual([]);
    await expect(service.startFocus()).rejects.toThrow();
  });

  it('turns ticks into a categorized timeline, live and after flush', async () => {
    const service = await open();
    await service.grantConsent();
    await service.setCategory('com.ide', 'coding');
    await use(service, 'com.ide', 30, 'Xcode');

    const live = await service.timeline(service.today());
    expect(live.totals).toEqual([{ category: 'coding', minutes: 30 }]);

    await service.flush();
    await service.refreshToday();
    expect(service.state()).toMatchObject({ status: 'tracking', todayActiveMinutes: 30, consentGrantedAt: T0 });
    expect(service.apps().mapped).toEqual([{ appId: 'com.ide', name: 'Xcode', category: 'coding' }]);
  });

  it('stores files only the user can read', async () => {
    const service = await open();
    await service.grantConsent();
    await use(service, 'com.ide', 5);
    await service.flush();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'samples', '2026-10-05.jsonl'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'consent.json'))).mode & 0o777).toBe(0o600);
  });

  it('records nothing while paused, persists the pause, and resumes on time', async () => {
    let service = await open();
    await service.grantConsent();
    await service.setCategory('com.ide', 'coding');
    await service.pauseFor(30);
    service = await open(); // the pause survives a restart
    expect(service.status()).toBe('paused');
    await use(service, 'com.ide', 30);
    expect(service.status()).toBe('tracking');
    await use(service, 'com.ide', 10);
    await service.flush();
    const view = await service.timeline(service.today());
    expect(view.totals).toEqual([{ category: 'coding', minutes: 10 }]);
  });

  it('pauses until local midnight', async () => {
    const service = await open();
    await service.grantConsent();
    await service.pauseFor('tomorrow');
    expect(service.state().pausedUntil).toBe(Date.UTC(2026, 9, 5, 22));
    await service.pauseFor('indefinite');
    now += 48 * HOUR;
    await service.tick({ appId: 'com.ide', appName: null, idleSeconds: 0 });
    expect(service.state()).toMatchObject({ status: 'paused', pausedUntil: null });
  });

  it('reports idle and drops idle time', async () => {
    const service = await open();
    await service.grantConsent();
    await service.setCategory('com.ide', 'coding');
    await use(service, 'com.ide', 10);
    for (let idle = 0; idle <= 600; idle += 5, now += 5 * SECOND) {
      await service.tick({ appId: 'com.ide', appName: null, idleSeconds: idle });
    }
    expect(service.status()).toBe('idle');
    await service.flush();
    const view = await service.timeline(service.today());
    expect(view.sessions.map((s) => s.activeMinutes)).toEqual([10]);
  });

  it('excluding an app deletes its history and stops recording it', async () => {
    const service = await open();
    await service.grantConsent();
    await use(service, 'com.chat', 10, 'Chat');
    await use(service, 'com.ide', 10, 'IDE');
    await service.flush();
    expect((await service.timeline(service.today())).uncategorized.map((a) => a.appId)).toEqual(['com.chat', 'com.ide']);

    await service.setExcluded('com.chat', true);
    await use(service, 'com.chat', 10);
    await service.flush();
    const raw = await readFile(join(dir, 'samples', '2026-10-05.jsonl'), 'utf8');
    expect(raw).not.toContain('com.chat');
    expect(service.apps().excluded).toEqual([{ appId: 'com.chat', name: 'Chat' }]);
  });

  it('forgets the last hour, and everything', async () => {
    const service = await open();
    await service.grantConsent();
    await service.setCategory('com.ide', 'coding');
    await use(service, 'com.ide', 90);
    await service.flush();
    await service.forget('last_hour');
    expect((await service.timeline(service.today())).totals).toEqual([{ category: 'coding', minutes: 30 }]);

    await service.forget('everything');
    expect(await store.sampleKeys()).toEqual([]);
    expect(service.apps().mapped).toHaveLength(1); // decisions are kept, activity is not
  });

  it('revoking permission stops tracking, discards the buffer and can delete data', async () => {
    const service = await open();
    await service.grantConsent();
    await service.setCategory('com.ide', 'coding');
    await use(service, 'com.ide', 1); // still buffered
    await service.revokeConsent(true);
    await use(service, 'com.ide', 10);
    await service.flush();
    expect(service.status()).toBe('needs_consent');
    expect(await store.sampleKeys()).toEqual([]);
    const consent = JSON.parse(await readFile(join(dir, 'consent.json'), 'utf8'));
    expect(consent.ledger.map((r: { granted: boolean }) => r.granted)).toEqual([true, false]);
  });

  it('tags focus sessions and closes forgotten ones', async () => {
    const service = await open();
    await service.grantConsent();
    await service.setCategory('com.ide', 'coding');
    await service.startFocus();
    expect(service.state().focusStartedAt).toBe(T0);
    await use(service, 'com.ide', 30);
    await service.stopFocus();
    await use(service, 'com.ide', 1);
    expect((await service.timeline(service.today())).sessions[0]!.focus).toBe(true);

    await service.startFocus();
    now += MAX_FOCUS_MS + MINUTE;
    await service.tick({ appId: null, appName: null, idleSeconds: 0 });
    expect(service.state().focusStartedAt).toBeNull();
  });

  it('survives corrupt files', async () => {
    await writeFile(join(dir, 'settings.json'), '{not json');
    await writeFile(join(dir, 'focus.json'), JSON.stringify({ blocks: [{ start: 1 }, { start: 2 }, 'x'] }));
    const service = await open();
    expect(service.apps().mapped).toEqual([]);
    expect(service.state().focusStartedAt).toBe(2);
  });

  it('applies retention to raw samples', async () => {
    const service = await open();
    await service.grantConsent();
    await use(service, 'com.ide', 5);
    await service.flush();
    now += 40 * 24 * HOUR;
    await use(service, 'com.ide', 5);
    await service.flush();
    await service.prune();
    expect(await store.sampleKeys()).toEqual(['2026-11-14']);
  });
});
