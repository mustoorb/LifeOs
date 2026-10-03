import { Menu, Tray, app, powerMonitor } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CompanionService } from '../core/service.js';
import { LocalStore } from '../core/store.js';
import { CHANNELS } from '../shared/api.js';
import { FixedDetector, HelperDetector, parseDevFrontmost, type FrontmostDetector } from './frontmost.js';
import { createTrayIcon } from './icon.js';
import { forgetWithConfirmation, registerIpc } from './ipc.js';
import { buildMenuTemplate, trayTitle, type MenuActions } from './menu.js';
import { currentWindow, openWindow } from './window.js';

/** The companion's own bundle id; looking at your own timeline is not activity. */
const OWN_BUNDLE_IDS = new Set(['app.lifeos.companion', 'com.github.Electron']);
const MINUTE_MS = 60_000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('LifeOS Companion');
  app.on('second-instance', () => openWindow());
  // Closing the window keeps the companion running in the menu bar.
  app.on('window-all-closed', () => {});
  void app.whenReady().then(start);
}

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'lifeos-frontmost')
    : join(app.getAppPath(), 'build', 'bin', 'lifeos-frontmost');
}

function createDetector(onRunningChange: (running: boolean) => void): FrontmostDetector {
  const dev = !app.isPackaged ? parseDevFrontmost(process.env.LIFEOS_DEV_FRONTMOST) : null;
  if (dev) return new FixedDetector(dev);
  const path = helperPath();
  if (!existsSync(path)) {
    console.warn(`[companion] native helper not found at ${path}; app detection is off`);
  }
  return new HelperDetector(path, [], onRunningChange);
}

async function start(): Promise<void> {
  app.dock?.hide();
  const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dataDir = process.env.LIFEOS_DATA_DIR && !app.isPackaged ? process.env.LIFEOS_DATA_DIR : join(app.getPath('userData'), 'activity');
  const service = await CompanionService.open({ store: new LocalStore(dataDir, timeZone), now: Date.now, timeZone });

  const detector = createDetector((running) => service.setDetectorRunning(running));
  detector.start();
  service.setDetectorRunning(detector.running);
  registerIpc(service);

  // --- menu bar ---
  const tray = new Tray(createTrayIcon());
  tray.setToolTip('LifeOS Companion');
  const actions: MenuActions = {
    openWindow: (section) => openWindow(section),
    pause: (duration) => void service.pauseFor(duration),
    resume: () => void service.resume(),
    startFocus: () => void service.startFocus(),
    stopFocus: () => void service.stopFocus(),
    forget: (scope) => void forgetWithConfirmation(service, scope),
    quit: () => app.quit(),
  };
  const render = () => {
    const state = service.state();
    tray.setTitle(trayTitle(state, Date.now()), { fontType: 'monospacedDigit' });
    tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(state, actions, Date.now())));
    currentWindow()?.webContents.send(CHANNELS.stateChanged, state);
  };
  service.onChange(render);
  render();

  // --- sampling ---
  let sampler: NodeJS.Timeout | null = null;
  const tick = () => {
    const front = detector.current();
    const locked = powerMonitor.getSystemIdleState(1) === 'locked';
    const appId = locked || (front.bundleId && OWN_BUNDLE_IDS.has(front.bundleId)) ? null : front.bundleId;
    void service.tick({ appId, appName: front.name, idleSeconds: powerMonitor.getSystemIdleTime() }).catch(logError);
  };
  const startSampling = () => {
    if (sampler) return;
    sampler = setInterval(tick, service.sampleIntervalSec() * 1000);
  };
  const stopSampling = () => {
    if (sampler) clearInterval(sampler);
    sampler = null;
  };
  startSampling();

  // Asleep or locked: nobody is at the Mac. Persist what we have and stop.
  powerMonitor.on('suspend', () => {
    stopSampling();
    void service.flush().catch(logError);
  });
  powerMonitor.on('lock-screen', () => void service.flush().catch(logError));
  powerMonitor.on('resume', startSampling);

  // Today's total for the menu bar, and the retention sweep.
  setInterval(() => {
    void service.refreshToday().then(render).catch(logError);
  }, MINUTE_MS);
  setInterval(() => void service.prune().catch(logError), 6 * 60 * MINUTE_MS);
  void service.prune().then(() => service.refreshToday()).catch(logError);

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopSampling();
    detector.stop();
    void service.flush().catch(logError).finally(() => app.quit());
  });

  if (service.status() === 'needs_consent') openWindow();
}

function logError(error: unknown): void {
  console.error('[companion]', error);
}
