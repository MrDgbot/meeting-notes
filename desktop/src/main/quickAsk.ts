import { IPC } from "@shared/ipc";
import { BrowserWindow, screen, shell } from "electron";

export interface QuickAskControllerDeps {
  preloadPath: string;
  loadUrl: string;
}

const COMPACT_HEIGHT = 196;
const MIN_HEIGHT = 184;
const MAX_HEIGHT = 560;

export class QuickAskController {
  private readonly deps: QuickAskControllerDeps;
  private win: BrowserWindow | null = null;
  private loaded = false;
  private pendingShow = false;

  constructor(deps: QuickAskControllerDeps) {
    this.deps = deps;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      return this.win;
    }

    this.loaded = false;
    const win = new BrowserWindow({
      width: 660,
      height: COMPACT_HEIGHT,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: true,
      roundedCorners: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: "全局闪问",
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (process.platform === "darwin") {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, "floating");
    }

    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === "http:" || u.protocol === "https:") {
          void shell.openExternal(url);
        }
      } catch {}
      return { action: "deny" };
    });

    win.once("ready-to-show", () => {
      this.loaded = true;
      if (this.pendingShow && !win.isDestroyed()) {
        this.pendingShow = false;
        this.positionOnActiveDisplay(win);
        win.show();
        win.focus();
        win.webContents.send(IPC.QUICK_ASK_FOCUS);
      }
    });

    win.webContents.on("did-finish-load", () => {
      this.loaded = true;
      if (win.isVisible()) {
        win.webContents.send(IPC.QUICK_ASK_FOCUS);
      }
    });

    win.on("blur", () => {
      if (!win.webContents.isDevToolsOpened()) {
        this.hide();
      }
    });

    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.loaded = false;
        this.pendingShow = false;
      }
    });

    const baseUrl = this.deps.loadUrl.replace(/#.*$/, "");
    void win.loadURL(`${baseUrl}#/quick-ask`);
    this.win = win;
    return win;
  }

  private positionOnActiveDisplay(win: BrowserWindow): void {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = display.workArea;
    const winW = win.getSize()[0] ?? 660;
    const targetX = Math.round(x + (width - winW) / 2);
    const targetY = Math.round(y + Math.max(48, Math.min(height * 0.18, height - 480)));
    win.setPosition(targetX, targetY, false);
  }

  resize(height: number): void {
    if (!this.win || this.win.isDestroyed()) return;
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
    const cur = this.win.getBounds();
    if (Math.abs(cur.height - clamped) < 4) return;
    const display = screen.getDisplayMatching(cur);
    const maxAllowed = Math.max(MIN_HEIGHT, display.workArea.y + display.workArea.height - cur.y - 24);
    const finalH = Math.min(clamped, maxAllowed);
    this.win.setBounds(
      { x: cur.x, y: cur.y, width: cur.width, height: finalH },
      process.platform === "darwin",
    );
  }

  show(): void {
    const win = this.ensureWindow();
    if (!this.loaded) {
      this.pendingShow = true;
      return;
    }
    this.positionOnActiveDisplay(win);
    win.show();
    win.focus();
    win.webContents.send(IPC.QUICK_ASK_FOCUS);
  }

  hide(): void {
    this.pendingShow = false;
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.QUICK_ASK_HIDDEN);
      if (this.win.isVisible()) {
        this.win.hide();
      }
    }
  }

  toggle(): boolean {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.hide();
      return false;
    }
    this.show();
    return true;
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
    this.loaded = false;
    this.pendingShow = false;
  }
}
