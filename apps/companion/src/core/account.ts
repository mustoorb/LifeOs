import { localDayWindow, localDateKey, type Instant, type Interval } from '@lifeos/contracts';
import type { AccountView } from '../shared/api.js';
import { AccountApiError, MAX_EVENTS_PER_UPLOAD, type AccountClient, type RemoteAccount, type UploadResult } from './account-client.js';
import type { CompanionService } from './service.js';
import type { LocalStore } from './store.js';

/**
 * Encrypts the session token at rest. In the app this is Electron's
 * safeStorage (macOS Keychain). When it is unavailable the token is kept in
 * memory only and the user signs in again after a restart.
 */
export interface SecretBox {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

/** Sent with sign-in so the account's device list is recognizable without naming the Mac. */
export const DEVICE_LABEL = 'LifeOS Companion · macOS';

const FILE = 'account.json';

interface UploadState {
  readonly enabled: boolean;
  /** Sessions that ended at or before this instant have been uploaded. */
  readonly watermark: Instant | null;
  /** Local deletions not yet applied to the account. */
  readonly pendingDeletes: readonly Interval[];
  /** Upload was turned off but the account hasn't recorded it yet. */
  readonly revokePending: boolean;
  readonly lastSyncAt: Instant | null;
  readonly lastResult: { readonly accepted: number; readonly duplicates: number; readonly rejected: number } | null;
  readonly lastError: string | null;
}

interface Persisted {
  readonly version: 1;
  readonly serverUrl: string;
  readonly account: RemoteAccount | null;
  readonly sealedToken: string | null;
  readonly upload: UploadState;
}

const NO_UPLOAD: UploadState = {
  enabled: false,
  watermark: null,
  pendingDeletes: [],
  revokePending: false,
  lastSyncAt: null,
  lastResult: null,
  lastError: null,
};

export interface AccountDeps {
  readonly store: LocalStore;
  readonly service: CompanionService;
  readonly client: AccountClient;
  readonly secrets: SecretBox;
  readonly now: () => Instant;
  readonly timeZone: () => string;
}

export interface RegistrationInput {
  readonly accessCode: string;
  readonly displayName: string;
  readonly birthDate: string;
  readonly region: string;
  readonly acceptTerms: boolean;
}

/**
 * Connects the companion to a LifeOS account and uploads settled desktop
 * sessions. Uploading is a separate, explicit choice, recorded as consent
 * on the account; signing in alone uploads nothing.
 */
export class AccountManager {
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private pending: { email: string; registrationToken?: string; termsVersion?: string } | null = null;
  private token: string | null;
  private notice: string | null = null;

  private constructor(
    private readonly deps: AccountDeps,
    private account: RemoteAccount | null,
    token: string | null,
    private upload: UploadState,
  ) {
    this.token = token;
    deps.service.onForget((range) => void this.handleForget(range));
  }

  static async open(deps: AccountDeps): Promise<AccountManager> {
    const saved = parsePersisted(await deps.store.readJson(FILE));
    let token: string | null = null;
    if (saved && saved.serverUrl === deps.client.baseUrl && saved.account && saved.sealedToken && deps.secrets.available) {
      try {
        token = deps.secrets.decrypt(saved.sealedToken);
      } catch {
        token = null;
      }
    }
    const signedIn = token !== null && saved?.account;
    return new AccountManager(deps, signedIn ? saved!.account : null, token, signedIn ? saved!.upload : NO_UPLOAD);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): AccountView {
    const status = this.token && this.account
      ? 'signed_in'
      : this.pending?.registrationToken
        ? 'registration_required'
        : this.pending
          ? 'awaiting_code'
          : 'signed_out';
    return {
      status,
      serverUrl: this.deps.client.baseUrl,
      email: this.account?.email ?? this.pending?.email ?? null,
      displayName: this.account?.displayName ?? null,
      staysSignedIn: this.deps.secrets.available,
      termsVersion: this.pending?.termsVersion ?? null,
      notice: this.notice,
      upload: {
        enabled: this.upload.enabled,
        since: this.upload.watermark,
        lastSyncAt: this.upload.lastSyncAt,
        lastResult: this.upload.lastResult,
        lastError: this.upload.lastError,
        pendingDeletes: this.upload.pendingDeletes.length,
        syncing: this.syncing !== null,
      },
    };
  }

  // --- sign-in -----------------------------------------------------------------

