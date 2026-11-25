import { type ChildProcessByStdio, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
  BootstrapMirror,
  BootstrapProgress,
  SidecarLogEntry,
  SidecarPhase,
  SidecarStatus,
} from "@shared/types";
import { buildSidecarPath, resolveBundledPaths, runStandaloneBootstrap } from "./bootstrap";

const MAX_LOGS = 500;
const MAX_RESTARTS = 3;

export function resolvePythonBin(
  backendDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const rel =
    platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : path.join(".venv", "bin", "python");
  const cand = path.join(backendDir, rel);
  return fs.existsSync(cand) ? cand : null;
}

export function isBackendRoot(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  return fs.existsSync(path.join(dir, "app.py")) && resolvePythonBin(dir, platform) !== null;
}

export function resolveBackendDir(opts: {
  appPath: string;
  envDir?: string;
  savedDir?: string | null;
  cwd?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}): string | null {
  const platform = opts.platform ?? process.platform;
  const seeds = [opts.envDir, opts.savedDir, opts.cwd, opts.appPath, opts.resourcesPath].filter(
    (x): x is string => Boolean(x?.trim()),
  );

  for (const rawSeed of seeds) {
    let cur = path.resolve(rawSeed);
    for (let depth = 0; depth < 8; depth++) {
      if (isBackendRoot(cur, platform)) {
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

export type SidecarLayout =
  | {
      mode: "repo";
      backendDir: string;
      pythonBin: string;
      dataDir: string;
    }
  | {
      mode: "standalone";
      backendDir: string;
      uvBin: string;
      bundledBinDir: string | null;
      runtimeRoot: string;
      dataDir: string;
      modelsDir: string;
    };

export function resolveSidecarLayout(opts: {
  appPath: string;
  envDir?: string;
  savedDir?: string | null;
  cwd?: string;
  resourcesPath?: string;
  userDataDir?: string | null;
  dataDirOverride?: string | null;
  platform?: NodeJS.Platform;
}): SidecarLayout | null {
  const platform = opts.platform ?? process.platform;
  const envData = process.env.MEETING_DATA?.trim();
  const envModels = process.env.MODELSCOPE_CACHE?.trim();

  const tryRepo = (dir: string | null | undefined): SidecarLayout | null => {
    if (!dir?.trim()) return null;
    const resolved = path.resolve(dir);
    if (!isBackendRoot(resolved, platform)) return null;
    const pythonBin = resolvePythonBin(resolved, platform);
    if (!pythonBin) return null;
    return {
      mode: "repo",
      backendDir: resolved,
      pythonBin,
      dataDir: opts.dataDirOverride || envData || path.join(resolved, "data"),
    };
  };

  const explicit = tryRepo(opts.envDir);
  if (explicit) return explicit;

  for (const seed of [opts.cwd, opts.appPath].filter((x): x is string => Boolean(x?.trim()))) {
    let cur = path.resolve(seed);
    for (let depth = 0; depth < 8; depth++) {
      const hit = tryRepo(cur);
      if (hit) return hit;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const bundled = resolveBundledPaths(opts.resourcesPath, platform);
  if (bundled) {
    const userRoot = opts.userDataDir?.trim() || path.join(os.homedir(), ".meeting-notes");
    return {
      mode: "standalone",
      backendDir: bundled.backendDir,
      uvBin: bundled.uvBin,
      bundledBinDir: bundled.binDir,
      runtimeRoot: path.join(userRoot, "runtime"),
      dataDir: opts.dataDirOverride || envData || path.join(userRoot, "data"),
      modelsDir: envModels || path.join(userRoot, "models"),
    };
  }

  return tryRepo(opts.savedDir);
}

export function allocateFreePort(preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", (err) => {
        if (allowFallback) {
          tryListen(0, false);
        } else {
          reject(err);
        }
      });
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const chosen = typeof addr === "object" && addr ? addr.port : port;
        srv.close(() => resolve(chosen));
      });
    };
    tryListen(preferredPort ?? 0, Boolean(preferredPort));
  });
}

export class LogRingBuffer {
  private entries: SidecarLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_LOGS) {
    this.maxEntries = maxEntries;
  }

  push(entry: SidecarLogEntry): SidecarLogEntry {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return entry;
  }

  list(): SidecarLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

export interface SidecarManagerOptions {
  appPath: string;
  isPackaged: boolean;
  resourcesPath?: string;
  savedBackendDir?: string | null;
  dataDirOverride?: string | null;
  userDataDir?: string | null;
  defaultMirror?: BootstrapMirror;
}

export class SidecarManager extends EventEmitter {
  private readonly opts: SidecarManagerOptions;
  private readonly logs = new LogRingBuffer(MAX_LOGS);
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private bootstrapAbort: AbortController | null = null;
  private mirror: BootstrapMirror;
  private starting = false;
  private attachedExternal = false;
  private intentionalStop = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private status: SidecarStatus = {
    phase: "stopped",
    pid: null,
    port: null,
    backendDir: null,
    pythonBin: null,
    dataDir: null,
    error: "",
    restarts: 0,
    startedAt: null,
    bootstrap: null,
  };

