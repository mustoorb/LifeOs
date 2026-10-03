import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import { isBundleId } from '../core/settings.js';
import type { AccountManager } from '../core/account.js';
import type { CompanionService } from '../core/service.js';
import {
  CHANNELS,
  type AccountView,
  type CompanionState,
  type ExportResult,
  type ForgetScope,
  type PauseDuration,
  type RegistrationForm,
} from '../shared/api.js';
import { RENDERER_URL, currentWindow } from './window.js';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PAUSES: readonly PauseDuration[] = [30, 60, 'tomorrow', 'indefinite'];
const SCOPES: readonly ForgetScope[] = ['last_hour', 'today', 'everything'];

/** Only our own bundled page may call in. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  if (url.split('#')[0] !== RENDERER_URL) throw new Error('Untrusted IPC sender');
}

function expect<T>(value: unknown, valid: (v: unknown) => v is T, what: string): T {
  if (!valid(value)) throw new Error(`Invalid ${what}`);
  return value;
}

const isDateKey = (v: unknown): v is string => typeof v === 'string' && DATE_KEY.test(v);
const isPause = (v: unknown): v is PauseDuration => PAUSES.includes(v as PauseDuration);
const isScope = (v: unknown): v is ForgetScope => SCOPES.includes(v as ForgetScope);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isCategoryArg = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length < 64);

/** Destructive actions are confirmed in main, where the renderer can't skip it. */
async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const window = currentWindow();
  const options = { type: 'warning' as const, message, detail, buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1 };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

export async function forgetWithConfirmation(service: CompanionService, scope: ForgetScope, alsoAccount = false): Promise<void> {
  const text: Record<ForgetScope, [string, string]> = {
    last_hour: ['Delete the last hour?', 'Everything recorded on this Mac in the past 60 minutes will be removed.'],
    today: ['Delete today?', 'Everything recorded on this Mac today will be removed.'],
    everything: [
      'Delete all recorded activity?',
      'All app samples and focus sessions stored on this Mac will be removed. Your app categories are kept.',
    ],
  };
  const [message, detail] = text[scope];
  const note = alsoAccount ? ' It is also removed from your LifeOS account.' : '';
  if (await confirm(message, detail + note, 'Delete')) await service.forget(scope);
}

const isShortString = (max: number) => (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parseRegistration(value: unknown): RegistrationForm {
  const form = (value ?? {}) as Record<string, unknown>;
  return {
    accessCode: expect(form.accessCode, isShortString(20), 'access code'),
    displayName: expect(form.displayName, isShortString(40), 'name'),
    birthDate: expect(form.birthDate, (v): v is string => typeof v === 'string' && DATE_KEY.test(v), 'date of birth'),
    region: expect(form.region, (v): v is string => typeof v === 'string' && /^[A-Za-z]{2}$/.test(v), 'region'),
    acceptTerms: expect(form.acceptTerms, isBoolean, 'terms'),
  };
}

export function registerIpc(service: CompanionService, account: AccountManager): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) =>
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event);
      return fn(...(args as A));
    });
  const withState = async (task: Promise<void>): Promise<CompanionState> => {
    await task;
    return service.state();
  };

  const withAccount = async (task: Promise<void>): Promise<AccountView> => {
    await task;
    return account.view();
  };
  handle(CHANNELS.getAccount, () => account.view());
  handle(CHANNELS.startSignIn, (email: unknown) => withAccount(account.startSignIn(expect(email, isShortString(254), 'email'))));
  handle(CHANNELS.verifyCode, (code: unknown) => withAccount(account.verifyCode(expect(code, isShortString(12), 'code'))));
  handle(CHANNELS.register, (form: unknown) => withAccount(account.register(parseRegistration(form))));
  handle(CHANNELS.cancelSignIn, () => withAccount(account.cancelSignIn()));
  handle(CHANNELS.signOut, () => withAccount(account.signOut()));
  handle(CHANNELS.setUpload, (enabled: unknown) => withAccount(account.setUpload(expect(enabled, isBoolean, 'flag'))));
  handle(CHANNELS.syncNow, () => withAccount(account.sync()));

  handle(CHANNELS.getState, () => service.state());
  handle(CHANNELS.getTimeline, (dateKey: unknown) => service.timeline(expect(dateKey, isDateKey, 'date')));
  handle(CHANNELS.getApps, () => service.apps());
  handle(CHANNELS.grantConsent, () => withState(service.grantConsent()));
  handle(CHANNELS.revokeConsent, async (deleteData: unknown) => {
    const wipe = expect(deleteData, isBoolean, 'flag');
    if (wipe && !(await confirm('Turn off tracking and delete activity?', 'Tracking stops now and everything recorded on this Mac is removed.', 'Turn off and delete'))) {
      return service.state();
    }
    return withState(service.revokeConsent(wipe));
  });
  handle(CHANNELS.pause, (duration: unknown) => withState(service.pauseFor(expect(duration, isPause, 'pause'))));
  handle(CHANNELS.resume, () => withState(service.resume()));
  handle(CHANNELS.startFocus, () => withState(service.startFocus()));
  handle(CHANNELS.stopFocus, () => withState(service.stopFocus()));
  handle(CHANNELS.setCategory, async (appId: unknown, category: unknown) => {
    await service.setCategory(expect(appId, isBundleId, 'app'), expect(category, isCategoryArg, 'category'));
    return service.apps();
  });
  handle(CHANNELS.setExcluded, async (appId: unknown, excluded: unknown) => {
    const app = expect(appId, isBundleId, 'app');
    const exclude = expect(excluded, isBoolean, 'flag');
    if (exclude && !(await confirm('Exclude this app?', 'It will never be recorded, and what was already recorded for it is deleted.', 'Exclude'))) {
      return service.apps();
    }
    await service.setExcluded(app, exclude);
    return service.apps();
  });
  handle(CHANNELS.forget, (scope: unknown) =>
    withState(forgetWithConfirmation(service, expect(scope, isScope, 'scope'), account.view().upload.since !== null)),
  );
  handle(CHANNELS.exportDay, async (dateKey: unknown): Promise<ExportResult> => {
    const key = expect(dateKey, isDateKey, 'date');
    const payload = await service.exportDay(key);
    if (payload.events.length === 0) return { kind: 'empty' };
    const window = currentWindow();
    const options = {
      title: 'Export activity summary',
      defaultPath: `lifeos-desktop-${key}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { kind: 'cancelled' };
    await writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return { kind: 'saved', path: result.filePath, events: payload.events.length };
  });
}
