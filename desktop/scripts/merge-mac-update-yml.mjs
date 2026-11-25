import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let arm64Path = "";
  let x64Path = "";
  let outPath = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arm64" && argv[i + 1]) arm64Path = argv[++i];
    else if (arg === "--x64" && argv[i + 1]) x64Path = argv[++i];
    else if (arg === "--out" && argv[i + 1]) outPath = argv[++i];
  }
  if (!outPath) {
    throw new Error("Usage: merge-mac-update-yml.mjs [--arm64 <file>] [--x64 <file>] --out <file>");
  }
  return { arm64Path, x64Path, outPath };
}

function unquoteYaml(val) {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseUpdateYml(text) {
  const doc = {
    version: "",
    files: [],
    path: "",
    sha512: "",
    releaseDate: "",
  };

  let inFiles = false;
  let currentFile = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
      inFiles = false;
      currentFile = null;
      const idx = rawLine.indexOf(":");
      if (idx === -1) continue;
      const key = rawLine.slice(0, idx).trim();
      const val = rawLine.slice(idx + 1).trim();
      if (key === "files") {
        inFiles = true;
      } else if (key === "version" || key === "path" || key === "sha512" || key === "releaseDate") {
        doc[key] = unquoteYaml(val);
      }
      continue;
    }

    if (inFiles) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith("- ")) {
        currentFile = {};
        doc.files.push(currentFile);
        const rest = trimmed.slice(2).trim();
        const colonIdx = rest.indexOf(":");
        if (colonIdx !== -1) {
          const k = rest.slice(0, colonIdx).trim();
          const v = rest.slice(colonIdx + 1).trim();
          currentFile[k] = k === "size" ? Number(v) : unquoteYaml(v);
        }
      } else if (currentFile) {
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx !== -1) {
          const k = trimmed.slice(0, colonIdx).trim();
          const v = trimmed.slice(colonIdx + 1).trim();
          currentFile[k] = k === "size" ? Number(v) : unquoteYaml(v);
        }
      }
    }
  }

  return doc;
}

export function serializeMacUpdateYml(docs) {
  const valid = docs.filter((d) => d?.version);
  if (valid.length === 0) {
    throw new Error("No valid macOS update manifests provided to merge");
  }
  const primary = valid[0];
  const seenUrls = new Set();
  const mergedFiles = [];

  for (const d of valid) {
    for (const f of d.files) {
      if (!f.url || seenUrls.has(f.url)) continue;
      seenUrls.add(f.url);
      mergedFiles.push(f);
    }
  }

  const lines = [`version: ${primary.version}`, "files:"];
  for (const f of mergedFiles) {
    lines.push(`  - url: ${f.url}`);
    if (f.sha512) lines.push(`    sha512: ${f.sha512}`);
    if (typeof f.size === "number" && Number.isFinite(f.size)) lines.push(`    size: ${f.size}`);
  }
  const primaryPath = primary.path || mergedFiles[0]?.url || "";
  const primarySha = primary.sha512 || mergedFiles[0]?.sha512 || "";
  if (primaryPath) lines.push(`path: ${primaryPath}`);
  if (primarySha) lines.push(`sha512: ${primarySha}`);
  if (primary.releaseDate) lines.push(`releaseDate: '${primary.releaseDate}'`);

  return `${lines.join("\n")}\n`;
}

function main() {
  const { arm64Path, x64Path, outPath } = parseArgs(process.argv.slice(2));
  const docs = [];
  for (const p of [arm64Path, x64Path]) {
    if (p && fs.existsSync(p)) {
      docs.push(parseUpdateYml(fs.readFileSync(p, "utf8")));
    }
  }
  const merged = serializeMacUpdateYml(docs);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, merged, "utf8");
  console.log(`Merged ${docs.length} macOS update manifest(s) -> ${outPath}`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isEntry) {
  main();
}
