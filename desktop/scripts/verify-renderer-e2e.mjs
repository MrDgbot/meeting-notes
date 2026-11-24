import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DESKTOP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..");
const RENDERER_DIST = path.join(DESKTOP_ROOT, "out/renderer");

const require = createRequire(path.join(REPO_ROOT, "tests/mobile/package.json"));
const { chromium } = require("@playwright/test");
const { AxeBuilder } = require("@axe-core/playwright");

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function assert(cond, msg) {
  if (!cond) throw new Error(`E2E assertion failed: ${msg}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("failed to get free port")));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function makeWav(durationS = 2.0, sr = 16000) {
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

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayCompact = todayStr.replace(/-/g, "");

  const seed = (id, meta, paragraphs, minutesObj, notes = "", qa = [], spkEmbs = null) => {
    const dir = path.join(meetingsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, ...meta }, null, 2));
    fs.writeFileSync(
      path.join(dir, "transcript.json"),
      JSON.stringify({ asr: "paraformer", cost: 1.0, paragraphs }),
    );
    fs.writeFileSync(path.join(dir, "minutes.json"), JSON.stringify(minutesObj));
    if (notes) fs.writeFileSync(path.join(dir, "notes.md"), notes);
    if (qa.length) fs.writeFileSync(path.join(dir, "qa.json"), JSON.stringify(qa));
    if (spkEmbs) fs.writeFileSync(path.join(dir, "spk_embs.json"), JSON.stringify(spkEmbs));
    fs.writeFileSync(path.join(dir, "audio.wav"), makeWav(2.0));
  };

  seed(
    "20261123-090000-e2e1",
    {
      title: "Workday 权限架构评审",
      title_auto: false,
      brief: "对齐 Workday 单点登录方案与权限边界，李四负责输出测试方案",
      tags: ["Workday", "单点登录"],
      created: "2026-11-23T09:00:00",
      status: "ready",
      source: "mic",
      duration: 600,
      num_spk: 2,
      hotword: "Workday OKR",
      template: "general",
      speakers: { 0: "张三", 1: "李四" },
      error: "",
    },
    [
      { start: 0, end: 30000, spk: 0, text: "今天先对齐 Workday 权限接入和单点登录时间线。" },
      {
        start: 30000,
        end: 65000,
        spk: 1,
        text: "收到，我来跟进 IT 账号申请，周五前输出测试方案。",
      },
      { start: 36650000, end: 36680000, spk: 0, text: "最后确认一下长时间戳的排版间距。" },
    ],
    {
      markdown:
        "## 会议概要\n讨论了 Workday 单点登录与权限边界。\n\n## 待办\n- [ ] 张三 确认 Workday 单点登录方案 [00:00]\n- [x] 李四 整理历史权限清单 [00:30]\n",
      template: "general",
      provider: "test",
      model: "m",
      created: "2026-11-23T09:00:00",
      cost: 0.1,
      highlights: [{ text: "对齐 Workday 单点登录与权限边界", start_ms: 0, end_ms: 30000, marked: true }],
    },
    "重点记录：本周五前确认 SSO 接口",
    [{ q: "谁负责测试方案？", a: "李四负责输出测试方案 [00:30]。", t: "2026-11-23T09:15:00" }],
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
      speakers: { 0: "张三", 1: "王五" },
      error: "",
    },
    [{ start: 0, end: 25000, spk: 0, text: "上次 Workday 权限方案已经确认，今天准备联调环境。" }],
    {
      markdown: "## 会议概要\nWorkday 联调环境准备。\n\n## 待办\n- [ ] 王五 开通 Workday 测试环境 [00:05]\n",
      template: "general",
      provider: "test",
      model: "m",
      created: "2026-11-22T14:00:00",
      cost: 0.1,
    },
  );

  seed(
    `${todayCompact}-091000-e2e3`,
    {
      title: "自动记录 09:10",
      title_auto: true,
      created: `${todayStr}T09:10:00`,
      status: "ready",
      source: "ambient",
      duration: 120,
      speech_s: 60,
      num_spk: 1,
      hotword: "",
      template: "general",
      speakers: {},
      error: "",
    },
    [
      {
        start: 0,
        end: 18000,
        spk: 0,
        text: "我明天把 Workday 联调方案发给你，顺便确认单点登录测试账号。",
      },
      {
        start: 18000,
        end: 42000,
        spk: 0,
        text: "另外周五前需要把权限边界压测跑完，有问题随时同步。",
      },
    ],
    {},
    "",
    [],
    {
      diarizer: "campp",
      dim: 4,
      speakers: {
        0: {
          centroid: [1.0, 0.0, 0.0, 0.0],
          voiced_s: 42.0,
          n_chunks: 12,
          intra_cos_mean: 0.88,
        },
      },
    },
  );

  seed(
    `${todayCompact}-103000-e2e4`,
    {
      title: "Workday 灰度验收对齐",
      title_auto: false,
      created: `${todayStr}T10:30:00`,
      status: "ready",
      source: "ambient",
      duration: 95,
      speech_s: 55,
      num_spk: 1,
      hotword: "Workday",
      template: "general",
      speakers: {},
      error: "",
    },
    [
      {
        start: 0,
        end: 25000,
        spk: 0,
        text: "Workday 单点登录灰度清单已确认，等测试同学明天回归结果。",
      },
    ],
    {},
    "",
    [],
    {
      diarizer: "campp",
      dim: 4,
      speakers: {
        0: {
          centroid: [0.99, 0.141, 0.0, 0.0],
          voiced_s: 36.0,
          n_chunks: 10,
          intra_cos_mean: 0.86,
        },
      },
    },
  );
}

function startRendererLoopbackProxy(backendPort) {
  const staticRoot = path.resolve(RENDERER_DIST);
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    const urlPath = rawUrl.split("?")[0] || "/";

    if (urlPath.startsWith("/api") || urlPath.startsWith("/lan") || urlPath.startsWith("/static")) {
      const headers = {
        ...req.headers,
        host: `127.0.0.1:${backendPort}`,
        origin: `http://127.0.0.1:${backendPort}`,
      };
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: backendPort,
          path: rawUrl,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("backend unavailable");
      });
      req.pipe(proxyReq);
      return;
    }

    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const resolved = path.resolve(staticRoot, rel);
    const rootWithSep = staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`;
    if (resolved !== staticRoot && !resolved.startsWith(rootWithSep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    const target =
      fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : path.join(staticRoot, "index.html");
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
  });

  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });

  server.on("upgrade", (req, clientSocket, head) => {
    const rawUrl = req.url || "/";
    if (!rawUrl.startsWith("/ws")) {
      clientSocket.destroy();
      return;
    }
    const up = net.createConnection({ host: "127.0.0.1", port: backendPort }, () => {
      const hdrs = Object.entries(req.headers)
        .filter(([k]) => !["host", "origin"].includes(k.toLowerCase()))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v || ""}`);
      hdrs.push(`Host: 127.0.0.1:${backendPort}`);
      hdrs.push(`Origin: http://127.0.0.1:${backendPort}`);
      up.write(`${req.method || "GET"} ${rawUrl} HTTP/1.1\r\n${hdrs.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      clientSocket.pipe(up);
      up.pipe(clientSocket);
    });
    up.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => up.destroy());
  });

  return {
    server,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      return `http://127.0.0.1:${addr.port}`;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become healthy at ${baseUrl}`);
}

