#!/usr/bin/env node
/**
 * Zero-dependency release CLI for Meeting Notes.
 *
 * Usage:
 *   node scripts/release.mjs <version|patch|minor|major> [--dry-run] [--no-push]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DESKTOP_PKG_PATH = path.join(ROOT, "desktop", "package.json");
const CHANGELOG_PATH = path.join(ROOT, "CHANGELOG.md");
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/release.mjs <version|patch|minor|major> [--dry-run] [--no-push]",
      "",
      "Options:",
      "  --dry-run   Validate, run preflight & release-notes check without modifying files, committing, tagging, or pushing.",
      "  --no-push   Bump version, commit, and create annotated tag locally without pushing to origin.",
      "  -h, --help  Show this help message.",
    ].join("\n"),
  );
}

function fail(msg) {
  console.error(`\n[release] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  let target = "";
  let dryRun = false;
  let noPush = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-push") {
      noPush = true;
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    } else if (!target) {
      target = arg;
    } else {
      fail(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!target) {
    usage();
    fail("Missing required <version|patch|minor|major> argument.");
  }

  return { target, dryRun, noPush };
}

function runCapture(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runInherit(cmd, args, label) {
  console.log(`\n[release] $ ${label || [cmd, ...args].join(" ")}`);
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32" && cmd === "pnpm",
  });
}

function resolveVersion(target, currentVersion) {
  const curMatch = currentVersion.match(SEMVER_RE);
  if (!curMatch) {
    fail(`Invalid current version in desktop/package.json: "${currentVersion}" (expected X.Y.Z).`);
  }

  let [, majStr, minStr, patStr] = curMatch;
  const maj = Number(majStr);
  const min = Number(minStr);
  const pat = Number(patStr);

  if (target === "patch") return `${maj}.${min}.${pat + 1}`;
  if (target === "minor") return `${maj}.${min + 1}.0`;
  if (target === "major") return `${maj + 1}.0.0`;

  const normalized = target.startsWith("v") ? target.slice(1) : target;
  if (!SEMVER_RE.test(normalized)) {
    fail(`Invalid version "${target}". Expected X.Y.Z or one of: patch, minor, major.`);
  }
  return normalized;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveVenvPython() {
  const unixPy = path.join(ROOT, ".venv", "bin", "python");
  if (fs.existsSync(unixPy)) return ".venv/bin/python";
  const winPy = path.join(ROOT, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(winPy)) return ".venv/Scripts/python.exe";
  fail("Local virtualenv Python not found at .venv/bin/python (run `uv sync` first).");
}

function checkTagDoesNotExist(tag) {
  const existing = runCapture("git", ["tag", "--list", tag]);
  if (existing === tag) {
    fail(`Git tag "${tag}" already exists locally.`);
  }
}

function checkChangelog(tag) {
  if (!fs.existsSync(CHANGELOG_PATH)) {
    fail("CHANGELOG.md not found at repository root.");
  }
  const content = fs.readFileSync(CHANGELOG_PATH, "utf8");
  const headingRe = new RegExp(`^##\\s+\\[${escapeRegExp(tag)}\\]`, "m");
  if (!headingRe.test(content)) {
    fail(`CHANGELOG.md is missing a "## [${tag}]" section. Please document the release before tagging.`);
  }
}

function hasCommand(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolvePytestStep() {
  const venvPy = resolveVenvPython();
  if (hasCommand(venvPy, ["-c", "import pytest"])) {
    return [venvPy, ["-m", "pytest", "-q", "tests/test_repetition.py"], `${venvPy} -m pytest -q tests/test_repetition.py`];
  }
  if (hasCommand("uv", ["--version"])) {
    return [
      "uv",
      ["run", "--no-sync", "--with", "pytest", "pytest", "-q", "tests/test_repetition.py"],
      "uv run --no-sync --with pytest pytest -q tests/test_repetition.py",
    ];
  }
  return [venvPy, ["tests/test_repetition.py"], `${venvPy} tests/test_repetition.py`];
}

function runLocalPreflight() {
  const steps = [
    ["python3", ["scripts/check_invariants.py"], "python3 scripts/check_invariants.py"],
    resolvePytestStep(),
    ["pnpm", ["--dir", "desktop", "typecheck"], "pnpm --dir desktop typecheck"],
    ["pnpm", ["--dir", "desktop", "lint"], "pnpm --dir desktop lint"],
    ["pnpm", ["--dir", "desktop", "test"], "pnpm --dir desktop test"],
    ["pnpm", ["--dir", "desktop", "build"], "pnpm --dir desktop build"],
  ];

  for (const [cmd, args, label] of steps) {
    runInherit(cmd, args, label);
  }
}

function verifyReleaseNotes(tag) {
  const outPath =
    process.platform === "win32"
      ? path.join(os.tmpdir(), "mn-release-notes-check.md")
      : "/tmp/mn-release-notes-check.md";

  try {
    runInherit(
      "node",
      ["scripts/generate-release-notes.mjs", "--tag", tag, "--out", outPath],
      `node scripts/generate-release-notes.mjs --tag ${tag} --out ${outPath}`,
    );
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fail(`Generated release notes file is empty: ${outPath}`);
    }
    const generated = fs.readFileSync(outPath, "utf8");
    if (!generated.includes("## 更新内容")) {
      fail(`Generated release notes at ${outPath} did not contain expected header.`);
    }
    console.log(`[release] Verified release notes output (${generated.split(/\r?\n/).length} lines).`);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
}

function main() {
  const { target, dryRun, noPush } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DESKTOP_PKG_PATH)) {
    fail("desktop/package.json not found.");
  }
  const originalPkgRaw = fs.readFileSync(DESKTOP_PKG_PATH, "utf8");
  const pkg = JSON.parse(originalPkgRaw);
  const currentVersion = String(pkg.version || "");
  const nextVersion = resolveVersion(target, currentVersion);
  const tag = `v${nextVersion}`;

  console.log(`[release] Preparing ${tag} (current desktop/package.json: ${currentVersion})`);
  if (dryRun) console.log("[release] Mode: --dry-run (no files modified, no commit/tag/push)");
  else if (noPush) console.log("[release] Mode: --no-push (commit & tag locally, skip push)");

  const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    fail(`Releases must be cut from branch "main" (current branch: "${branch}").`);
  }

  const dirty = runCapture("git", ["status", "--porcelain"]);
  if (dirty) {
    if (dryRun) {
      console.warn("[release] Warning: working tree has uncommitted changes (allowed under --dry-run).");
    } else {
      fail(`Git working tree is not clean. Commit or stash changes first:\n${dirty}`);
    }
  }

  checkTagDoesNotExist(tag);
  checkChangelog(tag);
  console.log(`[release] Git state & CHANGELOG.md checks passed for ${tag}.`);

  runLocalPreflight();

  if (dryRun) {
    verifyReleaseNotes(tag);
    console.log("\n[release] Dry-run succeeded. Planned actions:");
    console.log(`  1. Update desktop/package.json version: ${currentVersion} -> ${nextVersion}`);
    console.log(`  2. git add desktop/package.json && git commit -m "release: ${tag}"`);
    console.log(`  3. git tag -a ${tag} -m "Release ${tag}"`);
    if (noPush) {
      console.log("  4. Push skipped (--no-push)");
    } else {
      console.log(`  4. git push origin main && git push origin ${tag}`);
    }
    return;
  }

  let pkgUpdated = false;
  let committed = false;
  try {
    if (pkg.version !== nextVersion) {
      pkg.version = nextVersion;
      fs.writeFileSync(DESKTOP_PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      pkgUpdated = true;
      console.log(`\n[release] Updated desktop/package.json version to ${nextVersion}.`);
    } else {
      console.log(`\n[release] desktop/package.json is already at version ${nextVersion}.`);
    }

    verifyReleaseNotes(tag);

    runInherit("git", ["add", "desktop/package.json"], "git add desktop/package.json");
    const staged = runCapture("git", ["diff", "--cached", "--name-only"]);
    if (staged) {
      runInherit("git", ["commit", "-m", `release: ${tag}`], `git commit -m "release: ${tag}"`);
      committed = true;
    } else {
      console.log("[release] No version file diff to commit; tagging current HEAD.");
    }

    runInherit("git", ["tag", "-a", tag, "-m", `Release ${tag}`], `git tag -a ${tag} -m "Release ${tag}"`);
  } catch (err) {
    if (pkgUpdated && !committed) {
      try {
        fs.writeFileSync(DESKTOP_PKG_PATH, originalPkgRaw, "utf8");
        runCapture("git", ["reset", "HEAD", "--", "desktop/package.json"]);
      } catch {
        // Best-effort cleanup
      }
    }
    throw err;
  }

  if (noPush) {
    console.log(`\n[release] Created local commit & annotated tag ${tag} (--no-push).`);
    console.log(`[release] When ready, push with: git push origin main && git push origin ${tag}`);
    return;
  }

  runInherit("git", ["push", "origin", "main"], "git push origin main");
  runInherit("git", ["push", "origin", tag], `git push origin ${tag}`);
  console.log(`\n[release] Published ${tag} to origin. GitHub Actions Release workflow will now build & publish installers.`);
}

main();
