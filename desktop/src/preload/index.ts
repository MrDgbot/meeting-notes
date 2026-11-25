import { IPC } from "@shared/ipc";
import type {
  BootstrapMirror,
  DesktopAPI,
  DetectedMeetingApp,
  QuickMarkPayload,
  SidecarLogEntry,
  SidecarStatus,
  ThemeMode,
} from "@shared/types";
import { contextBridge, ipcRenderer } from "electron";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_ev: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function subscribeVoid(channel: string, cb: () => void): () => void {
  const listener = () => cb();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const desktopAPI: DesktopAPI = {
  getInfo: () => ipcRenderer.invoke(IPC.DESKTOP_GET_INFO),
  getSidecarStatus: () => ipcRenderer.invoke(IPC.SIDECAR_STATUS),
  getSidecarLogs: () => ipcRenderer.invoke(IPC.SIDECAR_LOGS),
  restartSidecar: () => ipcRenderer.invoke(IPC.SIDECAR_RESTART),
  retryBootstrap: (mirror?: BootstrapMirror) => ipcRenderer.invoke(IPC.SIDECAR_RETRY_BOOTSTRAP, mirror),
  openDataDir: () => ipcRenderer.invoke(IPC.SHELL_OPEN_DATA_DIR),
  revealMeeting: (mid) => ipcRenderer.invoke(IPC.SHELL_REVEAL_MEETING, mid),
  openExternal: (url) => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url),
  syncTrayState: (payload) => ipcRenderer.send(IPC.RECORDER_SYNC_TRAY, payload),
  toggleQuickAsk: () => ipcRenderer.invoke(IPC.QUICK_ASK_TOGGLE),
  hideQuickAsk: () => ipcRenderer.send(IPC.QUICK_ASK_HIDE),
  resizeQuickAsk: (height) => ipcRenderer.send(IPC.QUICK_ASK_RESIZE, height),
  openMeetingFromQuickAsk: (mid, tSec) => ipcRenderer.invoke(IPC.QUICK_ASK_OPEN_MEETING, mid, tSec),
  dismissMeetingApp: (appId) => ipcRenderer.send(IPC.MEETING_APP_DISMISS, appId),
  setThemeMode: (mode) => ipcRenderer.send(IPC.THEME_SET, mode),
  onSidecarStatus: (cb) => subscribe<SidecarStatus>(IPC.SIDECAR_STATUS_CHANGED, cb),
  onSidecarLog: (cb) => subscribe<SidecarLogEntry>(IPC.SIDECAR_LOG_LINE, cb),
  onQuickMark: (cb) => subscribe<QuickMarkPayload>(IPC.SHORTCUT_QUICK_MARK, cb),
  onOpenDiagnostics: (cb) => subscribeVoid(IPC.WINDOW_OPEN_DIAGNOSTICS, cb),
  onNavigate: (cb) => subscribe<string>(IPC.WINDOW_NAVIGATE, cb),
  onQuickAskFocus: (cb) => subscribeVoid(IPC.QUICK_ASK_FOCUS, cb),
  onQuickAskHidden: (cb) => subscribeVoid(IPC.QUICK_ASK_HIDDEN, cb),
  onMeetingAppDetected: (cb) => subscribe<DetectedMeetingApp | null>(IPC.MEETING_APP_DETECTED, cb),
  onThemeChanged: (cb) => subscribe<ThemeMode>(IPC.THEME_CHANGED, cb),
  confirmQuit: () => ipcRenderer.send(IPC.APP_QUIT_CONFIRM),
  onQuitRequested: (cb) => subscribeVoid(IPC.APP_QUIT_REQUESTED, cb),
};

contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