  startSignIn(email: string): Promise<void> {
    return this.serial(async () => {
      const trimmed = email.trim();
      await this.deps.client.startSignIn(trimmed);
      this.pending = { email: trimmed };
      this.notice = null;
      this.emit();
    });
  }

  verifyCode(code: string): Promise<void> {
    return this.serial(async () => {
      if (!this.pending) throw new Error('Request a sign-in code first.');
      const result = await this.deps.client.verify(this.pending.email, code.replace(/\s/g, ''), DEVICE_LABEL);
      if (result.status === 'signed_in') {
        await this.signedIn(result.token, result.account);
      } else {
        this.pending = { ...this.pending, registrationToken: result.registrationToken, termsVersion: result.termsVersion };
        this.emit();
      }
    });
  }

  register(input: RegistrationInput): Promise<void> {
    return this.serial(async () => {
      const pending = this.pending;
      if (!pending?.registrationToken || !pending.termsVersion) throw new Error('Verify your email first.');
      if (!input.acceptTerms) throw new Error('Accept the terms to create your account.');
      const result = await this.deps.client.register({
        registrationToken: pending.registrationToken,
        accessCode: input.accessCode.trim(),
        displayName: input.displayName.trim(),
        birthDate: input.birthDate,
        region: input.region.trim(),
        acceptedTerms: pending.termsVersion,
        deviceLabel: DEVICE_LABEL,
      });
      await this.signedIn(result.token, result.account);
    });
  }

  cancelSignIn(): Promise<void> {
    return this.serial(async () => {
      this.pending = null;
      this.emit();
    });
  }

  /** Signs out here and ends the session on the server when reachable. */
  signOut(): Promise<void> {
    return this.serial(async () => {
      const token = this.token;
      await this.clearLocal(null);
      if (token) await this.deps.client.logout(token).catch(() => undefined);
    });
  }

  // --- upload ------------------------------------------------------------------

  /**
   * Turning upload on records consent on the account and starts from the
   * beginning of today; nothing earlier is sent. Turning it off records the
   * revocation and stops further uploads.
   */
  setUpload(enabled: boolean): Promise<void> {
    return this.serial(async () => {
      const token = this.requireToken();
      if (enabled) {
        await this.callAuthed(() => this.deps.client.setConsent(token, 'desktop_activity', true));
        const startOfToday = localDayWindow(localDateKey(this.deps.now(), this.deps.timeZone()), this.deps.timeZone()).start;
        this.upload = { ...this.upload, enabled: true, watermark: this.upload.watermark ?? startOfToday, lastError: null };
      } else {
        // Stop locally at once; record the revocation on the account now or at the next sync.
        this.upload = { ...this.upload, enabled: false, revokePending: true };
        await this.persist();
        this.emit();
        try {
          await this.callAuthed(() => this.deps.client.setConsent(token, 'desktop_activity', false));
          this.upload = { ...this.upload, revokePending: false };
        } catch (error) {
          if (!(error instanceof AccountApiError && error.offline)) throw error;
        }
      }
      await this.persist();
      this.emit();
    }).then(() => (enabled ? this.sync() : undefined));
  }

