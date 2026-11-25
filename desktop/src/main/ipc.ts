import fs from "node:fs";
import path from "node:path";
import { IPC } from "@shared/ipc";
import type { BootstrapMirror, DesktopRuntimeInfo, ThemeMode } from "@shared/types";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { MeetingDetector } from "./meetingDetector";
import type { QuickAskController } from "./quickAsk";
import type { SidecarManager } from "./sidecar";
import type { RecorderSyncState, TrayController } from "./tray";
import type { AppUpdaterService } from "./updater";
import { applyNativeThemeMode, getThemeBackgroundColor, writeDesktopConfig } from "./window";

export interface IpcContext {
  sidecar: SidecarManager;
  tray: TrayController;
  updater: AppUpdaterService;
  setRecorderState: (next: RecorderSyncState) => void;
  onShowMain: (hash?: string) => void;
  onConfirmQuit?: () => void;
  getMainWindow: () => BrowserWindow | null;
  getQuickAsk: () => QuickAskController | null;
  meetingDetector: MeetingDetector;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle(IPC.DESKTOP_GET_INFO, (): DesktopRuntimeInfo => {
    const st = ctx.sidecar.getStatus();
    return {
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      backendDir: st.backendDir,
      dataDir: st.dataDir,
    };
  });

  ipcMain.handle(IPC.SIDECAR_STATUS, () => ctx.sidecar.getStatus());
  ipcMain.handle(IPC.SIDECAR_LOGS, () => ctx.sidecar.getLogs());
  ipcMain.handle(IPC.SIDECAR_RESTART, () => ctx.sidecar.restart());
  ipcMain.handle(IPC.SIDECAR_RETRY_BOOTSTRAP, (_ev, rawMirror?: unknown) => {
    const mirror: BootstrapMirror | undefined =
      rawMirror === "cn" || rawMirror === "official" ? rawMirror : undefined;
    if (mirror) {
      writeDesktopConfig({ bootstrapMirror: mirror });
    }
    return ctx.sidecar.retryBootstrap(mirror);
  });

  ipcMain.handle(IPC.SHELL_OPEN_DATA_DIR, async () => {
    const dataDir = ctx.sidecar.getStatus().dataDir;
    if (!dataDir) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    const err = await shell.openPath(dataDir);
    return err === "";
  });

  ipcMain.handle(IPC.SHELL_REVEAL_MEETING, (_ev, mid: unknown) => {
    if (typeof mid !== "string" || !/^[A-Za-z0-9_-]+$/.test(mid)) return false;
    const dataDir = ctx.sidecar.getStatus().dataDir;
    if (!dataDir) return false;
    const meetingsRoot = path.resolve(dataDir, "meetings");
    const target = path.resolve(meetingsRoot, mid);
    if (!target.startsWith(`${meetingsRoot}${path.sep}`)) return false;
    if (!fs.existsSync(target)) return false;
    shell.showItemInFolder(path.join(target, "meta.json"));
    return true;
  });

  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, async (_ev, rawUrl: unknown) => {
    if (typeof rawUrl !== "string") return false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      await shell.openExternal(u.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.on(
    IPC.RECORDER_SYNC_TRAY,
    (_ev, payload: { active?: boolean; paused?: boolean; mid?: string | null; elapsedMs?: number }) => {
      ctx.setRecorderState({
        active: Boolean(payload?.active),
        paused: Boolean(payload?.paused),
        mid: typeof payload?.mid === "string" ? payload.mid : null,
        elapsedMs: typeof payload?.elapsedMs === "number" ? payload.elapsedMs : 0,
        updatedAt: Date.now(),
      });
      ctx.tray.updateUI();
    },
  );

  ipcMain.handle(IPC.QUICK_ASK_TOGGLE, () => {
    const qa = ctx.getQuickAsk();
    return qa ? qa.toggle() : false;
  });

  ipcMain.on(IPC.QUICK_ASK_HIDE, () => {
    ctx.getQuickAsk()?.hide();
  });

  ipcMain.on(IPC.QUICK_ASK_RESIZE, (_ev, rawHeight: unknown) => {
    if (typeof rawHeight === "number" && Number.isFinite(rawHeight)) {
      ctx.getQuickAsk()?.resize(rawHeight);
    }
  });

  ipcMain.handle(IPC.QUICK_ASK_OPEN_MEETING, (_ev, mid: unknown, tSec?: unknown) => {
    if (typeof mid !== "string" || !/^[a-zA-Z0-9_-]+$/.test(mid)) return false;
    const secQuery =
      typeof tSec === "number" && Number.isFinite(tSec) && tSec >= 0 ? `?t=${Math.floor(tSec)}` : "";
    ctx.getQuickAsk()?.hide();
    ctx.onShowMain(`#/m/${mid}${secQuery}`);
    return true;
  });

  ipcMain.on(IPC.MEETING_APP_DISMISS, (_ev, appId: unknown) => {
    ctx.meetingDetector.dismiss(typeof appId === "string" ? appId : undefined);
    ctx.tray.updateUI();
  });

  ipcMain.on(IPC.THEME_SET, (ev, rawMode: unknown) => {
    const mode: ThemeMode =
      rawMode === "light" || rawMode === "dark" || rawMode === "auto" ? rawMode : "auto";
    writeDesktopConfig({ themeMode: mode });
    applyNativeThemeMode(mode);
    const main = ctx.getMainWindow();
    if (main && !main.isDestroyed()) {
      main.setBackgroundColor(getThemeBackgroundColor());
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.id !== ev.sender.id) {
        win.webContents.send(IPC.THEME_CHANGED, mode);
      }
    }
  });

  ipcMain.on(IPC.APP_QUIT_CONFIRM, () => {
    ctx.onConfirmQuit?.();
  });

  ipcMain.handle(IPC.UPDATER_STATUS, () => ctx.updater.getStatus());
  ipcMain.handle(IPC.UPDATER_CHECK, () => ctx.updater.checkForUpdates());
  ipcMain.handle(IPC.UPDATER_DOWNLOAD, () => ctx.updater.downloadUpdate());
  ipcMain.handle(IPC.UPDATER_INSTALL, () => ctx.updater.installUpdate());
  ipcMain.handle(IPC.UPDATER_SET_AUTO_CHECK, (_ev, enabled: unknown) => {
    const next = Boolean(enabled);
    writeDesktopConfig({ autoCheckUpdates: next });
    return ctx.updater.setAutoCheck(next);
  });
  ipcMain.handle(IPC.UPDATER_OPEN_RELEASE, (_ev, rawUrl?: unknown) =>
    ctx.updater.openReleasePage(typeof rawUrl === "string" ? rawUrl : undefined),
  );
}
