import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");

const args = process.argv.slice(2);
if (!args.some((arg) => arg === "--publish" || arg.startsWith("--publish="))) {
  args.push("--publish", "never");
}

const env = { ...process.env };
if (!env.CSC_LINK && !env.APPLE_CERTIFICATE) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}

const binName = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
const localBin = path.join(desktopDir, "node_modules", ".bin", binName);
const bin = fs.existsSync(localBin) ? localBin : binName;

const res = spawnSync(bin, args, {
  cwd: desktopDir,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (res.error) {
  console.error(res.error);
  process.exit(1);
}
process.exit(res.status ?? 1);
