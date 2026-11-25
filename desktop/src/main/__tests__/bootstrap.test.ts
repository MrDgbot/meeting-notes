import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSidecarPath,
  buildUvEnv,
  computeEnvStamp,
  resolveBundledPaths,
  resolveVenvPython,
  splitLinuxCpuRequirements,
} from "../bootstrap";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("standalone bootstrap helpers", () => {
  it("computes deterministic environment stamps sensitive to lock, platform, and flavor", () => {
    const a = computeEnvStamp("lock-v1", "darwin", "default");
    const b = computeEnvStamp("lock-v1", "darwin", "default");
    const c = computeEnvStamp("lock-v2", "darwin", "default");
    const d = computeEnvStamp("lock-v1", "linux", "cpu");
    const e = computeEnvStamp("lock-v1", "linux", "cuda");

    expect(a).toHaveLength(64);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(d).not.toBe(e);
  });

  it("builds uv environment variables for China mirror and official fallback", () => {
    const cnEnv = buildUvEnv({
      baseEnv: { PATH: "/usr/bin" },
      venvDir: "/tmp/rt/venv",
      pythonInstallDir: "/tmp/rt/py",
      uvCacheDir: "/tmp/rt/cache",
      mirror: "cn",
    });
    expect(cnEnv.UV_PROJECT_ENVIRONMENT).toBe("/tmp/rt/venv");
    expect(cnEnv.UV_LINK_MODE).toBe("copy");
    expect(cnEnv.UV_NO_CONFIG).toBe("1");
    expect(cnEnv.UV_DEFAULT_INDEX).toBe("https://pypi.tuna.tsinghua.edu.cn/simple");
    expect(cnEnv.UV_PYTHON_INSTALL_MIRROR).toContain("npmmirror.com");

    const cnFallbackEnv = buildUvEnv({
      baseEnv: cnEnv,
      venvDir: "/tmp/rt/venv",
      pythonInstallDir: "/tmp/rt/py",
      uvCacheDir: "/tmp/rt/cache",
      mirror: "cn",
      usePythonMirror: false,
    });
    expect(cnFallbackEnv.UV_DEFAULT_INDEX).toBe("https://pypi.tuna.tsinghua.edu.cn/simple");
    expect(cnFallbackEnv.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();

    const officialEnv = buildUvEnv({
      baseEnv: cnEnv,
      venvDir: "/tmp/rt/venv",
      pythonInstallDir: "/tmp/rt/py",
      uvCacheDir: "/tmp/rt/cache",
      mirror: "official",
    });
    expect(officialEnv.UV_DEFAULT_INDEX).toBeUndefined();
    expect(officialEnv.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
  });

  it("splits Linux CPU requirements away from CUDA/nvidia/triton wheels", () => {
    const sample = [
      "# comment line",
      "",
      "fastapi==0.115.0",
      "numpy==2.1.3",
      "nvidia-cublas-cu12==12.4.5.8",
      "cuda-nvrtc==12.4.127",
      "triton==3.2.0",
      "torch==2.6.0",
      "torchaudio==2.6.0",
      "torchcodec==0.2.1",
      "uvicorn==0.34.0",
    ].join("\n");

    const { rest, torch } = splitLinuxCpuRequirements(sample);
    expect(rest).toEqual(["fastapi==0.115.0", "numpy==2.1.3", "uvicorn==0.34.0"]);
    expect(torch).toEqual(["torch==2.6.0", "torchaudio==2.6.0", "torchcodec==0.2.1"]);
  });

  it("prepends bundled bin on darwin/win32 and appends on linux without duplicates", () => {
    const sep = path.delimiter;
    expect(buildSidecarPath(`/usr/bin${sep}/bin`, "/app/bin", "darwin")).toBe(
      `/app/bin${sep}/usr/bin${sep}/bin`,
    );
    expect(buildSidecarPath(`C:\\Windows\\System32`, "C:\\app\\bin", "win32")).toBe(
      `C:\\app\\bin${sep}C:\\Windows\\System32`,
    );
    expect(buildSidecarPath(`/usr/bin${sep}/bin`, "/app/bin", "linux")).toBe(
      `/usr/bin${sep}/bin${sep}/app/bin`,
    );
    expect(buildSidecarPath(`/app/bin${sep}/usr/bin`, "/app/bin", "darwin")).toBe(`/app/bin${sep}/usr/bin`);
  });

  it("resolves bundled backend/bin paths cleanly on darwin and win32", () => {
    const res = makeTempDir("mn-res-");
    expect(resolveBundledPaths(res, "darwin")).toBeNull();

    fs.mkdirSync(path.join(res, "backend"), { recursive: true });
    fs.writeFileSync(path.join(res, "backend", "app.py"), "");
    fs.writeFileSync(path.join(res, "backend", "pyproject.toml"), "");
    fs.writeFileSync(path.join(res, "backend", "uv.lock"), "");
    fs.mkdirSync(path.join(res, "bin"), { recursive: true });
    fs.writeFileSync(path.join(res, "bin", "uv"), "");
    fs.writeFileSync(path.join(res, "bin", "ffmpeg"), "");

    const mac = resolveBundledPaths(res, "darwin");
    expect(mac?.uvBin).toBe(path.join(res, "bin", "uv"));
    expect(mac?.ffmpegBin).toBe(path.join(res, "bin", "ffmpeg"));

    fs.writeFileSync(path.join(res, "bin", "uv.exe"), "");
    const win = resolveBundledPaths(res, "win32");
    expect(win?.uvBin).toBe(path.join(res, "bin", "uv.exe"));
    expect(win?.ffmpegBin).toBeNull();

    expect(resolveVenvPython("/v", "win32")).toBe(path.join("/v", "Scripts", "python.exe"));
    expect(resolveVenvPython("/v", "linux")).toBe(path.join("/v", "bin", "python"));
  });
});
