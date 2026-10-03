/**
 * The contract between the companion's main process and its window. The
 * renderer is treated as untrusted: every argument is validated in main.
 * Types only — this file must not import Node or Electron.
 */

export type TrackingStatus = 'needs_consent' | 'tracking' | 'idle' | 'paused';

export interface CompanionState {
  readonly status: TrackingStatus;
  /** Epoch ms when a timed pause ends; null for "until I resume". */
  readonly pausedUntil: number | null;
  readonly focusStartedAt: number | null;
  readonly todayActiveMinutes: number;
  readonly timeZone: string;
  readonly privacyNoticeVersion: string;
  readonly consentGrantedAt: number | null;
  /** False when the native helper is unavailable, so no app is detected. */
  readonly detectorRunning: boolean;
}

export interface TimelineSession {
  readonly start: number;
  readonly end: number;
  readonly category: string;
  readonly activityType: string;
  readonly activeMinutes: number;
  readonly focus: boolean;
}

export interface UncategorizedApp {
  readonly appId: string;
  readonly name: string;
  readonly minutes: number;
  readonly suggestion: string | null;
}

export interface TimelineView {
  readonly dateKey: string;
  readonly window: { readonly start: number; readonly end: number };
  readonly sessions: readonly TimelineSession[];
  readonly totals: readonly { readonly category: string; readonly minutes: number }[];
  readonly uncategorized: readonly UncategorizedApp[];
  readonly focusBlocks: readonly { readonly start: number; readonly end: number }[];
}

export interface AppsView {
  readonly categories: readonly string[];
  readonly mapped: readonly { readonly appId: string; readonly name: string; readonly category: string }[];
  readonly excluded: readonly { readonly appId: string; readonly name: string }[];
}

export type PauseDuration = 30 | 60 | 'tomorrow' | 'indefinite';
export type ForgetScope = 'last_hour' | 'today' | 'everything';

export type ExportResult =
  | { readonly kind: 'saved'; readonly path: string; readonly events: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'empty' };

export interface CompanionApi {
  getState(): Promise<CompanionState>;
  getTimeline(dateKey: string): Promise<TimelineView>;
  getApps(): Promise<AppsView>;
  grantConsent(): Promise<CompanionState>;
  revokeConsent(deleteData: boolean): Promise<CompanionState>;
  pause(duration: PauseDuration): Promise<CompanionState>;
  resume(): Promise<CompanionState>;
  startFocus(): Promise<CompanionState>;
  stopFocus(): Promise<CompanionState>;
  setCategory(appId: string, category: string | null): Promise<AppsView>;
  setExcluded(appId: string, excluded: boolean): Promise<AppsView>;
  forget(scope: ForgetScope): Promise<CompanionState>;
  exportDay(dateKey: string): Promise<ExportResult>;
  onStateChanged(listener: (state: CompanionState) => void): () => void;
  onNavigate(listener: (section: string) => void): () => void;
}

export const CHANNELS = {
  getState: 'companion:get-state',
  getTimeline: 'companion:get-timeline',
  getApps: 'companion:get-apps',
  grantConsent: 'companion:grant-consent',
  revokeConsent: 'companion:revoke-consent',
  pause: 'companion:pause',
  resume: 'companion:resume',
  startFocus: 'companion:start-focus',
  stopFocus: 'companion:stop-focus',
  setCategory: 'companion:set-category',
  setExcluded: 'companion:set-excluded',
  forget: 'companion:forget',
  exportDay: 'companion:export-day',
  stateChanged: 'companion:state-changed',
  navigate: 'companion:navigate',
} as const;
