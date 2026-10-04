import { MINUTE, SECOND } from '@lifeos/contracts';
import { grantConsent } from '@lifeos/promethee';
import { describe, expect, it } from 'vitest';
import { suggestCategory } from '../src/core/catalog.js';
import { buildExport } from '../src/core/export.js';
import { parseHelperLine } from '../src/core/helper-protocol.js';
import { SampleBuffer } from '../src/core/sampler.js';
import { DEFAULT_SETTINGS, parseSettings } from '../src/core/settings.js';
import { buildSessions, buildTimeline } from '../src/core/timeline.js';

const T0 = Date.UTC(2026, 9, 5, 7, 0); // 09:00 in Paris
const TZ = 'Europe/Paris';

describe('SampleBuffer', () => {
  const options = { idleThresholdSec: 120, deniedApps: new Set(['com.secret']) };

  it('holds samples until they can no longer turn out to be idle', () => {
    const buffer = new SampleBuffer(options);
    const ready = [];
    for (let s = 0; s <= 180; s += 5) {
      ready.push(...buffer.tick({ now: T0 + s * SECOND, appId: 'com.ide', idleSeconds: 0 }));
    }
    expect(ready.at(-1)!.at).toBeLessThan(T0 + 60 * SECOND);
    expect(buffer.size).toBe(25); // 60 s..180 s inclusive
    expect([...ready, ...buffer.drain()]).toHaveLength(37);
  });

  it('drops the samples that the idle threshold reveals were idle', () => {
    const buffer = new SampleBuffer(options);
    const ready = [];
    // Active for 60 s, then the user walks away; the OS reports idle at 180 s.
    for (let s = 0; s < 180; s += 5) {
      ready.push(...buffer.tick({ now: T0 + s * SECOND, appId: 'com.ide', idleSeconds: Math.max(0, s - 60) }));
    }
    ready.push(...buffer.tick({ now: T0 + 180 * SECOND, appId: 'com.ide', idleSeconds: 120 }));
    ready.push(...buffer.drain());
    expect(ready.map((sample) => (sample.at - T0) / SECOND)).toEqual(
      Array.from({ length: 13 }, (_, i) => i * 5), // 0..60 s only
    );
  });

  it('never records excluded or unknown apps', () => {
    const buffer = new SampleBuffer(options);
    buffer.tick({ now: T0, appId: 'com.secret', idleSeconds: 0 });
    buffer.tick({ now: T0 + 5 * SECOND, appId: null, idleSeconds: 0 });
    expect(buffer.drain()).toEqual([]);
  });
});

describe('helper protocol', () => {
  it('accepts well-formed lines and nothing else', () => {
    expect(parseHelperLine('{"bundleId":"com.apple.dt.Xcode","name":"Xcode"}')).toEqual({
      bundleId: 'com.apple.dt.Xcode',
      name: 'Xcode',
    });
    expect(parseHelperLine('{"bundleId":null,"name":null}')).toEqual({ bundleId: null, name: null });
    expect(parseHelperLine('{"bundleId":"../../etc/passwd","name":"x"}')?.bundleId).toBeNull();
    expect(parseHelperLine('not json')).toBeNull();
    expect(parseHelperLine(`{"bundleId":"${'a'.repeat(2000)}"}`)).toBeNull();
  });
});

