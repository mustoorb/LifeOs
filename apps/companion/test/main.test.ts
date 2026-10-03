import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HelperDetector, parseDevFrontmost } from '../src/main/frontmost.js';
import { buildMenuTemplate, trayTitle, type MenuActions } from '../src/main/menu.js';
import type { CompanionState } from '../src/shared/api.js';
import { formatDuration } from '../src/shared/format.js';

const state: CompanionState = {
  status: 'tracking',
  pausedUntil: null,
  focusStartedAt: null,
  todayActiveMinutes: 72,
  timeZone: 'Europe/Paris',
  privacyNoticeVersion: 'desktop-2026-10b',
  consentGrantedAt: 1,
  detectorRunning: true,
};

const actions: MenuActions = {
  openWindow: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  startFocus: vi.fn(),
  stopFocus: vi.fn(),
  forget: vi.fn(),
  quit: vi.fn(),
};

const labels = (s: CompanionState, now = 0) => buildMenuTemplate(s, actions, now).map((item) => item.label ?? '—');

describe('menu bar', () => {
  it('always shows what the companion is doing', () => {
    expect(trayTitle(state, 0)).toBe('1h 12m');
    expect(trayTitle({ ...state, status: 'paused' }, 0)).toBe('Paused');
    expect(trayTitle({ ...state, status: 'needs_consent' }, 0)).toBe('Off');
    expect(trayTitle({ ...state, focusStartedAt: 0 }, 25 * 60_000)).toBe('Focus 25m');
  });

  it('offers pause, focus and delete while tracking', () => {
    expect(labels(state)).toEqual([
      'Tracking · 1h 12m today',
      '—',
      'Start focus session',
      'Pause tracking',
      '—',
      'Open timeline…',
      'Delete the last hour',
      '—',
      'What LifeOS records…',
      'Quit LifeOS Companion',
    ]);
  });

  it('offers resume when paused, and only the consent screen before permission', () => {
    expect(labels({ ...state, status: 'paused', pausedUntil: null })).toContain('Resume tracking');
    expect(labels({ ...state, status: 'needs_consent' })).toEqual([
      'Not tracking: waiting for your permission',
      '—',
      'Review and allow tracking…',
      '—',
      'What LifeOS records…',
      'Quit LifeOS Companion',
    ]);
  });

  it('says so when app detection is unavailable', () => {
    expect(labels({ ...state, detectorRunning: false })[0]).toBe('Tracking is on, but app detection is unavailable');
  });

  it('formats durations compactly', () => {
    expect([formatDuration(0), formatDuration(45), formatDuration(60), formatDuration(135)]).toEqual(['0m', '45m', '1h', '2h 15m']);
  });
});

describe('HelperDetector', () => {
  async function fakeHelper(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lifeos-helper-'));
    const path = join(dir, 'helper.cjs');
    await writeFile(path, body);
    return path;
  }

  it('reads the frontmost app from the helper and ignores malformed lines', async () => {
    const script = await fakeHelper(`
      console.log('garbage');
      console.log(JSON.stringify({ bundleId: 'com.apple.FinalCut', name: 'Final Cut Pro' }));
      setInterval(() => {}, 1000);
    `);
    const changes: boolean[] = [];
    const detector = new HelperDetector(process.execPath, [script], (running) => changes.push(running));
    detector.start();
    await vi.waitFor(() => expect(detector.current().bundleId).toBe('com.apple.FinalCut'));
    detector.stop();
    expect(detector.current()).toEqual({ bundleId: null, name: null });
    expect(changes).toEqual([true, false]);
  });

  it('restarts a crashed helper and reports no app meanwhile', async () => {
    const script = await fakeHelper(`
      console.log(JSON.stringify({ bundleId: 'com.ide', name: 'IDE' }));
      setTimeout(() => process.exit(1), 50);
    `);
    const changes: boolean[] = [];
    const detector = new HelperDetector(process.execPath, [script], (running) => changes.push(running), 100);
    detector.start();
    await vi.waitFor(() => expect(changes).toEqual([true, false, true]), { timeout: 3000 });
    detector.stop();
  });

  it('reports nothing when the helper cannot start', async () => {
    const detector = new HelperDetector('/nonexistent/lifeos-frontmost');
    detector.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(detector.running).toBe(false);
    expect(detector.current().bundleId).toBeNull();
    detector.stop();
  });

  it('parses the development stand-in', () => {
    expect(parseDevFrontmost('com.ide:My IDE')).toEqual({ bundleId: 'com.ide', name: 'My IDE' });
    expect(parseDevFrontmost(undefined)).toBeNull();
  });
});
