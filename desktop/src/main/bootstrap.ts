import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BootstrapMirror, BootstrapProgress } from "@shared/types";

export interface BundledPaths {
  backendDir: string;
  binDir: string | null;
  uvBin: string;
  ffmpegBin: string | null;
}

export type BootstrapFlavor = "cuda" | "cpu" | "default";

export const STAMP_FILENAME = ".mn-env-stamp";
const CN_PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
const CN_PYTHON_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone";
const PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";

export function resolveBundledPaths(
  resourcesPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): BundledPaths | null {
  if (!resourcesPath?.trim()) return null;
  const backendDir = path.join(resourcesPath, "backend");
  const requiredFiles = ["app.py", "pyproject.toml", "uv.lock"];
  if (!requiredFiles.every((f) => fs.existsSync(path.join(backendDir, f)))) {
    return null;
  }

  const binDir = path.join(resourcesPath, "bin");
  const uvName = platform === "win32" ? "uv.exe" : "uv";
  const ffmpegName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const uvBin = path.join(binDir, uvName);
  if (!fs.existsSync(uvBin)) {
    return null;
  }

  const ffmpegCandidate = path.join(binDir, ffmpegName);
  return {
    backendDir,
    binDir: fs.existsSync(binDir) ? binDir : null,
    uvBin,
    ffmpegBin: fs.existsSync(ffmpegCandidate) ? ffmpegCandidate : null,
  };
}

export function resolveVenvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

export function computeEnvStamp(
  lockContent: string,
  platform: NodeJS.Platform,
  flavor: BootstrapFlavor,
): string {
  return crypto.createHash("sha256").update(`${lockContent}\n${platform}\n${flavor}`).digest("hex");
}

export function buildUvEnv(opts: {
  baseEnv?: NodeJS.ProcessEnv;
  venvDir: string;
  pythonInstallDir: string;
  uvCacheDir: string;
  mirror: BootstrapMirror;
  usePythonMirror?: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(opts.baseEnv ?? process.env),
    UV_PROJECT_ENVIRONMENT: opts.venvDir,
    UV_PYTHON_INSTALL_DIR: opts.pythonInstallDir,
    UV_CACHE_DIR: opts.uvCacheDir,
    UV_PYTHON_DOWNLOADS: "automatic",
    UV_NO_CONFIG: "1",
    UV_LINK_MODE: "copy",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };

  if (opts.mirror === "cn") {
    env.UV_DEFAULT_INDEX = CN_PYPI_MIRROR;
    if (opts.usePythonMirror !== false) {
      env.UV_PYTHON_INSTALL_MIRROR = CN_PYTHON_MIRROR;
    } else {
      delete env.UV_PYTHON_INSTALL_MIRROR;
    }
  } else {
    delete env.UV_DEFAULT_INDEX;
    delete env.UV_PYTHON_INSTALL_MIRROR;
  }

  return env;
}

export function splitLinuxCpuRequirements(exportedText: string): { rest: string[]; torch: string[] } {
  const rest: string[] = [];
  const torch: string[] = [];
  const gpuOrTorchRe = /^(torch==|torchaudio==|torchcodec==|triton==|nvidia-|cuda-)/;
  const cpuTorchRe = /^torch(audio|codec)?==/;

  for (const rawLine of exportedText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (gpuOrTorchRe.test(trimmed)) {
      if (cpuTorchRe.test(trimmed)) {
        torch.push(trimmed);
      }
      continue;
    }
    rest.push(trimmed);
  }
  return { rest, torch };
}

export function buildSidecarPath(
  existingPath: string | undefined,
  bundledBinDir: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const sep = path.delimiter;
  const current = (existingPath ?? "").trim();
  if (!bundledBinDir?.trim()) return current;
  const parts = current ? current.split(sep).filter(Boolean) : [];
  if (parts.includes(bundledBinDir)) return current;
  return platform === "linux" ? [...parts, bundledBinDir].join(sep) : [bundledBinDir, ...parts].join(sep);
}

export function detectBootstrapFlavor(platform: NodeJS.Platform = process.platform): BootstrapFlavor {
  if (platform !== "linux") return "default";
  try {
    execFileSync("nvidia-smi", ["-L"], { stdio: "ignore", timeout: 2000 });
    return "cuda";
  } catch {
    return "cpu";
  }
}

function killTree(child: ChildProcessByStdio<null, Readable, Readable>, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {}
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 2000);
  timer.unref();
}