describe('settings and catalog', () => {
  it('falls back to defaults field by field and lets exclusions win', () => {
    const parsed = parseSettings({
      categoryByApp: { 'com.ide': 'coding', 'com.chat': 'communication', 'com.bad': 'gaming', 'not a bundle!': 'coding' },
      deniedApps: ['com.chat', 42],
      sampleIntervalSec: 0,
      idleThresholdSec: 300,
    });
    expect(parsed.categoryByApp).toEqual({ 'com.ide': 'coding' });
    expect(parsed.deniedApps).toEqual(['com.chat']);
    expect(parsed.sampleIntervalSec).toBe(DEFAULT_SETTINGS.sampleIntervalSec);
    expect(parsed.idleThresholdSec).toBe(300);
    expect(parseSettings('garbage')).toEqual(DEFAULT_SETTINGS);
  });

  it('suggests categories for known apps but never for browsers', () => {
    expect(suggestCategory('com.apple.FinalCut')).toBe('video-editing');
    expect(suggestCategory('com.adobe.PremierePro.25')).toBe('video-editing');
    expect(suggestCategory('com.jetbrains.intellij')).toBe('coding');
    expect(suggestCategory('com.apple.Safari')).toBeUndefined();
    expect(suggestCategory('com.google.Chrome')).toBeUndefined();
  });
});

/** One sample every 5 s for `minutes` minutes. */
function run(appId: string, fromMinute: number, minutes: number) {
  return Array.from({ length: (minutes * 60) / 5 }, (_, i) => ({
    at: T0 + fromMinute * MINUTE + i * 5 * SECOND,
    appId,
    idle: false,
  }));
}

describe('timeline', () => {
  const settings = parseSettings({ categoryByApp: { 'com.apple.FinalCut': 'video-editing', 'com.ide': 'coding' } });
  const samples = [
    ...run('com.apple.FinalCut', 0, 45),
    ...run('com.ide', 60, 30),
    ...run('com.apple.Safari', 100, 12),
    ...run('com.apple.Logic', 120, 0.5),
  ];

  it('builds category sessions, totals and focus markers for a local day', () => {
    const view = buildTimeline({
      dateKey: '2026-10-05',
      timeZone: TZ,
      samples,
      settings,
      focusBlocks: [{ start: T0, end: T0 + 45 * MINUTE }],
      appNames: { 'com.apple.Safari': 'Safari' },
      now: T0 + 3 * 60 * MINUTE,
    });
    expect(view.window).toEqual({ start: Date.UTC(2026, 9, 4, 22), end: Date.UTC(2026, 9, 5, 22) });
    expect(view.sessions).toEqual([
      { start: T0, end: T0 + 45 * MINUTE, category: 'video-editing', activityType: 'creative_session', activeMinutes: 45, focus: true },
      { start: T0 + 60 * MINUTE, end: T0 + 90 * MINUTE, category: 'coding', activityType: 'digital_session', activeMinutes: 30, focus: false },
    ]);
    expect(view.totals).toEqual([
      { category: 'video-editing', minutes: 45 },
      { category: 'coding', minutes: 30 },
    ]);
    // Under a minute of Logic is noise and is not listed.
    expect(view.uncategorized).toEqual([{ appId: 'com.apple.Safari', name: 'Safari', minutes: 12, suggestion: null }]);
  });
});

describe('export', () => {
  const settings = parseSettings({ categoryByApp: { 'com.apple.FinalCut': 'video-editing' } });
  const sessions = buildSessions(run('com.apple.FinalCut', 0, 45), settings, [], T0 + 2 * 60 * MINUTE);

  it('contains derived categories only, never app ids or names', () => {
    const consent = grantConsent([], 'desktop_activity', T0 - MINUTE, 'desktop-2026-10');
    const payload = buildExport({ sessions, timeZone: TZ, consent, userId: 'local', now: T0 + 2 * 60 * MINUTE });
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: 'creative_session',
      evidenceLevel: 'observed',
      visibility: 'private',
      context: { appCategory: 'video-editing' },
      metrics: { activeSeconds: 45 * 60 },
    });
    expect(JSON.stringify(payload)).not.toMatch(/FinalCut|com\.apple/);
  });

  it('exports nothing without consent', () => {
    const payload = buildExport({ sessions, timeZone: TZ, consent: [], userId: 'local', now: T0 + 2 * 60 * MINUTE });
    expect(payload.events).toEqual([]);
    expect(payload.rejected).toEqual([{ sourceEventId: expect.any(String), reason: 'missing_consent' }]);
  });
});
