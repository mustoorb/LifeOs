import { BrowserWindow, app, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS } from '../shared/api.js';

export const RENDERER_URL = pathToFileURL(join(__dirname, 'renderer', 'index.html')).href;

let current: BrowserWindow | null = null;

export function openWindow(section?: 'privacy'): BrowserWindow {
  if (current && !current.isDestroyed()) {
    if (section) current.webContents.send(CHANNELS.navigate, section);
    current.show();
    current.focus();
    app.focus({ steal: true });
    return current;
  }

  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: 'LifeOS Companion',
    show: false,
    backgroundColor: '#f7f6f3',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  current = window;

  // The window shows local files only; links go to the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  window.once('ready-to-show', () => {
    window.show();
    app.focus({ steal: true });
  });
  window.on('closed', () => {
    if (current === window) current = null;
  });
  void window.loadURL(section ? `${RENDERER_URL}#${section}` : RENDERER_URL);
  return window;
}

export function currentWindow(): BrowserWindow | null {
  return current && !current.isDestroyed() ? current : null;
}