function runCommandWithLogs(opts: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  captureStdout?: boolean;
  onLog: (stream: "stdout" | "stderr" | "system", line: string) => void;
  onLine?: (line: string) => void;
}): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("初始化已取消"));
      return;
    }

    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutFull = "";
    let outBuf = "";
    let errBuf = "";
    let lastErrorLine = "";
    let aborted = false;

    const flush = (stream: "stdout" | "stderr", chunk: Buffer, isErr: boolean) => {
      const textChunk = chunk.toString("utf8");
      if (opts.captureStdout && !isErr) {
        stdoutFull += textChunk;
      }
      const combined = (isErr ? errBuf : outBuf) + textChunk;
      const lines = combined.split("\n");
      const tail = lines.pop() ?? "";
      if (isErr) errBuf = tail;
      else outBuf = tail;

      for (const raw of lines) {
        const clean = raw.replace(/\r$/, "").trimEnd();
        if (!clean) continue;
        if (!opts.captureStdout || isErr) {
          opts.onLog(stream, clean);
        }
        if (isErr) lastErrorLine = clean;
        opts.onLine?.(clean);
      }
    };

    child.stdout.on("data", (d: Buffer) => flush("stdout", d, false));
    child.stderr.on("data", (d: Buffer) => flush("stderr", d, true));

    const onAbort = () => {
      aborted = true;
      killTree(child, opts.platform);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.once("exit", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (outBuf.trim() && !opts.captureStdout) opts.onLog("stdout", outBuf.replace(/\r$/, ""));
      if (errBuf.trim()) {
        const clean = errBuf.replace(/\r$/, "");
        opts.onLog("stderr", clean);
        lastErrorLine = clean;
      }
      if (aborted) {
        reject(new Error("初始化已取消"));
        return;
      }
      if (code === 0) {
        resolve({ stdout: stdoutFull });
      } else {
        const hint = lastErrorLine ? `：${lastErrorLine.slice(0, 180)}` : "";
        reject(new Error(`命令退出码 ${code ?? "unknown"}${hint}`));
      }
    });
  });
}

