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
