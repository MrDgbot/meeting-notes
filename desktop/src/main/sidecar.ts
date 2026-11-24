import { type ChildProcessByStdio, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import type { SidecarLogEntry, SidecarPhase, SidecarStatus } from "@shared/types";

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
}

export class SidecarManager extends EventEmitter {
  private readonly opts: SidecarManagerOptions;
  private readonly logs = new LogRingBuffer(MAX_LOGS);
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
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
  };

  constructor(opts: SidecarManagerOptions) {
    super();
    this.opts = opts;
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
      const backendDir = resolveBackendDir({
        appPath: this.opts.appPath,
        envDir: process.env.MN_BACKEND_DIR,
        savedDir: this.opts.savedBackendDir,
        cwd: process.cwd(),
        resourcesPath: this.opts.resourcesPath,
      });
      if (!backendDir) {
        const err = "未找到会议记录后端目录（需要同时包含 app.py 与 .venv）";
        this.emitLog("system", err);
        this.setStatus({ phase: "error", port: null, error: err });
        return this.getStatus();
      }

      const pythonBin = resolvePythonBin(backendDir);
      if (!pythonBin) {
        const err = `未找到 Python 虚拟环境：${backendDir}/.venv`;
        this.emitLog("system", err);
        this.setStatus({ phase: "error", port: null, backendDir, error: err });
        return this.getStatus();
      }

      const dataDir =
        this.opts.dataDirOverride || process.env.MEETING_DATA?.trim() || path.join(backendDir, "data");

      const envPortRaw = process.env.MN_SIDECAR_PORT?.trim();
      const envPort = envPortRaw && /^\d+$/.test(envPortRaw) ? Number(envPortRaw) : undefined;

      // In dev mode (`!isPackaged`), attach if a dev backend is already running on the configured port (default 8770).
      if (!this.opts.isPackaged) {
        const devPort = envPort ?? 8770;
        if (await this.probeHealth(devPort)) {
          this.attachedExternal = true;
          this.emitLog("system", `检测到开发后端已在 127.0.0.1:${devPort} 运行，直接复用连接`);
          this.setStatus({
            phase: "running",
            pid: null,
            port: devPort,
            backendDir,
            pythonBin,
            dataDir,
            error: "",
            startedAt: Date.now(),
          });
          return this.getStatus();
        }
      }

      const port = await allocateFreePort(envPort ?? (this.opts.isPackaged ? undefined : 8770));
      this.attachedExternal = false;
      this.setStatus({
        phase: "starting",
        pid: null,
        port: null,
        backendDir,
        pythonBin,
        dataDir,
        error: "",
      });
      this.emitLog("system", `正在启动本机语音服务 (${pythonBin}) -> 127.0.0.1:${port}`);

      const child = spawn(
        pythonBin,
        ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(port)],
        {
          cwd: backendDir,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            PYTHONUTF8: "1",
            ...(this.opts.dataDirOverride ? { MEETING_DATA: this.opts.dataDirOverride } : {}),
          },
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

      const deadline = Date.now() + 30_000;
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

      const timeoutMsg = "本机语音服务启动超时（30 秒），请查看诊断信息或重试";
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
    if (this.attachedExternal && !this.proc) {
      this.attachedExternal = false;
      this.setStatus({ phase: "stopped", pid: null, port: null });
      return;
    }
    const child = this.proc;
    if (!child) {
      this.setStatus({ phase: "stopped", pid: null });
      return;
    }
    this.setStatus({ phase: "stopping" as SidecarPhase });
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
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
    this.setStatus({ phase: "stopped", pid: null, port: null });
  }

  async restart(): Promise<SidecarStatus> {
    this.emitLog("system", "正在重启 Python 后端…");
    await this.stop();
    this.setStatus({ restarts: 0 });
    return this.start();
  }
}
