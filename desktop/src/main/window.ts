import fs from "node:fs";
import path from "node:path";
import type { BootstrapMirror, ThemeMode } from "@shared/types";
import { app, BrowserWindow, desktopCapturer, nativeTheme, screen, shell } from "electron";

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface DesktopConfig {
  backendDir?: string;
  themeMode?: ThemeMode;
  bootstrapMirror?: BootstrapMirror;
  autoCheckUpdates?: boolean;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1320, height: 860 };

function configFile(): string {
  return path.join(app.getPath("userData"), "desktop-config.json");
}

export function readDesktopConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<DesktopConfig>;
    return {
      ...(typeof raw.backendDir === "string" ? { backendDir: raw.backendDir } : {}),
      ...(raw.themeMode === "auto" || raw.themeMode === "light" || raw.themeMode === "dark"
        ? { themeMode: raw.themeMode }
        : {}),
      ...(raw.bootstrapMirror === "cn" || raw.bootstrapMirror === "official"
        ? { bootstrapMirror: raw.bootstrapMirror }
        : {}),
      ...(typeof raw.autoCheckUpdates === "boolean" ? { autoCheckUpdates: raw.autoCheckUpdates } : {}),
    };
  } catch {
    return {};
  }
}

export function writeDesktopConfig(patch: DesktopConfig): void {
  try {
    const userData = app.getPath("userData");
    fs.mkdirSync(userData, { recursive: true });
    const next = { ...readDesktopConfig(), ...patch };
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  } catch {}
}

export function applyNativeThemeMode(mode: ThemeMode): void {
  nativeTheme.themeSource = mode === "light" || mode === "dark" ? mode : "system";
}

export function getThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#141414" : "#f5f5f5";
}

function boundsFile(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function isRectOnScreen(x: number, y: number, width: number, height: number): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const wa = d.workArea;
    const overlapW = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const overlapH = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    return overlapW >= 100 && overlapH >= 80;
  });
}

function loadBounds(): WindowBounds {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsFile(), "utf8")) as Partial<WindowBounds>;
    const width = typeof raw.width === "number" && raw.width >= 960 ? raw.width : DEFAULT_BOUNDS.width;
    const height = typeof raw.height === "number" && raw.height >= 620 ? raw.height : DEFAULT_BOUNDS.height;
    const hasCoords = typeof raw.x === "number" && typeof raw.y === "number";
    if (hasCoords && isRectOnScreen(raw.x as number, raw.y as number, width, height)) {
      return { width, height, x: raw.x, y: raw.y };
    }
    return { width, height };
  } catch {
    return DEFAULT_BOUNDS;
  }
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify(b, null, 2));
  } catch {}
}

export function createMainWindow(opts: {
  preloadPath: string;
  loadUrl: string;
  isQuitting: () => boolean;
}): BrowserWindow {
  const savedCfg = readDesktopConfig();
  applyNativeThemeMode(savedCfg.themeMode ?? "auto");

  const windowIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(import.meta.dirname, "../../build/icon.png");

  const b = loadBounds();
  const win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: "会议记录",
    backgroundColor: getThemeBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {
          autoHideMenuBar: true,
          ...(fs.existsSync(windowIconPath) ? { icon: windowIconPath } : {}),
        }),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Allow renderer navigator.mediaDevices.getDisplayMedia() to capture system loopback audio natively.
  win.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      const first = sources[0];
      if (!first) {
        callback({});
        return;
      }
      callback({ video: first, audio: "loopback" });
    } catch {
      callback({});
    }
  });

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
    win.show();
  });

  let saveT: ReturnType<typeof setTimeout> | null = null;
  const queueSave = () => {
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(() => saveBounds(win), 250);
  };
  win.on("resize", queueSave);
  win.on("move", queueSave);

  win.on("close", (e) => {
    saveBounds(win);
    if (process.platform === "darwin" && !opts.isQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });

  void win.loadURL(opts.loadUrl);
  return win;
}
