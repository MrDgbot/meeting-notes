import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { UpdateInfo, UpdateInstallMode, UpdateProgress, UpdateStatus } from "@shared/types";
import { app, type BrowserWindow, shell } from "electron";
import electronUpdater, { type UpdateInfo as ElectronUpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;
const execFileAsync = promisify(execFile);

export const REPO_SLUG = "MrDgbot/meeting-notes";
export const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`;
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MIN_FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 10_000;
const PROGRESS_THROTTLE_MS = 150;

const MAC_SWAP_SCRIPT = `
pid="$1"; target="$2"; staged="$3"; cleanup_dir="$4"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 150 ]; do
  sleep 0.1
  i=$((i + 1))
done
backup="\${target}.update-backup"
rm -rf "$backup"
if ! mv "$target" "$backup"; then
  exit 1
fi
if ! mv "$staged" "$target"; then
  mv "$backup" "$target" 2>/dev/null || true
  exit 1
fi
xattr -cr "$target" 2>/dev/null || true
rm -rf "$backup"
if [ -n "$cleanup_dir" ]; then
  rm -rf "$cleanup_dir"
fi
open -n "$target"
`.trim();

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

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

export function resolveMacAppBundlePath(
  execPath: string,
  appPath: string,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  for (const rawSeed of [execPath, appPath]) {
    if (!rawSeed) continue;
    let cur = path.resolve(rawSeed);
    for (let depth = 0; depth < 8; depth++) {
      if (cur.endsWith(".app") && exists(path.join(cur, "Contents", "Info.plist"))) {
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

export function isMacBundleWritable(appBundlePath: string): boolean {
  if (!appBundlePath) return false;
  if (appBundlePath.startsWith("/Volumes/") || appBundlePath.includes("/AppTranslocation/")) {
    return false;
  }
  try {
    fs.accessSync(appBundlePath, fs.constants.W_OK);
    fs.accessSync(path.dirname(appBundlePath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function isAppleDeveloperSigned(appBundlePath: string): boolean {
  try {
    const res = spawnSync("codesign", ["-dv", appBundlePath], { encoding: "utf8" });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    return (
      res.status === 0 && /Authority=Developer ID Application:/i.test(out) && !/Signature=adhoc/i.test(out)
    );
  } catch {
    return false;
  }
}

export function detectBaseInstallMode(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  execPath: string;
  platform?: NodeJS.Platform;
}): { mode: UpdateInstallMode; macAppBundle: string | null } {
  const platform = opts.platform ?? process.platform;
  if (!opts.isPackaged) {
    return { mode: "installer", macAppBundle: null };
  }
  const hasAppUpdateYml = fs.existsSync(path.join(opts.resourcesPath, "app-update.yml"));
  if (platform === "win32") {
    return { mode: hasAppUpdateYml ? "native" : "installer", macAppBundle: null };
  }
  if (platform === "linux") {
    return { mode: hasAppUpdateYml && process.env.APPIMAGE ? "native" : "installer", macAppBundle: null };
  }
  if (platform === "darwin") {
    const macAppBundle = resolveMacAppBundlePath(opts.execPath, opts.appPath);
    if (macAppBundle && hasAppUpdateYml && isAppleDeveloperSigned(macAppBundle)) {
      return { mode: "native", macAppBundle };
    }
    if (macAppBundle && isMacBundleWritable(macAppBundle)) {
      return { mode: "mac-zip", macAppBundle };
    }
    return { mode: "installer", macAppBundle };
  }
  return { mode: "manual", macAppBundle: null };
}

export function isAllowedDownloadUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!m) continue;
    const digest = (m[1] ?? "").toLowerCase();
    const filename = path.basename((m[2] ?? "").trim());
    if (digest && filename) {
      map.set(filename, digest);
    }
  }
  return map;
}

function nameMatchesTokens(lowerName: string, tokens: string[]): boolean {
  return tokens.some((tok) => lowerName.includes(tok));
}

export function selectReleaseAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
  preferMode: UpdateInstallMode,
): { asset: ReleaseAsset | null; resolvedMode: UpdateInstallMode } {
  const candidates = assets.filter((a) => {
    const lower = a.name.toLowerCase();
    if (
      lower.endsWith(".blockmap") ||
      lower.endsWith(".yml") ||
      lower.endsWith(".yaml") ||
      lower.endsWith(".txt")
    ) {
      return false;
    }
    return isAllowedDownloadUrl(a.browser_download_url);
  });

  if (platform === "darwin") {
    const archTokens = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "x86_64", "intel"];
    const macZips = candidates.filter((a) => {
      const lower = a.name.toLowerCase();
      return (
        lower.endsWith(".zip") &&
        nameMatchesTokens(lower, archTokens) &&
        !lower.includes("win") &&
        !lower.includes("linux")
      );
    });
    macZips.sort((a, b) => {
      const aMac = a.name.toLowerCase().includes("mac.zip") ? 0 : 1;
      const bMac = b.name.toLowerCase().includes("mac.zip") ? 0 : 1;
      return aMac - bMac;
    });
    const macDmgs = candidates.filter((a) => {
      const lower = a.name.toLowerCase();
      return lower.endsWith(".dmg") && nameMatchesTokens(lower, archTokens);
    });

    if (preferMode === "mac-zip") {
      if (macZips[0]) {
        return { asset: macZips[0], resolvedMode: "mac-zip" };
      }
      if (macDmgs[0]) {
        return { asset: macDmgs[0], resolvedMode: "installer" };
      }
      return { asset: null, resolvedMode: "manual" };
    }

    const picked = macDmgs[0] ?? macZips[0] ?? null;
    return picked ? { asset: picked, resolvedMode: "installer" } : { asset: null, resolvedMode: "manual" };
  }

  if (platform === "win32") {
    const exe = candidates.find((a) => a.name.toLowerCase().endsWith(".exe"));
    if (exe) return { asset: exe, resolvedMode: "installer" };
    const winZip = candidates.find((a) => {
      const lower = a.name.toLowerCase();
      return lower.endsWith(".zip") && lower.includes("win");
    });
    return winZip ? { asset: winZip, resolvedMode: "installer" } : { asset: null, resolvedMode: "manual" };
  }

  if (platform === "linux") {
    const archTokens = arch === "arm64" ? ["arm64", "aarch64"] : ["x86_64", "amd64", "x64"];
    const appImageExact = candidates.find((a) => {
      const lower = a.name.toLowerCase();
      return lower.endsWith(".appimage") && nameMatchesTokens(lower, archTokens);
    });
    const appImageAny = candidates.find((a) => a.name.toLowerCase().endsWith(".appimage"));
    const deb = candidates.find((a) => {
      const lower = a.name.toLowerCase();
      return lower.endsWith(".deb") && nameMatchesTokens(lower, archTokens);
    });
    const picked = appImageExact ?? appImageAny ?? deb ?? null;
    return picked ? { asset: picked, resolvedMode: "installer" } : { asset: null, resolvedMode: "manual" };
  }

  return { asset: null, resolvedMode: "manual" };
}

export function parseGithubReleaseFallback(
  json: unknown,
  currentVersion: string,
  opts?: {
    platform?: NodeJS.Platform;
    arch?: string;
    baseInstallMode?: UpdateInstallMode;
  },
): { hasUpdate: boolean; info: UpdateInfo; installMode: UpdateInstallMode } | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  if (obj.draft === true) return null;

  const tagName = typeof obj.tag_name === "string" ? obj.tag_name : "";
  const version = tagName.replace(/^v/i, "").trim();
  if (!version) return null;

  const rawAssets = Array.isArray(obj.assets) ? obj.assets : [];
  const assets: ReleaseAsset[] = [];
  let sha256Url: string | undefined;

  for (const raw of rawAssets) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const browserUrl = typeof rec.browser_download_url === "string" ? rec.browser_download_url.trim() : "";
    const size = typeof rec.size === "number" && Number.isFinite(rec.size) ? rec.size : undefined;
    if (!name || !browserUrl) continue;
    if (name.toUpperCase() === "SHA256SUMS.TXT" && isAllowedDownloadUrl(browserUrl)) {
      sha256Url = browserUrl;
    }
    assets.push({ name, browser_download_url: browserUrl, size });
  }

  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const preferMode = opts?.baseInstallMode ?? "manual";
  const selected = selectReleaseAsset(assets, platform, arch, preferMode);

  const info: UpdateInfo = {
    version,
    releaseName: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : `v${version}`,
    releaseDate: typeof obj.published_at === "string" ? obj.published_at : undefined,
    releaseNotes: typeof obj.body === "string" ? obj.body.trim() : "",
    releaseUrl: typeof obj.html_url === "string" ? obj.html_url : `${RELEASES_PAGE_URL}/tag/v${version}`,
    ...(selected.asset
      ? {
          assetName: selected.asset.name,
          assetSize: selected.asset.size,
          downloadUrl: selected.asset.browser_download_url,
          ...(sha256Url ? { sha256Url } : {}),
        }
      : {}),
  };

  return {
    hasUpdate: compareSemver(version, currentVersion) > 0,
    info,
    installMode: selected.resolvedMode,
  };
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

function isAutoInstallMode(mode: UpdateInstallMode): boolean {
  return mode === "native" || mode === "mac-zip";
}

function findExtractedAppBundle(stageDir: string): string | null {
  if (!fs.existsSync(stageDir)) return null;
  const entries = fs.readdirSync(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(stageDir, entry.name);
    if (entry.name.endsWith(".app") && fs.existsSync(path.join(candidate, "Contents", "Info.plist"))) {
      return candidate;
    }
    // Also check one level deeper in case zip wraps the bundle in a folder.
    try {
      const subEntries = fs.readdirSync(candidate, { withFileTypes: true });
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const subCand = path.join(candidate, sub.name);
        if (sub.name.endsWith(".app") && fs.existsSync(path.join(subCand, "Contents", "Info.plist"))) {
          return subCand;
        }
      }
    } catch {
      // Ignore unreadable subdir
    }
  }
  return null;
}

export interface AppUpdaterOptions {
  autoCheck: boolean;
  onStatusChanged: (status: UpdateStatus) => void;
  onBeforeInstall: () => Promise<boolean | undefined>;
  onNotifyTray?: () => void;
}

export class AppUpdaterService {
  private readonly opts: AppUpdaterOptions;
  private readonly baseInstallMode: UpdateInstallMode;
  private readonly macAppBundle: string | null;
  private status: UpdateStatus;
  private checkIntervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCheckTime = 0;
  private checkingPromise: Promise<UpdateStatus> | null = null;
  private initialized = false;
  private stagedMacAppPath: string | null = null;
  private stagedCleanupDir: string | null = null;
  private downloadedInstallerPath: string | null = null;
  private downloadAbort: AbortController | null = null;

  constructor(opts: AppUpdaterOptions) {
    this.opts = opts;
    const currentVersion = app.getVersion();
    const detected = detectBaseInstallMode({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      execPath: process.execPath,
    });
    this.baseInstallMode = detected.mode;
    this.macAppBundle = detected.macAppBundle;
    this.status = {
      status: "idle",
      currentVersion,
      autoCheck: opts.autoCheck,
      canAutoInstall: isAutoInstallMode(this.baseInstallMode),
      installMode: this.baseInstallMode,
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
        if (
          this.status.status === "downloaded" ||
          this.status.status === "downloading" ||
          this.status.status === "preparing"
        ) {
          return;
        }
        this.emit({ status: "checking", error: "" });
      });
      autoUpdater.on("update-available", (info) => {
        this.emit({
          status: "available",
          installMode: "native",
          canAutoInstall: true,
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
          installMode: "native",
          canAutoInstall: true,
          info: toUpdateInfo(info),
          progress: { percent: 100, bytesPerSecond: 0, transferred: 1, total: 1 },
          error: "",
          checkedAt: Date.now(),
        });
      });
      autoUpdater.on("error", (err) => {
        if (this.status.status === "downloaded") return;
        this.emit({ status: "error", progress: null, error: err.message });
      });
    }

    win.on("focus", () => {
      if (
        app.isPackaged &&
        this.status.autoCheck &&
        this.status.status !== "downloaded" &&
        this.status.status !== "downloading" &&
        this.status.status !== "preparing" &&
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
      if (
        this.status.status !== "downloaded" &&
        this.status.status !== "downloading" &&
        this.status.status !== "preparing"
      ) {
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
    this.downloadAbort?.abort();
    this.downloadAbort = null;
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
    const parsed = parseGithubReleaseFallback(data, this.status.currentVersion, {
      platform: process.platform,
      arch: process.arch,
      baseInstallMode: this.baseInstallMode,
    });
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
      installMode: parsed.installMode,
      canAutoInstall: isAutoInstallMode(parsed.installMode),
      info: parsed.info,
      progress: null,
      error: "",
      checkedAt: Date.now(),
    });
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (
      this.status.status === "downloading" ||
      this.status.status === "preparing" ||
      this.status.status === "downloaded"
    ) {
      return this.getStatus();
    }
    if (this.checkingPromise) {
      return this.checkingPromise;
    }

    this.checkingPromise = (async () => {
      this.lastCheckTime = Date.now();
      this.emit({ status: "checking", error: "" });
      try {
        if (this.baseInstallMode === "native") {
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

  private async streamDownloadFile(
    url: string,
    destPath: string,
    expectedSize: number | undefined,
    signal: AbortSignal,
  ): Promise<{ sha256: string; transferred: number; total: number }> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": `meeting-notes-desktop/${this.status.currentVersion}`,
      },
      redirect: "follow",
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`下载更新失败（HTTP ${res.status}）`);
    }

    const headerLen = Number.parseInt(res.headers.get("content-length") ?? "0", 10);
    const total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : (expectedSize ?? 0);
    const hash = createHash("sha256");
    const ws = fs.createWriteStream(destPath);
    const reader = res.body.getReader();

    let transferred = 0;
    let lastEmitAt = 0;
    let windowStartAt = Date.now();
    let windowBytes = 0;
    let currentBps = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        transferred += value.byteLength;
        windowBytes += value.byteLength;
        hash.update(value);

        if (!ws.write(value)) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              ws.off("error", onErr);
              resolve();
            };
            const onErr = (err: Error) => {
              ws.off("drain", onDrain);
              reject(err);
            };
            ws.once("drain", onDrain);
            ws.once("error", onErr);
          });
        }

        const now = Date.now();
        if (now - lastEmitAt >= PROGRESS_THROTTLE_MS) {
          const elapsedSec = Math.max(0.05, (now - windowStartAt) / 1000);
          currentBps = Math.round(windowBytes / elapsedSec);
          if (now - windowStartAt >= 1000) {
            windowStartAt = now;
            windowBytes = 0;
          }
          const percent = total > 0 ? Math.max(0, Math.min(99, Math.round((transferred / total) * 100))) : 0;
          this.emit({
            status: "downloading",
            progress: {
              percent,
              bytesPerSecond: currentBps,
              transferred,
              total,
            },
            error: "",
          });
          lastEmitAt = now;
        }
      }

      await new Promise<void>((resolve, reject) => {
        ws.once("error", reject);
        ws.once("finish", resolve);
        ws.end();
      });

      return {
        sha256: hash.digest("hex").toLowerCase(),
        transferred,
        total: total > 0 ? total : transferred,
      };
    } catch (err) {
      ws.destroy();
      throw err;
    }
  }

  private async verifyDownloadedSha256(
    sha256Url: string,
    assetName: string,
    actualDigest: string,
  ): Promise<void> {
    if (!isAllowedDownloadUrl(sha256Url)) return;
    const res = await fetch(sha256Url, {
      headers: {
        "User-Agent": `meeting-notes-desktop/${this.status.currentVersion}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const text = await res.text();
    const sums = parseSha256Sums(text);
    const expected = sums.get(path.basename(assetName));
    if (expected && expected !== actualDigest.toLowerCase()) {
      throw new Error("更新包完整性校验失败（SHA-256 不匹配），请重试");
    }
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (
      this.status.status === "downloaded" ||
      this.status.status === "downloading" ||
      this.status.status === "preparing"
    ) {
      return this.getStatus();
    }

    if (this.status.installMode === "native") {
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
          progress: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const info = this.status.info;
    const mode = this.status.installMode;
    if (mode === "manual" || !info?.downloadUrl || !isAllowedDownloadUrl(info.downloadUrl)) {
      await this.openReleasePage();
      return this.getStatus();
    }

    const safeAssetName = path.basename(info.assetName || `Meeting-Notes-${info.version}.zip`);
    let targetDir: string;
    if (mode === "mac-zip") {
      const updatesRoot = path.join(app.getPath("userData"), "updates");
      const versionDirName = `v${info.version}`;
      if (fs.existsSync(updatesRoot)) {
        for (const entry of fs.readdirSync(updatesRoot)) {
          if (entry !== versionDirName) {
            fs.rmSync(path.join(updatesRoot, entry), { recursive: true, force: true });
          }
        }
      }
      targetDir = path.join(updatesRoot, versionDirName);
    } else {
      let downloadsDir = "";
      try {
        downloadsDir = app.getPath("downloads");
      } catch {
        downloadsDir = "";
      }
      targetDir = downloadsDir || path.join(app.getPath("userData"), "updates");
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const finalPath = path.join(targetDir, safeAssetName);
    const partPath = `${finalPath}.part`;

    this.downloadAbort?.abort();
    const abortCtrl = new AbortController();
    this.downloadAbort = abortCtrl;

    try {
      this.emit({
        status: "downloading",
        progress: {
          percent: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: info.assetSize ?? 0,
        },
        error: "",
      });

      const { sha256, transferred, total } = await this.streamDownloadFile(
        info.downloadUrl,
        partPath,
        info.assetSize,
        abortCtrl.signal,
      );

      this.emit({
        status: "preparing",
        progress: {
          percent: 100,
          bytesPerSecond: 0,
          transferred,
          total,
        },
        error: "",
      });

      if (info.sha256Url && isAllowedDownloadUrl(info.sha256Url)) {
        await this.verifyDownloadedSha256(info.sha256Url, safeAssetName, sha256);
      }

      fs.rmSync(finalPath, { force: true });
      fs.renameSync(partPath, finalPath);

      if (mode === "mac-zip") {
        const stageDir = path.join(targetDir, "extracted");
        fs.rmSync(stageDir, { recursive: true, force: true });
        fs.mkdirSync(stageDir, { recursive: true });

        await execFileAsync("ditto", ["-x", "-k", finalPath, stageDir]);
        const extractedApp = findExtractedAppBundle(stageDir);
        if (!extractedApp) {
          throw new Error("更新包内未找到有效的应用程序");
        }
        await execFileAsync("xattr", ["-cr", extractedApp]).catch(() => {});

        this.stagedMacAppPath = extractedApp;
        this.stagedCleanupDir = targetDir;
        this.downloadedInstallerPath = null;
      } else {
        this.downloadedInstallerPath = finalPath;
        this.stagedMacAppPath = null;
        this.stagedCleanupDir = null;
      }

      this.stopSchedule();
      return this.emit({
        status: "downloaded",
        progress: { percent: 100, bytesPerSecond: 0, transferred, total },
        error: "",
        checkedAt: Date.now(),
      });
    } catch (err) {
      fs.rmSync(partPath, { force: true });
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? "下载已取消"
          : err instanceof Error
            ? err.message
            : String(err);
      return this.emit({
        status: "error",
        progress: null,
        error: msg,
      });
    } finally {
      if (this.downloadAbort === abortCtrl) {
        this.downloadAbort = null;
      }
    }
  }

  async installUpdate(): Promise<boolean> {
    if (this.status.status !== "downloaded") {
      return false;
    }

    if (this.status.installMode === "installer") {
      if (!this.downloadedInstallerPath || !fs.existsSync(this.downloadedInstallerPath)) {
        return false;
      }
      const errMsg = await shell.openPath(this.downloadedInstallerPath);
      if (errMsg) {
        shell.showItemInFolder(this.downloadedInstallerPath);
      }
      return true;
    }

    if (this.status.installMode === "native") {
      const ok = await this.opts.onBeforeInstall();
      if (ok === false) return false;
      autoUpdater.quitAndInstall();
      return true;
    }

    if (this.status.installMode === "mac-zip") {
      if (!this.macAppBundle || !this.stagedMacAppPath || !fs.existsSync(this.stagedMacAppPath)) {
        return false;
      }
      const ok = await this.opts.onBeforeInstall();
      if (ok === false) return false;

      const child = spawn(
        "/bin/sh",
        [
          "-c",
          MAC_SWAP_SCRIPT,
          "--",
          String(process.pid),
          this.macAppBundle,
          this.stagedMacAppPath,
          this.stagedCleanupDir ?? "",
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      app.quit();
      return true;
    }

    return false;
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
