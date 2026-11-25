import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let tag = "";
  let prev = "";
  let repo = process.env.GITHUB_REPOSITORY || "MrDgbot/meeting-notes";
  let out = "release-notes.md";
  let changelogPath = "CHANGELOG.md";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag" && argv[i + 1]) tag = argv[++i];
    else if (a === "--prev" && argv[i + 1]) prev = argv[++i];
    else if (a === "--repo" && argv[i + 1]) repo = argv[++i];
    else if (a === "--out" && argv[i + 1]) out = argv[++i];
    else if (a === "--changelog" && argv[i + 1]) changelogPath = argv[++i];
  }
  if (!tag) {
    throw new Error("Missing required --tag argument (e.g. --tag v0.1.0)");
  }
  return { tag, prev, repo, out, changelogPath };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolvePreviousTag(currentTag, explicitPrev) {
  if (explicitPrev) return explicitPrev;
  try {
    const raw = git(["tag", "--sort=-version:refname"]);
    const tags = raw.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    const idx = tags.indexOf(currentTag);
    if (idx !== -1 && tags[idx + 1]) {
      return tags[idx + 1];
    }
    const other = tags.find((t) => t !== currentTag);
    if (other) return other;
  } catch {
    // Ignore when shallow checkout has no tags
  }
  return "";
}

function extractChangelogSection(changelogFile, tag) {
  if (!fs.existsSync(changelogFile)) return "";
  const raw = fs.readFileSync(changelogFile, "utf8");
  const ver = tag.replace(/^v/i, "");
  const lines = raw.split(/\r?\n/);

  let startIdx = -1;
  const headerRe = new RegExp(`^##\\s+\\[(?:v?${ver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\]`);
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i] ?? "")) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx === -1) return "";

  const body = [];
  for (let i = startIdx; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    if (/^##\s+\[/.test(ln) || /^---\s*$/.test(ln)) break;
    body.push(ln);
  }
  return body.join("\n").trim();
}

function generateFromCommits(tag, prevTag) {
  let subjects = [];
  try {
    const range = prevTag ? `${prevTag}..${tag}` : `${tag}`;
    const out = git(["log", range, "-n", "60", "--pretty=format:%s", "--no-merges"]);
    subjects = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return "";
  }
  if (subjects.length === 0) return "";

  const groups = {
    feat: [],
    fix: [],
    perf: [],
    ci: [],
    other: [],
  };

  for (const line of subjects) {
    const m = line.match(/^([a-zA-Z]+)(?:\([^)]+\))?:\s*(.+)$/);
    const kind = m?.[1]?.toLowerCase() ?? "";
    const msg = m?.[2] ?? line;
    if (kind === "feat") groups.feat.push(`- **${msg}**`);
    else if (kind === "fix") groups.fix.push(`- **${msg}**`);
    else if (kind === "perf" || kind === "refactor") groups.perf.push(`- ${msg}`);
    else if (kind === "ci" || kind === "build" || kind === "chore" || kind === "docs") groups.ci.push(`- ${msg}`);
    else groups.other.push(`- ${line}`);
  }

  const out = [];
  if (groups.feat.length) out.push("### ✨ 新功能", "", ...groups.feat, "");
  if (groups.fix.length) out.push("### 🐛 问题修复", "", ...groups.fix, "");
  if (groups.perf.length) out.push("### ⚡ 优化与重构", "", ...groups.perf, "");
  if (groups.ci.length) out.push("### 🔨 CI / 构建", "", ...groups.ci, "");
  if (groups.other.length) out.push("### 📝 其他变更", "", ...groups.other, "");
  return out.join("\n").trim();
}

function buildDownloadSection(tag, repo, prevTag) {
  const ver = tag.replace(/^v/i, "");
  const changelogLine = prevTag
    ? `**Full Changelog**: https://github.com/${repo}/compare/${prevTag}...${tag}`
    : `**Release**: https://github.com/${repo}/releases/tag/${tag}`;

  return [
    "---",
    "",
    "## 📦 下载安装包（下载即用）",
    "",
    `各平台安装包与校验文件见下方 Assets，也可查看完整 [更新日志 (CHANGELOG.md)](https://github.com/${repo}/blob/${tag}/CHANGELOG.md)。`,
    "",
    "| 平台 | 推荐安装包 | 便携包 / 其它格式 |",
    "|---|---|---|",
    `| **macOS (Apple Silicon M 系列)** | \`Meeting-Notes-${ver}-arm64.dmg\` | \`Meeting-Notes-${ver}-arm64-mac.zip\` |`,
    `| **macOS (Intel)** | \`Meeting-Notes-${ver}-x64.dmg\` | \`Meeting-Notes-${ver}-x64-mac.zip\` |`,
    `| **Windows (64-bit)** | \`Meeting-Notes-Setup-${ver}.exe\` | \`Meeting-Notes-${ver}-win-x64-portable.zip\` |`,
    `| **Linux (x86_64)** | \`Meeting-Notes-${ver}-x86_64.AppImage\` | \`meeting-notes_${ver}_amd64.deb\` |`,
    "",
    "- **校验文件**：`SHA256SUMS.txt`；**自动更新元数据**：`latest-mac.yml` / `latest.yml` / `latest-linux.yml` 与 `.blockmap`。",
    "- **内置开箱即用环境**：所有安装包均已内置后端代码、`uv` 与 `ffmpeg`；首次启动自动拉取 Python 3.11 并安装依赖（支持国内清华 PyPI 加速源与官方源切换）。",
    "",
    "### 首次打开提示（未签名安装包）",
    "",
    "- **macOS**：当前安装包尚未做 Apple 公证签名。拖入「应用程序」后如被系统拦截，请在终端运行一次即可放行：",
    "  ```bash",
    '  xattr -cr "/Applications/Meeting Notes.app"',
    "  ```",
    "  也可右键点击应用 →「打开」，或在「系统设置 → 隐私与安全性」点击「仍要打开」。",
    "- **Windows**：若 Microsoft Defender SmartScreen 提示“Windows 已保护你的电脑”，点击 **更多信息 → 仍要运行** 即可。",
    "- **Linux (AppImage)**：如提示无执行权限，请先执行 `chmod +x Meeting-Notes-*.AppImage` 后启动。",
    "",
    "---",
    "",
    changelogLine,
  ].join("\n");
}

function main() {
  const { tag, prev, repo, out, changelogPath } = parseArgs(process.argv.slice(2));
  const prevTag = resolvePreviousTag(tag, prev);

  const fromChangelog = extractChangelogSection(changelogPath, tag);
  const body = fromChangelog || generateFromCommits(tag, prevTag) || "- 常规维护与稳定性更新。";

  const markdown = [`## 更新内容`, "", body, "", buildDownloadSection(tag, repo, prevTag), ""].join("\n");
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, markdown, "utf8");
  console.log(`Generated release notes for ${tag} -> ${out}`);
}

main();
