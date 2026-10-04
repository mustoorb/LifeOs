import { MINUTE, SECOND } from '@lifeos/contracts';
import { grantConsent } from '@lifeos/promethee';
import { describe, expect, it } from 'vitest';
import { buildExport } from '../apps/companion/src/core/export.js';
import { parseSettings } from '../apps/companion/src/core/settings.js';
import { buildSessions } from '../apps/companion/src/core/timeline.js';
import { DesktopUpload } from '../apps/server/src/activity.js';

/** The companion's export file must be exactly what the server's upload endpoint accepts. */
describe('companion export → server upload', () => {
  it('parses a real companion export without losing the observation', () => {
    const t0 = Date.UTC(2026, 9, 5, 7);
    const samples = Array.from({ length: (45 * 60) / 5 }, (_, i) => ({ at: t0 + i * 5 * SECOND, appId: 'com.apple.FinalCut', idle: false }));
    const settings = parseSettings({ categoryByApp: { 'com.apple.FinalCut': 'video-editing' } });
    const sessions = buildSessions(samples, settings, [{ start: t0, end: t0 + 45 * MINUTE }], t0 + 60 * MINUTE);
    const exported = buildExport({
      sessions,
      timeZone: 'Europe/Paris',
      consent: grantConsent([], 'desktop_activity', t0 - MINUTE, 'desktop-2026-10'),
      userId: 'local',
      now: t0 + 60 * MINUTE,
    });

    const parsed = DesktopUpload.parse(JSON.parse(JSON.stringify(exported)));
    expect(parsed.events).toEqual([
      {
        sourceEventId: exported.events[0]!.sourceEventId,
        type: 'creative_session',
        interval: { start: t0, end: t0 + 45 * MINUTE },
        timeZone: 'Europe/Paris',
        metrics: { activeSeconds: 2700 },
        context: { appCategory: 'video-editing', tags: ['focus'] },
      },
    ]);
  });
});
