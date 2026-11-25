import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UV_VERSION = "0.13.9";
const FFMPEG_TAG = "b6.1.1";

const TARGETS = {
  "darwin-arm64": {
    uvAsset: "uv-aarch64-apple-darwin.tar.gz",
    uvBin: "uv",
    ffmpegAsset: "ffmpeg-darwin-arm64",
    ffmpegBin: "ffmpeg",
  },
  "darwin-x64": {
    uvAsset: "uv-x86_64-apple-darwin.tar.gz",
    uvBin: "uv",
    ffmpegAsset: "ffmpeg-darwin-x64",
    ffmpegBin: "ffmpeg",
  },
  "win32-x64": {
    uvAsset: "uv-x86_64-pc-windows-msvc.zip",
    uvBin: "uv.exe",
    ffmpegAsset: "ffmpeg-win32-x64",
    ffmpegBin: "ffmpeg.exe",
  },
  "linux-x64": {
    uvAsset: "uv-x86_64-unknown-linux-gnu.tar.gz",
    uvBin: "uv",
    ffmpegAsset: "ffmpeg-linux-x64",
    ffmpegBin: "ffmpeg",
  },
};

function parseArgs(argv) {
  let platform = process.platform;
  let arch = process.arch;
  let skipBin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform" && argv[i + 1]) {
      platform = argv[++i];
    } else if (arg === "--arch" && argv[i + 1]) {
      arch = argv[++i];
    } else if (arg === "--skip-bin") {
      skipBin = true;
    }
  }
  return { platform, arch, skipBin };
}

