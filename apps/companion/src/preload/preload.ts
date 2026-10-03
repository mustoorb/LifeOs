import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type CompanionApi, type CompanionState } from '../shared/api.js';

/** The only surface the window can reach: typed calls, no Node, no raw IPC. */
const api: CompanionApi = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  getTimeline: (dateKey) => ipcRenderer.invoke(CHANNELS.getTimeline, dateKey),
  getApps: () => ipcRenderer.invoke(CHANNELS.getApps),
  grantConsent: () => ipcRenderer.invoke(CHANNELS.grantConsent),
  revokeConsent: (deleteData) => ipcRenderer.invoke(CHANNELS.revokeConsent, deleteData),
  pause: (duration) => ipcRenderer.invoke(CHANNELS.pause, duration),
  resume: () => ipcRenderer.invoke(CHANNELS.resume),
  startFocus: () => ipcRenderer.invoke(CHANNELS.startFocus),
  stopFocus: () => ipcRenderer.invoke(CHANNELS.stopFocus),
  setCategory: (appId, category) => ipcRenderer.invoke(CHANNELS.setCategory, appId, category),
  setExcluded: (appId, excluded) => ipcRenderer.invoke(CHANNELS.setExcluded, appId, excluded),
  forget: (scope) => ipcRenderer.invoke(CHANNELS.forget, scope),
  exportDay: (dateKey) => ipcRenderer.invoke(CHANNELS.exportDay, dateKey),
  onStateChanged(listener) {
    const handler = (_event: IpcRendererEvent, state: CompanionState) => listener(state);
    ipcRenderer.on(CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, handler);
  },
  onNavigate(listener) {
    const handler = (_event: IpcRendererEvent, section: string) => listener(section);
    ipcRenderer.on(CHANNELS.navigate, handler);
    return () => ipcRenderer.removeListener(CHANNELS.navigate, handler);
  },
};

contextBridge.exposeInMainWorld('lifeos', api);
