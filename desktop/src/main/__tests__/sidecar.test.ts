import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateFreePort,
  LogRingBuffer,
  resolveBackendDir,
  resolvePythonBin,
  resolveSidecarLayout,
} from "../sidecar";

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

describe("sidecar resolution & log buffering", () => {
  it("walks ancestor directories from packaged appPath to find app.py and .venv python", () => {
    const root = makeTempDir("mn-sidecar-");
    fs.writeFileSync(path.join(root, "app.py"), "app = object()\n");
    const venvPython = path.join(root, ".venv", "bin", "python");
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.writeFileSync(venvPython, "#!/bin/sh\n");

    const packagedApp = path.join(
      root,
      "desktop",
      "dist",
      "mac-arm64",
      "Meeting Notes.app",
      "Contents",
      "Resources",
      "app.asar",
    );
    fs.mkdirSync(packagedApp, { recursive: true });

    const found = resolveBackendDir({ appPath: packagedApp, platform: "darwin" });
    expect(found).toBe(root);
    expect(resolvePythonBin(root, "darwin")).toBe(venvPython);
  });

  it("prioritizes explicit envDir over savedDir and ancestors", () => {
    const a = makeTempDir("mn-env-");
    const b = makeTempDir("mn-saved-");
    for (const d of [a, b]) {
      fs.writeFileSync(path.join(d, "app.py"), "");
      fs.mkdirSync(path.join(d, ".venv", "bin"), { recursive: true });
      fs.writeFileSync(path.join(d, ".venv", "bin", "python"), "");
    }
    expect(resolveBackendDir({ appPath: b, envDir: a, savedDir: b, platform: "darwin" })).toBe(a);
  });

  it("caps rolling sidecar logs at max capacity and preserves order", () => {
    const ring = new LogRingBuffer(3);
    ring.push({ ts: 1, stream: "stdout", line: "l1" });
    ring.push({ ts: 2, stream: "stdout", line: "l2" });
    ring.push({ ts: 3, stream: "stderr", line: "l3" });
    ring.push({ ts: 4, stream: "stdout", line: "l4" });
    expect(ring.list().map((e) => e.line)).toEqual(["l2", "l3", "l4"]);
  });

  it("allocates a live free loopback port", async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("configures CommonJS (.cjs) preload output for sandboxed renderer compatibility", () => {
    const desktopDir = path.resolve(import.meta.dirname, "../../..");
    const viteCfg = fs.readFileSync(path.join(desktopDir, "electron.vite.config.ts"), "utf8");
    const mainEntry = fs.readFileSync(path.join(desktopDir, "src/main/index.ts"), "utf8");
    expect(viteCfg).toMatch(/format:\s*"cjs"/);
    expect(mainEntry).toContain("../preload/index.cjs");
  });

  it("selects standalone layout when packaged outside a dev repo checkout", () => {
    const resDir = makeTempDir("mn-standalone-res-");
    const userDir = makeTempDir("mn-standalone-user-");
    const appDir = makeTempDir("mn-standalone-app-");

    fs.mkdirSync(path.join(resDir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(resDir, "backend", "app.py"), "");
    fs.writeFileSync(path.join(resDir, "backend", "pyproject.toml"), "");
    fs.writeFileSync(path.join(resDir, "backend", "uv.lock"), "");
    fs.mkdirSync(path.join(resDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(resDir, "bin", "uv"), "");

    const layout = resolveSidecarLayout({
      appPath: appDir,
      cwd: appDir,
      resourcesPath: resDir,
      userDataDir: userDir,
      platform: "darwin",
    });

    expect(layout?.mode).toBe("standalone");
    if (layout?.mode === "standalone") {
      expect(layout.backendDir).toBe(path.join(resDir, "backend"));
      expect(layout.uvBin).toBe(path.join(resDir, "bin", "uv"));
      expect(layout.runtimeRoot).toBe(path.join(userDir, "runtime"));
      expect(layout.dataDir).toBe(path.join(userDir, "data"));
      expect(layout.modelsDir).toBe(path.join(userDir, "models"));
    }
  });
});
