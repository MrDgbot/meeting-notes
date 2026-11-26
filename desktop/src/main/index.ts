import fs from "node:fs";
import path from "node:path";
import { IPC } from "@shared/ipc";
import { app, type BrowserWindow, dialog, Notification, nativeTheme } from "electron";
import { LoopbackBridge } from "./bridge";
import { registerIpcHandlers } from "./ipc";
import { MeetingDetector } from "./meetingDetector";
import { QuickAskController } from "./quickAsk";
import { ShortcutController } from "./shortcuts";
import { SidecarManager } from "./sidecar";
import { type RecorderSyncState, TrayController } from "./tray";
import { AppUpdaterService } from "./updater";
import { createMainWindow, getThemeBackgroundColor, readDesktopConfig, writeDesktopConfig } from "./window";

let mainWindow: BrowserWindow | null = null;
let quickAsk: QuickAskController | null = null;
let isQuitting = false;
let recorderState: RecorderSyncState = {
  active: false,
  paused: false,
  mid: null,
  elapsedMs: 0,
  updatedAt: Date.now(),
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const savedCfg = readDesktopConfig();
  const defaultMirror =
    savedCfg.bootstrapMirror ?? (app.getLocale().toLowerCase().startsWith("zh") ? "cn" : "official");
  const sidecar = new SidecarManager({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    savedBackendDir: savedCfg.backendDir ?? null,
    userDataDir: app.getPath("userData"),
    defaultMirror,
  });

  const bridge = new LoopbackBridge({
    rendererDir: path.join(import.meta.dirname, "../renderer"),
    getSidecarPort: () => sidecar.getPort(),
  });

  const showMain = (hash?: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (hash) {
      mainWindow.webContents.send(IPC.WINDOW_NAVIGATE, hash);
    }
  };

  let shortcuts: ShortcutController;
  let trayRef: TrayController | null = null;
  let readyToQuit = false;

  const updater = new AppUpdaterService({
    autoCheck: savedCfg.autoCheckUpdates ?? true,
    onStatusChanged: (st) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.UPDATER_STATUS_CHANGED, st);
      }
    },
    onBeforeInstall: async () => {
      if (recorderState.active) {
        const res = await dialog.showMessageBox({
          type: "warning",
          title: "正在录音中",
          message: "当前会议还在录音，现在安装更新会中断录制并重启应用。",
          buttons: ["继续录音", "停止并安装更新"],
          defaultId: 0,
          cancelId: 0,
        });
        if (res.response !== 1) {
          return false;
        }
      }
      isQuitting = true;
      await sidecar.stop();
      await bridge.stop();
      readyToQuit = true;
      return true;
    },
    onNotifyTray: () => trayRef?.updateUI(),
  });

  const meetingDetector = new MeetingDetector({
    getRecorderState: () => recorderState,
    onDetected: (detected) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.MEETING_APP_DETECTED, detected);
      }
      trayRef?.updateUI();
    },
    onNotify: (detected) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: `检测到正在进行 ${detected.name}`,
        body: "点击打开并准备双声道会议录音",
        silent: true,
      });
      n.on("click", () => {
        showMain("#/?autostart=mix");
      });
      n.show();
    },
  });

  const tray = new TrayController({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    sidecar,
    getRecorderState: () => recorderState,
    getDetectedMeetingApp: () => meetingDetector.getCurrent(),
    onShowMain: showMain,
    onToggleQuickAsk: () => {
      quickAsk?.toggle();
    },
    onQuickMark: () => shortcuts.triggerQuickMark(),
    onOpenDataDir: () => {
      const dataDir = sidecar.getStatus().dataDir;
      if (dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        void import("electron").then(({ shell }) => shell.openPath(dataDir));
      }
    },
    onOpenDiagnostics: () => {
      showMain();
      mainWindow?.webContents.send(IPC.WINDOW_OPEN_DIAGNOSTICS);
    },
    getUpdateStatus: () => updater.getStatus(),
    onCheckUpdates: () => {
      showMain();
      void updater.checkForUpdates();
    },
    onInstallUpdate: () => {
      void updater.installUpdate();
    },
    onQuit: () => {
      app.quit();
    },
  });
  trayRef = tray;

  shortcuts = new ShortcutController({
    sidecar,
    getRecorderState: () => recorderState,
    isMainFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
    onShowMain: showMain,
    onToggleQuickAsk: () => {
      quickAsk?.toggle();
    },
    onQuickMarkCreated: (payload) => {
      mainWindow?.webContents.send(IPC.SHORTCUT_QUICK_MARK, payload);
    },
  });

  sidecar.on("status", (st) => {
    if (st.phase === "running" && st.backendDir && st.mode !== "standalone") {
      writeDesktopConfig({ backendDir: st.backendDir });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SIDECAR_STATUS_CHANGED, st);
    }
  });
  sidecar.on("log", (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.SIDECAR_LOG_LINE, entry);
    }
  });

  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(getThemeBackgroundColor());
    }
  });

  app.on("second-instance", () => {
    showMain();
  });

  let quitPromptPending = false;
  let flushQuitTimer: NodeJS.Timeout | null = null;
  const clearQuitTimer = () => {
    if (flushQuitTimer) {
      clearTimeout(flushQuitTimer);
      flushQuitTimer = null;
    }
  };
  const performQuit = () => {
    clearQuitTimer();
    if (isQuitting) return;
    isQuitting = true;
    void (async () => {
      await sidecar.stop();
      await bridge.stop();
      readyToQuit = true;
      app.exit(0);
    })();
  };

  app.whenReady().then(async () => {
    registerIpcHandlers({
      sidecar,
      tray,
      updater,
      setRecorderState: (next) => {
        recorderState = next;
        if (next.active) {
          meetingDetector.clearIfActive();
        }
      },
      onShowMain: showMain,
      onConfirmQuit: performQuit,
      getMainWindow: () => mainWindow,
      getQuickAsk: () => quickAsk,
      meetingDetector,
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    let loadUrl: string;
    if (!app.isPackaged && devUrl) {
      await sidecar.start();
      loadUrl = devUrl;
    } else {
      const bridgePort = await bridge.start();
      loadUrl = `http://127.0.0.1:${bridgePort}/`;
      void sidecar.start();
    }

    const preloadPath = path.join(import.meta.dirname, "../preload/index.cjs");
    quickAsk = new QuickAskController({
      preloadPath,
      loadUrl,
    });

    const createAndWireMain = () => {
      const win = createMainWindow({
        preloadPath,
        loadUrl,
        isQuitting: () => isQuitting,
      });
      win.webContents.on("did-finish-load", () => {
        win.webContents.send(IPC.SIDECAR_STATUS_CHANGED, sidecar.getStatus());
        win.webContents.send(IPC.MEETING_APP_DETECTED, meetingDetector.getCurrent());
        win.webContents.send(IPC.UPDATER_STATUS_CHANGED, updater.getStatus());
      });
      return win;
    };

    mainWindow = createAndWireMain();
    updater.init(mainWindow);

    tray.start();
    shortcuts.register();
    meetingDetector.start();

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createAndWireMain();
      } else {
        showMain();
      }
    });
  });

  app.on("will-quit", () => {
    updater.dispose();
    shortcuts.unregisterAll();
    meetingDetector.stop();
    quickAsk?.destroy();
    tray.stop();
  });

  app.on("before-quit", (e) => {
    if (readyToQuit) return;
    e.preventDefault();
    if (isQuitting) return;

    const winReady =
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed() &&
      !mainWindow.webContents.isLoading();

    if (recorderState.active) {
      if (winReady) {
        clearQuitTimer();
        showMain();
        mainWindow?.webContents.send(IPC.APP_QUIT_REQUESTED);
        return;
      }
      if (quitPromptPending) return;
      quitPromptPending = true;
      void dialog
        .showMessageBox({
          type: "warning",
          title: "正在录音中",
          message: "当前会议还在录音，现在退出会中断录制并可能丢失尚未保存的内容。",
          buttons: ["继续录音", "停止并退出"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) {
            performQuit();
          }
        })
        .finally(() => {
          quitPromptPending = false;
        });
      return;
    }

    if (winReady) {
      clearQuitTimer();
      mainWindow?.webContents.send(IPC.APP_QUIT_REQUESTED);
      flushQuitTimer = setTimeout(() => {
        flushQuitTimer = null;
        performQuit();
      }, 1500);
      return;
    }

    performQuit();
  });
}