  constructor(opts: SidecarManagerOptions) {
    super();
    this.opts = opts;
    this.mirror = opts.defaultMirror ?? "official";
  }

  getStatus(): SidecarStatus {
    return { ...this.status };
  }

  getLogs(): SidecarLogEntry[] {
    return this.logs.list();
  }

  getPort(): number | null {
    return this.status.port;
  }

  private emitLog(stream: SidecarLogEntry["stream"], line: string): void {
    const clean = line.replace(/\r$/, "");
    if (!clean) return;
    const entry = this.logs.push({ ts: Date.now(), stream, line: clean });
    this.emit("log", entry);
  }

  private setStatus(patch: Partial<SidecarStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.getStatus());
  }

  private async probeHealth(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Host: `127.0.0.1:${port}` },
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchApi<T = unknown>(apiPath: string, init: RequestInit = {}): Promise<T> {
    const port = this.status.port;
    if (!port) {
      throw new Error("本机语音服务尚未就绪，请稍候…");
    }
    const base = `http://127.0.0.1:${port}`;
    const headers = new Headers(init.headers);
    headers.set("Origin", base);
    if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${base}${apiPath}`, { ...init, headers });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const detail =
        data && typeof data === "object" && "detail" in data
          ? String((data as { detail: unknown }).detail)
          : "";
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return data as T;
  }

  async start(): Promise<SidecarStatus> {
    if (this.proc || this.starting || this.status.phase === "running") {
      return this.getStatus();
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.intentionalStop = false;
    this.starting = true;

    try {
      const layout = resolveSidecarLayout({
        appPath: this.opts.appPath,
        envDir: process.env.MN_BACKEND_DIR,
        savedDir: this.opts.savedBackendDir,
        cwd: process.cwd(),
        resourcesPath: this.opts.resourcesPath,
        userDataDir: this.opts.userDataDir,
        dataDirOverride: this.opts.dataDirOverride,
      });
      if (!layout) {
        const err = "未找到会议记录后端目录（需要完整安装包，或同时包含 app.py 与 .venv 的开发目录）";
        this.emitLog("system", err);
        this.setStatus({ phase: "error", port: null, error: err, bootstrap: null });
        return this.getStatus();
      }

      const backendDir = layout.backendDir;
      const dataDir = layout.dataDir;
      let pythonBin: string;

      if (layout.mode === "standalone") {
        let lastProgress: BootstrapProgress | null = null;
        this.bootstrapAbort = new AbortController();
        try {
          const boot = await runStandaloneBootstrap({
            backendDir: layout.backendDir,
            uvBin: layout.uvBin,
            runtimeRoot: layout.runtimeRoot,
            dataDir: layout.dataDir,
            modelsDir: layout.modelsDir,
            mirror: this.mirror,
            signal: this.bootstrapAbort.signal,
            onProgress: (progress) => {
              lastProgress = progress;
              this.setStatus({
                phase: "bootstrapping",
                mode: "standalone",
                pid: null,
                port: null,
                backendDir,
                dataDir,
                error: "",
                bootstrap: progress,
              });
            },
            onLog: (stream, line) => this.emitLog(stream, line),
          });
          pythonBin = boot.pythonBin;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (this.intentionalStop) {
            this.setStatus({ phase: "stopped", mode: "standalone", pid: null, port: null, bootstrap: null });
            return this.getStatus();
          }
          this.emitLog("system", `运行环境初始化失败：${errMsg}`);
          this.setStatus({
            phase: "error",
            mode: "standalone",
            pid: null,
            port: null,
            backendDir,
            dataDir,
            error: errMsg,
            bootstrap: lastProgress ?? {
              stage: "python",
              percent: 0,
              message: errMsg,
              mirror: this.mirror,
              isUpgrade: false,
            },
          });
          return this.getStatus();
        } finally {
          this.bootstrapAbort = null;
        }
      } else {
        pythonBin = layout.pythonBin;
      }

      const envPortRaw = process.env.MN_SIDECAR_PORT?.trim();
      const envPort = envPortRaw && /^\d+$/.test(envPortRaw) ? Number(envPortRaw) : undefined;

      // In dev mode (`!isPackaged`), attach if a dev backend is already running on the configured port (default 8770).
      if (!this.opts.isPackaged && layout.mode === "repo") {
        const devPort = envPort ?? 8770;
        if (await this.probeHealth(devPort)) {
          this.attachedExternal = true;
          this.emitLog("system", `检测到开发后端已在 127.0.0.1:${devPort} 运行，直接复用连接`);
          this.setStatus({
            phase: "running",
            mode: "repo",
            pid: null,
            port: devPort,
            backendDir,
            pythonBin,
            dataDir,
            error: "",
            startedAt: Date.now(),
            bootstrap: null,
          });
          return this.getStatus();
        }
      }

      const port = await allocateFreePort(envPort ?? (this.opts.isPackaged ? undefined : 8770));
      this.attachedExternal = false;
      this.setStatus({
        phase: "starting",
        mode: layout.mode,
        pid: null,
        port: null,
        backendDir,
        pythonBin,
        dataDir,
        error: "",
        bootstrap: null,
      });
      this.emitLog("system", `正在启动本机语音服务 (${pythonBin}) -> 127.0.0.1:${port}`);

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        MEETING_DATA: dataDir,
        ...(layout.mode === "standalone"
          ? {
              MODELSCOPE_CACHE: layout.modelsDir,
              HF_HOME: path.join(layout.modelsDir, "huggingface"),
              PATH: buildSidecarPath(process.env.PATH, layout.bundledBinDir),
            }
          : {}),
      };

      const child = spawn(
        pythonBin,
        ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(port)],
        {
          cwd: backendDir,
          env: childEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.proc = child;
      this.setStatus({ pid: child.pid ?? null });

      let outBuf = "";
      let errBuf = "";
      let timedOut = false;
      const flushLines = (stream: "stdout" | "stderr", chunk: Buffer, isErr: boolean) => {
        const text = (isErr ? errBuf : outBuf) + chunk.toString("utf8");
        const parts = text.split("\n");
        const tail = parts.pop() ?? "";
        if (isErr) errBuf = tail;
        else outBuf = tail;
        for (const ln of parts) {
          this.emitLog(stream, ln);
        }
      };

      child.stdout.on("data", (d: Buffer) => flushLines("stdout", d, false));
      child.stderr.on("data", (d: Buffer) => flushLines("stderr", d, true));

      child.once("exit", (code, signal) => {
        if (outBuf) this.emitLog("stdout", outBuf);
        if (errBuf) this.emitLog("stderr", errBuf);
        if (this.proc === child) {
          this.proc = null;
        }
        if (timedOut) {
          this.emitLog(
            "system",
            `本机语音服务在启动超时后已关闭 (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          );
          return;
        }
        if (this.intentionalStop) {
          this.emitLog("system", `本机语音服务已退出 (code=${code ?? "null"}, signal=${signal ?? "none"})`);
          this.setStatus({ phase: "stopped", pid: null, port: null });
          return;
        }
        const msg = `本机语音服务意外退出 (code=${code ?? "null"}, signal=${signal ?? "none"})`;
        this.emitLog("system", msg);
        if (this.status.restarts < MAX_RESTARTS) {
          const nextAttempt = this.status.restarts + 1;
          const delayMs = 1000 * 2 ** (nextAttempt - 1);
          this.emitLog("system", `将在 ${delayMs / 1000} 秒后自动恢复 (${nextAttempt}/${MAX_RESTARTS})…`);
          // Keep phase "starting" during automatic backoff so UI stays calm instead of flashing an error banner.
          this.setStatus({
            phase: "starting",
            pid: null,
            port: null,
            error: "",
            restarts: nextAttempt,
          });
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.start();
          }, delayMs);
        } else {
          this.setStatus({
            phase: "error",
            pid: null,
            port: null,
            error: `${msg}（自动恢复未成功，请点击重启服务）`,
          });
        }
      });

      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (this.proc !== child || this.intentionalStop) {
          return this.getStatus();
        }
        if (await this.probeHealth(port)) {
          this.emitLog("system", `本机语音服务就绪：http://127.0.0.1:${port}`);
          this.setStatus({
            phase: "running",
            port,
            error: "",
            restarts: 0,
            startedAt: Date.now(),
            bootstrap: null,
          });
          return this.getStatus();
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      timedOut = true;
      if (this.proc === child) {
        this.proc = null;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 3000);
      killTimer.unref();
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
      }

      const timeoutMsg = "本机语音服务启动超时（45 秒），请查看诊断信息或重试";
      this.emitLog("system", timeoutMsg);
      this.setStatus({ phase: "error", pid: null, port: null, error: timeoutMsg });
      return this.getStatus();
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.intentionalStop = true;
    if (this.bootstrapAbort) {
      this.bootstrapAbort.abort();
      this.bootstrapAbort = null;
    }
    if (this.attachedExternal && !this.proc) {
      this.attachedExternal = false;
      this.setStatus({ phase: "stopped", pid: null, port: null, bootstrap: null });
      return;
    }
    const child = this.proc;
    if (!child) {
      this.setStatus({ phase: "stopped", pid: null, port: null, bootstrap: null });
      return;
    }
    this.setStatus({ phase: "stopping" as SidecarPhase });
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          try {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {}
        }
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 3000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
    this.proc = null;
    this.setStatus({ phase: "stopped", pid: null, port: null, bootstrap: null });
  }

  async restart(): Promise<SidecarStatus> {
    this.emitLog("system", "正在重启 Python 后端…");
    await this.stop();
    this.setStatus({ restarts: 0 });
    return this.start();
  }

  async retryBootstrap(mirror?: BootstrapMirror): Promise<SidecarStatus> {
    if (mirror === "cn" || mirror === "official") {
      this.mirror = mirror;
    }
    this.emitLog(
      "system",
      `正在重新初始化运行环境（镜像：${this.mirror === "cn" ? "清华加速" : "官方源"}）…`,
    );
    await this.stop();
    this.setStatus({ restarts: 0, error: "", bootstrap: null });
    return this.start();
  }
}
