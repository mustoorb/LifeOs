import type { MenuItemConstructorOptions } from 'electron';
import type { CompanionState, ForgetScope, PauseDuration } from '../shared/api.js';
import { formatClock, formatDuration } from '../shared/format.js';

export interface MenuActions {
  openWindow(section?: 'privacy'): void;
  pause(duration: PauseDuration): void;
  resume(): void;
  startFocus(): void;
  stopFocus(): void;
  forget(scope: ForgetScope): void;
  quit(): void;
}

/** One line in the menu bar next to the icon: the always-visible status. */
export function trayTitle(state: CompanionState, now: number): string {
  if (state.status === 'needs_consent') return 'Off';
  if (state.status === 'paused') return 'Paused';
  if (state.focusStartedAt !== null) return `Focus ${formatDuration((now - state.focusStartedAt) / 60_000)}`;
  if (state.status === 'idle') return 'Idle';
  return formatDuration(state.todayActiveMinutes);
}

export function statusLine(state: CompanionState): string {
  switch (state.status) {
    case 'needs_consent':
      return 'Not tracking: waiting for your permission';
    case 'paused':
      return state.pausedUntil === null
        ? 'Paused until you resume'
        : `Paused until ${formatClock(state.pausedUntil, state.timeZone)}`;
    case 'idle':
      return `Idle · ${formatDuration(state.todayActiveMinutes)} tracked today`;
    case 'tracking':
      return state.detectorRunning
        ? `Tracking · ${formatDuration(state.todayActiveMinutes)} today`
        : 'Tracking is on, but app detection is unavailable';
  }
}

export function buildMenuTemplate(state: CompanionState, actions: MenuActions, now: number): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: statusLine(state), enabled: false }, { type: 'separator' }];

  if (state.status === 'needs_consent') {
    items.push({ label: 'Review and allow tracking…', click: () => actions.openWindow() });
  } else {
    if (state.focusStartedAt === null) {
      items.push({ label: 'Start focus session', click: () => actions.startFocus() });
    } else {
      const elapsed = formatDuration((now - state.focusStartedAt) / 60_000);
      items.push({ label: `Stop focus session (${elapsed})`, click: () => actions.stopFocus() });
    }
    if (state.status === 'paused') {
      items.push({ label: 'Resume tracking', click: () => actions.resume() });
    } else {
      items.push({
        label: 'Pause tracking',
        submenu: [
          { label: 'For 30 minutes', click: () => actions.pause(30) },
          { label: 'For 1 hour', click: () => actions.pause(60) },
          { label: 'Until tomorrow', click: () => actions.pause('tomorrow') },
          { label: 'Until I resume', click: () => actions.pause('indefinite') },
        ],
      });
    }
    items.push(
      { type: 'separator' },
      { label: 'Open timeline…', click: () => actions.openWindow() },
      { label: 'Delete the last hour', click: () => actions.forget('last_hour') },
    );
  }

  items.push(
    { type: 'separator' },
    { label: 'What LifeOS records…', click: () => actions.openWindow('privacy') },
    { label: 'Quit LifeOS Companion', click: () => actions.quit() },
  );
  return items;
}
