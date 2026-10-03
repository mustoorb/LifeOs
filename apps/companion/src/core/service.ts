import { DAY, HOUR, localDateKey, localDayWindow, type Instant } from '@lifeos/contracts';
import {
  CONSENT_SCOPES,
  grantConsent,
  hasConsent,
  consentAt,
  revokeConsent,
  type ConsentLedger,
  type ConsentRecord,
} from '@lifeos/promethee';
import type {
  AppsView,
  CompanionState,
  ForgetScope,
  PauseDuration,
  TimelineView,
  TrackingStatus,
} from '../shared/api.js';
import { buildExport, type DesktopExport } from './export.js';
import { SampleBuffer } from './sampler.js';
import { CATEGORIES, isBundleId, isCategory, parseSettings, type CompanionSettings } from './settings.js';
import type { LocalStore } from './store.js';
import { buildSessions, buildTimeline, type StoredFocusBlock } from './timeline.js';

/** Version of the plain-language notice shown on the consent screen. */
export const PRIVACY_NOTICE_VERSION = 'desktop-2026-10';

/** Focus blocks left running are closed after this long. */
export const MAX_FOCUS_MS = 4 * HOUR;

/** Until an account exists, exports are attributed to this local id. */
export const LOCAL_USER_ID = 'local';

const FILES = {
  settings: 'settings.json',
  consent: 'consent.json',
  state: 'state.json',
  focus: 'focus.json',
  apps: 'apps.json',
} as const;

interface Pause {
  /** null means "until I resume". */
  readonly until: Instant | null;
}

export interface ServiceDeps {
  readonly store: LocalStore;
  readonly now: () => Instant;
  readonly timeZone: () => string;
}

export interface TickInput {
  readonly appId: string | null;
  readonly appName: string | null;
  readonly idleSeconds: number;
}

/**
 * The companion's behaviour, independent of Electron: consent, pause, focus,
 * sampling, local storage and the user's controls over their data.
 */
export class CompanionService {
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly buffer: SampleBuffer;
  private idle = false;
  private detectorRunning = false;
  private todayMinutes = 0;

  private constructor(
    private readonly deps: ServiceDeps,
    private settings: CompanionSettings,
    private consent: ConsentLedger,
    private pause: Pause | null,
    private focus: StoredFocusBlock[],
    private appNames: Record<string, string>,
  ) {
    this.buffer = new SampleBuffer(this.samplerOptions());
  }