export async function runStandaloneBootstrap(opts: {
  backendDir: string;
  uvBin: string;
  runtimeRoot: string;
  dataDir: string;
  modelsDir: string;
  mirror: BootstrapMirror;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  onProgress: (p: BootstrapProgress) => void;
  onLog: (stream: "stdout" | "stderr" | "system", line: string) => void;
}): Promise<{ pythonBin: string; skipped: boolean }> {
  const platform = opts.platform ?? process.platform;
  const venvDir = path.join(opts.runtimeRoot, "venv");
  const pythonInstallDir = path.join(opts.runtimeRoot, "python");
  const uvCacheDir = path.join(opts.runtimeRoot, "uv-cache");
  const venvPython = resolveVenvPython(venvDir, platform);
  const stampPath = path.join(venvDir, STAMP_FILENAME);

  fs.mkdirSync(opts.runtimeRoot, { recursive: true });
  fs.mkdirSync(pythonInstallDir, { recursive: true });
  fs.mkdirSync(uvCacheDir, { recursive: true });
  fs.mkdirSync(opts.dataDir, { recursive: true });
  fs.mkdirSync(opts.modelsDir, { recursive: true });

  const lockContent = fs.readFileSync(path.join(opts.backendDir, "uv.lock"), "utf8");
  const flavor = detectBootstrapFlavor(platform);
  const expectedStamp = computeEnvStamp(lockContent, platform, flavor);
  const previousStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8").trim() : "";
  const isUpgrade = Boolean(previousStamp && previousStamp !== expectedStamp);

  if (previousStamp === expectedStamp && fs.existsSync(venvPython)) {
    return { pythonBin: venvPython, skipped: true };
  }

  const emitProgress = (stage: BootstrapProgress["stage"], percent: number, message: string) => {
    opts.onProgress({ stage, percent, message, mirror: opts.mirror, isUpgrade });
  };

  opts.onLog(
    "system",
    isUpgrade
      ? `检测到版本更新，正在同步本机 Python 环境（镜像：${opts.mirror === "cn" ? "清华加速" : "官方源"}）…`
      : `首次启动初始化本机 Python 环境（镜像：${opts.mirror === "cn" ? "清华加速" : "官方源"}）…`,
  );

  // Stage 1: Ensure managed Python 3.11
  emitProgress("python", 15, "正在准备 Python 3.11 运行时…");
  const pyEnvMirror = buildUvEnv({
    venvDir,
    pythonInstallDir,
    uvCacheDir,
    mirror: opts.mirror,
    usePythonMirror: opts.mirror === "cn",
  });

  try {
    await runCommandWithLogs({
      bin: opts.uvBin,
      args: ["python", "install", "3.11"],
      cwd: opts.runtimeRoot,
      env: pyEnvMirror,
      platform,
      signal: opts.signal,
      onLog: opts.onLog,
    });
  } catch (err) {
    if (opts.mirror === "cn" && !opts.signal?.aborted) {
      opts.onLog("system", "国内 Python 镜像拉取未成功，自动切换官方源重试 Python 3.11…");
      const fallbackEnv = buildUvEnv({
        venvDir,
        pythonInstallDir,
        uvCacheDir,
        mirror: opts.mirror,
        usePythonMirror: false,
      });
      await runCommandWithLogs({
        bin: opts.uvBin,
        args: ["python", "install", "3.11"],
        cwd: opts.runtimeRoot,
        env: fallbackEnv,
        platform,
        signal: opts.signal,
        onLog: opts.onLog,
      });
    } else {
      throw err;
    }
  }

  // Stage 2: Sync dependencies outside the read-only backendDir
  const syncEnv = buildUvEnv({
    venvDir,
    pythonInstallDir,
    uvCacheDir,
    mirror: opts.mirror,
    usePythonMirror: false,
  });

  let depPct = 35;
  const bumpDeps = (msg?: string) => {
    depPct = Math.min(88, depPct + 1);
    emitProgress("deps", depPct, msg || "正在下载并安装语音与 AI 依赖包…");
  };
  const onDepLine = (line: string) => {
    if (/^Resolved\b/i.test(line)) bumpDeps("依赖解析完成，准备下载组件…");
    else if (/^(Downloading|Prepared|Installed|Uninstalled)\b/i.test(line)) {
      bumpDeps("正在下载并安装语音与 AI 依赖包…");
    }
  };

  emitProgress("deps", 35, "正在下载并安装语音与 AI 依赖包（首次约需几分钟）…");

  if (platform === "linux" && flavor === "cpu") {
    if (!fs.existsSync(venvPython)) {
      await runCommandWithLogs({
        bin: opts.uvBin,
        args: ["venv", "--python", "3.11", venvDir],
        cwd: opts.runtimeRoot,
        env: syncEnv,
        platform,
        signal: opts.signal,
        onLog: opts.onLog,
      });
    }
    const { stdout: exported } = await runCommandWithLogs({
      bin: opts.uvBin,
      args: [
        "export",
        "--project",
        opts.backendDir,
        "--frozen",
        "--no-hashes",
        "--no-emit-project",
        "--no-header",
        "--no-dev",
      ],
      cwd: opts.runtimeRoot,
      env: syncEnv,
      platform,
      signal: opts.signal,
      captureStdout: true,
      onLog: opts.onLog,
    });
    const { rest, torch } = splitLinuxCpuRequirements(exported);
    const reqTmpDir = fs.mkdtempSync(path.join(opts.runtimeRoot, "req-"));
    try {
      const restFile = path.join(reqTmpDir, "rest.txt");
      const torchFile = path.join(reqTmpDir, "torch.txt");
      fs.writeFileSync(restFile, `${rest.join("\n")}\n`, "utf8");
      fs.writeFileSync(torchFile, `${torch.join("\n")}\n`, "utf8");

      await runCommandWithLogs({
        bin: opts.uvBin,
        args: ["pip", "install", "--python", venvPython, "--no-deps", "--link-mode", "copy", "-r", restFile],
        cwd: opts.runtimeRoot,
        env: syncEnv,
        platform,
        signal: opts.signal,
        onLog: opts.onLog,
        onLine: onDepLine,
      });
      if (torch.length > 0) {
        emitProgress("deps", Math.max(depPct, 75), "正在安装 Linux CPU 版 PyTorch…");
        await runCommandWithLogs({
          bin: opts.uvBin,
          args: [
            "pip",
            "install",
            "--python",
            venvPython,
            "--no-deps",
            "--link-mode",
            "copy",
            "-r",
            torchFile,
            "--index-url",
            PYTORCH_CPU_INDEX,
          ],
          cwd: opts.runtimeRoot,
          env: syncEnv,
          platform,
          signal: opts.signal,
          onLog: opts.onLog,
          onLine: onDepLine,
        });
      }
    } finally {
      fs.rmSync(reqTmpDir, { recursive: true, force: true });
    }
  } else {
    await runCommandWithLogs({
      bin: opts.uvBin,
      args: [
        "sync",
        "--frozen",
        "--no-dev",
        "--no-install-project",
        "--python",
        "3.11",
        "--link-mode",
        "copy",
        "--project",
        opts.backendDir,
      ],
      cwd: opts.runtimeRoot,
      env: syncEnv,
      platform,
      signal: opts.signal,
      onLog: opts.onLog,
      onLine: onDepLine,
    });
  }

  // Stage 3: Verify runtime imports and write stamp atomically
  emitProgress("verify", 92, "正在校验 Python 运行时…");
  await runCommandWithLogs({
    bin: venvPython,
    args: ["-c", "import fastapi, uvicorn, torch"],
    cwd: opts.runtimeRoot,
    env: syncEnv,
    platform,
    signal: opts.signal,
    onLog: opts.onLog,
  });

  const stampTmp = `${stampPath}.${process.pid}.tmp`;
  fs.writeFileSync(stampTmp, `${expectedStamp}\n`, "utf8");
  fs.renameSync(stampTmp, stampPath);
  emitProgress("starting", 96, "环境准备完成，正在启动本机语音服务…");
  return { pythonBin: venvPython, skipped: false };
}
