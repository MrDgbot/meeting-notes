import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { UpdateInfo, UpdateProgress, UpdateStatus } from "@shared/types";
import { app, type BrowserWindow, shell } from "electron";
import electronUpdater, { type UpdateInfo as ElectronUpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;

export const REPO_SLUG = "MrDgbot/meeting-notes";
export const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`;
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MIN_FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 10_000;

export function compareSemver(aRaw: string, bRaw: string): number {
  const parse = (raw: string) => {
    const clean = raw.trim().replace(/^v/i, "");
    const [corePart = "", prePart = ""] = clean.split("-", 2);
    const core = corePart.split(".").map((n) => {
      const v = Number.parseInt(n, 10);
      return Number.isFinite(v) ? v : 0;
    });
    while (core.length < 3) core.push(0);
    return { core, pre: prePart };
  };

  const a = parse(aRaw);
  const b = parse(bRaw);
  const len = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < len; i++) {
    const av = a.core[i] ?? 0;
    const bv = b.core[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}

export function normalizeReleaseNotes(raw: unknown): string {
  if (!raw) return "";
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .map((item) => {
        if (item && typeof item === "object" && "note" in item) {
          return String((item as { note?: unknown }).note ?? "");
        }
        return typeof item === "string" ? item : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseGithubReleaseFallback(
  json: unknown,
  currentVersion: string,
): { hasUpdate: boolean; info: UpdateInfo } | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  if (obj.draft === true) return null;

  const tagName = typeof obj.tag_name === "string" ? obj.tag_name : "";
  const version = tagName.replace(/^v/i, "").trim();
  if (!version) return null;

  const info: UpdateInfo = {
    version,
    releaseName: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : `v${version}`,
    releaseDate: typeof obj.published_at === "string" ? obj.published_at : undefined,
    releaseNotes: typeof obj.body === "string" ? obj.body.trim() : "",
    releaseUrl: typeof obj.html_url === "string" ? obj.html_url : `${RELEASES_PAGE_URL}/tag/v${version}`,
  };

  return {
    hasUpdate: compareSemver(version, currentVersion) > 0,
    info,
  };
}

function detectCanAutoInstall(isPackaged: boolean, resourcesPath: string, appPath: string): boolean {
  if (!isPackaged) return false;
  if (!fs.existsSync(path.join(resourcesPath, "app-update.yml"))) return false;
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return Boolean(process.env.APPIMAGE);
  if (process.platform === "darwin") {
    try {
      const appBundle = path.resolve(appPath, "../..");
      const out = execFileSync("codesign", ["-dv", appBundle], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return !/Signature=adhoc/i.test(out);
    } catch {
      return false;
    }
  }
  return false;
}

function toUpdateInfo(info: ElectronUpdateInfo): UpdateInfo {
  const ver = String(info.version || "").replace(/^v/i, "");
  return {
    version: ver,
    releaseName: info.releaseName || (ver ? `v${ver}` : undefined),
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    releaseUrl: ver ? `${RELEASES_PAGE_URL}/tag/v${ver}` : RELEASES_PAGE_URL,
  };
}

export interface AppUpdaterOptions {
  autoCheck: boolean;
  onStatusChanged: (status: UpdateStatus) => void;
  onBeforeInstall: () => Promise<void>;
  onNotifyTray?: () => void;
}

export class AppUpdaterService {
  private readonly opts: AppUpdaterOptions;
  private status: UpdateStatus;
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCheckTime = 0;
  private checkingPromise: Promise<UpdateStatus> | null = null;
  private initialized = false;

  constructor(opts: AppUpdaterOptions) {
    this.opts = opts;
    const currentVersion = app.getVersion();
    const canAutoInstall = detectCanAutoInstall(app.isPackaged, process.resourcesPath, app.getAppPath());
    this.status = {
      status: "idle",
      currentVersion,
      autoCheck: opts.autoCheck,
      canAutoInstall,
      info: null,
      progress: null,
      error: "",
      checkedAt: null,
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  private emit(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch };
    const snap = this.getStatus();
    this.opts.onStatusChanged(snap);
    this.opts.onNotifyTray?.();
    return snap;
  }

  init(win: BrowserWindow): void {
    if (!this.initialized) {
      this.initialized = true;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = this.status.currentVersion.includes("-");

      autoUpdater.on("checking-for-update", () => {
        if (this.status.status === "downloaded" || this.status.status === "downloading") return;
        this.emit({ status: "checking", error: "" });
      });
      autoUpdater.on("update-available", (info) => {
        this.emit({
          status: "available",
          info: toUpdateInfo(info),
          progress: null,
          error: "",
          checkedAt: Date.now(),
        });
      });
      autoUpdater.on("update-not-available", (info) => {
        if (this.status.status === "downloaded") return;
        this.emit({
          status: "not-available",
          info: toUpdateInfo(info),
          progress: null,
          error: "",
          checkedAt: Date.now(),
        });
      });
      autoUpdater.on("download-progress", (p) => {
        const progress: UpdateProgress = {
          percent: Math.max(0, Math.min(100, Math.round(p.percent))),
          bytesPerSecond: p.bytesPerSecond,
          transferred: p.transferred,
          total: p.total,
        };
        this.emit({ status: "downloading", progress, error: "" });
      });
      autoUpdater.on("update-downloaded", (info) => {
        this.stopSchedule();
        this.emit({
          status: "downloaded",
          info: toUpdateInfo(info),
          progress: { percent: 100, bytesPerSecond: 0, transferred: 1, total: 1 },
          error: "",
          checkedAt: Date.now(),
        });
      });
      autoUpdater.on("error", (err) => {
        if (this.status.status === "downloaded") return;
        this.emit({ status: "error", error: err.message });
      });
    }

    win.on("focus", () => {
      if (
        app.isPackaged &&
        this.status.autoCheck &&
        this.status.status !== "downloaded" &&
        this.status.status !== "downloading" &&
        Date.now() - this.lastCheckTime >= MIN_FOCUS_CHECK_INTERVAL_MS
      ) {
        void this.checkForUpdates();
      }
    });

    this.applySchedule();
  }

  setAutoCheck(enabled: boolean): UpdateStatus {
    const next = this.emit({ autoCheck: enabled });
    this.applySchedule();
    return next;
  }

  private stopSchedule(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }

  private applySchedule(): void {
    this.stopSchedule();
    if (!this.status.autoCheck || !app.isPackaged || this.status.status === "downloaded") return;

    this.checkIntervalId = setInterval(() => {
      if (this.status.status !== "downloaded" && this.status.status !== "downloading") {
        void this.checkForUpdates();
      }
    }, CHECK_INTERVAL_MS);
    this.checkIntervalId.unref();

    if (this.lastCheckTime === 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        void this.checkForUpdates();
      }, INITIAL_CHECK_DELAY_MS);
      this.initialTimer.unref();
    }
  }

  dispose(): void {
    this.stopSchedule();
  }

  private async checkViaGithubApi(): Promise<UpdateStatus> {
    const res = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `meeting-notes-desktop/${this.status.currentVersion}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return this.emit({
        status: "not-available",
        info: null,
        error: "",
        checkedAt: Date.now(),
      });
    }
    if (!res.ok) {
      throw new Error(`检查更新失败（HTTP ${res.status}）`);
    }
    const data = (await res.json()) as unknown;
    const parsed = parseGithubReleaseFallback(data, this.status.currentVersion);
    if (!parsed) {
      return this.emit({
        status: "not-available",
        info: null,
        error: "",
        checkedAt: Date.now(),
      });
    }
    return this.emit({
      status: parsed.hasUpdate ? "available" : "not-available",
      info: parsed.info,
      error: "",
      checkedAt: Date.now(),
    });
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (this.status.status === "downloading" || this.status.status === "downloaded") {
      return this.getStatus();
    }
    if (this.checkingPromise) {
      return this.checkingPromise;
    }

    this.checkingPromise = (async () => {
      this.lastCheckTime = Date.now();
      this.emit({ status: "checking", error: "" });
      try {
        if (this.status.canAutoInstall) {
          try {
            await autoUpdater.checkForUpdates();
            if (this.status.status !== "error" && this.status.status !== "checking") {
              return this.getStatus();
            }
          } catch {
            // Fall through cleanly to GitHub Releases API check
          }
        }
        return await this.checkViaGithubApi();
      } catch (err) {
        return this.emit({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          checkedAt: Date.now(),
        });
      } finally {
        this.checkingPromise = null;
      }
    })();

    return this.checkingPromise;
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.status.status === "downloaded" || this.status.status === "downloading") {
      return this.getStatus();
    }
    if (!this.status.canAutoInstall) {
      await this.openReleasePage();
      return this.getStatus();
    }
    try {
      this.emit({
        status: "downloading",
        progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
        error: "",
      });
      await autoUpdater.downloadUpdate();
      return this.getStatus();
    } catch (err) {
      return this.emit({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async installUpdate(): Promise<boolean> {
    if (this.status.status !== "downloaded" || !this.status.canAutoInstall) {
      return false;
    }
    await this.opts.onBeforeInstall();
    autoUpdater.quitAndInstall();
    return true;
  }

  async openReleasePage(url?: string): Promise<boolean> {
    const target = url?.trim() || this.status.info?.releaseUrl || `${RELEASES_PAGE_URL}/latest`;
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  }
}