  static async open(deps: ServiceDeps): Promise<CompanionService> {
    const { store } = deps;
    await store.init();
    const [settings, consent, state, focus, apps] = await Promise.all([
      store.readJson(FILES.settings),
      store.readJson(FILES.consent),
      store.readJson(FILES.state),
      store.readJson(FILES.focus),
      store.readJson(FILES.apps),
    ]);
    return new CompanionService(
      deps,
      parseSettings(settings),
      parseConsent(consent),
      parsePause(state),
      parseFocus(focus),
      parseAppNames(apps),
    );
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- state ---------------------------------------------------------------

  status(): TrackingStatus {
    if (!this.hasConsent()) return 'needs_consent';
    if (this.isPaused()) return 'paused';
    return this.idle ? 'idle' : 'tracking';
  }

  state(): CompanionState {
    const granted = consentAt(this.consent, 'desktop_activity', this.deps.now());
    return {
      status: this.status(),
      pausedUntil: this.isPaused() ? this.pause!.until : null,
      focusStartedAt: this.activeFocus()?.start ?? null,
      todayActiveMinutes: this.todayMinutes,
      timeZone: this.deps.timeZone(),
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      consentGrantedAt: granted?.granted ? granted.at : null,
      detectorRunning: this.detectorRunning,
    };
  }

  sampleIntervalSec(): number {
    return this.settings.sampleIntervalSec;
  }

  setDetectorRunning(running: boolean): void {
    if (running === this.detectorRunning) return;
    this.detectorRunning = running;
    this.emit();
  }

  // --- sampling --------------------------------------------------------------

  tick(input: TickInput): Promise<void> {
    return this.serial(async () => {
      const now = this.deps.now();
      if (this.pause && this.pause.until !== null && this.pause.until <= now) {
        this.pause = null;
        await this.persistState();
        this.emit();
      }
      const focus = this.activeFocus();
      if (focus && now - focus.start >= MAX_FOCUS_MS) await this.closeFocus(focus.start + MAX_FOCUS_MS);

      const status = this.status();
      if (status === 'needs_consent' || status === 'paused') return;

      const excluded = input.appId !== null && this.settings.deniedApps.includes(input.appId);
      if (input.appId && input.appName && !excluded && this.appNames[input.appId] !== input.appName) {
        this.appNames = { ...this.appNames, [input.appId]: input.appName };
        await this.deps.store.writeJson(FILES.apps, { names: this.appNames });
      }
      const idle = input.idleSeconds >= this.settings.idleThresholdSec;
      if (idle !== this.idle) {
        this.idle = idle;
        this.emit();
      }
      const ready = this.buffer.tick({ now, appId: input.appId, idleSeconds: input.idleSeconds });
      if (ready.length > 0) await this.deps.store.appendSamples(ready);
    });
  }

  /** Persists buffered samples, e.g. before sleep or quit. */
  flush(): Promise<void> {
    return this.serial(() => this.deps.store.appendSamples(this.buffer.drain()));
  }

  // --- consent ---------------------------------------------------------------

  grantConsent(): Promise<void> {
    return this.serial(async () => {
      this.consent = grantConsent(this.consent, 'desktop_activity', this.deps.now(), PRIVACY_NOTICE_VERSION);
      await this.deps.store.writeJson(FILES.consent, { ledger: this.consent });
      this.emit();
    });
  }

  /** Stops tracking at once. Buffered samples are discarded, never written. */
  revokeConsent(deleteData: boolean): Promise<void> {
    return this.serial(async () => {
      this.buffer.discard();
      const focus = this.activeFocus();
      if (focus) await this.closeFocus(this.deps.now());
      this.consent = revokeConsent(this.consent, 'desktop_activity', this.deps.now(), PRIVACY_NOTICE_VERSION);
      await this.deps.store.writeJson(FILES.consent, { ledger: this.consent });
      if (deleteData) await this.deleteAllActivity();
      await this.refreshTodayUnlocked();
      this.emit();
    });
  }

  // --- pause & focus ------------------------------------------------------------

  pauseFor(duration: PauseDuration): Promise<void> {
    return this.serial(async () => {
      const now = this.deps.now();
      // The user is present right now, so buffered samples are real activity.
      await this.deps.store.appendSamples(this.buffer.drain());
      let until: Instant | null = null;
      if (duration === 'tomorrow') {
        until = localDayWindow(this.today(), this.deps.timeZone()).end;
      } else if (typeof duration === 'number') {
        until = now + duration * 60_000;
      }
      this.pause = { until };
      await this.persistState();
      this.emit();
    });
  }

  resume(): Promise<void> {
    return this.serial(async () => {
      this.pause = null;
      await this.persistState();
      this.emit();
    });
  }

  startFocus(): Promise<void> {
    return this.serial(async () => {
      if (!this.hasConsent()) throw new Error('Tracking permission is required for focus sessions');
      if (this.activeFocus()) return;
      this.focus = [...this.focus, { start: this.deps.now() }];
      await this.persistFocus();
      this.emit();
    });
  }

  stopFocus(): Promise<void> {
    return this.serial(async () => {
      if (!this.activeFocus()) return;
      await this.closeFocus(this.deps.now());
    });
  }

  // --- app categories ---------------------------------------------------------

  apps(): AppsView {
    const name = (appId: string) => this.appNames[appId] ?? appId;
    return {
      categories: CATEGORIES,
      mapped: Object.entries(this.settings.categoryByApp)
        .map(([appId, category]) => ({ appId, name: name(appId), category }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      excluded: this.settings.deniedApps.map((appId) => ({ appId, name: name(appId) })),
    };
  }

  setCategory(appId: string, category: string | null): Promise<void> {
    return this.serial(async () => {
      if (!isBundleId(appId)) throw new Error('Invalid app id');
      if (category !== null && !isCategory(category)) throw new Error('Unknown category');
      const mapping = { ...this.settings.categoryByApp };
      if (category === null) delete mapping[appId];
      else mapping[appId] = category;
      await this.saveSettings({
        ...this.settings,
        categoryByApp: mapping,
        deniedApps: this.settings.deniedApps.filter((app) => app !== appId),
      });
    });
  }

  /** Excluding an app also deletes everything already recorded for it. */
  setExcluded(appId: string, excluded: boolean): Promise<void> {
    return this.serial(async () => {
      if (!isBundleId(appId)) throw new Error('Invalid app id');
      const denied = this.settings.deniedApps.filter((app) => app !== appId);
      const mapping = { ...this.settings.categoryByApp };
      if (excluded) {
        denied.push(appId);
        delete mapping[appId];
      }
      await this.saveSettings({ ...this.settings, categoryByApp: mapping, deniedApps: denied });
      if (excluded) {
        await this.deps.store.forgetApp(appId);
        await this.refreshTodayUnlocked();
      }
    });
  }

  // --- data controls ---------------------------------------------------------

  forget(scope: ForgetScope): Promise<void> {
    return this.serial(async () => {
      const now = this.deps.now();
      this.buffer.discard();
      if (scope === 'last_hour') {
        await this.deps.store.forgetRange({ start: now - HOUR, end: now + 1 });
        await this.trimFocus({ start: now - HOUR, end: now + 1 });
      } else if (scope === 'today') {
        const window = localDayWindow(this.today(), this.deps.timeZone());
        await this.deps.store.forgetRange(window);
        await this.trimFocus(window);
      } else {
        await this.deleteAllActivity();
      }
      await this.refreshTodayUnlocked();
      this.emit();
    });
  }

  /** Applies the retention setting to raw samples and focus history. */
  prune(): Promise<void> {
    return this.serial(async () => {
      const cutoff = this.deps.now() - this.settings.retentionDays * DAY;
      await this.deps.store.pruneBefore(localDateKey(cutoff, this.deps.timeZone()));
      const kept = this.focus.filter((block) => (block.end ?? Infinity) >= cutoff);
      if (kept.length !== this.focus.length) {
        this.focus = kept;
        await this.persistFocus();
      }
    });
  }

  // --- views -----------------------------------------------------------------

  timeline(dateKey: string): Promise<TimelineView> {
    return this.serial(() => this.timelineUnlocked(dateKey));
  }

  /** Recomputes today's tracked minutes for the menu bar. */
  refreshToday(): Promise<void> {
    return this.serial(() => this.refreshTodayUnlocked());
  }

  exportDay(dateKey: string): Promise<DesktopExport> {
    return this.serial(async () => {
      const window = localDayWindow(dateKey, this.deps.timeZone());
      const samples = await this.deps.store.readSamples(window);
      return buildExport({
        sessions: buildSessions(samples, this.settings, this.focus, this.deps.now()),
        timeZone: this.deps.timeZone(),
        consent: this.consent,
        userId: LOCAL_USER_ID,
        now: this.deps.now(),
      });
    });
  }

  today(): string {
    return localDateKey(this.deps.now(), this.deps.timeZone());
  }

  // --- internals ---------------------------------------------------------------

  private async timelineUnlocked(dateKey: string): Promise<TimelineView> {
    const window = localDayWindow(dateKey, this.deps.timeZone());
    const stored = await this.deps.store.readSamples(window);
    const live = dateKey === this.today() ? this.buffer.peek() : [];
    return buildTimeline({
      dateKey,
      timeZone: this.deps.timeZone(),
      samples: [...stored, ...live],
      settings: this.settings,
      focusBlocks: this.focus,
      appNames: this.appNames,
      now: this.deps.now(),
    });
  }

  private async refreshTodayUnlocked(): Promise<void> {
    const view = await this.timelineUnlocked(this.today());
    const minutes = view.totals.reduce((sum, total) => sum + total.minutes, 0);
    if (minutes !== this.todayMinutes) {
      this.todayMinutes = minutes;
      this.emit();
    }
  }

  private async deleteAllActivity(): Promise<void> {
    await this.deps.store.forgetAllSamples();
    this.focus = [];
    await this.persistFocus();
    // Keep names only for apps the user still has a decision about.
    const keep = new Set([...Object.keys(this.settings.categoryByApp), ...this.settings.deniedApps]);
    this.appNames = Object.fromEntries(Object.entries(this.appNames).filter(([appId]) => keep.has(appId)));
    await this.deps.store.writeJson(FILES.apps, { names: this.appNames });
  }

  private async trimFocus(range: { start: Instant; end: Instant }): Promise<void> {
    const now = this.deps.now();
    this.focus = this.focus.filter((block) => (block.end ?? now) <= range.start || block.start >= range.end);
    await this.persistFocus();
  }

  private async closeFocus(end: Instant): Promise<void> {
    this.focus = this.focus.map((block) => (block.end === undefined ? { start: block.start, end } : block));
    await this.persistFocus();
    this.emit();
  }

  private async saveSettings(next: CompanionSettings): Promise<void> {
    this.settings = parseSettings(next);
    this.buffer.configure(this.samplerOptions());
    await this.deps.store.writeJson(FILES.settings, this.settings);
    this.emit();
  }

  private persistState(): Promise<void> {
    return this.deps.store.writeJson(FILES.state, { pause: this.pause });
  }

  private persistFocus(): Promise<void> {
    return this.deps.store.writeJson(FILES.focus, { blocks: this.focus });
  }

  private activeFocus(): StoredFocusBlock | undefined {
    return this.focus.find((block) => block.end === undefined);
  }

  private hasConsent(): boolean {
    return hasConsent(this.consent, 'desktop_activity', this.deps.now());
  }

  private isPaused(): boolean {
    return this.pause !== null && (this.pause.until === null || this.pause.until > this.deps.now());
  }

  private samplerOptions() {
    return {
      idleThresholdSec: this.settings.idleThresholdSec,
      deniedApps: new Set(this.settings.deniedApps),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Store operations run one at a time so rewrites never race appends. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function parseConsent(raw: unknown): ConsentLedger {
  const ledger = (raw as { ledger?: unknown } | undefined)?.ledger;
  if (!Array.isArray(ledger)) return [];
  return ledger.filter(
    (record): record is ConsentRecord =>
      !!record &&
      typeof record === 'object' &&
      (CONSENT_SCOPES as readonly unknown[]).includes(record.scope) &&
      typeof record.granted === 'boolean' &&
      typeof record.at === 'number' &&
      typeof record.policyVersion === 'string',
  );
}

function parsePause(raw: unknown): Pause | null {
  const pause = (raw as { pause?: unknown } | undefined)?.pause as { until?: unknown } | null | undefined;
  if (!pause || typeof pause !== 'object') return null;
  if (pause.until === null) return { until: null };
  return typeof pause.until === 'number' ? { until: pause.until } : null;
}

function parseFocus(raw: unknown): StoredFocusBlock[] {
  const blocks = (raw as { blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const parsed = blocks.flatMap((block): StoredFocusBlock[] => {
    if (!block || typeof block.start !== 'number') return [];
    return [typeof block.end === 'number' && block.end > block.start ? { start: block.start, end: block.end } : { start: block.start }];
  });
  // At most one block may be open: close any stale extras at their start.
  let open = 0;
  return parsed
    .reverse()
    .map((block) => (block.end === undefined && open++ > 0 ? { start: block.start, end: block.start + 1 } : block))
    .reverse();
}

function parseAppNames(raw: unknown): Record<string, string> {
  const names = (raw as { names?: unknown } | undefined)?.names;
  if (!names || typeof names !== 'object') return {};
  return Object.fromEntries(
    Object.entries(names as Record<string, unknown>).filter(
      (entry): entry is [string, string] => isBundleId(entry[0]) && typeof entry[1] === 'string',
    ),
  );
}