async function fetchBuffer(url) {
  const headers = { "User-Agent": "meeting-notes-builder/1.0" };
  let res = await fetch(url, { headers, redirect: "follow" });
  if ((res.status === 403 || res.status === 429) && process.env.GITHUB_TOKEN) {
    res = await fetch(url, {
      headers: { ...headers, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
      redirect: "follow",
    });
  }
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function downloadCached(url, cachePath, expectedSha256 = null) {
  if (fs.existsSync(cachePath)) {
    const existing = fs.readFileSync(cachePath);
    if (!expectedSha256) {
      if (existing.length > 0) return cachePath;
    } else {
      const actual = crypto.createHash("sha256").update(existing).digest("hex");
      if (actual === expectedSha256.toLowerCase()) return cachePath;
    }
  }

  console.log(`[prepare] downloading ${path.basename(cachePath)} from ${url}`);
  const buf = await fetchBuffer(url);
  if (expectedSha256) {
    const actual = crypto.createHash("sha256").update(buf).digest("hex");
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${path.basename(cachePath)}: expected ${expectedSha256}, got ${actual}`,
      );
    }
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, cachePath);
  return cachePath;
}

function findFileRecursive(dir, filename) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, filename);
      if (nested) return nested;
    }
  }
  return null;
}

function extractBinary(archivePath, binName, destPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mn-uv-extract-"));
  try {
    if (archivePath.endsWith(".tar.gz")) {
      execFileSync("tar", ["-xzf", archivePath, "-C", tmpDir], { stdio: "pipe" });
    } else if (archivePath.endsWith(".zip")) {
      let extracted = false;
      try {
        execFileSync("tar", ["-xf", archivePath, "-C", tmpDir], { stdio: "pipe" });
        extracted = true;
      } catch {
        extracted = false;
      }
      if (!extracted) {
        if (process.platform === "win32") {
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${tmpDir.replaceAll("'", "''")}' -Force`,
            ],
            { stdio: "pipe" },
          );
        } else {
          execFileSync("unzip", ["-q", "-o", archivePath, "-d", tmpDir], { stdio: "pipe" });
        }
      }
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }

    const found = findFileRecursive(tmpDir, binName);
    if (!found) {
      throw new Error(`Could not locate ${binName} inside ${path.basename(archivePath)}`);
    }
    fs.copyFileSync(found, destPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function stageBackend(repoRoot, backendOutDir) {
  fs.rmSync(backendOutDir, { recursive: true, force: true });
  fs.mkdirSync(backendOutDir, { recursive: true });

  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".py")) {
      fs.copyFileSync(path.join(repoRoot, entry.name), path.join(backendOutDir, entry.name));
    }
  }

  for (const rel of ["pyproject.toml", "uv.lock", "LICENSE"]) {
    const src = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required backend file: ${src}`);
    }
    fs.copyFileSync(src, path.join(backendOutDir, rel));
  }

  fs.cpSync(path.join(repoRoot, "static"), path.join(backendOutDir, "static"), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== ".DS_Store" && base !== "__pycache__";
    },
  });

  const cpuScriptSrc = path.join(repoRoot, "scripts", "install-linux-cpu.sh");
  if (fs.existsSync(cpuScriptSrc)) {
    const cpuScriptDst = path.join(backendOutDir, "scripts", "install-linux-cpu.sh");
    fs.mkdirSync(path.dirname(cpuScriptDst), { recursive: true });
    fs.copyFileSync(cpuScriptSrc, cpuScriptDst);
    if (process.platform !== "win32") {
      fs.chmodSync(cpuScriptDst, 0o755);
    }
  }

  for (const reqFile of ["app.py", "uv.lock", "pyproject.toml", path.join("static", "index.html")]) {
    if (!fs.existsSync(path.join(backendOutDir, reqFile))) {
      throw new Error(`Backend staging verification failed, missing: ${reqFile}`);
    }
  }
  for (const forbidden of ["data", ".venv", "__pycache__", "tests"]) {
    if (fs.existsSync(path.join(backendOutDir, forbidden))) {
      throw new Error(`Forbidden directory leaked into vendor/backend: ${forbidden}`);
    }
  }
}

async function stageBinaries(targetKey, target, binOutDir, cacheDir, hostMatches) {
  fs.rmSync(binOutDir, { recursive: true, force: true });
  fs.mkdirSync(binOutDir, { recursive: true });

  const uvBaseUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  const shaText = (await fetchBuffer(`${uvBaseUrl}/${target.uvAsset}.sha256`)).toString("utf8").trim();
  const expectedSha = shaText.split(/\s+/)[0];
  if (!expectedSha || !/^[a-f0-9]{64}$/i.test(expectedSha)) {
    throw new Error(`Unexpected sha256 content for ${target.uvAsset}: ${shaText}`);
  }

  const uvArchivePath = await downloadCached(
    `${uvBaseUrl}/${target.uvAsset}`,
    path.join(cacheDir, `${UV_VERSION}-${target.uvAsset}`),
    expectedSha,
  );
  const uvDest = path.join(binOutDir, target.uvBin);
  extractBinary(uvArchivePath, target.uvBin, uvDest);

  const ffmpegUrl = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${target.ffmpegAsset}`;
  const ffmpegCached = await downloadCached(
    ffmpegUrl,
    path.join(cacheDir, `${FFMPEG_TAG}-${target.ffmpegAsset}`),
  );
  const ffmpegDest = path.join(binOutDir, target.ffmpegBin);
  fs.copyFileSync(ffmpegCached, ffmpegDest);

  const isPosixTarget = !targetKey.startsWith("win32");
  if (process.platform !== "win32" && isPosixTarget) {
    fs.chmodSync(uvDest, 0o755);
    fs.chmodSync(ffmpegDest, 0o755);
  }

  for (const binPath of [uvDest, ffmpegDest]) {
    const st = fs.statSync(binPath);
    if (!st.isFile() || st.size < 1024 * 1024) {
      throw new Error(`Invalid staged binary ${binPath} (size=${st.size})`);
    }
  }

  if (hostMatches) {
    const uvOut = execFileSync(uvDest, ["--version"], { encoding: "utf8" }).trim();
    if (!uvOut.includes(UV_VERSION)) {
      throw new Error(`Unexpected bundled uv --version output: ${uvOut}`);
    }
    const ffOut = execFileSync(ffmpegDest, ["-version"], { encoding: "utf8" });
    if (!ffOut.toLowerCase().includes("ffmpeg version")) {
      throw new Error(`Unexpected bundled ffmpeg -version output: ${ffOut.slice(0, 120)}`);
    }
    if (process.platform === "darwin") {
      const devicesOut = execFileSync(ffmpegDest, ["-hide_banner", "-devices"], { encoding: "utf8" });
      if (!devicesOut.toLowerCase().includes("avfoundation")) {
        throw new Error("Bundled macOS ffmpeg is missing avfoundation support");
      }
    }
    console.log(`[prepare] host smoke passed (${uvOut}; ffmpeg ok)`);
  }
}

async function main() {
  const { platform, arch, skipBin } = parseArgs(process.argv.slice(2));
  const targetKey = `${platform}-${arch}`;
  const target = TARGETS[targetKey];
  if (!target) {
    throw new Error(`Unsupported target "${targetKey}". Expected one of: ${Object.keys(TARGETS).join(", ")}`);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const desktopDir = path.resolve(scriptDir, "..");
  const repoRoot = path.resolve(desktopDir, "..");
  const vendorDir = path.join(desktopDir, "vendor");
  const backendOutDir = path.join(vendorDir, "backend");
  const binOutDir = path.join(vendorDir, "bin");
  const cacheDir = path.join(desktopDir, ".cache", "vendor-dl");

  stageBackend(repoRoot, backendOutDir);
  if (!skipBin) {
    const hostMatches = platform === process.platform && arch === process.arch;
    await stageBinaries(targetKey, target, binOutDir, cacheDir, hostMatches);
  }
  console.log(`[prepare] bundle staged cleanly for ${targetKey} -> ${vendorDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
