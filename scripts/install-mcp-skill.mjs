#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "meeting-notes";
const SKILL_NAME = "meeting-context";
const ALL_TARGETS = ["antigravity", "claude-code", "cursor", "codex", "claude-desktop"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function printHelp() {
  console.log(`Usage: node scripts/install-mcp-skill.mjs [options]

Install or uninstall the meeting-notes MCP v2 server and meeting-context Agent Skill
for local desktop AI clients (zero external dependencies).

Options:
  --targets <list|all>  Comma-separated targets or "all"
                        Supported: ${ALL_TARGETS.join(", ")}
                        Default: auto-detect installed clients (falls back to all)
  --exclude-private     Add "--exclude-private" to MCP server args
  --data-dir <path>     Override MEETING_DATA directory (default: env MEETING_DATA or <repo>/data)
  --dry-run             Print planned changes without writing any files
  --uninstall           Remove only the "${SERVER_NAME}" MCP entry and "${SKILL_NAME}" skill
  -h, --help            Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    targetsRaw: "",
    excludePrivate: false,
    dataDir: "",
    dryRun: false,
    uninstall: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--uninstall") {
      opts.uninstall = true;
    } else if (arg === "--exclude-private") {
      opts.excludePrivate = true;
    } else if (arg === "--targets") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for --targets");
      }
      opts.targetsRaw = argv[++i];
    } else if (arg.startsWith("--targets=")) {
      opts.targetsRaw = arg.slice("--targets=".length);
    } else if (arg === "--data-dir") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for --data-dir");
      }
      opts.dataDir = argv[++i];
    } else if (arg.startsWith("--data-dir=")) {
      opts.dataDir = arg.slice("--data-dir=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function getHomeDir() {
  if (process.platform === "win32") {
    return path.resolve(process.env.USERPROFILE || process.env.HOME || os.homedir());
  }
  return path.resolve(process.env.HOME || os.homedir());
}

function getClaudeDesktopConfigPath(home) {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, "Claude", "claude_desktop_config.json");
}

function getTargetSpecs(home) {
  const claudeDesktopConfig = getClaudeDesktopConfigPath(home);
  return {
    antigravity: {
      id: "antigravity",
      label: "Antigravity",
      format: "json",
      mcpConfigPath: path.join(home, ".gemini", "config", "mcp_config.json"),
      skillDestPath: path.join(home, ".gemini", "config", "skills", SKILL_NAME),
      detectPaths: [
        path.join(home, ".gemini", "config"),
        path.join(home, ".gemini", "antigravity"),
      ],
    },
    "claude-code": {
      id: "claude-code",
      label: "Claude Code",
      format: "json",
      mcpConfigPath: path.join(home, ".claude.json"),
      skillDestPath: path.join(home, ".claude", "skills", SKILL_NAME),
      detectPaths: [
        path.join(home, ".claude"),
        path.join(home, ".claude.json"),
      ],
    },
    cursor: {
      id: "cursor",
      label: "Cursor",
      format: "json",
      mcpConfigPath: path.join(home, ".cursor", "mcp.json"),
      skillDestPath: path.join(home, ".cursor", "skills", SKILL_NAME),
      detectPaths: [path.join(home, ".cursor")],
    },
    codex: {
      id: "codex",
      label: "Codex",
      format: "toml",
      mcpConfigPath: path.join(home, ".codex", "config.toml"),
      skillDestPath: path.join(home, ".codex", "skills", SKILL_NAME),
      detectPaths: [path.join(home, ".codex")],
    },
    "claude-desktop": {
      id: "claude-desktop",
      label: "Claude Desktop",
      format: "json",
      mcpConfigPath: claudeDesktopConfig,
      skillDestPath: null, // Claude Desktop uses MCP prompts & resources directly
      detectPaths: [path.dirname(claudeDesktopConfig)],
    },
  };
}

function resolveTargets(targetsRaw, specs) {
  if (!targetsRaw) {
    const detected = ALL_TARGETS.filter((id) =>
      specs[id].detectPaths.some((p) => fs.existsSync(p)),
    );
    if (detected.length > 0) {
      return { targets: detected, mode: "auto-detected" };
    }
    return { targets: [...ALL_TARGETS], mode: "fallback-all" };
  }

  const tokens = targetsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("--targets cannot be empty");
  }
  if (tokens.includes("all")) {
    return { targets: [...ALL_TARGETS], mode: "explicit" };
  }

  const unique = [];
  for (const t of tokens) {
    if (!Object.prototype.hasOwnProperty.call(specs, t)) {
      throw new Error(`Unknown target "${t}". Valid targets: ${ALL_TARGETS.join(", ")}, all`);
    }
    if (!unique.includes(t)) unique.push(t);
  }
  return { targets: unique, mode: "explicit" };
}

function detectServerEntry(repoRoot, dataDir, excludePrivate) {
  const serverScript = path.join(repoRoot, "mcp_server.py");
  const candidates =
    process.platform === "win32"
      ? [
          path.join(repoRoot, ".venv", "Scripts", "python.exe"),
          path.join(repoRoot, ".venv", "bin", "python"),
        ]
      : [
          path.join(repoRoot, ".venv", "bin", "python"),
          path.join(repoRoot, ".venv", "bin", "python3"),
          path.join(repoRoot, ".venv", "Scripts", "python.exe"),
        ];

  const foundPython = candidates.find((p) => fs.existsSync(p));
  let command;
  let args;

  if (foundPython) {
    command = foundPython;
    args = [serverScript];
  } else {
    command = "uv";
    args = ["run", "--directory", repoRoot, "python", "mcp_server.py"];
  }

  if (excludePrivate) {
    args.push("--exclude-private");
  }

  return {
    command,
    args,
    env: {
      MEETING_DATA: dataDir,
    },
  };
}

function resolveWriteTarget(filePath) {
  let lstat = null;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    return filePath;
  }
  if (lstat.isSymbolicLink()) {
    try {
      return fs.realpathSync(filePath);
    } catch {
      // Dangling symlink: resolve target relative to symlink's parent so we preserve the symlink
      const rawTarget = fs.readlinkSync(filePath);
      return path.resolve(path.dirname(filePath), rawTarget);
    }
  }
  return filePath;
}

function atomicWriteFile(filePath, content) {
  const targetPath = resolveWriteTarget(filePath);
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  let mode = 0o644;
  try {
    const st = fs.statSync(targetPath);
    mode = st.mode & 0o777;
  } catch {
    // New file: use default mode
  }

  const tmpName = `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, data: {} };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return { exists: true, data: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected top-level JSON object in ${filePath}`);
  }
  return { exists: true, data: parsed };
}

function updateJsonMcpConfig(filePath, serverEntry, { uninstall, dryRun }) {
  const { exists, data } = readJsonObject(filePath);

  if (uninstall) {
    if (!exists) {
      return { action: "skip", detail: "config file not found" };
    }
    if (
      !data.mcpServers ||
      typeof data.mcpServers !== "object" ||
      Array.isArray(data.mcpServers) ||
      !Object.prototype.hasOwnProperty.call(data.mcpServers, SERVER_NAME)
    ) {
      return { action: "skip", detail: `"${SERVER_NAME}" not present` };
    }
    delete data.mcpServers[SERVER_NAME];
    if (!dryRun) {
      atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
    }
    return { action: "remove", detail: `${dryRun ? "would remove" : "removed"} mcpServers["${SERVER_NAME}"]` };
  }

  if (data.mcpServers !== undefined && (typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers))) {
    throw new Error(`Expected "mcpServers" to be an object in ${filePath}`);
  }
  const servers = data.mcpServers ? { ...data.mcpServers } : {};
  const prev = servers[SERVER_NAME];
  const unchanged = exists && prev && JSON.stringify(prev) === JSON.stringify(serverEntry);
  if (unchanged) {
    return { action: "unchanged", detail: `mcpServers["${SERVER_NAME}"] already up to date` };
  }

  servers[SERVER_NAME] = serverEntry;
  const nextData = { ...data, mcpServers: servers };
  if (!dryRun) {
    atomicWriteFile(filePath, `${JSON.stringify(nextData, null, 2)}\n`);
  }
  return {
    action: prev ? "update" : exists ? "merge" : "create",
    detail: `${dryRun ? (prev ? "would update" : "would write") : prev ? "updated" : "wrote"} mcpServers["${SERVER_NAME}"]`,
  };
}

function parseTomlHeaderSegments(rawHeader) {
  const segments = [];
  let i = 0;
  const s = rawHeader.trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i++];
      let buf = "";
      while (i < s.length && s[i] !== quote) {
        if (quote === '"' && s[i] === "\\" && i + 1 < s.length) {
          buf += s[i + 1];
          i += 2;
        } else {
          buf += s[i++];
        }
      }
      if (i < s.length && s[i] === quote) i++;
      segments.push(buf);
    } else {
      let buf = "";
      while (i < s.length && s[i] !== ".") {
        buf += s[i++];
      }
      segments.push(buf.trim());
    }
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i < s.length && s[i] === ".") i++;
  }
  return segments;
}

function isTargetTomlSection(line, serverName) {
  const m = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
  if (!m) return false;
  const segs = parseTomlHeaderSegments(m[1]);
  return segs.length >= 2 && segs[0] === "mcp_servers" && segs[1] === serverName;
}

function isAnyTomlHeader(line) {
  return /^\s*\[(\[)?[^\[\]]+(\])?\]\s*(?:#.*)?$/.test(line);
}

function extractTomlKeyBeforeEquals(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (ch === "\\" && i + 1 < line.length) {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#") {
      return null;
    } else if (ch === "=") {
      return line.slice(0, i).trim();
    }
  }
  return null;
}

function detectConflictingTomlKey(content, serverName) {
  const lines = content.split(/\r?\n/);
  let currentHeader = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const arrMatch = line.match(/^\s*\[\[([^\[\]]+)\]\]\s*(?:#.*)?$/);
    if (arrMatch) {
      currentHeader = parseTomlHeaderSegments(arrMatch[1]);
      continue;
    }
    const tblMatch = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
    if (tblMatch) {
      currentHeader = parseTomlHeaderSegments(tblMatch[1]);
      continue;
    }

    const keyPart = extractTomlKeyBeforeEquals(line);
    if (!keyPart) continue;
    const keySegs = parseTomlHeaderSegments(keyPart);
    if (
      currentHeader.length === 0 &&
      keySegs.length >= 2 &&
      keySegs[0] === "mcp_servers" &&
      keySegs[1] === serverName
    ) {
      return idx + 1;
    }
    if (
      currentHeader.length === 1 &&
      currentHeader[0] === "mcp_servers" &&
      keySegs.length >= 1 &&
      keySegs[0] === serverName
    ) {
      return idx + 1;
    }
  }
  return 0;
}

function removeTomlServerSections(content, serverName) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const out = [];
  let skipping = false;
  let removed = false;

  for (const line of lines) {
    if (isTargetTomlSection(line, serverName)) {
      skipping = true;
      removed = true;
      // Drop a single preceding blank line to avoid leaving an extra gap where our block was
      if (out.length > 0 && out[out.length - 1].trim() === "") {
        out.pop();
      }
      continue;
    }
    if (skipping && isAnyTomlHeader(line)) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }

  // Trim only trailing blank lines left behind if our removed section was at EOF
  if (removed) {
    while (out.length > 0 && out[out.length - 1].trim() === "") {
      out.pop();
    }
  }

  let result = out.join(eol);
  if (result.trim().length > 0 && !result.endsWith(eol)) {
    result += eol;
  } else if (result.trim().length === 0) {
    result = "";
  }
  return { content: result, removed, eol };
}

function formatTomlServerBlock(serverName, serverEntry, eol = "\n") {
  const argsList = serverEntry.args.map((a) => JSON.stringify(a)).join(", ");
  const lines = [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(serverEntry.command)}`,
    `args = [${argsList}]`,
  ];
  const envEntries = Object.entries(serverEntry.env || {});
  if (envEntries.length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${serverName}.env]`);
    for (const [k, v] of envEntries) {
      lines.push(`${k} = ${JSON.stringify(String(v))}`);
    }
  }
  return `${lines.join(eol)}${eol}`;
}

function updateTomlMcpConfig(filePath, serverEntry, { uninstall, dryRun }) {
  const exists = fs.existsSync(filePath);
  const raw = exists ? fs.readFileSync(filePath, "utf8") : "";

  if (exists) {
    const conflictLine = detectConflictingTomlKey(raw, SERVER_NAME);
    if (conflictLine > 0) {
      throw new Error(
        `Conflicting inline/dotted key for "${SERVER_NAME}" found at ${filePath}:${conflictLine}. ` +
          `Please remove or convert it to a [mcp_servers.${SERVER_NAME}] table manually.`,
      );
    }
  }

  if (uninstall) {
    if (!exists) {
      return { action: "skip", detail: "config file not found" };
    }
    const { content, removed } = removeTomlServerSections(raw, SERVER_NAME);
    if (!removed) {
      return { action: "skip", detail: `[mcp_servers.${SERVER_NAME}] not present` };
    }
    if (!dryRun) {
      atomicWriteFile(filePath, content);
    }
    return { action: "remove", detail: `${dryRun ? "would remove" : "removed"} [mcp_servers.${SERVER_NAME}]` };
  }

  const { content: stripped, removed: hadExisting, eol } = removeTomlServerSections(raw, SERVER_NAME);
  const block = formatTomlServerBlock(SERVER_NAME, serverEntry, eol);
  const sep =
    stripped.trim().length > 0
      ? stripped.endsWith(`${eol}${eol}`)
        ? ""
        : stripped.endsWith(eol)
          ? eol
          : `${eol}${eol}`
      : "";
  const nextContent = `${stripped}${sep}${block}`;

  if (exists && nextContent === raw) {
    return { action: "unchanged", detail: `[mcp_servers.${SERVER_NAME}] already up to date` };
  }

  if (!dryRun) {
    atomicWriteFile(filePath, nextContent);
  }
  return {
    action: hadExisting ? "update" : exists ? "merge" : "create",
    detail: `${dryRun ? (hadExisting ? "would update" : "would write") : hadExisting ? "updated" : "wrote"} [mcp_servers.${SERVER_NAME}]`,
  };
}

function isManagedSkillDir(dirPath) {
  const skillFile = path.join(dirPath, "SKILL.md");
  if (!fs.existsSync(skillFile)) return false;
  try {
    const content = fs.readFileSync(skillFile, "utf8");
    return /^name:\s*meeting-context\s*$/m.test(content);
  } catch {
    return false;
  }
}

function resolveRealOrLexical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function symlinkPointsToSource(linkPath, resolvedSrc, realSrc) {
  const rawTarget = fs.readlinkSync(linkPath);
  const lexicalTarget = path.resolve(path.dirname(linkPath), rawTarget);
  if (fs.existsSync(linkPath)) {
    try {
      if (fs.realpathSync(linkPath) === realSrc) return { matches: true, rawTarget };
    } catch {
      // fall through
    }
  }
  return {
    matches: lexicalTarget === resolvedSrc || lexicalTarget === realSrc,
    rawTarget,
  };
}

function updateSkillLink(skillSrc, skillDest, { uninstall, dryRun }) {
  if (!skillDest) {
    return { action: "n/a", detail: "client uses MCP prompts/resources directly (no local skills dir)" };
  }

  const resolvedSrc = path.resolve(skillSrc);
  const realSrc = resolveRealOrLexical(resolvedSrc);
  const resolvedDest = path.resolve(skillDest);
  const destParent = path.dirname(resolvedDest);
  const effectiveDest = fs.existsSync(destParent)
    ? path.join(resolveRealOrLexical(destParent), path.basename(resolvedDest))
    : resolvedDest;

  if (resolvedDest === resolvedSrc || effectiveDest === realSrc) {
    return {
      action: "skip",
      detail: `refused to modify source skill directory (${resolvedDest} resolves to ${realSrc})`,
    };
  }

  let lstat = null;
  try {
    lstat = fs.lstatSync(resolvedDest);
  } catch {
    lstat = null;
  }

  if (lstat && !lstat.isSymbolicLink() && resolveRealOrLexical(resolvedDest) === realSrc) {
    return {
      action: "skip",
      detail: `refused to modify source skill directory (${resolvedDest} resolves to ${realSrc})`,
    };
  }

  if (uninstall) {
    if (!lstat) {
      return { action: "skip", detail: "skill not installed" };
    }
    if (lstat.isSymbolicLink()) {
      const { matches, rawTarget } = symlinkPointsToSource(resolvedDest, resolvedSrc, realSrc);
      if (!matches) {
        return {
          action: "skip",
          detail: `refused to remove symlink pointing elsewhere (${rawTarget})`,
        };
      }
      if (!dryRun) {
        fs.unlinkSync(resolvedDest);
      }
      return { action: "remove", detail: `${dryRun ? "would remove" : "removed"} symlink ${resolvedDest}` };
    }
    if (lstat.isDirectory()) {
      if (!isManagedSkillDir(resolvedDest)) {
        return {
          action: "skip",
          detail: `refused to remove unmanaged directory ${resolvedDest} (missing name: ${SKILL_NAME})`,
        };
      }
      if (!dryRun) {
        fs.rmSync(resolvedDest, { recursive: true, force: true });
      }
      return { action: "remove", detail: `${dryRun ? "would remove" : "removed"} skill directory ${resolvedDest}` };
    }
    return { action: "skip", detail: `refused to remove unexpected file at ${resolvedDest}` };
  }

  // Install mode
  if (lstat) {
    if (lstat.isSymbolicLink()) {
      const { matches, rawTarget } = symlinkPointsToSource(resolvedDest, resolvedSrc, realSrc);
      if (matches) {
        return { action: "unchanged", detail: `symlink already points to ${resolvedSrc}` };
      }
      if (fs.existsSync(resolvedDest) && !isManagedSkillDir(resolvedDest)) {
        throw new Error(
          `Refusing to overwrite unrelated symlink at ${resolvedDest} -> ${rawTarget}. Remove or rename it first.`,
        );
      }
      if (!dryRun) {
        fs.unlinkSync(resolvedDest);
      }
    } else if (lstat.isDirectory()) {
      if (!isManagedSkillDir(resolvedDest)) {
        throw new Error(
          `Refusing to overwrite non-${SKILL_NAME} directory at ${resolvedDest}. Remove or rename it first.`,
        );
      }
      if (!dryRun) {
        fs.rmSync(resolvedDest, { recursive: true, force: true });
      }
    } else {
      throw new Error(`Refusing to overwrite existing file at ${resolvedDest}`);
    }
  }

  if (dryRun) {
    return {
      action: lstat ? "update" : "install",
      detail: `would symlink ${resolvedDest} -> ${resolvedSrc}`,
    };
  }

  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(resolvedSrc, resolvedDest, linkType);
    return {
      action: lstat ? "update" : "install",
      detail: `symlinked ${resolvedDest} -> ${resolvedSrc}`,
    };
  } catch (err) {
    // Fallback to copying if symlinks are disallowed (e.g. restricted Windows environments)
    if (err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "ENOTSUP")) {
      fs.cpSync(resolvedSrc, resolvedDest, { recursive: true });
      return {
        action: lstat ? "update" : "install",
        detail: `copied ${resolvedSrc} -> ${resolvedDest} (symlink fallback)`,
      };
    }
    throw err;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const home = getHomeDir();
  const specs = getTargetSpecs(home);
  const { targets, mode: targetMode } = resolveTargets(opts.targetsRaw, specs);

  const serverScript = path.join(REPO_ROOT, "mcp_server.py");
  const skillSrc = path.join(REPO_ROOT, "skills", SKILL_NAME);
  const skillFile = path.join(skillSrc, "SKILL.md");

  if (!opts.uninstall) {
    if (!fs.existsSync(serverScript)) {
      throw new Error(`Cannot find MCP server at ${serverScript}`);
    }
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Cannot find skill file at ${skillFile}`);
    }
  }

  const dataDir = path.resolve(opts.dataDir || process.env.MEETING_DATA || path.join(REPO_ROOT, "data"));
  const serverEntry = detectServerEntry(REPO_ROOT, dataDir, opts.excludePrivate);

  const headerMode = opts.uninstall ? "UNINSTALL" : "INSTALL";
  const dryTag = opts.dryRun ? " [DRY-RUN]" : "";
  console.log(`=== meeting-notes MCP v2 + ${SKILL_NAME} Skill (${headerMode}${dryTag}) ===`);
  console.log(`Repo:    ${REPO_ROOT}`);
  console.log(`Home:    ${home}`);
  console.log(`Targets: ${targets.join(", ")} (${targetMode})`);
  if (!opts.uninstall) {
    console.log(`Command: ${serverEntry.command} ${serverEntry.args.join(" ")}`);
    console.log(`Env:     MEETING_DATA=${serverEntry.env.MEETING_DATA}`);
  }
  console.log("");

  for (const id of targets) {
    const spec = specs[id];
    const mcpResult =
      spec.format === "toml"
        ? updateTomlMcpConfig(spec.mcpConfigPath, serverEntry, {
            uninstall: opts.uninstall,
            dryRun: opts.dryRun,
          })
        : updateJsonMcpConfig(spec.mcpConfigPath, serverEntry, {
            uninstall: opts.uninstall,
            dryRun: opts.dryRun,
          });

    const skillResult = updateSkillLink(skillSrc, spec.skillDestPath, {
      uninstall: opts.uninstall,
      dryRun: opts.dryRun,
    });

    console.log(`[${spec.label}]`);
    console.log(`  MCP   (${mcpResult.action}): ${spec.mcpConfigPath}`);
    console.log(`        -> ${mcpResult.detail}`);
    console.log(`  Skill (${skillResult.action}): ${spec.skillDestPath || "(none)"}`);
    console.log(`        -> ${skillResult.detail}`);
  }

  console.log("");
  if (targets.includes("claude-code")) {
    console.log(
      `Note (Claude Code): Quit running Claude Code sessions before editing ~/.claude.json (it rewrites ~/.claude.json on exit),` +
        (opts.uninstall
          ? ` or run \`claude mcp remove -s user ${SERVER_NAME}\`.`
          : ` or run \`claude mcp add-json -s user ${SERVER_NAME} '${JSON.stringify(serverEntry)}'\`.`),
    );
  }
  if (opts.dryRun) {
    console.log("Dry-run complete. No files were modified.");
  } else if (opts.uninstall) {
    console.log("Uninstall complete. Restart your AI client(s) to reload MCP configuration.");
  } else {
    console.log("Install complete. Restart your AI client(s) to load meeting-notes MCP v2 and meeting-context skill.");
  }
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
