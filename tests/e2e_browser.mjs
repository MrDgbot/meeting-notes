import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(path.join(ROOT, "tests/mobile/package.json"));
const { chromium } = require("@playwright/test");
const { AxeBuilder } = require("@axe-core/playwright");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function makeWav(durationS = 1.0, sr = 16000) {
  const numSamples = Math.floor(durationS * sr);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function seedFixtureData(dataDir) {
  const meetingsDir = path.join(dataDir, "meetings");
  fs.mkdirSync(meetingsDir, { recursive: true });

  const seed = (id, meta, paragraphs, minutesMd) => {
    const dir = path.join(meetingsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, ...meta }, null, 2));
    fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ asr: "paraformer", cost: 1.0, paragraphs }));
    fs.writeFileSync(path.join(dir, "minutes.json"), JSON.stringify({
      markdown: minutesMd,
      template: "general",
      provider: "test",
      model: "m",
      created: meta.created,
      cost: 0.1,
    }));
    fs.writeFileSync(path.join(dir, "audio.wav"), makeWav(2.0));
  };

  seed(
    "20261123-090000-e2e1",
    {
      title: "Workday 权限架构评审",
      title_auto: false,
      created: "2026-11-23T09:00:00",
      status: "ready",
      source: "mic",
      duration: 600,
      num_spk: 2,
      hotword: "Workday OKR",
      template: "general",
      speakers: { "0": "张三", "1": "李四" },
      error: "",
    },
    [
      { start: 0, end: 30000, spk: 0, text: "今天先对齐 Workday 权限接入和单点登录时间线。" },
      { start: 30000, end: 65000, spk: 1, text: "收到，我来跟进 IT 账号申请，周五前输出测试方案。" },
    ],
    "## 会议概要\n讨论了 Workday 单点登录与权限边界。\n\n## 待办\n- [ ] 张三 确认 Workday 单点登录方案 [00:00]\n- [x] 李四 整理历史权限清单 [00:30]\n",
  );

  seed(
    "20261122-140000-e2e2",
    {
      title: "Workday 接口联调准备",
      title_auto: false,
      created: "2026-11-22T14:00:00",
      status: "ready",
      source: "upload",
      duration: 420,
      num_spk: 2,
      hotword: "Workday",
      template: "general",
      speakers: { "0": "张三", "1": "王五" },
      error: "",
    },
    [
      { start: 0, end: 25000, spk: 0, text: "上次 Workday 权限方案已经确认，今天准备联调环境。" },
    ],
    "## 会议概要\nWorkday 联调环境准备。\n\n## 待办\n- [ ] 王五 开通 Workday 测试环境 [00:05]\n",
  );
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not become healthy at ${baseUrl}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`E2E assertion failed: ${msg}`);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mn-browser-e2e-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  seedFixtureData(tmpDir);

  const pyBin = path.join(ROOT, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const serverCode = [
    "import asyncio, os, uvicorn, app, lan",
    "app.load_models = lambda: None",
    "uvicorn.run(lan.Guard(app.app), host='127.0.0.1', port=int(os.environ['E2E_PORT']), log_level='warning')",
  ].join("\n");

  const srv = spawn(pyBin, ["-c", serverCode], {
    cwd: ROOT,
    env: { ...process.env, MEETING_DATA: tmpDir, E2E_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let srvErr = "";
  srv.stderr.on("data", chunk => { srvErr += chunk.toString(); });

  let browser;
  try {
    await waitForHealth(baseUrl);
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();

    const errors = [];
    page.on("pageerror", err => errors.push(`pageerror: ${err.message}`));
    page.on("console", msg => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    // 1. Home view + Light/Dark WCAG 2.2 AA audit + select chevron spacing check
    await page.goto(`${baseUrl}/#/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".home-wrap");
    const homeSelectPads = await page.evaluate(() =>
      [...document.querySelectorAll("select")].map(el => parseFloat(getComputedStyle(el).paddingRight) || 0),
    );
    assert(homeSelectPads.every(p => p >= 22), `select padding-right too small on home: ${homeSelectPads}`);

    const axeLight = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert(axeLight.violations.length === 0, `Light theme axe violations: ${JSON.stringify(axeLight.violations.map(v => v.id))}`);

    await page.evaluate(() => {
      const btn = document.getElementById("themeBtn");
      for (let i = 0; i < 3 && document.documentElement.dataset.theme !== "dark"; i++) btn?.click();
    });
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "failed switching to dark theme");
    await page.waitForTimeout(400);
    const axeDark = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert(
      axeDark.violations.length === 0,
      `Dark theme axe violations: ${JSON.stringify(axeDark.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })))}`,
    );

    // Switch back to light for meeting inspection
    await page.evaluate(() => {
      const btn = document.getElementById("themeBtn");
      for (let i = 0; i < 3 && document.documentElement.dataset.theme !== "light"; i++) btn?.click();
    });

    // 2. Meeting detail: split workspace, related card, player hover preview, interactive todo toggle
    await page.goto(`${baseUrl}/#/m/20261123-090000-e2e1`, { waitUntil: "networkidle" });
    await page.waitForSelector("#player");
    await page.waitForSelector(".rel-card");
    const relText = await page.locator(".rel-card").innerText();
    assert(relText.includes("Workday 接口联调准备"), "related meeting card missing expected match");

    const trackBox = await page.locator("#pTrack").boundingBox();
    assert(trackBox && trackBox.width > 50, "player track missing");
    await page.mouse.move(trackBox.x + trackBox.width * 0.2, trackBox.y + trackBox.height / 2);
    await page.waitForTimeout(150);
    const tipText = await page.locator("#pTip").innerText();
    assert(tipText.length > 0, "player hover tooltip empty");

    // 3. Overlay shortcut guard: exercise isOverlayOpen() in both palette.js and player.js
    await page.keyboard.press("?");
    await page.waitForSelector("#modal:not([hidden])");
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.keyboard.press("/");
    const activeAfterSlash = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert(activeAfterSlash !== "tSearch" && activeAfterSlash !== "searchMeetings", "search shortcut leaked through open #modal");
    const tBefore = await page.evaluate(() => document.getElementById("audio")?.currentTime ?? 0);
    await page.keyboard.press("ArrowRight");
    const tAfter = await page.evaluate(() => document.getElementById("audio")?.currentTime ?? 0);
    assert(tAfter === tBefore, "player ArrowRight shortcut leaked through open #modal");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(260);
    assert(await page.evaluate(() => document.getElementById("modal").hidden), "#modal did not close on Escape");

    await page.keyboard.press("Control+k");
    await page.waitForSelector("#cmdk:not([hidden])");
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.keyboard.press("ArrowRight");
    assert((await page.evaluate(() => document.getElementById("audio")?.currentTime ?? 0)) === tBefore, "player shortcut leaked through open #cmdk");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(220);
    assert(await page.evaluate(() => document.getElementById("cmdk").hidden), "#cmdk did not close on Escape");

    // 4. Todos hub toggle syncs back to server & original meeting minutes
    await page.goto(`${baseUrl}/#/todos`, { waitUntil: "networkidle" });
    await page.waitForSelector("#todoHubList input.cb");
    await page.locator("#todoHubList input.cb").first().click();
    await page.waitForTimeout(400);
    const todosAfter = await (await fetch(`${baseUrl}/api/todos?status=all`)).json();
    assert(todosAfter.counts.done === 2, `expected 2 done todos after hub toggle, got ${JSON.stringify(todosAfter.counts)}`);

    // 5. People hub & person timeline
    await page.goto(`${baseUrl}/#/people`, { waitUntil: "networkidle" });
    await page.waitForSelector(".person-card");
    await page.locator(".person-card", { hasText: "张三" }).click();
    await page.locator(".hub-wrap h1", { hasText: "张三" }).waitFor({ timeout: 5000 });
    assert((await page.locator(".hub-wrap h1").innerText()).includes("张三"), "person timeline title mismatch");

    assert(errors.length === 0, `Browser errors observed:\n${errors.join("\n")}`);
    console.log("PASS: Browser E2E + Light/Dark WCAG 2.2 AA (0 violations) verified on isolated MEETING_DATA");
  } finally {
    if (browser) await browser.close();
    srv.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (srvErr.trim()) console.error("[server stderr]", srvErr.trim());
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
