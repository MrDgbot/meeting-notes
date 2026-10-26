// 宽度扫描：320–1600px 每 10px，Chromium + WebKit，各页面状态逐个检查
//   · 横向溢出（整页、以及非预期的横向滚动区域）
//   · 可点元素被遮挡（取元素中心点做命中测试）
//   · 点击区域：WCAG 2.5.8（24×24 或间距例外）硬性；Apple HIG 44×44 记为建议
//   · 文字被裁掉（overflow 隐藏且没有省略号）
//   · axe-core（WCAG 2.2 AA）在 390 / 820 / 1280 三个宽度各跑一次
// 用法：MN_URL=http://127.0.0.1:8772 node sweep.mjs [chromium|webkit ...] [--quick]
// 结果：out/report-<引擎>.json，标准输出打印汇总；有硬性问题时退出码为 1
import { chromium, webkit } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

const BASE = process.env.MN_URL || "http://127.0.0.1:8772";
const LONG = process.env.MN_LONG || "20261023-152641-vp1d"; // 95 分钟那场：长内容压力
const DAY = process.env.MN_DAY || "2026-10-23";
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const ONLY = (args.find(a => a.startsWith("--state=")) || "").slice(8);
const ENGINES = args.filter(a => !a.startsWith("--")).length ? args.filter(a => !a.startsWith("--")) : ["chromium", "webkit"];
const STEP = QUICK ? 40 : 10;
const range = (a, b) => { const r = []; for (let w = a; w <= b; w += STEP) r.push(w); return r; };
// 触屏：手机到 iPad Pro 横屏；鼠标：窄桌面到宽桌面
const MODES = { touch: range(320, 1370), mouse: range(900, 1600) };
const heightFor = (w, mode) => mode === "mouse" ? 900 : w <= 600 ? 844 : w <= 1100 ? 1180 : 1024;
// 横屏（矮）：手机横屏、iPad 横屏
const LANDSCAPE = [[667, 375], [844, 390], [932, 430], [1024, 768], [1180, 820], [1366, 1024]];
const AXE_W = [390, 820, 1280];
// 本来就该横向滑动的区域（纪要里的宽表格、代码块）
const H_SCROLL_OK = [".tblwrap", "pre", ".md table", ".tabs"];

const tab = k => async p => { const b = p.locator(`button[data-tab=${k}]`); if (await b.count() && !((await b.getAttribute("class")) || "").includes("on")) await b.click(); };
const STATES = [
  { name: "home", hash: "#/" },
  { name: "minutes", hash: `#/m/${LONG}`, ensure: tab("minutes") },
  { name: "transcript", hash: `#/m/${LONG}`, ensure: tab("transcript") },
  { name: "notes", hash: `#/m/${LONG}`, ensure: tab("notes") },
  { name: "qa", hash: `#/m/${LONG}`, ensure: tab("qa") },
  { name: "day", hash: `#/day/${DAY}` },
  { name: "settings", hash: "#/", scope: "#modal", setup: async p => { await p.evaluate(() => openSettings()); await p.waitForSelector("#modal:not([hidden])"); await p.waitForTimeout(800); } },
  { name: "drawer", hash: "#/", scope: "#side", ensure: async p => { if (await p.locator("#navBtn").isVisible() && (await p.locator("#navBtn").getAttribute("aria-expanded")) !== "true") await p.click("#navBtn"); }, only: "touch" },
].filter(s => !ONLY || ONLY.split(",").includes(s.name));