async function setTheme(page, target) {
  await page.evaluate((want) => {
    const btn = document.getElementById("themeBtn");
    for (let i = 0; i < 4 && document.documentElement.dataset.theme !== want; i++) {
      btn?.click();
    }
  }, target);
  await page.waitForFunction((want) => document.documentElement.dataset.theme === want, target, {
    timeout: 5000,
  });
  await page.waitForTimeout(150);
}

async function assertAxeClean(page, label) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 400);
        const finite = document
          .getAnimations()
          .filter((a) => a.effect?.getTiming?.().iterations !== Number.POSITIVE_INFINITY);
        Promise.allSettled(finite.map((a) => a.finished)).finally(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  );
  const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  assert(
    res.violations.length === 0,
    `[${label}] WCAG 2.2 AA violations: ${JSON.stringify(
      res.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    )}`,
  );
}

async function main() {
  assert(
    fs.existsSync(path.join(RENDERER_DIST, "index.html")),
    "desktop/out/renderer/index.html missing; run pnpm --dir desktop build first",
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mn-desktop-e2e-"));
  const backendPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  seedFixtureData(tmpDir);

  const pyBin = path.join(
    REPO_ROOT,
    process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
  );
  const serverCode = [
    "import os, uvicorn, app, lan",
    "app.load_models = lambda: None",
    "uvicorn.run(lan.Guard(app.app), host='127.0.0.1', port=int(os.environ['E2E_PORT']), log_level='warning')",
  ].join("\n");

  const srv = spawn(pyBin, ["-c", serverCode], {
    cwd: REPO_ROOT,
    env: { ...process.env, MEETING_DATA: tmpDir, E2E_PORT: String(backendPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let srvErr = "";
  srv.stderr.on("data", (chunk) => {
    srvErr += chunk.toString();
  });

  const proxy = startRendererLoopbackProxy(backendPort);
  let browser;

  try {
    await waitForHealth(backendUrl);
    const appUrl = await proxy.listen();

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();

    const errors = [];
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    const shotDir = process.env.E2E_SCREENSHOT_DIR ? path.resolve(process.env.E2E_SCREENSHOT_DIR) : "";
    if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

    // 1. HomePage (Today Workbench) + Commitment Radar + Backfill + Voiceprint Wizard + Select padding + Light/Dark WCAG 2.2 AA
    await page.goto(`${appUrl}/#/`, { waitUntil: "networkidle" });
    await page.waitForSelector("main h1");
    await page.waitForSelector("#homeQuickTitle");
    await page.waitForSelector("main >> text=今日脉络");
    await page.waitForSelector("main section[aria-label='人物快捷入口'] >> text=张三");
    await page.waitForSelector("main >> text=张三 确认 Workday 单点登录方案");

    const homeLayoutMetrics = await page.evaluate(() => {
      const header = document.querySelector("main header");
      const quickStart = document.querySelector("main section[aria-label='快速开始会议']");
      const closedHeights = [...document.querySelectorAll("main .mn-disclosure[data-open='false']")].map(
        (el) => el.getBoundingClientRect().height,
      );
      if (!header || !quickStart) return null;
      return {
        headerToRow1Gap: quickStart.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        closedHeights,
      };
    });
    assert(homeLayoutMetrics, "missing Home header/quickStart layout nodes");
    assert(
      homeLayoutMetrics.headerToRow1Gap >= 16 && homeLayoutMetrics.headerToRow1Gap <= 32,
      `unexpected Home header-to-Row-1 gap: ${homeLayoutMetrics.headerToRow1Gap}px`,
    );
    assert(
      homeLayoutMetrics.closedHeights.length >= 4 && homeLayoutMetrics.closedHeights.every((h) => h <= 1),
      `closed Disclosure did not collapse to <=1px: ${homeLayoutMetrics.closedHeights}`,
    );

    // Commitment radar tab
    await page.click("main button:has-text('承诺雷达')");
    await page.waitForSelector("main >> text=Workday 联调方案");
    await page.click("main button:has-text('未完待办')");

    // Auto-title/brief backfill trigger
    const backfillPromise = page.waitForResponse(
      (r) => r.url().includes("/api/insights/backfill") && r.request().method() === "POST",
    );
    await page.click("main button:has-text('智能起名')");
    const backfillRes = await backfillPromise;
    assert(backfillRes.ok(), `backfill failed: ${backfillRes.status()}`);
    await page.waitForTimeout(200);

    // Suggestions pill & Drawer (must NOT displace Bento Row 2)
    await page.waitForSelector("main header button:has-text('待确认')");
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "mac-home-with-insights.png") });
    await page.click("main header button:has-text('待确认')");
    await page.waitForSelector("[role='dialog'][aria-label='智能识别建议']");
    await page.waitForTimeout(240);
    await assertAxeClean(page, "home-insights-drawer");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role='dialog'][aria-label='智能识别建议']", { state: "detached" });

    // Voiceprint batch-naming wizard (accessible inside People card header)
    await page.click("main button:has-text('批量认人')");
    await page.waitForSelector("[role='dialog'][aria-label='批量认人向导']");
    await page.waitForSelector("[role='dialog'] >> text=出现 2 场");
    await page.waitForTimeout(240);
    await assertAxeClean(page, "vp-wizard-light");
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "mac-voiceprint-wizard.png") });
    await page.fill("[role='dialog'] input[placeholder*='输入 TA 的名字']", "赵六");
    const batchNamePromise = page.waitForResponse(
      (r) => r.url().includes("/api/rsi/voiceprints/batch-name") && r.request().method() === "POST",
    );
    await page.click("[role='dialog'] button:has-text('一键认人')");
    const batchNameRes = await batchNamePromise;
    assert(batchNameRes.ok(), `batch-name failed: ${batchNameRes.status()}`);
    await page.waitForSelector("[role='dialog'] >> text=近 14 天暂无待确认的常见声音");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role='dialog'][aria-label='批量认人向导']", {
      state: "detached",
    });

    await page.click("button:has-text('选项')");
    await page.waitForSelector("#homeNumSpk");
    await page.waitForSelector("#homeTpl");
    const selectPads = await page.evaluate(() =>
      [...document.querySelectorAll("select")].map(
        (el) => Number.parseFloat(getComputedStyle(el).paddingRight) || 0,
      ),
    );
    assert(
      selectPads.length >= 2 && selectPads.every((p) => p >= 24),
      `select paddingRight too small: ${selectPads}`,
    );
    await setTheme(page, "light");
    await assertAxeClean(page, "home-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "home-dark");
    await setTheme(page, "light");

    // 2. Meeting Detail: split view, related card, player controls + hover preview, todo toggle persistence, notes
    await page.goto(`${appUrl}/#/m/20261123-090000-e2e1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[aria-label="音频播放进度"]');
    await page.waitForSelector('[aria-label="后退 15 秒"]');
    await page.waitForSelector('[aria-label="前进 15 秒"]');
    await page.waitForSelector("button:has-text('隐私会议')");
    await page.waitForSelector("main >> text=相关会议");
    await page.waitForSelector("main >> text=Workday 接口联调准备");
    await page.waitForSelector("text=今天先对齐 Workday 权限接入和单点登录时间线。");
    await page.waitForSelector("button[title='跳到此处播放']:has-text('10:10:50')");

    const longTsMetrics = await page.evaluate(() => {
      const tsBtn = [...document.querySelectorAll('button[title="跳到此处播放"]')].find(
        (b) => b.textContent?.trim() === "10:10:50",
      );
      if (!tsBtn) return null;
      const row = tsBtn.parentElement;
      const spkBtn = row
        ? [...row.querySelectorAll("button")].find((b) => b.textContent?.includes("张三"))
        : null;
      if (!spkBtn) return null;
      return {
        fontSize: Number.parseFloat(getComputedStyle(tsBtn).fontSize),
        gapPx: spkBtn.getBoundingClientRect().left - tsBtn.getBoundingClientRect().right,
      };
    });
    assert(longTsMetrics, "missing 10:10:50 timestamp/speaker row for layout check");
    assert(longTsMetrics.fontSize <= 12, `timestamp fontSize too large: ${longTsMetrics.fontSize}`);
    assert(longTsMetrics.gapPx >= 12, `timestamp/speaker gap too tight: ${longTsMetrics.gapPx}px`);

    const sliderBox = await page.locator('[aria-label="音频播放进度"]').boundingBox();
    assert(sliderBox && sliderBox.width > 50, "audio waveform slider missing");
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.25, sliderBox.y + sliderBox.height / 2);
    await page.waitForSelector("text=00:");

    // Todo toggle + persistence across reload
    const firstTodoCb = page.locator('input[type="checkbox"][aria-label="完成待办"]').first();
    assert((await firstTodoCb.isChecked()) === false, "expected first todo unchecked initially");
    const patchPromise = page.waitForResponse(
      (r) => r.url().includes("/api/meetings/20261123-090000-e2e1") && r.request().method() === "PATCH",
    );
    await firstTodoCb.click();
    const patchRes = await patchPromise;
    assert(patchRes.ok(), `todo patch failed: ${patchRes.status()}`);
    await page.waitForSelector("text=待办 2 / 2");

    // Notes tab switch + auto-save persistence
    await page.click("main button:text-is('我的笔记')");
    await page.waitForSelector("#notes");
    const noteSavePromise = page.waitForResponse(
      (r) => r.url().includes("/api/meetings/20261123-090000-e2e1") && r.request().method() === "PATCH",
    );
    await page.fill("#notes", "已确认周五前完成 SSO 联调与验收");
    const noteSaveRes = await noteSavePromise;
    assert(noteSaveRes.ok(), `notes auto-save failed: ${noteSaveRes.status()}`);
    await page.click("main button:text-is('AI 纪要')");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=待办 2 / 2");
    assert(
      (await page.locator('input[type="checkbox"][aria-label="完成待办"]').first().isChecked()) === true,
      "toggled todo did not persist after reload",
    );
    await page.click("main button:text-is('我的笔记')");
    assert(
      (await page.locator("#notes").inputValue()).includes("已确认周五前完成 SSO 联调与验收"),
      "saved notes did not persist after reload",
    );
    await page.click("main button:text-is('AI 纪要')");

    await setTheme(page, "light");
    await assertAxeClean(page, "meeting-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "meeting-dark");
    await setTheme(page, "light");

    // 3. Todos Hub sync
    await page.click("button:has-text('待办中心')");
    await page.waitForSelector("h1:has-text('待办中心')");
    await page.click("button:has-text('全部')");
    await page.waitForSelector("text=Workday 权限架构评审");
    await assertAxeClean(page, "todos-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "todos-dark");
    await setTheme(page, "light");

    // 4. Home People Entry -> People Directory & Interactive Editing -> Timeline
    await page.goto(`${appUrl}/#/`, { waitUntil: "networkidle" });
    await page.click("main section[aria-label='人物快捷入口'] button:has-text('管理与修改')");
    await page.waitForSelector("h1:has-text('人物管理')");
    await page.waitForSelector("main button:has-text('张三')");
    await page.waitForSelector("main button:has-text('王五')");
    await assertAxeClean(page, "people-light");

    await page.click("main button[aria-label='修改 王五']");
    await page.waitForSelector("[role='dialog'][aria-label='修改人物姓名']");
    await page.fill("#personRenameInput", "王六");
    const renPromise1 = page.waitForResponse(
      (r) => r.url().includes("/api/people/rename") && r.request().method() === "POST",
    );
    await page.click("[role='dialog'] button:has-text('保存改名')");
    const renRes1 = await renPromise1;
    assert(renRes1.ok(), `people rename failed: ${renRes1.status()}`);
    await page.waitForSelector("main button:has-text('王六')");

    await page.click("main button:has-text('王六')");
    await page.waitForSelector("h1:has-text('王六')");
    await page.click("main button:has-text('改人')");
    await page.waitForSelector("[role='dialog'][aria-label='修改单场发言人']");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role='dialog'][aria-label='修改单场发言人']", { state: "detached" });

    await page.click("main button:has-text('改名 / 合并')");
    await page.waitForSelector("[role='dialog'][aria-label='修改人物姓名']");
    await page.fill("#personRenameInput", "王五");
    const renPromise2 = page.waitForResponse(
      (r) => r.url().includes("/api/people/rename") && r.request().method() === "POST",
    );
    await page.click("[role='dialog'] button:has-text('保存改名')");
    const renRes2 = await renPromise2;
    assert(renRes2.ok(), `people restore rename failed: ${renRes2.status()}`);
    await page.waitForSelector("h1:has-text('王五')");

    await page.click("aside button:has-text('人物')");
    await page.waitForSelector("main button:has-text('张三')");
    await page.click("main button:has-text('张三')");
    await page.waitForSelector("h1:has-text('张三')");
    await page.waitForSelector("text=参会时间线");
    await assertAxeClean(page, "person-timeline-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "person-timeline-dark");
    await setTheme(page, "light");

    // 5. Day Summary Page
    await page.goto(`${appUrl}/#/day/2026-11-23`, { waitUntil: "networkidle" });
    await page.waitForSelector("h1:has-text('2026-11-23')");
    await page.waitForSelector("main >> text=Workday 权限架构评审");
    await assertAxeClean(page, "day-light");

    // 5b. Projects Stream Page
    await page.click("aside button:has-text('项目脉络')");
    await page.waitForSelector("h1:has-text('项目脉络')");
    await page.waitForSelector("main >> text=Workday");
    await assertAxeClean(page, "projects-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "projects-dark");
    await setTheme(page, "light");

    // 5c. Weekly Draft Page (auto-assembles local draft when empty, plus manual refresh)
    await page.click("aside button:has-text('周报')");
    await page.waitForSelector("h1:has-text('周报')");
    await page.waitForSelector("main >> text=本周概览", { timeout: 10000 });
    const draftPromise = page.waitForResponse(
      (r) => r.url().includes("/api/weekly/draft") && r.request().method() === "POST",
    );
    await page.click("main button:has-text('重新汇总')");
    const draftRes = await draftPromise;
    assert(draftRes.ok(), `weekly draft failed: ${draftRes.status()}`);
    await page.waitForSelector("main >> text=本周概览");
    await assertAxeClean(page, "weekly-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "weekly-dark");
    await setTheme(page, "light");

    // 5d. Quick Ask Spotlight Page (standalone full-bleed route)
    await page.goto(`${appUrl}/#/quick-ask`, { waitUntil: "networkidle" });
    await page.waitForSelector("h1:has-text('全局闪问')");
    await page.fill("[aria-label='跨会议提问']", "Workday");
    const askPromise = page.waitForResponse(
      (r) => r.url().includes("/api/ask-global") && r.request().method() === "POST",
    );
    await page.click("button:has-text('提问')");
    const askRes = await askPromise;
    assert(askRes.ok(), `ask-global failed: ${askRes.status()}`);
    await page.waitForSelector("text=原声依据");
    await assertAxeClean(page, "quick-ask-light");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.waitForTimeout(100);
    await assertAxeClean(page, "quick-ask-dark");
    await page.goto(`${appUrl}/#/`, { waitUntil: "networkidle" });
    await setTheme(page, "light");

    // 6. Settings Modal (all 5 consolidated tabs)
    await page.click("#cfgBtn");
    await page.waitForSelector("[role='dialog']");
    await page.waitForTimeout(240);
    for (const tabLabel of ["AI 模型", "语音识别", "词库与声纹", "全天模式", "多端与集成"]) {
      await page.click(`nav[aria-label='设置分类'] button:has-text('${tabLabel}')`);
      await page.waitForTimeout(100);
    }
    await assertAxeClean(page, "settings-light");
    await setTheme(page, "dark");
    await assertAxeClean(page, "settings-dark");
    await setTheme(page, "light");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role='dialog']", { state: "detached" });

    // 7. Command Palette (Ctrl+K) & Shortcuts Modal (?) + Space guard on audio
    await page.goto(`${appUrl}/#/m/20261123-090000-e2e1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[aria-label="音频播放进度"]');
    await page.keyboard.press("Control+k");
    await page.waitForSelector("[role='dialog'][aria-label='命令面板']");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role='dialog'][aria-label='命令面板']", { state: "detached" });

    await page.keyboard.press("?");
    await page.waitForSelector("[role='dialog']");
    await page.keyboard.press("Space");
    const audioPaused = await page.evaluate(() => {
      const a = document.getElementById("audio");
      return a instanceof HTMLAudioElement ? a.paused : true;
    });
    assert(audioPaused === true, "Space toggled audio playback while modal was open");
    await page.keyboard.press("Escape");

    assert(errors.length === 0, `Browser errors detected: ${errors.join("; ")}`);

    // 8. Cold-start retry verification: first 2 /api/meetings calls fail (sidecar booting), sidebar auto-populates on 3rd
    const coldCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const coldPage = await coldCtx.newPage();
    let meetingCalls = 0;
    await coldPage.route("**/api/meetings", async (route) => {
      meetingCalls += 1;
      if (meetingCalls <= 2) {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"starting"}' });
      } else {
        await route.continue();
      }
    });
    await coldPage.goto(`${appUrl}/#/`, { waitUntil: "domcontentloaded" });
    await coldPage.waitForSelector("aside button:has-text('Workday 权限架构评审')", { timeout: 10000 });
    assert(meetingCalls >= 3, `expected retry calls >= 3, got ${meetingCalls}`);
    await coldCtx.close();

    // 9. macOS Electron window chrome & sidebar collapse layout audit (1366x900 & 960x640)
    const macCtx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Electron/45.4.1 Chrome/136.0.0.0 Safari/537.36",
    });
    await macCtx.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    });
    const macPage = await macCtx.newPage();
    const macErrors = [];
    macPage.on("pageerror", (err) => macErrors.push(`pageerror: ${err.message}`));
    macPage.on("console", (msg) => {
      if (msg.type() === "error") macErrors.push(`console.error: ${msg.text()}`);
    });

    const snap = async (filename) => {
      if (!shotDir) return;
      await macPage
        .evaluate(
          () =>
            new Promise((resolve) => {
              const t = setTimeout(resolve, 320);
              const fin = document
                .getAnimations()
                .filter((a) => a.effect?.getTiming?.().iterations !== Number.POSITIVE_INFINITY);
              Promise.allSettled(fin.map((a) => a.finished)).finally(() => {
                clearTimeout(t);
                resolve();
              });
            }),
        )
        .catch(() => {});
      await macPage.screenshot({ path: path.join(shotDir, filename) });
    };

    const assertMacChromeClean = async (label, { expectCollapsed }) => {
      const m = await macPage.evaluate(() => {
        const main = document.getElementById("main");
        const mainRect = main?.getBoundingClientRect() || null;
        const trafficBox = { left: 0, top: 0, right: 78, bottom: 34 };
        const overlapsTraffic = [];
        for (const el of document.querySelectorAll("button, a, input, select, textarea, h1, h2")) {
          if (el.closest("[inert], [aria-hidden='true']")) continue;
          const st = getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || Number.parseFloat(st.opacity) === 0)
            continue;
          const raw = el.getBoundingClientRect();
          if (raw.width <= 0 || raw.height <= 0) continue;
          const r =
            main?.contains(el) && mainRect
              ? {
                  left: Math.max(raw.left, mainRect.left),
                  top: Math.max(raw.top, mainRect.top),
                  right: Math.min(raw.right, mainRect.right),
                  bottom: Math.min(raw.bottom, mainRect.bottom),
                }
              : raw;
          if (r.right <= r.left || r.bottom <= r.top) continue;
          const hit =
            r.left < trafficBox.right &&
            r.right > trafficBox.left &&
            r.top < trafficBox.bottom &&
            r.bottom > trafficBox.top;
          if (hit) {
            overlapsTraffic.push({
              tag: el.tagName,
              label: el.getAttribute("aria-label") || el.textContent?.trim()?.slice(0, 24) || "",
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            });
          }
        }

        const aside = document.querySelector("aside");
        const asideRect = aside?.getBoundingClientRect();
        const expandBtn = document.querySelector('button[aria-label="展开左侧边栏"]');
        const btnRect = expandBtn?.getBoundingClientRect() || null;
        const h1 = main?.querySelector("h1");
        const h1Rect = h1?.getBoundingClientRect() || null;
        const player = main?.querySelector('[aria-label="音频播放进度"]')?.closest(".sticky");
        const playerRect = player?.getBoundingClientRect() || null;

        return {
          overlapsTraffic,
          scrollOverflow: document.documentElement.scrollWidth - window.innerWidth,
          asideWidth: asideRect?.width ?? -1,
          asideInert: Boolean(aside?.inert),
          asideHiddenAttr: aside?.getAttribute("aria-hidden"),
          btnRect: btnRect
            ? { left: btnRect.left, top: btnRect.top, right: btnRect.right, bottom: btnRect.bottom }
            : null,
          mainRect: mainRect ? { top: mainRect.top } : null,
          scrollTop: main?.scrollTop ?? 0,
          h1Rect: h1Rect ? { top: h1Rect.top } : null,
          playerRect: playerRect ? { top: playerRect.top } : null,
        };
      });

      assert(
        m.overlapsTraffic.length === 0,
        `[${label}] macOS traffic-light overlap: ${JSON.stringify(m.overlapsTraffic)}`,
      );
      assert(m.scrollOverflow <= 0, `[${label}] horizontal overflow ${m.scrollOverflow}px`);
      assert(m.mainRect, `[${label}] missing #main`);

      if (expectCollapsed) {
        assert(m.asideWidth <= 1, `[${label}] expected collapsed aside width <= 1, got ${m.asideWidth}`);
        assert(m.asideInert, `[${label}] expected collapsed aside inert=true`);
        assert(m.asideHiddenAttr === "true", `[${label}] expected collapsed aside aria-hidden='true'`);
        assert(m.btnRect, `[${label}] expand button missing while collapsed`);
        assert(m.btnRect.left >= 78, `[${label}] expand button left=${m.btnRect.left} < 78`);
        assert(
          m.btnRect.top >= 0 && m.btnRect.bottom <= 38,
          `[${label}] expand btn outside 38px bar: ${JSON.stringify(m.btnRect)}`,
        );
        const centerY = (m.btnRect.top + m.btnRect.bottom) / 2;
        assert(Math.abs(centerY - 19) <= 2, `[${label}] expand btn centerY=${centerY} not aligned with 19`);
        assert(
          m.btnRect.bottom <= m.mainRect.top + 0.5,
          `[${label}] expand btn overlaps #main (${m.btnRect.bottom} > ${m.mainRect.top})`,
        );
        if (m.scrollTop === 0 && m.h1Rect) {
          assert(
            m.btnRect.bottom <= m.h1Rect.top + 0.5,
            `[${label}] expand btn overlaps h1 (${m.btnRect.bottom} > ${m.h1Rect.top})`,
          );
        }
        if (m.playerRect) {
          assert(m.playerRect.top >= m.btnRect.bottom - 0.5, `[${label}] sticky player overlaps expand btn`);
        }
      } else {
        assert(
          m.asideWidth >= 260 && m.asideWidth <= 268,
          `[${label}] expected expanded aside ~264px, got ${m.asideWidth}`,
        );
        assert(!m.asideInert, `[${label}] expected expanded aside not inert`);
      }
    };

    await macPage.goto(`${appUrl}/#/m/20261123-090000-e2e1`, { waitUntil: "networkidle" });
    await macPage.waitForSelector("h1:has-text('Workday 权限架构评审')");
    await macPage.waitForSelector('[aria-label="音频播放进度"]');
    await assertMacChromeClean("mac-expanded-1366", { expectCollapsed: false });
    await snap("mac-meeting-expanded.png");

    await macPage.click('button[aria-label="收起左侧边栏"]');
    await macPage.waitForSelector('button[aria-label="展开左侧边栏"]');
    await macPage.waitForTimeout(300);
    await assertMacChromeClean("mac-collapsed-1366", { expectCollapsed: true });
    await snap("mac-meeting-collapsed.png");

    await macPage.evaluate(() => {
      const main = document.getElementById("main");
      if (main) main.scrollTop = 300;
    });
    await macPage.waitForTimeout(100);
    await assertMacChromeClean("mac-collapsed-scrolled-1366", { expectCollapsed: true });
    await snap("mac-meeting-collapsed-scrolled.png");

    for (const [hashRoute, headingSel, shotName] of [
      ["#/", "main >> text=今日脉络", "mac-home-collapsed.png"],
      ["#/todos", "h1:has-text('待办中心')", ""],
      ["#/people", "h1:has-text('人物管理')", ""],
      ["#/projects", "h1:has-text('项目脉络')", "mac-projects.png"],
      ["#/weekly", "h1:has-text('周报')", "mac-weekly.png"],
      ["#/day/2026-11-23", "h1:has-text('2026-11-23')", ""],
    ]) {
      await macPage.goto(`${appUrl}/${hashRoute}`, { waitUntil: "networkidle" });
      await macPage.waitForSelector(headingSel);
      await assertMacChromeClean(`mac-collapsed-${hashRoute}`, { expectCollapsed: true });
      if (shotName) await snap(shotName);
    }

    await macPage.goto(`${appUrl}/#/m/20261123-090000-e2e1`, { waitUntil: "networkidle" });
    await macPage.waitForSelector("h1:has-text('Workday 权限架构评审')");
    await assertAxeClean(macPage, "mac-collapsed-meeting");

    const sampleQrSvg =
      '<svg viewBox="0 0 29 29" class="segno"><path class="qrline" stroke="#171717" d="M2 2.5h7m1 0h1m1 0h7M2 3.5h1m5 0h1m3 0h1m5 0h1"/></svg>';
    const lanRouteHandler = async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          port: 8771,
          has_password: true,
          running: true,
          error: "",
          ca_sha256: "B0:68:13:64:45:33:9A:1E",
          urls: [
            { url: "https://172.16.68.97:8771", label: "Wi-Fi / 有线", qr: sampleQrSvg },
            { url: "https://100.127.203.65:8771", label: "Tailscale", qr: sampleQrSvg },
          ],
        }),
      });
    };
    await macPage.route("**/api/lan", lanRouteHandler);
    await macPage.keyboard.press("Control+,");
    await macPage.waitForSelector("[role='dialog']");
    await macPage.click("nav[aria-label='设置分类'] button:has-text('多端与集成')");
    await macPage.waitForSelector("[role='dialog'] img");
    const lanImgs = await macPage.evaluate(async () => {
      const imgs = [...document.querySelectorAll("[role='dialog'] img")];
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((res) => {
                img.addEventListener("load", res, { once: true });
                img.addEventListener("error", res, { once: true });
              }),
        ),
      );
      const dlg = document.querySelector("[role='dialog']")?.getBoundingClientRect();
      return {
        dialogTop: dlg ? dlg.top : -1,
        items: imgs.map((i) => ({ complete: i.complete, naturalWidth: i.naturalWidth })),
      };
    });
    assert(lanImgs.dialogTop >= 16, `settings dialog top clipped: ${lanImgs.dialogTop}`);
    assert(lanImgs.items.length >= 2, `expected >= 2 LAN QR imgs, got ${lanImgs.items.length}`);
    assert(
      lanImgs.items.every((i) => i.complete && i.naturalWidth > 0),
      `broken LAN QR image(s): ${JSON.stringify(lanImgs.items)}`,
    );
    await snap("mac-settings-lan.png");
    await macPage.keyboard.press("Escape");
    await macPage.waitForSelector("[role='dialog']", { state: "detached" });
    await macPage.unroute("**/api/lan", lanRouteHandler);

    await macPage.setViewportSize({ width: 960, height: 640 });
    await macPage.evaluate(() => {
      const main = document.getElementById("main");
      if (main) main.scrollTop = 240;
    });
    await macPage.waitForTimeout(200);
    await assertMacChromeClean("mac-collapsed-960x640", { expectCollapsed: true });
    await snap("mac-min-960.png");

    await macPage.click('button[aria-label="展开左侧边栏"]');
    await macPage.waitForTimeout(300);
    await assertMacChromeClean("mac-reexpanded-960x640", { expectCollapsed: false });

    await macPage.setViewportSize({ width: 1366, height: 900 });
    await macPage.goto(`${appUrl}/#/`, { waitUntil: "networkidle" });
    await macPage.waitForSelector("main >> text=今日脉络");
    await assertMacChromeClean("mac-home-expanded-1366", { expectCollapsed: false });
    await snap("mac-home-v2.png");
    await setTheme(macPage, "dark");
    await snap("mac-home-dark.png");
    await setTheme(macPage, "light");

    await macPage.click("aside button:has-text('人物')");
    await macPage.waitForSelector("main button:has-text('批量认人')");
    await macPage.click("main button:has-text('批量认人')");
    await macPage.waitForSelector("[role='dialog'][aria-label='批量认人向导']");
    await snap("mac-voiceprint-wizard-empty.png");
    await macPage.keyboard.press("Escape");

    await macPage.goto(`${appUrl}/#/quick-ask`, { waitUntil: "networkidle" });
    await macPage.waitForSelector("h1:has-text('全局闪问')");
    await macPage.fill("[aria-label='跨会议提问']", "Workday");
    await macPage.click("button:has-text('提问')");
    await macPage.waitForSelector("text=原声依据");
    await snap("mac-quick-ask.png");

    assert(macErrors.length === 0, `macOS audit errors: ${macErrors.join("; ")}`);
    await macCtx.close();

    console.log(
      "verify-renderer-e2e OK: all functional checks + cold-start retry + macOS chrome/collapse audit + Light/Dark WCAG 2.2 AA audits passed (0 errors, 0 violations)",
    );
  } finally {
    if (browser) await browser.close();
    await proxy.close();
    srv.kill("SIGTERM");
    await new Promise((r) => {
      srv.once("exit", r);
      setTimeout(r, 2000);
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (srvErr.trim()) {
      console.error("[uvicorn stderr]", srvErr.trim());
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