  /** Uploads settled sessions and pending deletions. Concurrent calls share one run. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.serial(() => this.syncUnlocked()).finally(() => {
      this.syncing = null;
      this.emit();
    });
    this.emit();
    return this.syncing;
  }

  private async syncUnlocked(): Promise<void> {
    const token = this.token;
    if (!token || !this.account) return;
    const now = this.deps.now();
    try {
      // Confirms the session is still valid (a 401 signs out here) and picks up profile changes.
      const me = await this.deps.client.me(token);
      if (me.email !== this.account.email || me.displayName !== this.account.displayName) {
        this.account = { id: me.id, email: me.email, displayName: me.displayName };
        await this.persist();
      }
      if (this.upload.revokePending) {
        await this.deps.client.setConsent(token, 'desktop_activity', false);
        this.upload = { ...this.upload, revokePending: false };
        await this.persist();
      }
      // Deletions first: the user's "delete" must reach the account even if uploads are off.
      while (this.upload.pendingDeletes.length > 0) {
        const [range, ...rest] = this.upload.pendingDeletes;
        await this.deps.client.deleteActivity(token, range!.start, range!.end);
        this.upload = { ...this.upload, pendingDeletes: rest };
        await this.persist();
      }
      if (!this.upload.enabled || this.upload.watermark === null) return;

      const until = now - this.deps.service.settleDelayMs();
      if (until <= this.upload.watermark) return;
      const payload = await this.deps.service.exportSettled(this.upload.watermark, until);
      const total = { accepted: 0, duplicates: 0, rejected: payload.rejected.length };
      for (let i = 0; i < payload.events.length; i += MAX_EVENTS_PER_UPLOAD) {
        const chunk = payload.events.slice(i, i + MAX_EVENTS_PER_UPLOAD);
        const result: UploadResult = await this.deps.client.uploadDesktop(token, { format: payload.format, version: payload.version, events: chunk });
        total.accepted += result.accepted;
        total.duplicates += result.duplicates;
        total.rejected += result.rejected.length;
      }
      this.upload = { ...this.upload, watermark: until, lastSyncAt: now, lastResult: total, lastError: null };
      await this.persist();
    } catch (error) {
      await this.handleSyncError(error, now);
    }
  }

  private async handleSyncError(error: unknown, now: Instant): Promise<void> {
    if (error instanceof AccountApiError && error.status === 401) {
      await this.clearLocal('Your LifeOS session ended. Sign in again to keep uploading.');
      return;
    }
    if (error instanceof AccountApiError && error.code === 'consent_required') {
      this.upload = { ...this.upload, enabled: false, lastError: 'Uploads were turned off for this account. Turn them on again to continue.' };
    } else {
      const message = error instanceof AccountApiError && !error.offline ? error.message : 'Could not reach LifeOS. Will try again shortly.';
      this.upload = { ...this.upload, lastSyncAt: now, lastError: message };
    }
    await this.persist();
  }

  /** Mirrors a local deletion on the account once anything may have been uploaded. */
  private handleForget(range: Interval): Promise<void> {
    return this.serial(async () => {
      if (!this.token || this.upload.watermark === null) return;
      this.upload = { ...this.upload, pendingDeletes: [...this.upload.pendingDeletes, range] };
      await this.persist();
      this.emit();
    }).then(() => this.sync());
  }

  // --- internals ---------------------------------------------------------------

  private async signedIn(token: string, account: RemoteAccount): Promise<void> {
    this.token = token;
    this.account = { id: account.id, email: account.email, displayName: account.displayName };
    this.pending = null;
    this.notice = null;
    this.upload = NO_UPLOAD;
    await this.persist();
    this.emit();
  }

  private async clearLocal(notice: string | null): Promise<void> {
    this.token = null;
    this.account = null;
    this.pending = null;
    this.upload = NO_UPLOAD;
    this.notice = notice;
    await this.persist();
    this.emit();
  }

  private requireToken(): string {
    if (!this.token) throw new Error('Sign in to LifeOS first.');
    return this.token;
  }

  private async callAuthed<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) {
        await this.clearLocal('Your LifeOS session ended. Sign in again.');
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const sealedToken = this.token && this.deps.secrets.available ? this.deps.secrets.encrypt(this.token) : null;
    const persisted: Persisted = {
      version: 1,
      serverUrl: this.deps.client.baseUrl,
      account: this.account,
      sealedToken,
      upload: this.upload,
    };
    await this.deps.store.writeJson(FILE, persisted);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function parsePersisted(raw: unknown): Persisted | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Persisted>;
  if (value.version !== 1 || typeof value.serverUrl !== 'string') return null;
  const account = value.account;
  const validAccount =
    account && typeof account.id === 'string' && typeof account.email === 'string' && typeof account.displayName === 'string';
  const upload = (value.upload ?? {}) as Partial<UploadState>;
  const intervals = Array.isArray(upload.pendingDeletes)
    ? upload.pendingDeletes.filter((r): r is Interval => !!r && typeof r.start === 'number' && typeof r.end === 'number')
    : [];
  return {
    version: 1,
    serverUrl: value.serverUrl,
    account: validAccount ? { id: account.id, email: account.email, displayName: account.displayName } : null,
    sealedToken: typeof value.sealedToken === 'string' ? value.sealedToken : null,
    upload: {
      enabled: upload.enabled === true,
      watermark: typeof upload.watermark === 'number' ? upload.watermark : null,
      pendingDeletes: intervals,
      revokePending: upload.revokePending === true,
      lastSyncAt: typeof upload.lastSyncAt === 'number' ? upload.lastSyncAt : null,
      lastResult: upload.lastResult ?? null,
      lastError: typeof upload.lastError === 'string' ? upload.lastError : null,
    },
  };
}