// 在页面里跑的检查
function audit({ hOk, touch, scope }) {
  const vw = innerWidth, vh = innerHeight;
  const desc = el => {
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : ""}${t ? ` "${t}"` : ""}`;
  };
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || +cs.opacity === 0 || cs.pointerEvents === "none") return false;
    if (el.closest("[hidden]")) return false;
    const d = el.closest("details"); if (d && !d.open && !el.closest("summary")) return false;
    return true;
  };
  const res = { docOverflow: 0, hscroll: [], clipped: [], obstructed: [], small24: [], small44: [], coarse: matchMedia("(pointer: coarse)").matches };
  const se = document.scrollingElement;
  res.docOverflow = Math.max(0, se.scrollWidth - se.clientWidth);
  if (res.docOverflow > 1) {
    // 找出伸出屏幕右边、又没被祖先裁掉的元素
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 || r.width === 0) continue;
      let p = el.parentElement, clipped = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o !== "visible") { clipped = true; break; } p = p.parentElement; }
      if (!clipped) res.hscroll.push(`页面: ${desc(el)} 右边到 ${Math.round(r.right)}px`);
      if (res.hscroll.length > 6) break;
    }
  }
  for (const el of document.body.querySelectorAll("*")) {
    if (el.scrollWidth <= el.clientWidth + 1 || !el.clientWidth) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || !visible(el)) continue;
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") {
      if (!hOk.some(s => el.matches(s) || el.closest(s))) res.hscroll.push(`横向滚动: ${desc(el)} 内容 ${el.scrollWidth}px / 可见 ${el.clientWidth}px`);
    } else if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && cs.textOverflow !== "ellipsis") {
      // 有文字被裁掉：只算直接含文字的元素
      if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) res.clipped.push(`${desc(el)} 内容 ${el.scrollWidth}px / 可见 ${el.clientWidth}px`);
    }
  }
  const SEL = "a[href],a[onclick],a.ts,button,input:not([type=hidden]),select,textarea,summary,[role=button],[onclick],label:has(> input[type=radio]),label:has(> input[type=checkbox])";
  const root = (scope && document.querySelector(scope)) || document;
  // 元素真正露出来的部分：和所有会裁剪的祖先（滚动区）取交集
  const shown = el => {
    let r = el.getBoundingClientRect(), L = Math.max(0, r.left), T = Math.max(0, r.top), R = Math.min(vw, r.right), B = Math.min(vh, r.bottom);
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflow === "visible") continue;
      const q = p.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom);
    }
    return R - L >= 2 && B - T >= 2 ? { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T, full: (R - L) * (B - T) >= 0.5 * r.width * r.height } : null;
  };
  const hitOk = (el, r) => {
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: !hit || hit === el || el.contains(hit) || (hit.tagName === "LABEL" && hit.contains(el)) || !!hit.closest("#toast"), hit };
  };
  let targets = [...root.querySelectorAll(SEL)].filter(el => {
    if (el.matches("input[type=radio],input[type=checkbox]") && el.closest("label")) return false; // 由外层 label 接收点击
    if (!visible(el)) return false;
    const v = shown(el);
    return v && v.full; // 大半被滚动区裁掉的不算（滚一下才看得到）
  });
  targets = targets.filter(el => !targets.some(o => o !== el && o.contains(el) && o.matches("button,a,[onclick],label"))); // 按钮里的子元素不单独算
  const rects = targets.map(el => el.getBoundingClientRect());
  targets.forEach((el, i) => {
    const r = rects[i];
    // 遮挡：露出部分的中心点命中的是不是自己；被吸顶/固定的东西挡住时，先滚到中间再试一次（用户能滚开就不算）
    let h = hitOk(el, shown(el) || r);
    if (!h.ok) {
      const saved = []; for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) saved.push([p, p.scrollTop, p.scrollLeft]);
      const ss = [document.scrollingElement.scrollTop, document.scrollingElement.scrollLeft];
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const v2 = shown(el); h = v2 ? hitOk(el, v2) : h;
      saved.forEach(([p, t, l]) => { p.scrollTop = t; p.scrollLeft = l; }); document.scrollingElement.scrollTop = ss[0]; document.scrollingElement.scrollLeft = ss[1];
      if (!h.ok) res.obstructed.push(`${desc(el)} 被 ${desc(h.hit)} 挡住`);
    }
    if (!touch) return;
    if (el.tagName === "A" && !el.classList.contains("ts") && el.closest(".md, .tx, p, li")) return; // 段落里的文字链接：WCAG 行内例外
    if (r.width < 24 || r.height < 24) {
      // 间距例外：以中心为圆心、直径 24 的圆不碰到别的目标
      const c = [r.left + r.width / 2, r.top + r.height / 2];
      const bad = rects.some((o, j) => {
        if (j === i) return false;
        const dx = Math.max(o.left - c[0], 0, c[0] - o.right), dy = Math.max(o.top - c[1], 0, c[1] - o.bottom);
        return Math.hypot(dx, dy) < 12;
      });
      if (bad) res.small24.push(`${desc(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    if (r.width < 44 || r.height < 44) res.small44.push(`${desc(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
  });
  return res;
}

const settle = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

async function runState(browser, engine, mode, st, widths, report) {
  const touch = mode === "touch";
  const ctx = await browser.newContext({ viewport: { width: widths[0], height: heightFor(widths[0], mode) }, hasTouch: touch, isMobile: touch,
    deviceScaleFactor: touch ? 2 : 1, reducedMotion: "reduce", locale: "zh-CN" });
  await ctx.addInitScript(() => localStorage.setItem("splitView", "1"));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message || e)));
  await page.goto(BASE + "/" + st.hash, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (st.setup) await st.setup(page);
  const sizes = [...widths.map(w => [w, heightFor(w, mode)]), ...(touch ? LANDSCAPE : [])];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(260); // 分屏切换有 200ms 防抖
    if (st.ensure) { await st.ensure(page).catch(() => {}); await page.waitForTimeout(120); }
    await settle(page);
    const r = await page.evaluate(audit, { hOk: H_SCROLL_OK, touch, scope: st.scope });
    report.push({ engine, mode, state: st.name, w, h, ...r });
    if (AXE_W.includes(w) && h === heightFor(w, mode)) {
      const ax = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()
        .catch(e => ({ violations: [{ id: "axe-error", impact: "critical", help: String(e).slice(0, 120), nodes: [] }] }));
      report.push({ engine, mode, state: st.name, w, h, axe: ax.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, sample: v.nodes.slice(0, 3).map(n => n.target.join(" ")) })) });
    }
  }
  // 直接在这个宽度打开（不是拉伸过来的）也要一致：每 200px 抽查一次
  for (const w of widths.filter((_, i) => i % Math.max(1, Math.round(200 / STEP)) === 0)) {
    await page.setViewportSize({ width: w, height: heightFor(w, mode) });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    if (st.setup) await st.setup(page);
    if (st.ensure) { await st.ensure(page).catch(() => {}); await page.waitForTimeout(150); }
    const r = await page.evaluate(audit, { hOk: H_SCROLL_OK, touch, scope: st.scope });
    report.push({ engine, mode, state: st.name + "@load", w, h: heightFor(w, mode), ...r });
  }
  if (errors.length) report.push({ engine, mode, state: st.name, jsErrors: [...new Set(errors)] });
  await ctx.close();
}

async function runEngine(engine) {
  const browser = await { chromium, webkit }[engine].launch();
  const report = [];
  const jobs = [];
  for (const [mode, widths] of Object.entries(MODES))
    for (const st of STATES) if (!st.only || st.only === mode) jobs.push(() => runState(browser, engine, mode, st, widths, report));
  const N = 5; let k = 0;
  await Promise.all(Array.from({ length: N }, async () => { while (k < jobs.length) { const j = jobs[k++]; await j().catch(e => report.push({ engine, error: String(e).slice(0, 300) })); } }));
  await browser.close();
  fs.mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`./out/report-${engine}.json`, import.meta.url), JSON.stringify(report, null, 1));
  return report;
}

function summarize(engine, report) {
  const hard = { docOverflow: [], hscroll: [], obstructed: [], small24: [], clipped: [], axe: [], jsErrors: [], error: [] };
  const small44 = new Map();
  for (const r of report) {
    const at = `${r.state} ${r.mode} ${r.w}×${r.h}`;
    if (r.error) hard.error.push(r.error);
    if (r.jsErrors) hard.jsErrors.push(`${r.state} ${r.mode}: ${r.jsErrors.join(" | ")}`);
    if (r.axe) for (const v of r.axe) if (["serious", "critical"].includes(v.impact)) hard.axe.push(`${at}: ${v.id}（${v.impact}，${v.n} 处）${v.sample.join(" , ")}`);
    if (r.docOverflow > 1) hard.docOverflow.push(`${at}: 多出 ${r.docOverflow}px`);
    for (const k of ["hscroll", "obstructed", "small24", "clipped"]) for (const x of r[k] || []) hard[k].push(`${at}: ${x}`);
    for (const x of r.small44 || []) { const name = x.replace(/ \d+×\d+$/, ""); if (!small44.has(name)) small44.set(name, x + `（${r.state} ${r.w}px）`); }
  }
  console.log(`\n===== ${engine}：${report.filter(r => !r.axe && !r.jsErrors && !r.error).length} 个页面状态×尺寸 =====`);
  for (const [k, v] of Object.entries(hard)) {
    // 同一个问题在相邻宽度反复出现：按“问题文字”归并，显示出现在哪些宽度
    const groups = new Map();
    for (const x of v) { const i = x.indexOf(": "); const at = x.slice(0, i), msg = x.slice(i + 2).replace(/多出 \d+px/, "多出 Npx"); const g = groups.get(msg) || []; g.push(at); groups.set(msg, g); }
    console.log(`${k}: ${v.length} 次${groups.size ? `，${groups.size} 种` : ""}`);
    [...groups].slice(0, 14).forEach(([msg, ats]) => console.log(`   - ${msg}  ← ${ats.length} 处，如 ${ats.slice(0, 3).join("；")}`));
  }
  console.log(`建议（Apple HIG 44×44，不算失败）：${small44.size} 种控件偏小`);
  [...small44.values()].slice(0, 15).forEach(x => console.log("   · " + x));
  return Object.values(hard).reduce((a, v) => a + v.length, 0);
}

let bad = 0;
for (const e of ENGINES) bad += summarize(e, await runEngine(e));
process.exit(bad ? 1 : 0);
