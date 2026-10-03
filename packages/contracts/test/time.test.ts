import { describe, expect, it } from 'vitest';
import { HOUR, localDateKey, localDayWindow, startOfLocalDay, timeZoneOffsetMs } from '../src/index.js';

describe('local day helpers', () => {
  it('finds local midnight in zones east and west of UTC', () => {
    expect(startOfLocalDay('2026-10-05', 'Europe/Paris')).toBe(Date.UTC(2026, 9, 4, 22));
    expect(startOfLocalDay('2026-10-05', 'America/Los_Angeles')).toBe(Date.UTC(2026, 9, 5, 7));
    expect(startOfLocalDay('2026-10-05', 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 4, 18, 30));
    expect(timeZoneOffsetMs(Date.UTC(2026, 0, 1), 'Europe/Paris')).toBe(HOUR);
  });

  it('handles DST transition days', () => {
    const spring = localDayWindow('2026-03-29', 'Europe/Paris');
    const autumn = localDayWindow('2026-10-25', 'Europe/Paris');
    expect(spring.end - spring.start).toBe(23 * HOUR);
    expect(autumn.end - autumn.start).toBe(25 * HOUR);
    expect(localDateKey(autumn.start, 'Europe/Paris')).toBe('2026-10-25');
    expect(localDateKey(autumn.end - 1, 'Europe/Paris')).toBe('2026-10-25');
  });

  it('rejects malformed keys', () => {
    expect(() => startOfLocalDay('5 Oct', 'UTC')).toThrow();
  });
});
