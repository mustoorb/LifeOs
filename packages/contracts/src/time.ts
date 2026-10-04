/** Milliseconds since the Unix epoch, UTC. */
export type Instant = number;

/** Half-open interval `[start, end)`. */
export interface Interval {
  readonly start: Instant;
  readonly end: Instant;
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function durationMs(interval: Interval): number {
  return Math.max(0, interval.end - interval.start);
}

export function overlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function isValidInterval(interval: Interval): boolean {
  return (
    Number.isFinite(interval.start) &&
    Number.isFinite(interval.end) &&
    interval.end > interval.start
  );
}

export function clipInterval(interval: Interval, window: Interval): Interval | null {
  const start = Math.max(interval.start, window.start);
  const end = Math.min(interval.end, window.end);
  return end > start ? { start, end } : null;
}

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The user's local calendar date (`YYYY-MM-DD`) for an instant. Daily caps,
 * streak alternatives and recaps are bucketed by this, never by UTC date.
 */
export function localDateKey(at: Instant, timeZone: string): string {
  let formatter = dateKeyFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateKeyFormatters.set(timeZone, formatter);
  }
  return formatter.format(at);
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC at `at`, in ms (positive east of UTC). */
export function timeZoneOffsetMs(at: Instant, timeZone: string): number {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    offsetFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(at / SECOND) * SECOND;
}

/** The instant local midnight begins on `dateKey` (`YYYY-MM-DD`) in `timeZone`. */
export function startOfLocalDay(dateKey: string, timeZone: string): Instant {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error(`Invalid date key "${dateKey}"`);
  const wallMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let guess = wallMidnight;
  for (let i = 0; i < 3; i++) {
    const next = wallMidnight - timeZoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** The local calendar day `dateKey` as an interval (23–25 h around DST changes). */
export function localDayWindow(dateKey: string, timeZone: string): Interval {
  const start = startOfLocalDay(dateKey, timeZone);
  const nextKey = localDateKey(start + 36 * HOUR, timeZone);
  return { start, end: startOfLocalDay(nextKey, timeZone) };
}

function parseDateKey(dateKey: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error(`Invalid date key "${dateKey}"`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Calendar arithmetic on `YYYY-MM-DD` keys; independent of time zones. */
export function addDays(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday that starts the ISO week containing `dateKey`. */
export function weekStartKey(dateKey: string): string {
  const weekday = (parseDateKey(dateKey).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(dateKey, -weekday);
}

/** Monday 00:00 to the next Monday 00:00 in `timeZone`. */
export function localWeekWindow(weekStart: string, timeZone: string): Interval {
  return { start: startOfLocalDay(weekStart, timeZone), end: startOfLocalDay(addDays(weekStart, 7), timeZone) };
}
