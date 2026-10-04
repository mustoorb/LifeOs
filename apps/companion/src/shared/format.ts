/** Formatting shared by the menu bar and the window. No Node or DOM imports. */

export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatClock(at: number, timeZone: string): string {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit' });
    clockFormatters.set(timeZone, formatter);
  }
  return formatter.format(at);
}

export function formatDay(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return 'Today';
  const [year, month, day] = dateKey.split('-').map(Number);
  // Noon UTC on that date names the same calendar day as the key.
  const noon = Date.UTC(year!, month! - 1, day!, 12);
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(noon);
}

export function categoryLabel(category: string): string {
  const text = category.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
