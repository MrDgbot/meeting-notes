"use strict";
const COLORS = ["#3b6ef5", "#e5484d", "#12a594", "#e38a00", "#8e4ec6", "#0b8fc4", "#d6409f", "#687076", "#5f9e1b", "#c2410c"];
// 线性图标（24 网格）；线宽由 CSS 统一成 1.5px 且不随尺寸缩放，14/16/18px 下粗细一致。
// 值以 "<" 开头的是多段图形：class="mv" 的部分会单独动（箭头、盖子、分隔线）；f: 前缀的是实心
const ICONS = {
  plus: "M12 5v14M5 12h14", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-3.5-3.5",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M3 10h18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4l3 2",
  mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21",
  monitor: "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M21.5 20a6.5 6.5 0 0 0-4-6",
  speech: "M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12z",
  wave: "M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3",
  // 全天模式：中心一点向两侧发散的声波，表示“一直在听”
  radio: "M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8.3 15.7a5.2 5.2 0 0 1 0-7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.5 18.5a9.2 9.2 0 0 1 0-13M18.5 5.5a9.2 9.2 0 0 1 0 13",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  sparkle: "M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z",
  upload: '<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/><path class="mv" d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/>',
  download: '<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/><path class="mv" d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/>',
  chev: "m6 9 6 6 6-6", left: "m15 6-6 6 6 6", right: "m9 6 6 6-6 6",
  refresh: "M20 11a8 8 0 0 0-14.7-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16M20 20v-4h-4",
  trash: '<path d="M6.5 7l1 13h9l1-13"/><path class="mv" d="M4 7h16M9.5 7V4.5h5V7"/>',
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  x: "M6 6l12 12M18 6 6 18", check: "M5 12.5l4.5 4.5L19 7.5",
  copy: "M10 8h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM15 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4",
  // 后退/前进 15 秒：圆弧箭头里写上秒数，和“重新转写”的循环箭头区分开
  back: '<path d="M12 4.5a8 8 0 1 1-8 8"/><path d="M14.5 2 12 4.5 14.5 7"/><text x="12" y="15.6">15</text>',
  fwd: '<path d="M12 4.5a8 8 0 1 0 8 8"/><path d="M9.5 2 12 4.5 9.5 7"/><text x="12" y="15.6">15</text>',
  send: "M5 12h14M13 6l6 6-6 6", text: "M5 6h14M5 12h14M5 18h9", subtitle: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 14h4M14 14h3M7 10h10",
  columns: '<path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path class="mv" d="M12 4v16"/>',
  "f:play": "M8 5.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8A.8.8 0 0 0 8 5.2z",
  "f:pause": "M7 5h3.2v14H7zM13.8 5H17v14h-3.2z", "f:stop": "M7 7h10v10H7z",
};
const ic = (name, cls = "") => {
  const f = ICONS["f:" + name], v = f || ICONS[name] || "";
  return `<svg class="ic i-${name}${f ? " f" : ""}${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${v[0] === "<" ? v : `<path d="${v}"/>`}</svg>`;
};
// 两个图标叠在同一处，按钮加 .alt 时切到第二个（播放/暂停、复制/已复制）：旧的缩小淡出，新的放大淡入
const icSwap = (a, b) => `<span class="swap">${ic(a)}${ic(b)}</span>`;
function flashDone(btn, ms = 1600) { btn.classList.add("alt"); clearTimeout(btn._doneT); btn._doneT = setTimeout(() => btn.classList.remove("alt"), ms); }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTs = ms => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(x).padStart(2, "0"); };
const fmtDur = sec => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60;
  return h ? `${h}小时${m}分` : m ? `${m}分${sec % 60}秒` : `${sec}秒`; };
const tsToSec = t => t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
const STATUS = { new: "未开始", recording: "录音中", queued: "排队中", transcribing: "转写中", ready: "", error: "出错" };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hms = ts => new Date(ts * 1000).toTimeString().slice(0, 8);
const statusTag = m => { const t = m.status === "recording" && m.source === "ambient" ? "记录中" : STATUS[m.status];
  return t ? `<span class="tag ${m.status}">${t}</span>` : ""; };
const autoIc = m => m.source === "ambient" ? `<span class="auto-ic" title="全天模式自动记录">${ic("radio")}</span>`
  : m.source === "upload" ? `<span class="auto-ic" title="上传的文件">${ic("file")}</span>` : "";
const hm = iso => (iso || "").slice(11, 16);

const S = { meetings: [], health: null, cur: null, tab: null, settings: null, filter: "", follow: true,
  split: localStorage.getItem("splitView") !== "0" };
// 在别的设备（平板、手机）上通过局域网打开的
const REMOTE = !["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
const OFFLINE = REMOTE ? "连不上电脑上的会议记录服务（电脑睡眠了、换了网络，或者服务没开）" : "连不上会议记录服务，请确认服务还在运行（./start.sh）";
const TOUCH = matchMedia("(hover: none)").matches;
// 在微信、飞书、钉钉、QQ、支付宝这类应用里扫码打开的：证书提示、录音、下载证书都可能不正常
const IN_APP = (navigator.userAgent.match(/MicroMessenger|Lark|Feishu|DingTalk|AlipayClient|\bQQ\//) || [""])[0]
  .replace("MicroMessenger", "微信").replace(/Lark|Feishu/, "飞书").replace("DingTalk", "钉钉").replace("AlipayClient", "支付宝").replace(/QQ\//, "QQ");
// 录电脑声音要靠屏幕共享，手机和平板的浏览器都不支持
const CAN_SYS = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const CAN_MIC = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// ---------------- 通用 ----------------
// 局域网设备的登录过期了（或者在电脑上点了“让所有设备退出”）：回登录页，登录后回到当前页面
function needLogin(status, data) {
  if (status !== 401 || !data || !data.login) return false;
  location.href = data.login + "?next=" + encodeURIComponent("/" + location.hash);
  return true;
}
async function api(url, opt = {}) {
  const o = { ...opt };
  if (o.body && typeof o.body !== "string" && !(o.body instanceof FormData)) {
    o.body = JSON.stringify(o.body); o.headers = { "Content-Type": "application/json", ...(o.headers || {}) };
  }
  let r;
  try { r = await fetch(url, o); } catch { throw new Error(OFFLINE); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
  if (needLogin(r.status, data)) throw new Error("需要重新登录");
  if (!r.ok) throw new Error((data && data.detail) || `${r.status} ${r.statusText}`);
  return data;
}
async function streamNd(url, body, onEvent) {
  let r;
  try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new Error(OFFLINE); }
  if (!r.ok) {
    let j = null; try { j = await r.json(); } catch {}
    if (needLogin(r.status, j)) throw new Error("需要重新登录");
    throw new Error((j && j.detail) || r.statusText);
  }
  const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}
let toastT;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
}
// 兜底：任何没处理的失败都提示出来，不要点了没反应
window.addEventListener("unhandledrejection", e => {
  const msg = (e.reason && e.reason.message) || String(e.reason || "");
  if (msg) toast("操作失败：" + msg, 5000);
});
// 有没保存的笔记或纪要修改时，关闭/刷新网页前提醒
window.addEventListener("beforeunload", e => {
  if (REC.active || notesDirty || mdEditDirty()) { e.preventDefault(); e.returnValue = ""; }
});
// 表单控件的可读名称（读屏、语音控制、axe 检查都靠它）：label.f 后面的控件自动关联，没有 id 的加 aria-label
function linkLabels(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("label.f").forEach(l => {
    if (l.htmlFor) return;
    let c = l.nextElementSibling;
    if (c && !c.matches("input,select,textarea")) c = c.querySelector("input:not([type=hidden]),select,textarea");
    if (!c) return;
    if (c.id) l.htmlFor = c.id;
    else if (!c.getAttribute("aria-label")) c.setAttribute("aria-label", l.textContent.trim());
  });
}
new MutationObserver(ms => { for (const m of ms) if (m.addedNodes.length) linkLabels(m.target); }).observe(document.body, { childList: true, subtree: true });
// 在应用内置浏览器里打开的：底部常驻提示，引导到系统浏览器
if (IN_APP) {
  const bar = document.createElement("div");
  bar.className = "inapp";
  bar.innerHTML = `<span class="grow">现在是在${IN_APP}里打开的：证书提示、录音都可能不正常。请点右上角“…”，选“在浏览器打开”（iPhone 用 Safari）。</span><button class="sm">知道了</button>`;
  bar.querySelector("button").onclick = () => bar.remove();
  document.body.appendChild(bar);
}
// 弹窗：出现时从 0.97 放大 + 上移一点（不从 0 开始），关闭时先淡出、更快
let modalT;
function modal(html) {
  const m = $("#modal"); clearTimeout(modalT); m.classList.remove("closing");
  SB.bars.forEach(b => b.node.classList.remove("on", "near")); // 背后区域的滑块让位给弹窗
  m.innerHTML = `<div class="dialog">${html}</div>`; m.hidden = false;
  void m.offsetWidth; m.classList.add("show");
  return m.firstElementChild;
}
function closeModal() {
  const m = $("#modal"); if (m.hidden || m.classList.contains("closing")) return;
  m.classList.remove("show"); m.classList.add("closing"); clearTimeout(modalT);
  SB.bars.forEach(b => m.contains(b.el) && b.node.classList.remove("on", "near")); // 滑块跟着弹窗一起退场
  modalT = setTimeout(() => { m.hidden = true; m.innerHTML = ""; m.classList.remove("closing"); SB.bars.forEach(b => b.marks.length && sbShow(b)); }, 200);
}
$("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("#modal").hidden && !e.target.closest(".pe-text")) closeModal();
  else if (document.body.classList.contains("nav-open")) navOpen(false);
});
document.addEventListener("touchstart", () => {}, { passive: true }); // iOS Safari 要有触摸监听，按钮的 :active 按下效果才生效
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------- 窄屏抽屉侧栏 ----------------
// 平板竖屏、手机上侧栏收起来：点左上角菜单拉出，点遮罩、向左滑、按 Esc 或者点了里面的链接就收起
function navOpen(on) {
  document.body.classList.toggle("nav-open", on);
  $("#navBtn").setAttribute("aria-expanded", on ? "true" : "false");
}
const NARROW = matchMedia("(max-width: 899px)");
NARROW.addEventListener("change", () => navOpen(false));
$("#navBtn").onclick = () => navOpen(!document.body.classList.contains("nav-open"));
$("#scrim").onclick = () => navOpen(false);
$("#side").addEventListener("click", e => { if (NARROW.matches && e.target.closest("a[href], #newBtn, #settingsBtn, #recPill")) navOpen(false); });
{
  let x0 = null, y0 = 0;
  $("#side").addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  $("#side").addEventListener("touchend", e => {
    const t = e.changedTouches[0];
    if (x0 !== null && t.clientX - x0 < -60 && Math.abs(t.clientY - y0) < 50) navOpen(false);
    x0 = null;
  }, { passive: true });
}

// ---------------- 悬停共享背景（HoverFill） ----------------
// 同一容器里的相邻项共用一块悬停背景：从一项移到另一项时背景滑过去，而不是一个消失一个出现；
// 从外面移进来时原地从 0.96 淡入。容器会被重新渲染（innerHTML），背景元素会被重新挂回去。
function hoverFill(box, sel) {
  if (!box) return;
  box.classList.add("hfbox"); box._hfSel = sel;
  if (box._hf) return hfSync(box);
  const st = box._hf = { bg: null, on: false, cur: null, t: 0 };
  const getBg = () => {
    if (!st.bg) { st.bg = document.createElement("i"); st.bg.className = "hf"; }
    if (st.bg.parentNode !== box) box.prepend(st.bg);
    return st.bg;
  };
  const place = (it, slide) => {
    const b = getBg(), br = box.getBoundingClientRect(), r = it.getBoundingClientRect();
    const x = r.left - br.left + box.scrollLeft - box.clientLeft, y = r.top - br.top + box.scrollTop - box.clientTop;
    const pos = `translate(${x}px, ${y}px)`;
    if (!slide) { b.style.transition = "none"; b.style.opacity = "0"; b.style.transform = pos + " scale(.96)"; }
    b.style.width = r.width + "px"; b.style.height = r.height + "px"; b.style.borderRadius = getComputedStyle(it).borderRadius;
    if (!slide) { void b.offsetWidth; b.style.transition = ""; }
    b.style.transform = pos; b.style.opacity = "1";
    st.on = true; st.cur = it;
  };
  const hide = () => { if (st.bg) st.bg.style.opacity = "0"; st.on = false; st.cur = null; };
  box.addEventListener("pointerover", e => {
    if (e.pointerType === "touch") return;
    clearTimeout(st.t);
    const it = e.target.closest(box._hfSel);
    if (!it || !box.contains(it) || it.closest(".hfbox") !== box || it.matches(".on.mi")) { st.t = setTimeout(hide, 80); return; }
    if (it !== st.cur || !st.on) place(it, st.on);
  });
  box.addEventListener("pointerleave", () => { clearTimeout(st.t); hide(); });
  Object.assign(st, { place, hide });
}
function hfSync(box) {
  const st = box && box._hf; if (!st) return;
  if (st.bg && st.bg.parentNode !== box) box.prepend(st.bg);
  const it = $$(box._hfSel, box).find(x => x.matches(":hover") && !x.matches(".on.mi"));
  it ? st.place(it, st.on) : st.hide();
}
// 标签页指示条：在选中项之间滑动；重新渲染时直接就位，不做动画
function tabInd(box, animate) {
  if (!box) return;
  let ind = $(".ind", box);
  if (!ind) { ind = document.createElement("i"); ind.className = "ind"; box.appendChild(ind); }
  const on = $("button.on", box); if (!on) return;
  if (!animate) ind.style.transition = "none";
  ind.style.width = on.offsetWidth - 24 + "px"; ind.style.transform = `translateX(${on.offsetLeft + 12}px)`;
  if (!animate) { void ind.offsetWidth; ind.style.transition = ""; }
}
// 下拉菜单：插到 host 里，点外面关闭；菜单项共用悬停背景
function popMenu(host, html) {
  const old = $(".pop", host); if (old) { old.remove(); return null; }
  host.insertAdjacentHTML("beforeend", `<div class="pop">${html}</div>`);
  const pop = $(".pop", host); hoverFill(pop, "a");
  // 默认右对齐按钮；窄屏上左边放不下时改成左对齐，不伸出屏幕
  if (pop.getBoundingClientRect().left < 8) Object.assign(pop.style, { left: "0", right: "auto", transformOrigin: "top left" });
  setTimeout(() => document.addEventListener("click", () => pop.isConnected && pop.remove(), { once: true }));
  return pop;
}

// ---------------- 滚动条 ----------------
// 主要滚动区域的原生滚动条由 CSS 隐藏，这里在区域右侧浮出一根细滑块：
// 鼠标在区域里、或用户正在滚动时出现，离开/停下后淡出；靠近右边缘或拖动时变粗变深；
// 上下留出圆角的距离，不戳出圆角。整页共用一个浮层，区域被重新渲染后旧滑块自动清掉。
const SB_SEL = "#mlist, #main, .pane-body, .tr-scroll, .livebox, .dialog, textarea";
const SB = { bars: new Map(), layer: null, hover: null, drag: null, input: 0, raf: 0, pt: null, px: 0 };
const sbScrollable = el => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
function sbFind(t) {
  for (let el = t && t.closest ? t.closest(SB_SEL) : null; el; el = el.parentElement && el.parentElement.closest(SB_SEL))
    if (sbScrollable(el)) return el;
  return null;
}
function sbBar(el) {
  let b = SB.bars.get(el);
  if (b) return b;
  SB.bars.forEach((x, k) => { if (!k.isConnected) { x.node.remove(); SB.bars.delete(k); } }); // 清掉已被重新渲染掉的区域
  if (!SB.layer) { SB.layer = document.createElement("div"); SB.layer.id = "sbLayer"; document.body.appendChild(SB.layer); }
  const node = document.createElement("div"); node.className = "sb";
  node.innerHTML = `<div class="sb-marks"></div><i class="sb-thumb"></i>`;
  SB.layer.appendChild(node);
  b = { el, node, thumb: node.lastChild, marksBox: node.firstChild, marks: [], markEl: null, t: 0, h: 0, trackH: 0,
    inset: Math.max(4, (parseFloat(getComputedStyle(el).borderTopRightRadius) || 0) * .6) };
  SB.bars.set(el, b);
  b.thumb.addEventListener("pointerdown", e => sbDrag(b, e));
  return b;
}
function sbPlace(b) {
  const el = b.el;
  if (!el.isConnected) { b.node.remove(); SB.bars.delete(el); if (SB.hover === el) SB.hover = null; return false; }
  if (b.marks.length && !(b.markEl && b.markEl.isConnected)) { b.marks = []; b.marksBox.innerHTML = ""; }
  const sh = el.scrollHeight, ch = el.clientHeight, r = el.getBoundingClientRect();
  const top = Math.max(r.top + el.clientTop, 0) + b.inset, bot = Math.min(r.top + el.clientTop + ch, innerHeight) - b.inset;
  const trackH = bot - top, ok = sh > ch + 1 && trackH > 40 && r.width > 0;
  b.node.classList.toggle("none", !ok);
  if (!ok) return false;
  const h = Math.max(28, Math.round(trackH * ch / sh)), y = (trackH - h) * Math.min(1, el.scrollTop / (sh - ch));
  b.trackH = trackH; b.h = h;
  b.node.style.cssText = `transform:translate(${r.left + el.clientLeft + el.clientWidth}px,${top}px);height:${trackH}px`;
  b.thumb.style.cssText = `height:${h}px;transform:translateY(${y}px)`;
  return true;
}
function sbShow(b, hideAfter = 0) {
  clearTimeout(b.t);
  if (!sbPlace(b)) return;
  b.node.classList.add("on");
  if (hideAfter) b.t = setTimeout(() => sbHide(b), hideAfter);
}
function sbHide(b) {
  if (SB.drag === b || SB.hover === b.el || b.marks.length) return;
  b.node.classList.remove("on", "near");
}
const sbHideLater = (b, ms = 700) => { clearTimeout(b.t); b.t = setTimeout(() => sbHide(b), ms); };
const sbBlocked = el => !$("#modal").hidden && !$("#modal").contains(el); // 弹窗打开时，背后的区域不出滑块
function sbFrame() {
  SB.raf = 0;
  if (SB.pt && SB.pt.closest && SB.pt.closest("#sbLayer")) return; // 指针在滑块上：保持当前区域
  const el = SB.pt ? sbFind(SB.pt) : null;
  if (el !== SB.hover) {
    const old = SB.hover && SB.bars.get(SB.hover);
    SB.hover = el;
    if (old) { old.node.classList.remove("near"); sbHideLater(old); }
  }
  if (!el || sbBlocked(el)) return;
  const b = sbBar(el); sbShow(b);
  const edge = el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
  b.node.classList.toggle("near", SB.px > edge - 16 && SB.px <= edge + 2);
}
function sbDrag(b, e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const el = b.el, y0 = e.clientY, s0 = el.scrollTop, k = (el.scrollHeight - el.clientHeight) / Math.max(1, b.trackH - b.h);
  const ac = new AbortController();
  SB.drag = b; b.node.classList.add("drag", "on"); b.thumb.setPointerCapture(e.pointerId);
  b.thumb.addEventListener("pointermove", ev => { el.scrollTop = s0 + (ev.clientY - y0) * k; }, { signal: ac.signal });
  const up = () => { ac.abort(); SB.drag = null; b.node.classList.remove("drag"); if (SB.hover !== el) sbHideLater(b); };
  b.thumb.addEventListener("pointerup", up, { signal: ac.signal });
  b.thumb.addEventListener("pointercancel", up, { signal: ac.signal });
}
// 搜索命中在滑块轨道上标出刻度，一眼看出命中分布在哪；有刻度时滑块常驻
function sbMarks(el, hits) {
  if (!el) return;
  const b = sbBar(el), sh = el.scrollHeight || 1, base = el.getBoundingClientRect().top + el.clientTop - el.scrollTop;
  b.marks = hits.map(h => { const r = h.getBoundingClientRect(); return (r.top + r.height / 2 - base) / sh; });
  b.markEl = hits[0] || null;
  b.marksBox.innerHTML = b.marks.map(f => `<i style="top:${(f * 100).toFixed(2)}%"></i>`).join("");
  b.marks.length ? sbShow(b) : SB.hover !== el && sbHideLater(b, 300);
}
document.addEventListener("pointermove", e => {
  if (e.pointerType === "touch" || SB.drag) return;
  SB.pt = e.target; SB.px = e.clientX;
  if (!SB.raf) SB.raf = requestAnimationFrame(sbFrame);
}, { passive: true });
document.addEventListener("pointerout", e => { if (!e.relatedTarget && !SB.drag) { SB.pt = null; sbFrame(); } }); // 移出窗口
document.addEventListener("scroll", e => {
  const el = e.target;
  if (!(el instanceof Element) || !el.matches(SB_SEL)) return;
  const b = SB.bars.get(el);
  if (b && b.node.classList.contains("on")) { sbPlace(b); if (SB.hover !== el && !SB.drag) sbHideLater(b, 900); }
  else if (performance.now() - SB.input < 600 && !sbBlocked(el)) sbShow(sbBar(el), SB.hover === el ? 0 : 900); // 只对用户滚动出现，自动跟随播放不打扰
}, { capture: true, passive: true });
["wheel", "touchmove", "keydown"].forEach(t => addEventListener(t, () => { SB.input = performance.now(); }, { capture: true, passive: true }));
addEventListener("resize", () => SB.bars.forEach(b => b.node.classList.contains("on") && sbPlace(b)));

// ---------------- Markdown ----------------
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // [12:30] 和 [12:30, 13:05]（有的模型把几处出处写在一个括号里）都拆成一个个能点的时间
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,，、]\s*\d{1,2}:\d{2}(?::\d{2})?)*)\]/g,
      (m, g) => g.split(/\s*[,，、]\s*/).map(t => `<a class="ts" data-ts="${t}">[${t}]</a>`).join(""));
}
function md(src) {
  const L = (src || "").replace(/\r/g, "").split("\n");
  let html = "", para = [], stack = [];
  const flushP = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const closeLists = (lvl = -1) => { while (stack.length && stack[stack.length - 1].indent > lvl) html += `</li></${stack.pop().tag}>`; };
  for (let i = 0; i < L.length; i++) {
    const ln = L[i];
    let m;
    if (/^\s*$/.test(ln)) { flushP(); continue; }
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { flushP(); closeLists(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flushP(); closeLists(); html += "<hr>"; continue; }
    if (/^\s*\|/.test(ln) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      flushP(); closeLists();
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      html += "<table><thead><tr>" + cells(ln).map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < L.length && /^\s*\|/.test(L[i])) { html += "<tr>" + cells(L[i]).map(c => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++; }
      i--; html += "</tbody></table>"; continue;
    }
    if ((m = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushP();
      const indent = m[1].replace(/\t/g, "  ").length, tag = /\d/.test(m[2]) ? "ol" : "ul";
      let text = m[3];
      const top = stack[stack.length - 1];
      if (!top || indent > top.indent) { html += `<${tag}><li>`; stack.push({ indent, tag }); }
      else { closeLists(indent); const t2 = stack[stack.length - 1];
        if (t2 && t2.indent === indent) html += "</li><li>"; else { html += `<${tag}><li>`; stack.push({ indent, tag }); } }
      text = inline(text).replace(/^\[( |x|X)\]\s*/, (_, c) => `<input type="checkbox" class="cb" disabled ${c.trim() ? "checked" : ""}>`);
      html += text; continue;
    }
    if ((m = ln.match(/^>\s?(.*)$/))) { flushP(); closeLists(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (stack.length && /^\s{2,}\S/.test(ln)) { html += "<br>" + inline(ln.trim()); continue; }
    closeLists(); para.push(ln);
  }
  flushP(); closeLists();
  return html;
}

// ---------------- 侧栏 ----------------
async function loadMeetings() {
  try { S.meetings = await api("/api/meetings"); } catch { return; } // 服务断开时左下角会提示，这里不重复报错
  renderSide();
}
function renderSide() {
  const q = S.filter.trim().toLowerCase();
  // 搜索标题和内容（转写、笔记、纪要）：内容命中由服务端算，返回前先按标题过滤
  const hits = q && S.searchQ === q ? S.searchHits : null;
  const list = S.meetings.filter(m => !q || m.title.toLowerCase().includes(q) || (hits && hits[m.id]));
  const groups = {};
  const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
  for (const m of list) {
    const d = new Date(m.created), k = d.toDateString() === today ? "今天" : d.toDateString() === yest ? "昨天" : `${d.getMonth() + 1}月${d.getDate()}日`;
    (groups[k] = groups[k] || Object.assign([], { date: ymd(d) })).push(m);
  }
  const curId = S.cur && S.cur.meta.id;
  $("#mlist").innerHTML = Object.entries(groups).map(([k, ms]) => `<div class="group-h"><span>${k}</span><a href="#/day/${ms.date}" title="查看这一天的时间线和汇总">当日汇总</a></div>` + ms.map(m => `
    <a class="mi ${m.id === curId ? "on" : ""}" href="#/m/${m.id}">
      <div class="t"><span class="tt">${esc(m.title)}</span>${statusTag(m)}</div>
      <div class="s"><span class="num">${new Date(m.created).toTimeString().slice(0, 5)}</span><span>·</span><span>${fmtDur(m.source === "ambient" ? m.speech_s : m.duration)}</span>${autoIc(m)}</div>
      ${hits && hits[m.id] && hits[m.id].snippet ? `<div class="s snip">${hits[m.id].hits > 1 ? `<b class="num">${hits[m.id].hits} 处</b> ` : ""}${hl(hits[m.id].snippet, S.filter.trim())}</div>` : ""}
    </a>`).join("")).join("") || `<div class="muted small" style="padding:10px">还没有会议</div>`;
  if (q && !list.length) $("#mlist").innerHTML = `<div class="muted small" style="padding:10px">${hits ? "没有找到相关的会议" : "搜索中…"}</div>`;
  hoverFill($("#mlist"), ".mi");
  renderPill();
}
const hl = (s, q) => q ? s.split(q).map(esc).join(`<mark>${esc(q)}</mark>`) : esc(s);
function renderPill() {
  const pill = $("#recPill"), tb = $("#tbRec");
  if (REC.active) {
    pill.hidden = false;
    pill.innerHTML = `<span class="recdot${REC.paused ? " paused" : ""}" style="width:8px;height:8px;flex-basis:8px"></span><span class="grow">${REC.paused ? "已暂停" : "录音中"} <span class="num">${fmtTs(REC.elapsedMs())}</span></span><span>返回</span>`;
    pill.onclick = () => location.hash = "#/m/" + REC.mid;
    // 窄屏时侧栏收着：顶栏上也显示录音时长，点一下回录音页
    tb.hidden = false; tb.href = "#/m/" + REC.mid;
    tb.innerHTML = `<span class="recdot${REC.paused ? " paused" : ""}" style="width:7px;height:7px;flex-basis:7px"></span><span class="num">${fmtTs(REC.elapsedMs())}</span>`;
  }
  else { pill.hidden = true; tb.hidden = true; }
}
setInterval(renderPill, 1000);
const searchContent = debounce(async q => {
  let r; try { r = await api("/api/search?q=" + encodeURIComponent(q)); } catch { return; }
  if (S.filter.trim().toLowerCase() !== q.toLowerCase()) return;
  S.searchQ = q.toLowerCase(); S.searchHits = Object.fromEntries(r.map(x => [x.id, x])); renderSide();
}, 250);
$("#searchMeetings").oninput = e => { S.filter = e.target.value; const q = S.filter.trim(); q && searchContent(q); renderSide(); };
// 回首页：点左上角的名称或“新建会议”。已经在首页时 hash 不变、不会触发路由，手动刷新一下
function goHome(e) {
  e && e.preventDefault();
  if (location.hash === "#/" || location.hash === "") route(); else location.hash = "#/";
}
$("#newBtn").onclick = goHome;
$("#homeLink").onclick = goHome;
$("#tbHome").onclick = goHome;
$("#tbNew").onclick = goHome;
$("#settingsBtn").onclick = openSettings;

async function pollHealth() {
  clearTimeout(S.healthT);
  let h = null;
  try { h = await api("/api/health"); } catch {}
  const b = $("#asrBadge");
  b.onclick = null; b.classList.remove("act");
  if (!h) {
    b.className = "badge err"; b.textContent = "服务未连接"; b.title = OFFLINE + "；连上后自动恢复";
    S.healthT = setTimeout(pollHealth, 3000); return;
  }
  const was = S.health; S.health = h;
  if (h.asr_loading || (!h.asr_ready && !h.asr_error)) {
    b.className = "badge"; b.textContent = "语音模型加载中…"; b.title = "";
  } else if (h.asr_error) {
    b.className = "badge err act"; b.textContent = "语音模型加载失败 · 重试"; b.title = h.asr_error + "\n点击重新加载";
    b.onclick = async () => { b.textContent = "重新加载中…"; try { await api("/api/asr/reload", { method: "POST" }); } catch (e) { toast(e.message); } pollHealth(); };
    if (!was || !was.asr_error) toast("语音模型加载失败：" + h.asr_error.slice(0, 120) + "。点左下角“重试”", 8000);
  } else if (h.asr_note) {
    b.className = "badge warn"; b.textContent = h.asr_note.startsWith("正在") ? "正在加载 Nano…" : "Nano 未加载 · 暂用 Paraformer"; b.title = h.asr_note;
  } else {
    b.className = "badge ok"; b.textContent = "语音模型就绪 · " + h.device.toUpperCase(); b.title = "";
  }
  if (was && !was.asr_ready && h.asr_ready && S.cur) showMeeting(S.cur.meta.id); // 模型好了：出错的记录会自动重新转写
  S.healthT = setTimeout(pollHealth, h.asr_ready && !h.asr_note ? 15000 : 2000); // 一直检查：服务断开、模型出错都能看到
}
// ---------------- 全天模式 ----------------
const AMB_TXT = { off: "已关闭", starting: "等待语音模型就绪…", listening: "正在听 · 没人说话时不录音", speech: "有人在说话，正在记录",
  held: "手动录音中，自动记录已暂停" };
let ambSig = "";
// 网页可见时走 WebSocket 推送：开口约 0.6 秒内显示“有人在说话”，说话过程中每秒出临时文字。
// 推送断开或网页在后台时退回轮询（可见 2 秒、后台 8 秒）
let ambWS = null, ambLive = false;
function ambConnect() {
  if (ambWS || document.visibilityState !== "visible") return;
  let ws;
  try { ws = ambWS = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ambient`); } catch { ambWS = null; return; }
  ws.onmessage = e => { if (ambWS !== ws) return; ambLive = true; onAmb(JSON.parse(e.data)); };
  ws.onclose = () => { if (ambWS === ws) { ambWS = null; ambLive = false; setTimeout(ambConnect, 3000); } };
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") return ambConnect();
  if (ambWS) { const ws = ambWS; ambWS = null; ambLive = false; ws.close(); }
});
async function pollAmbient() {
  if (!ambLive) {
    let a = null;
    try { a = await api("/api/ambient"); } catch { S.amb = null; renderAmb(); }
    if (a && !ambLive) onAmb(a);
  }
  const a = S.amb;
  setTimeout(pollAmbient, ambLive ? 5000 : a && a.enabled && document.visibilityState === "visible" ? 2000 : 8000);
}
function onAmb(a) {
  const prev = S.amb; S.amb = a;
  const sig = (a.conv ? a.conv.id : "") + "|" + a.today.count;
  if (sig !== ambSig) { const first = !ambSig; ambSig = sig; if (!first && !REC.active) loadMeetings(); }
  renderAmb();
  // 正在看的这段对话：有新定稿的句子就立即刷新；对话结束了也立即刷新（转为“排队转写”）
  const id = S.cur && S.cur.meta.id;
  // 正在看的这段因为发言太短被丢弃了：告诉用户，而不是只显示“会议不存在”
  if (a.discarded && a.discarded.at !== S.discardSeen) {
    S.discardSeen = a.discarded.at;
    if (location.hash.startsWith("#/m/" + a.discarded.id)) return showDiscarded(a.discarded);
  }
  if (!id || !location.hash.startsWith("#/m/" + id)) return;
  const was = prev && prev.conv && prev.conv.id === id, now = a.conv && a.conv.id === id;
  if ((now && prev && prev.live_rev !== a.live_rev) || (was && !now)) refreshLive(id);
  else if (now) renderPartial();
}
function showDiscarded(x) {
  clearTimeout(pollT); S.cur = null;
  $("#main").innerHTML = `<div class="wrap"><div class="empty">这段对话能认出字的发言只有 ${x.voiced_s} 秒，不足 ${x.min_s} 秒，已按设置自动丢弃（没有写笔记、没改过标题的短对话不保存）。
    <div style="margin-top:12px"><a class="btn" href="#/">回到首页</a> <a class="btn" id="dSet">调整“发言少于多少秒不保存”</a></div></div></div>`;
  $("#dSet").onclick = openSettings;
  renderSide();
}
// 结束正在记录的这段：发言太短、又没写东西的话会被丢弃，先问一句
function confirmSplit() {
  const a = S.amb, c = a && a.conv; if (!c) return true;
  const d = S.cur && S.cur.meta.id === c.id ? S.cur : null;
  const typed = $("#notes") ? $("#notes").value : d && d.notes; // 刚写的笔记可能还没自动保存
  const mine = d && ((typed || "").trim() || d.minutes || (d.qa || []).length || d.meta.title_auto === false);
  if (mine || c.voiced_s >= a.cfg.min_speech_s) return true;
  return confirm(`这段能认出字的发言只有 ${c.voiced_s} 秒，不足 ${a.cfg.min_speech_s} 秒，结束后不会保存。确定结束？`);
}
function renderAmb() {
  const box = $("#ambCard"), a = S.amb;
  $("#navBtn").dataset.amb = a && a.enabled ? a.state : ""; // 侧栏收起时，菜单按钮上的小圆点显示全天模式状态
  if (!a) { box.innerHTML = ""; ambCardSig = ""; return; }
  const lvl = Math.max(0, Math.min(100, (a.level_db + 70) / 55 * 100));
  // 推送很频繁（音量每 0.3 秒变一次）：只有状态变了才重建卡片，否则原地更新音量条和字幕，不打断悬停和点击
  const sig = JSON.stringify([a.enabled, a.state, a.error, a.fallback, a.paused_until, a.conv && [a.conv.id, a.conv.speech_s], a.today]);
  if (sig === ambCardSig || $(".pop", box)) { // 菜单打开时也不重建
    const m = $(".amb-meter i", box); m && (m.style.width = lvl + "%");
    ambCaption(box, a);
    return;
  }
  ambCardSig = sig;
  const on = a.enabled;
  let line = AMB_TXT[a.state] || a.state;
  if (a.state === "paused") line = a.paused_until === -1 ? "已暂停，麦克风已关闭" : `已暂停到 ${new Date(a.paused_until * 1000).toTimeString().slice(0, 5)}，麦克风已关闭`;
  if (a.state === "error") line = a.error.startsWith("语音模型") ? a.error + "（点左下角“重试”）" : "出错，自动重试中：" + a.error;
  if (a.fallback && ["listening", "speech"].includes(a.state)) line += ` · ${a.fallback}未连接，暂用电脑麦克风`;
  box.className = "amb " + (on ? "on " + a.state : "off");
  box.innerHTML = `<div class="row" style="gap:8px"><span class="adot"></span><b class="grow">全天模式</b>
      <label class="switch" title="${on ? "关闭" : "开启"}全天模式"><input type="checkbox" id="ambSw" ${on ? "checked" : ""}><i></i></label></div>
    <div class="small aline" data-line="${esc(on ? line : "自动记录身边的对话，有人说话才录音")}">${esc(on ? line : "自动记录身边的对话，有人说话才录音")}</div>
    ${on ? `${["listening", "speech"].includes(a.state) ? `<div class="meter amb-meter"><i style="width:${lvl}%"></i></div>` : ""}
      ${a.conv ? `<a class="small aconv" href="#/m/${a.conv.id}"><span class="rdot"></span>当前对话 <span class="num">${hms(a.conv.started).slice(0, 5)}</span> 起 · 发言 ${fmtDur(a.conv.speech_s)}</a>` : ""}
      <div class="row small" style="gap:6px;margin-top:8px;flex-wrap:nowrap"><a href="#/day/${a.today.date}" class="grow muted">今天 ${a.today.count} 段 · 发言 ${fmtDur(a.today.speech_s)}</a>
        ${a.state === "paused" ? `<button class="sm" id="ambResume">恢复</button>` : a.state !== "held" ? `<div class="menu"><button class="sm lt" id="ambPause">暂停 ${ic("chev")}</button></div>` : ""}</div>` : ""}`;
  $("#ambSw").onchange = e => toggleAmb(e.target.checked);
  $("#ambResume") && ($("#ambResume").onclick = () => ambAct({ action: "resume" }));
  $("#ambPause") && ($("#ambPause").onclick = e => {
    e.stopPropagation();
    const menu = e.currentTarget.parentElement;
    const pop = popMenu(menu, [[30, "30 分钟"], [60, "1 小时"], [120, "2 小时"], [0, "直到我恢复"]]
      .map(([n, t]) => `<a data-min="${n}">${ic("clock")}暂停 ${t}</a>`).join("") + (a.conv ? `<a data-split="1">${ic("x")}现在结束当前这段对话</a>` : ""));
    pop && $$("a", pop).forEach(x => x.onclick = () => {
      pop.remove();
      if (x.dataset.split && !confirmSplit()) return;
      ambAct(x.dataset.split ? { action: "split" } : { action: "pause", minutes: +x.dataset.min });
    });
  });
  ambCaption(box, a);
}
// 卡片第二行：说话过程中显示正在识别的文字（黑色），说完后留最近一句 20 秒（灰色），没有时显示状态。
// 只有一行：太长时右对齐只露出最新的字，左边渐隐
function ambCaption(box, a) {
  const el = $(".aline", box); if (!el) return;
  const cap = a.enabled && ["listening", "speech"].includes(a.state) ? (a.partial || a.last || "") : "";
  const key = cap && (a.partial ? "p" : "l") + cap;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.classList.toggle("cap", !!cap); el.classList.toggle("now", !!a.partial); el.classList.remove("ovf");
  el.innerHTML = cap ? `<span>${esc(cap.slice(-80))}</span>` : esc(el.dataset.line);
  if (cap && el.scrollWidth > el.clientWidth + 1) el.classList.add("ovf");
}
let ambCardSig = "";
async function ambAct(body) {
  try { S.amb = await api("/api/ambient", { method: "POST", body }); } catch (e) { toast(e.message); ambCardSig = ""; } // 失败时重画，开关回到实际状态
  renderAmb();
  if (body.action === "split") setTimeout(loadMeetings, 800);
}
async function toggleAmb(on) {
  const a = S.amb;
  if (on && !localStorage.getItem("ambIntro")) {
    const ok = await new Promise(res => {
      const dlg = modal(`<h2>开启全天模式</h2>
        <ul class="intro">
          <li>后台直接用电脑麦克风持续监听，<b>不需要开着网页</b>；只有检测到有人说话才录音和转写，没人说话时不保存任何声音。</li>
          <li>静音超过 ${a.cfg.split_min} 分钟自动结束一段对话，随后精准转写并区分说话人；发言不足 ${a.cfg.min_speech_s} 秒的片段直接丢弃（写过笔记、改过标题的会保留）。</li>
          <li>${a.cfg.summary_time ? `每天 ${a.cfg.summary_time} 自动生成当日汇总（需在设置里配好 AI 模型的 API Key）` : "可以在“当日汇总”页面一键生成当天的工作汇总"}。</li>
          <li>没人说话时约占单核 3% CPU。开启期间电脑不会自动休眠（屏幕照常熄灭）；合上盖子用电池时电脑会休眠，记录随之暂停。</li>
          <li>菜单栏会一直显示橙色麦克风图标。需要隐私时点“暂停”，麦克风会立即关闭。<b>请告知身边的人正在录音</b>，并遵守所在单位的规定。</li>
        </ul>
        <div class="row" style="justify-content:flex-end"><button id="aNo">取消</button><button class="pri" id="aYes">开启</button></div>`);
      $("#aNo", dlg).onclick = () => { closeModal(); res(false); };
      $("#aYes", dlg).onclick = () => { closeModal(); res(true); };
    });
    if (!ok) { ambCardSig = ""; return renderAmb(); } // 取消：开关拨回“关”
    localStorage.setItem("ambIntro", "1");
  }
  await ambAct({ action: on ? "start" : "stop" });
  if (on) toast("全天模式已开启");
}

// ---------------- 录音 ----------------
const MIC_OPTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };
async function getSysAudio() {
  const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include" });
  if (!disp.getAudioTracks().length) { disp.getTracks().forEach(t => t.stop());
    throw new Error("没有拿到电脑声音：共享时请选择“整个屏幕”或“标签页”，并勾选“共享音频”"); }
  disp.getVideoTracks().forEach(t => t.stop());
  return disp;
}
// 录音链路（手机、平板上网络会断）：每块 100ms（3200 字节）按顺序发，没被电脑确认的块留在内存里；
// 断线后带同一个录音编号重连，电脑告诉这边已经存到哪，从那里补发。缓存上限 15 分钟，和电脑等重连的时间一致。
const CHUNK = 3200, BUF_MAX = 15 * 60 * 10;
const GAP_TEXT = { hidden: "页面在后台或锁屏了", interrupted: "被系统打断（来电、Siri 或别的应用在用麦克风）", muted: "麦克风没有声音（可能被别的应用占用）",
  overflow: "和电脑断开太久，超出了这台设备能暂存的 15 分钟", stall: "浏览器暂停了收音" };
const wsUrl = path => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
const newRecId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 20);
const REC = {
  active: false, paused: false, mid: null, ws: null, ctx: null, streams: [], samples: 0, offsetMs: 0, finals: [], partial: null,
  level: 0, onUpdate: null, node: null, ctx0: null, wake: null,
  lost: null, // 音频源断了：mic = 麦克风断开（耳机断连、拔掉 USB 麦克风），sys = 电脑声音停止共享
  // 传输
  rec: null, buf: [], base: 0, next: 0, sent: 0, startBytes: 0, conn: "ok", retry: 0, retryT: null, flushT: null,
  dropped: 0, overflow: null, stopping: false, stopRes: null, stopSentOn: null, ctl: [], timers: [],
  // 缺口：多久没收到声音、为什么
  lastChunk: 0, stall: null, flags: {}, gaps: [],
  elapsedMs() { return this.offsetMs + this.samples / 16; },
  pendingSec() { return (this.next - this.base) / 10; },
  // iPhone / iPad 的 Safari 只允许在点击的那一刻启动声音处理，等拿到麦克风、连上服务后再建会一直是暂停状态：
  // 点“开始录音”时先建好，start() 里接着用
  prime() {
    if (this.active || this.ctx0) return;
    try { this.ctx0 = new AudioContext(); this.ctx0.resume().catch(() => {}); } catch { this.ctx0 = null; }
  },
  dropCtx0() { try { this.ctx0 && this.ctx0.close(); } catch {} this.ctx0 = null; },
  // 录音时不让屏幕自动锁上（手机锁屏后浏览器就收不到声音了）；切回页面时系统会收回，要重新申请
  async keepAwake() {
    if (!this.active || this.wake || !navigator.wakeLock || document.visibilityState !== "visible") return;
    try { this.wake = await navigator.wakeLock.request("screen"); this.wake.onrelease = () => { this.wake = null; }; } catch { this.wake = null; }
  },
  emit(type) { this.onUpdate && this.onUpdate(type); },
  async start(mid, source) {
    if (this.active || this.stopping) throw new Error("已有会议在录音");
    if (!CAN_MIC) { this.dropCtx0(); throw new Error(window.isSecureContext ? "这个浏览器不支持录音" : "要用 https 地址打开才能录音"); }
    const streams = [];
    try {
      streams.push(await navigator.mediaDevices.getUserMedia(MIC_OPTS));
      if (source === "mix" && CAN_SYS) streams.push(await getSysAudio());
    } catch (e) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); this.dropCtx0(); throw e.name === "NotAllowedError" ? new Error("没有获得麦克风/屏幕共享权限") : e; }
    Object.assign(this, { mid, rec: newRecId(), buf: [], base: 0, next: 0, sent: 0, conn: "ok", retry: 0, dropped: 0, overflow: null,
      stopping: false, stopSentOn: null, ctl: [], gaps: [], flags: {}, stall: null, lastChunk: 0, samples: 0, finals: [], partial: null, lost: null,
      clock: null, muted: null });
    try { await this.connect(true); }
    catch (e) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); try { this.ws && this.ws.close(); } catch {} this.ws = null; this.dropCtx0(); throw e; }

    const ctx = this.ctx0 && this.ctx0.state !== "closed" ? this.ctx0 : new AudioContext();
    this.ctx0 = null;
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule("/static/pcm-worklet.js?v=" + Date.now());
    const node = new AudioWorkletNode(ctx, "pcm16k", { channelCount: 1, channelCountMode: "explicit" });
    for (const s of streams) ctx.createMediaStreamSource(s).connect(node);
    const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
    // Safari 被来电、Siri 打断时状态是 interrupted，别的浏览器是 suspended
    ctx.onstatechange = () => { if (this.active && ctx.state !== "running") this.flags.interrupted = true; };
    node.port.onmessage = e => this.onChunk(e.data);
    Object.assign(this, { active: true, paused: false, ctx, node, streams });
    streams.forEach((s, i) => this.watch(s, i ? "sys" : "mic"));
    // 多久没收到声音：超过 1.5 秒就在录音页提示（锁屏、被打断时浏览器不再送声音过来）
    this.timers = [setInterval(() => this.checkStall(), 500), setInterval(() => this.sendCtl(this.stat(), true), 5000)];
    window.onbeforeunload = () => "正在录音，确定离开？";
    this.keepAwake();
  },
  // 收到一块声音。两种“没录到”分开算：
  // - 音频时钟停了（被来电/Siri 打断、页面被系统挂起）：音频时钟和真实时间的差突然变大并且一直大 → 缺口；
  //   只是消息晚到（后台页面被节流）时差会回落，不算缺口，所以要多看 2 秒再下结论；
  // - 麦克风静音（被别的应用占用、后台）：音频时钟还在走，收到的是静音，按静音开始/结束的时间记缺口。
  onChunk({ pcm, level, frame, rate }) {
    const now = performance.now();
    this.level = level;
    if (frame !== undefined) {
      const off = now - frame / rate * 1000;
      const c = this.clock || (this.clock = { base: off, cand: null });
      const d = off - c.base;
      if (c.cand) {
        c.cand.min = Math.min(c.cand.min, d);
        // 看 2 秒（真实时间）：消息积压时这 2 秒里会一口气到齐，差值回落；真停过的话差值一直在
        if (now - c.cand.t >= 2000 && ++c.cand.n >= 5) {
          if (c.cand.min > 1200) { this.addGap(c.cand.min, c.cand.reason, c.cand.at); c.base += c.cand.min; }
          c.cand = null;
        }
      } else if (d > 1200 && this.active) c.cand = { t: now, at: this.elapsedMs(), min: d, n: 0, reason: this.gapReason() };
      else if (d > 0 && d < 300) c.base += d * 0.05; // 音频硬件时钟和系统时钟的微小漂移
    }
    this.lastChunk = now;
    if (!document.hidden) this.flags = {};
    if (this.stall) { this.stall = null; this.emit("lost"); }
    if (this.active && !this.paused) {
      if (this.next - this.base >= BUF_MAX) { // 缓存满了：先不收，恢复后记一个缺口
        this.dropped += CHUNK;
        if (!this.overflow) this.overflow = { t: now, at: this.elapsedMs() };
      } else {
        if (this.overflow) { this.addGap(now - this.overflow.t, "overflow", this.overflow.at); this.overflow = null; }
        this.buf.push(pcm); this.next++; this.samples += 1600;
        this.flush();
      }
    }
    this.emit("tick");
  },
  gapReason() {
    return document.hidden || this.flags.hidden ? "hidden" : this.flags.interrupted ? "interrupted" : this.flags.muted ? "muted" : "stall";
  },
  addGap(ms, reason, at) {
    at = Math.round(at ?? this.elapsedMs());
    // 同一处既停了时钟又静了音（iPhone 切到后台时两样都会发生）：合成一个
    const same = this.gaps.find(g => Math.abs(g.at_ms - at) < 1500);
    if (same) { if (ms > same.dur_ms) { same.dur_ms = Math.round(ms); this.sendCtl({ ...same }); } return; }
    const g = { type: "gap", at_ms: at, dur_ms: Math.round(ms), reason };
    this.gaps.push(g); this.sendCtl(g);
    this.emit("gap");
    if (!document.hidden) toast(`刚才有 ${Math.max(1, Math.round(ms / 1000))} 秒没录到：${GAP_TEXT[reason]}。转写稿里会标出这一段。`, 6000);
  },
  checkStall() {
    // 连接“假活”（手机换了网络，旧连接成了黑洞，浏览器察觉不到）：8 秒没收到电脑的确认就主动断开重连
    if (this.conn === "ok" && this.ws && this.ws.readyState === 1 && performance.now() - this.lastAck > 8000) {
      const ws = this.ws; this.ws = null;
      try { ws.close(); } catch {}
      this.conn = "reconnecting"; this.stopSentOn = null; this.emit("conn"); this.scheduleReconnect(true);
    }
    if (!this.active || this.paused || !this.lastChunk || this.stall) return;
    if (performance.now() - this.lastChunk > 1500) { this.stall = { reason: this.gapReason() }; this.emit("lost"); }
  },
  stat() { return { type: "stat", produced: this.next * CHUNK + this.dropped, dropped: this.dropped }; },
  // 控制消息：连着就发，断着就排队（统计只留最新一条）
  sendCtl(msg, replace) {
    if (replace) this.ctl = this.ctl.filter(m => m.type !== msg.type);
    this.ctl.push(msg); this.flushCtl();
  },
  flushCtl() {
    const ws = this.ws; if (!ws || ws.readyState !== 1 || this.conn !== "ok") return;
    while (this.ctl.length) ws.send(JSON.stringify(this.ctl.shift()));
  },
  flush() {
    clearTimeout(this.flushT);
    const ws = this.ws; if (!ws || ws.readyState !== 1 || this.conn !== "ok") return;
    while (this.sent < this.next && ws.bufferedAmount < 256 * 1024) { ws.send(this.buf[this.sent - this.base]); this.sent++; }
    if (this.sent < this.next) this.flushT = setTimeout(() => this.flush(), 100);
    else if (this.stopping) this.sendStop();
  },
  ackTo(bytes) {
    const idx = Math.min(this.next, Math.floor(bytes / CHUNK));
    if (idx > this.base) { this.buf.splice(0, idx - this.base); this.base = idx; }
    if (this.sent < this.base) this.sent = this.base;
  },
  connect(first) {
    const ws = new WebSocket(wsUrl(`/ws/live/${this.mid}?rec=${this.rec}`));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    return new Promise((res, rej) => {
      let ok = false;
      ws.onmessage = ev => {
        if (this.ws !== ws) return;
        const j = JSON.parse(ev.data);
        if (j.type === "ready") { ok = true; this.onReady(j, first); res(); }
        else if (j.type === "stopped") { ok = true; res(); this.onStopped(j); }
        else if (j.type === "error" && !ok) rej(Object.assign(new Error(j.msg), { code: j.code }));
        else if (j.type === "status") toast(j.msg);
        else this.onMsg(j);
      };
      // iPhone / iPad 没装好电脑的证书时，Safari 可能直接断开这个连接
      ws.onerror = () => { if (!ok) rej(new Error(REMOTE && /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && "ontouchend" in document
        ? "实时转写连接失败。iPhone / iPad 上要先安装并信任电脑的证书（电脑上“设置 · 平板、手机访问”里有步骤）" : "连接服务失败")); };
      ws.onclose = () => { if (!ok) rej(new Error("连接已关闭")); else this.onClose(ws); };
    });
  },
  onReady(j, first) {
    if (first) { this.offsetMs = j.offset_ms; this.startBytes = j.start_bytes; }
    this.ackTo(j.file_bytes - this.startBytes);
    this.sent = this.base; // 没确认的全部重发（服务端已经按落盘位置去重）
    const was = this.conn; this.conn = "ok"; this.retry = 0; this.lastAck = performance.now();
    this.flushCtl(); this.flush();
    if (this.stopping) this.sendStop();
    if (!first && was !== "ok") { this.emit("conn"); toast(j.resumed ? "已重新连上电脑，断开期间的录音已补传" : "已重新连上电脑"); }
  },
  onMsg(j) {
    if (j.type === "ack") { this.lastAck = performance.now(); this.ackTo(j.bytes); this.emit("ack"); return; }
    if (j.type === "end_requested") { toast("在别的设备上点了结束录音"); this.stop().then(() => this.emit("closed")); return; }
    if (j.type === "partial") this.partial = j;
    else if (j.type === "final") { this.finals.push(j); this.partial = null; }
    else if (j.type === "error") toast(j.msg, 5000);
    this.emit(j.type);
  },
  onClose(ws) {
    if (ws !== this.ws || (!this.active && !this.stopping)) return;
    this.conn = "reconnecting"; this.stopSentOn = null; this.emit("conn");
    this.scheduleReconnect();
  },
  scheduleReconnect(now) {
    clearTimeout(this.retryT);
    if (this.conn !== "reconnecting") return;
    const delay = now ? 0 : [500, 1000, 2000, 3000, 5000][Math.min(this.retry, 4)];
    this.retryT = setTimeout(async () => {
      this.retry++;
      try { await this.connect(false); }
      catch (e) {
        if (e.code === "busy" || e.code === "gone") { toast(e.message + "，这里的录音停止了", 8000); this.cleanup(); this.emit("closed"); return; }
        this.scheduleReconnect();
      }
    }, delay);
  },
  onStopped(j) {
    // 正常结束；或者电脑那边已经结束了这次录音（断开超过 15 分钟 / 在别处点了结束）
    const lost = Math.max(0, this.startBytes + this.next * CHUNK - (j.file_bytes ?? this.startBytes + this.next * CHUNK));
    if (j.already && lost >= CHUNK) toast(`电脑那边已经结束了这次录音，最后 ${Math.round(lost / 32000)} 秒没能传上`, 8000);
    const r = this.stopRes; this.stopRes = null;
    if (r) r({ lost });
    else { this.cleanup(); this.emit("closed"); }
  },
  // 盯住音频源：断开时录音页显示醒目的提示和“重新连接”按钮，而不是继续显示“正在录音”
  watch(s, kind) {
    s.getTracks().forEach(t => {
      t.onended = () => {
        if (!this.active) return;
        this.lost = kind; this.emit("lost");
        toast(kind === "sys" ? "电脑声音已断开（停止了共享），现在只录麦克风" : "麦克风断开了，现在录不到声音", 6000);
      };
      if (kind !== "mic") return;
      t.onmute = () => {
        this.flags.muted = true;
        if (this.active && !this.paused) this.muted = { t: performance.now(), at: this.elapsedMs(), hidden: document.hidden };
        clearTimeout(this.muteT); this.muteT = setTimeout(() => { if (this.active && t.muted && !this.lost) { this.lost = "mic"; this.emit("lost"); } }, 3000);
      };
      t.onunmute = () => {
        clearTimeout(this.muteT);
        this.endMute();
        if (this.lost === "mic" && t.readyState === "live") { this.lost = null; this.emit("lost"); }
      };
    });
  },
  endMute() {
    const m = this.muted; this.muted = null;
    if (m && performance.now() - m.t > 1500) this.addGap(performance.now() - m.t, m.hidden || document.hidden || this.flags.hidden ? "hidden" : "muted", m.at);
  },
  async reconnect() {
    const kind = this.lost; if (!kind || !this.active) return;
    let s;
    try { s = kind === "sys" ? await getSysAudio() : await navigator.mediaDevices.getUserMedia(MIC_OPTS); }
    catch (e) { throw e.name === "NotAllowedError" ? new Error("没有获得麦克风/屏幕共享权限") : e; }
    this.ctx.createMediaStreamSource(s).connect(this.node);
    this.streams.push(s); this.watch(s, kind);
    this.lost = null; this.emit("lost");
  },
  // 被打断后（来电结束、从后台切回来）声音处理可能还停着：在点击里恢复
  async wakeAudio() {
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    const mic = this.streams[0] && this.streams[0].getAudioTracks()[0];
    if (mic && mic.readyState === "ended" && !this.lost) { this.lost = "mic"; this.emit("lost"); }
  },
  pause() { this.paused = true; },
  resume() { this.paused = false; this.lastChunk = performance.now(); },
  // 结束：先停收音，再把还没传上的传完，最后告诉电脑结束（断着就等重连）。giveUp() 可以不等了
  async stop() {
    if (!this.active) return { lost: 0 };
    this.active = false; this.stopping = true;
    this.timers.forEach(clearInterval); this.timers = [];
    if (this.overflow) { this.addGap(performance.now() - this.overflow.t, "overflow", this.overflow.at); this.overflow = null; }
    this.endMute();
    this.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    try { await this.ctx.close(); } catch {}
    this.emit("conn");
    this.timers = [setInterval(() => this.checkStall(), 1000)];
    const r = await new Promise(res => { this.stopRes = res; this.flush(); this.sendStop(); });
    this.cleanup();
    return r;
  },
  sendStop() {
    const ws = this.ws;
    if (!this.stopping || this.conn !== "ok" || !ws || ws.readyState !== 1 || this.sent < this.next || this.stopSentOn === ws) return;
    this.stopSentOn = ws;
    this.flushCtl();
    ws.send(JSON.stringify({ ...this.stat(), type: "stop" }));
    // 回执丢了也不要一直等：已经全部发出去了，30 秒后按结束处理（重连时电脑会告诉我们结果）
    clearTimeout(this.stopT); this.stopT = setTimeout(() => this.stopRes && this.onStopped({}), 30000);
  },
  giveUp() { const r = this.stopRes; if (!r) return; this.stopRes = null; r({ lost: (this.next - this.base) * CHUNK, gaveUp: true }); },
  cleanup() {
    this.active = false; this.stopping = false;
    this.timers.forEach(clearInterval); this.timers = [];
    clearTimeout(this.retryT); clearTimeout(this.flushT); clearTimeout(this.stopT);
    this.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    try { this.ctx && this.ctx.state !== "closed" && this.ctx.close(); } catch {}
    const ws = this.ws; this.ws = null;
    try { ws && ws.readyState <= 1 && ws.close(); } catch {}
    try { this.wake && this.wake.release(); } catch {}
    this.wake = null; this.buf = []; this.conn = "ok";
    window.onbeforeunload = null;
  },
};
document.addEventListener("visibilitychange", () => {
  if (!REC.active && !REC.stopping) return;
  if (document.visibilityState !== "visible") { REC.flags.hidden = true; return; }
  REC.keepAwake();
  if (REC.ctx && REC.ctx.state !== "running" && REC.ctx.state !== "closed") REC.ctx.resume().catch(() => {}); // 手机切回来时声音处理可能被系统挂起了
  if (REC.conn === "reconnecting") REC.scheduleReconnect(true);
});
window.addEventListener("online", () => { if (REC.conn === "reconnecting") REC.scheduleReconnect(true); });

// ---------------- 路由 ----------------
let pollT = null;
async function route() {
  clearTimeout(pollT);
  REC.onUpdate = null;
  navOpen(false);
  closeModal(); // 安卓返回手势 / 浏览器后退：先关掉弹窗，不然它会盖在新页面上
  await Promise.all([saveNotesNow(), saveMdEditNow()]); // 离开前把没保存的笔记和纪要修改存掉
  const m = location.hash.match(/^#\/m\/([\w-]+)/), day = location.hash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})/);
  if (m) await showMeeting(m[1]);
  else if (day) { S.cur = null; await showDay(day[1]); }
  else { S.cur = null; showHome(); }
  renderSide();
}
window.addEventListener("hashchange", route);

// ---------------- 首页 ----------------
function templateOptions(sel) {
  const t = (S.health && S.health.templates) || { general: "通用会议" };
  return Object.entries(t).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v}</option>`).join("");
}
// “麦克风 + 电脑声音”靠屏幕共享，手机、平板的浏览器都不支持：灰掉并说明
function srcMixLabel(name, checked, desc) {
  const head = `<b>${ic("monitor")}麦克风 + 电脑声音</b>`;
  if (!CAN_SYS) return `<label class="dis" title="这台设备的浏览器不支持录电脑声音"><input type="radio" name="${name}" value="mix" disabled>${head}${desc ? `<small>这台设备的浏览器录不了电脑声音，线上会议请在电脑上录</small>` : ""}</label>`;
  return `<label><input type="radio" name="${name}" value="mix" ${checked ? "checked" : ""}>${head}${desc ? `<small>${desc}</small>` : ""}</label>`;
}
function showHome() {
  const last = JSON.parse(localStorage.getItem("lastForm") || "{}");
  const mix = last.src === "mix" && CAN_SYS;
  $("#main").innerHTML = `<div class="wrap">
    <div class="home-h"><h1>开始会议记录</h1><p>实时转写，会后自动区分说话人，再由 AI 整理纪要与待办</p></div>
    <div class="card"><div class="hero">
      <div class="full"><label class="f">会议标题</label><input id="fTitle" style="width:100%" placeholder="留空则由 AI 根据内容自动命名"></div>
      <div><label class="f">参会人数（说话人区分用）</label>
        <select id="fSpk" style="width:100%"><option value="0">自动判断</option>${[2, 3, 4, 5, 6, 7, 8, 10, 12].map(n => `<option value="${n}" ${last.spk == n ? "selected" : ""}>${n} 人</option>`).join("")}</select></div>
      <div><label class="f">纪要模板</label><select id="fTpl" style="width:100%">${templateOptions(last.tpl || "general")}</select></div>
      <div class="full"><label class="f">热词（人名、产品名、术语等，空格分隔，可提高识别准确率）</label><input id="fHot" style="width:100%" value="${esc(last.hot || "")}" placeholder="例如：张伟 李娜 通义千问 OKR"></div>
      <div class="full"><label class="f">音频来源</label><div class="seg">
        <label><input type="radio" name="src" value="mic" ${!mix ? "checked" : ""}><b>${ic("mic")}麦克风</b><small>线下会议、面对面交流</small></label>
        ${srcMixLabel("src", mix, "线上会议（腾讯会议 / 飞书 / Zoom），需共享屏幕并勾选共享音频")}
      </div></div>
      <div class="full row"><button class="rec big" id="startBtn" ${CAN_MIC ? "" : `disabled title="要用 https 地址打开才能录音"`}><span class="rdot"></span>开始录音</button>
        <button class="big lt" id="upBtn">${ic("upload")}上传录音 / 视频文件</button><input type="file" id="upFile" accept="audio/*,video/*" hidden>
        <span id="upProg" class="muted small"></span></div>
    </div>
    <ul class="tips">
      ${TOUCH && CAN_MIC ? `<li>用手机、平板录音时请让这个页面一直在前台，并插上电源：锁屏、切到别的应用或者来电时，浏览器可能停止收音（没录到的地方转写稿里会标出来）。${IN_APP ? `在${IN_APP}里打开时，一切到后台就会停止收音。` : ""}网络断了不要紧，录音会先存在这台设备上，连上后补传。</li>` : ""}
      <li>知道实际发言人数时请填写，能明显提高说话人区分准确度（尤其 30 分钟以上的会议）；不确定就选“自动判断”，填错比不填更糟。</li>
      <li>会后可以把“说话人1/2”改成真实姓名，AI 纪要和待办会使用真实姓名；把两个说话人改成同一个名字即可合并。</li>
      <li>录音中可以在${matchMedia("(max-width: 699px)").matches ? "下方" : "右侧"}记笔记，AI 生成纪要时会重点参考你的笔记。</li>
    </ul></div>
    <div class="sec-h"><h2>最近的会议</h2><span class="muted small">${S.meetings.length ? `共 ${S.meetings.length} 条` : ""}</span></div>
    <div class="recent stagger">${S.meetings.slice(0, 9).map((m, i) => `<div class="mcard" style="--i:${i}" onclick="location.hash='#/m/${m.id}'">
      <div class="t">${esc(m.title)}</div><div class="m"><span class="num">${m.created.slice(5, 10)} ${hm(m.created)}</span><span>·</span><span>${fmtDur(m.source === "ambient" ? m.speech_s : m.duration)}</span>
      ${m.num_speakers ? `<span>·</span><span>${m.num_speakers} 人</span>` : ""}${autoIc(m)}${statusTag(m)}</div></div>`).join("")
      || `<div class="muted">还没有会议，点击“开始录音”或上传一段录音试试。</div>`}</div></div>`;
  const form = () => ({ title: $("#fTitle").value, num_spk: +$("#fSpk").value, hotword: $("#fHot").value, template: $("#fTpl").value,
    src: $("input[name=src]:checked").value });
  const remember = f => localStorage.setItem("lastForm", JSON.stringify({ spk: f.num_spk, tpl: f.template, hot: f.hotword, src: f.src }));
  $("#startBtn").onclick = async () => {
    const f = form(); remember(f);
    if (REC.active) return toast("已有会议在录音");
    REC.prime();
    $("#startBtn").disabled = true;
    let meta;
    try {
      meta = await api("/api/meetings", { method: "POST", body: f });
      await REC.start(meta.id, f.src);
      await loadMeetings();
      location.hash = "#/m/" + meta.id;
    } catch (e) {
      toast("无法开始录音：" + e.message, 5000);
      if (meta) { await api(`/api/meetings/${meta.id}`, { method: "DELETE" }).catch(() => {}); loadMeetings(); }
      $("#startBtn").disabled = false;
    }
  };
  $("#upBtn").onclick = () => $("#upFile").click();
  $("#upFile").onchange = e => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return; // 清空选择，失败后再选同一个文件也能重新上传
    const f = form(); remember(f);
    const fd = new FormData();
    fd.append("file", file); fd.append("title", f.title); fd.append("num_spk", f.num_spk); fd.append("hotword", f.hotword); fd.append("template", f.template);
    const x = new XMLHttpRequest();
    const prog = t => { const el = $("#upProg"); el && (el.textContent = t); };
    const fail = msg => { prog(""); $("#upBtn") && ($("#upBtn").disabled = false); toast("上传失败：" + msg, 6000); };
    x.open("POST", "/api/meetings/upload");
    $("#upBtn").disabled = true;
    x.upload.onprogress = ev => prog(`上传中 ${Math.round(ev.loaded / ev.total * 100)}%`);
    x.upload.onload = () => prog("上传完成，正在转换音频…");
    x.onload = async () => {
      let j = null; try { j = JSON.parse(x.responseText); } catch {}
      if (needLogin(x.status, j)) return;
      if (x.status !== 200) return fail((j && j.detail) || `服务返回 ${x.status}`);
      if (!j) return fail("服务返回的内容无法识别");
      prog(""); $("#upBtn") && ($("#upBtn").disabled = false);
      await loadMeetings(); location.hash = "#/m/" + j.id;
    };
    x.onerror = () => fail(REMOTE ? "网络中断，或者电脑上的服务没有运行" : "网络中断或服务没有运行");
    x.onabort = () => fail("已取消");
    x.send(fd);
  };
}

// ---------------- 会议详情 ----------------
async function showMeeting(id) {
  let data;
  try { data = await api("/api/meetings/" + id); } catch (e) {
    const x = S.amb && S.amb.discarded;
    if (x && x.id === id) return showDiscarded(x);
    if (S.cur && S.cur.meta.id === id && /连不上/.test(e.message)) return refreshMeeting(id, 5000); // 服务暂时断开：保留当前内容，稍后再试
    S.cur = null;
    $("#main").innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}<div style="margin-top:12px"><a class="btn" href="#/">回到首页</a></div></div></div>`;
    return;
  }
  const sameMeeting = S.cur && S.cur.meta.id === id;
  if (location.hash !== "#/m/" + id && !location.hash.startsWith("#/m/" + id)) return; // 已切走
  S.cur = data;
  if (!sameMeeting) S.tab = data.minutes ? "minutes" : "transcript";
  // 刷新同一场会议时保留滚动位置（分屏时两栏各自滚动）
  const st = $("#main").scrollTop, pst = ["#tabBody", "#trScroll"].map(s => ($(s) || {}).scrollTop || 0);
  renderMeeting();
  if (sameMeeting) { $("#main").scrollTop = st; ["#tabBody", "#trScroll"].forEach((s, i) => $(s) && ($(s).scrollTop = pst[i])); }
}
// 正在输入或编辑时不重画页面：输入框会被换成服务器上的旧内容
function editingNow() {
  const ae = document.activeElement;
  return !!((ae && TYPING.includes(ae.id)) || $("#mdEdit") || $("#peText") || ($("#qIn") && $("#qIn").value.trim()) || !$("#modal").hidden);
}
// 刷新当前会议（正在记笔记、编辑时不打断）
function refreshMeeting(id, ms = 4000) {
  clearTimeout(pollT);
  pollT = setTimeout(async () => {
    if (editingNow()) return refreshMeeting(id, ms);
    await saveNotesNow();
    showMeeting(id).then(() => S.cur && S.cur.meta.id !== id && loadMeetings());
  }, ms);
}
// 转写中：只更新进度条，不重画页面（不打断记笔记、编辑、提问）；转写结束后再整页刷新
function pollJob(id) {
  clearTimeout(pollT);
  pollT = setTimeout(async () => {
    let d; try { d = await api("/api/meetings/" + id); } catch { return pollJob(id); }
    if (!S.cur || S.cur.meta.id !== id || !location.hash.startsWith("#/m/" + id)) return;
    const m = d.meta;
    if (["queued", "transcribing"].includes(m.status)) {
      Object.assign(S.cur.meta, { status: m.status, job_started: m.job_started, job_estimate: m.job_estimate, duration: m.duration });
      const b = $("#jobBanner"); b && (b.outerHTML = jobBanner(S.cur.meta));
      return pollJob(id);
    }
    if (editingNow()) { S.cur.meta.status = m.status; const b = $("#jobBanner"); b && (b.outerHTML = jobBanner(m)); return refreshMeeting(id, 2000); }
    await saveNotesNow();
    await showMeeting(id); loadMeetings();
  }, 2000);
}
function jobBanner(m) {
  if (!["queued", "transcribing"].includes(m.status))
    return `<div class="banner info" id="jobBanner"><b>转写完成</b><span class="muted small">编辑结束后自动刷新显示结果</span></div>`;
  const el = m.job_started ? (Date.now() / 1000 - m.job_started) : 0, est = m.job_estimate || 30;
  const pct = m.status === "queued" ? 3 : Math.min(95, el / est * 100);
  return `<div class="banner info" id="jobBanner"><b>${m.status === "queued" ? "排队中" : "正在精准转写并区分说话人"}</b>
    <div class="progress"><i style="width:${pct}%"></i></div><span class="muted small">${m.status === "transcribing" ? `已用 ${Math.round(el)}s / 预计 ${Math.round(est)}s` : ""}</span></div>`;
}
// 正在记录的这段对话（全天模式推送）：有新定稿的句子时立即刷新；原来就在底部的话刷新后仍贴着底部
const TYPING = ["notes", "qIn", "mdEdit", "mTitle", "peText", "tSearch"];
const liveScroller = () => $("#paras") && ($("#trPane") ? $("#trScroll") : $("#main"));
const atBottom = el => !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
let liveBusy = false, liveAgain = false;
async function refreshLive(id) {
  if (editingNow()) return; // 正在输入、编辑：等兜底轮询再刷新
  if (liveBusy) { liveAgain = true; return; }
  liveBusy = true;
  try {
    const stick = atBottom(liveScroller());
    clearTimeout(pollT);
    await showMeeting(id);
    renderPartial(true);
    const sc = liveScroller(); if (stick && sc) sc.scrollTop = sc.scrollHeight;
  } finally { liveBusy = false; }
  if (liveAgain) { liveAgain = false; refreshLive(id); }
}
// 说话过程中的临时文字：接在实时转写稿末尾，灰色。定稿时推送里的临时文字先清空、再来新版本号，
// 所以清空后先留着这一行，等刷新换成定稿（最多 3 秒）
let partialT = null;
function renderPartial(fresh = false) {
  const box = $("#paras"), a = S.amb, d = S.cur;
  if (!box || !d || d.transcript || !a || !a.conv || a.conv.id !== d.meta.id) return;
  let el = $("#ambPartial");
  if (!a.partial) {
    if (el && !fresh) { clearTimeout(partialT); partialT = setTimeout(() => el.remove(), 3000); }
    return;
  }
  clearTimeout(partialT);
  const sc = liveScroller(), stick = atBottom(sc);
  if (!el) {
    $(".empty", box) && $(".empty", box).remove();
    box.insertAdjacentHTML("beforeend", `<div class="para partial" id="ambPartial"><span class="ts" title="正在说，说完后定稿"><i class="rdot"></i></span><div class="txt"></div></div>`);
    el = $("#ambPartial");
  }
  $(".txt", el).textContent = a.partial;
  if (stick) sc.scrollTop = sc.scrollHeight;
}
function wallOf(ms) {
  const sm = S.cur && S.cur.segmap; if (!sm || !sm.length) return null;
  let b = sm[0]; for (const s of sm) { if (s[0] <= ms) b = s; else break; }
  return b[1] + (ms - b[0]) / 1000;
}
const tsLabel = ms => { const w = wallOf(ms); return w ? hms(w) : fmtTs(ms); };
function spkName(spk) { const n = S.cur.meta.speakers || {}; return n[String(spk)] || `说话人${spk + 1}`; }
// 转写用的引擎：憨包云端时附上本机补了几段
function asrInfo(a, long) {
  if (!a || !a.engine) return "本机识别";
  if (a.engine !== "hanbao") {
    const name = { nano: "本机 Fun-ASR-Nano", paraformer: "本机 Paraformer" }[a.engine] || "本机识别";
    // 选的是憨包/Nano，但实际退回了本机/Paraformer：说清楚原因
    if (a.cloud_failed) return long ? `憨包云端识别失败（${a.cloud_failed}），已改用${name}` : `${name}（憨包云端失败，已改用本机）`;
    if (a.nano_failed) return long ? `Fun-ASR-Nano 加载失败（${a.nano_failed}），已改用 Paraformer` : `${name}（Nano 加载失败）`;
    return name;
  }
  const fix = (a.failed || 0) + (a.local || 0);
  return long ? `憨包云端识别 ${a.units} 段；云端失败 ${a.failed || 0} 段、没出字 ${a.local || 0} 段由本机模型补上`
    : `憨包云端${fix ? `（本机补 ${a.local || 0} 段）` : ""}`;
}
function spkColor(spk) {
  // 同名的说话人用同一个颜色
  const ids = [...new Set(paras().map(p => p.spk))].sort((a, b) => a - b);
  const key = ids.join(",") + "|" + JSON.stringify(S.cur.meta.speakers || {});
  if (S._ck !== key) { S._ck = key; S._names = [...new Set(ids.map(spkName))]; }
  return COLORS[Math.max(0, S._names.indexOf(spkName(spk))) % COLORS.length];
}
function paras() {
  const d = S.cur;
  if (d.transcript && d.transcript.paragraphs) return d.transcript.paragraphs;
  return (d.live || []).map(x => ({ ...x, spk: -1 }));
}

// 录音完整性（手机、平板录音时网络断开、锁屏、来电）：每次录音的健康记录汇总
function recHealth(m) {
  const hs = m.rec_health || [];
  if (!hs.length) return null;
  const gaps = hs.flatMap(h => h.gaps || []).sort((a, b) => a.at_ms - b.at_ms);
  const lost = hs.reduce((a, h) => a + (h.ended && h.produced ? Math.max(0, h.produced - h.received - (h.dropped || 0)) : 0), 0);
  return { gaps, gapMs: gaps.reduce((a, g) => a + g.dur_ms, 0), reconnects: hs.reduce((a, h) => a + (h.reconnects || 0), 0), lostMs: lost / 32 };
}
function recHealthHTML(m) {
  const h = recHealth(m); if (!h) return "";
  const why = [...new Set(h.gaps.map(g => GAP_TEXT[g.reason] || GAP_TEXT.stall))].join("；");
  const tip = [`网络断开后重连 ${h.reconnects} 次（断开期间的录音会补传）`, h.gaps.length ? `没录到 ${h.gaps.length} 段，共 ${fmtDur(h.gapMs / 1000)}：${why}` : "",
    h.lostMs >= 1000 ? `另有约 ${fmtDur(h.lostMs / 1000)} 录到了但没传上电脑` : ""].filter(Boolean).join("\n");
  return h.gaps.length || h.lostMs >= 1000
    ? `<span class="rh bad" title="${esc(tip)}">${ic("clock")}录音有 ${h.gaps.length + (h.lostMs >= 1000 ? 1 : 0)} 处缺口，共 ${fmtDur((h.gapMs + h.lostMs) / 1000)}</span>`
    : `<span class="rh" title="${esc(tip)}">${ic("check")}录音完整${h.reconnects ? `（断网重连 ${h.reconnects} 次，已补传）` : ""}</span>`;
}

function renderMeeting() {
  const d = S.cur, m = d.meta, recHere = REC.active && REC.mid === m.id;
  const busy = ["queued", "transcribing"].includes(m.status);
  const isAmb = m.source === "ambient";
  const canContinue = m.source !== "upload" && !isAmb && !REC.active && !busy && !d.live_active;
  $("#main").innerHTML = `<div class="wrap">
    <div class="mhead"><div class="grow">
      <input class="title" id="mTitle" value="${esc(m.title)}" title="点击修改标题">
      <div class="meta-line">${isAmb ? `<span>${ic("calendar")}<span class="num">${m.created.slice(0, 10)} ${hm(m.started_at || m.created)}–${hm(m.ended_at)}</span></span>
        <span>${ic("speech")}发言 ${fmtDur(m.speech_s)}</span><span>${ic("radio")}全天自动记录</span>`
        : `<span>${ic("calendar")}<span class="num">${m.created.slice(0, 10)} ${hm(m.created)}</span></span><span>${ic("clock")}${fmtDur(m.duration)}</span>`}
        ${m.num_speakers ? `<span>${ic("users")}${m.num_speakers} 位发言人</span>` : ""}${m.source === "upload" ? `<span>${ic("file")}${esc(m.filename || "上传文件")}</span>` : ""}
        ${d.transcript ? `<span title="${esc(asrInfo(d.transcript.asr, true))}">${ic("mic")}${esc(asrInfo(d.transcript.asr))} · 用时 <span class="num">${d.transcript.cost}s</span></span>` : ""}${m.audio_purged ? `<span>录音已按保留期限删除</span>` : ""}${recHealthHTML(m)}</div></div>
      <div class="row mact" id="mAct">
        ${canContinue && !recHere ? `<button class="lt" id="contBtn"><span class="rdot" style="color:var(--red)"></span>${m.duration ? "继续录音" : "开始录音"}</button>` : ""}
        ${!recHere && d.has_audio && !busy && !d.ambient_active ? `<button class="lt" id="reBtn">${ic("refresh")}重新转写</button>` : ""}
        <div class="menu"><button class="lt" id="expBtn">${ic("download")}导出</button></div>
        ${!recHere ? `<button class="lt danger" id="delBtn" title="删除">${ic("trash")}</button>` : ""}
      </div></div>
    <div id="mBody"></div></div>`;
  hoverFill($("#mAct"), "button.lt");
  $("#mTitle").onchange = async e => {
    const v = e.target.value.trim();
    if (!v) { e.target.value = m.title; return toast("标题不能为空"); }
    try { await api(`/api/meetings/${m.id}`, { method: "PATCH", body: { title: v } }); }
    catch (err) { e.target.value = m.title; return toast("标题没有保存：" + err.message, 5000); }
    m.title = v; m.title_auto = false; loadMeetings();
  };
  $("#mTitle").onkeydown = e => e.key === "Enter" && e.target.blur();
  $("#delBtn") && ($("#delBtn").onclick = async () => {
    if (!confirm(d.ambient_active ? `删除正在记录的「${m.title}」？已录下的内容会删除，之后的发言会记成新的一段。`
      : `确定删除「${m.title}」？录音、转写和纪要都会删除。`)) return;
    try { await api(`/api/meetings/${m.id}`, { method: "DELETE" }); } catch (e) { return toast("删除失败：" + e.message, 5000); }
    notesDirty = false; mdEditOrig = null; // 已删除，不要再保存它的笔记和纪要
    await loadMeetings(); location.hash = "#/";
  });
  $("#reBtn") && ($("#reBtn").onclick = () => retranscribeDialog());
  $("#contBtn") && ($("#contBtn").onclick = () => continueDialog());
  $("#expBtn").onclick = e => {
    e.stopPropagation();
    const pop = popMenu(e.currentTarget.parentElement, `
      <a href="/api/meetings/${m.id}/export?fmt=md">${ic("file")}Markdown（纪要 + 转写）</a>
      <a href="/api/meetings/${m.id}/export?fmt=txt">${ic("text")}TXT 转写稿</a>
      <a href="/api/meetings/${m.id}/export?fmt=srt">${ic("subtitle")}SRT 字幕</a>
      <a id="copyMin">${ic("copy")}复制纪要</a>`);
    pop && ($("#copyMin").onclick = () => { navigator.clipboard.writeText((d.minutes && d.minutes.markdown) || ""); toast(d.minutes ? "已复制纪要" : "还没有纪要"); });
  };
  if (recHere) return renderRecording();
  renderDetail();
}

function continueDialog() {
  const last = JSON.parse(localStorage.getItem("lastForm") || "{}");
  const edited = paras().some(p => p.edited) && !!S.cur.transcript;
  const dlg = modal(`<h2>${S.cur.meta.duration ? "继续录音" : "开始录音"}</h2>
    <p class="muted">新录音会接在已有录音后面，结束后重新整体转写。${S.cur.transcript ? "已改的说话人姓名会保留，但编号可能变化，请复核。" : ""}</p>
    ${edited ? `<div class="banner err small" style="margin:8px 0">这场有手动修改过的段落，继续录音结束后的重新转写会覆盖这些修改（纠错表里的规则不受影响）。</div>` : ""}
    ${S.cur.minutes ? `<p class="muted small">已有的 AI 纪要不会自动更新，录完后到“AI 纪要”里重新生成。</p>` : ""}
    <div class="seg" style="margin:14px 0">
      <label><input type="radio" name="src2" value="mic" ${last.src !== "mix" || !CAN_SYS ? "checked" : ""}><b>${ic("mic")}麦克风</b></label>
      ${srcMixLabel("src2", last.src === "mix" && CAN_SYS, "")}</div>
    <div class="row" style="justify-content:flex-end"><button onclick="closeModal()">取消</button><button class="rec" id="goRec"><span class="rdot"></span>开始</button></div>`);
  $("#goRec", dlg).onclick = async () => {
    const src = $("input[name=src2]:checked", dlg).value; REC.prime(); closeModal();
    try { await REC.start(S.cur.meta.id, src); await showMeeting(S.cur.meta.id); loadMeetings(); }
    catch (e) { toast("无法开始录音：" + e.message, 5000); }
  };
}

function retranscribeDialog() {
  const m = S.cur.meta;
  const edited = paras().some(p => p.edited);
  const dlg = modal(`<h2>重新转写</h2><p class="muted">调整参会人数或热词后重新识别。已改的说话人姓名会保留，但编号可能变化，请复核。</p>
    ${edited ? `<div class="banner err small" style="margin:8px 0">这场有手动修改过的段落，重新转写会覆盖这些修改（纠错表里的规则不受影响，会自动重新套用）。</div>` : ""}
    <div class="row" style="margin:14px 0"><div><label class="f">参会人数</label><select id="rSpk"><option value="0">自动判断</option>
      ${[2, 3, 4, 5, 6, 7, 8, 10, 12].map(n => `<option value="${n}" ${m.num_spk == n ? "selected" : ""}>${n} 人</option>`).join("")}</select></div>
      <div class="grow"><label class="f">本场额外热词（设置里的常用热词会自动带上）</label><input id="rHot" style="width:100%" value="${esc(m.hotword)}"></div></div>
    <div class="row" style="justify-content:flex-end"><button onclick="closeModal()">取消</button><button class="pri" id="rGo">开始</button></div>`);
  $("#rGo", dlg).onclick = async () => {
    try { await api(`/api/meetings/${m.id}/transcribe`, { method: "POST", body: { num_spk: +$("#rSpk", dlg).value, hotword: $("#rHot", dlg).value } }); }
    catch (e) { return toast(e.message); }
    closeModal(); await showMeeting(m.id); loadMeetings();
  };
}

// ----- 录音中视图 -----
function renderRecording() {
  const d = S.cur;
  $("#mBody").innerHTML = `
    <div id="lostSlot"></div>
    <div class="recbar"><span class="recdot" id="rDot"></span><span class="timer" id="rTimer">00:00</span>
      <div class="meter"><i id="rMeter"></i></div><span class="muted small" id="rState">正在录音并实时转写</span>
      <span class="grow"></span><button id="rPause">${REC.paused ? `${ic("play")}继续` : `${ic("pause")}暂停`}</button><button class="rec" id="rStop">${ic("stop")}结束录音</button></div>
    ${TOUCH ? `<div class="muted small" style="margin:-8px 2px 12px">请让这个页面一直在前台：锁屏、切到别的应用或来电时浏览器可能停止收音，没录到的地方会标出来。网络断了录音不停，先存在这台设备上。</div>` : ""}
    <div class="livegrid">
      <div class="card"><h2>实时转写 <span class="muted small" style="font-weight:normal">会后会重新精准转写并区分说话人</span></h2><div class="livebox" id="liveBox"></div></div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">我的笔记</h2>
        <button class="sm lt" id="insTs">${ic("clock")}插入时间点</button></div>
        <textarea class="notes-area" id="notes" placeholder="记录重点、决定、待办……&#10;AI 生成纪要时会重点参考这里的内容">${esc(d.notes)}</textarea>
        <div class="muted small" id="noteState"></div></div>
    </div>`;
  const box = $("#liveBox");
  const prev = (d.live || []).filter(x => x.start < REC.offsetMs);
  let shown = prev.length + REC.finals.length; // 之后新出现的句子带入场动画（先位移、后淡入）
  const gapRow = g => `<div class="lv gap">${ic("clock")}<span>这里有 ${fmtDur(Math.max(1, g.dur_ms / 1000))} 没录到：${GAP_TEXT[g.reason] || GAP_TEXT.stall}</span></div>`;
  const draw = () => {
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const items = [...prev, ...REC.finals];
    const gaps = [...REC.gaps].sort((a, b) => a.at_ms - b.at_ms);
    let gi = 0;
    box.innerHTML = items.map((x, i) => {
      let pre = "";
      while (gi < gaps.length && gaps[gi].at_ms <= x.start) pre += gapRow(gaps[gi++]);
      return pre + `<div class="lv${i >= shown ? " in" : ""}"><a class="ts" data-ts="${fmtTs(x.start)}">${fmtTs(x.start)}</a>${esc(x.text)}</div>`;
    }).join("") + gaps.slice(gi).map(gapRow).join("")
      + (REC.partial ? `<div class="lv partial"><a class="ts">${fmtTs(REC.partial.start)}</a>${esc(REC.partial.text)}…</div>` : "")
      + (!items.length && !REC.partial && !gaps.length ? `<div class="empty">开始说话，文字会实时出现在这里</div>` : "");
    shown = items.length;
    if (atBottom) box.scrollTop = box.scrollHeight;
  };
  draw();
  // 录音页顶上的提示：连接断了（声音先存在本机）> 正在把剩下的传完 > 现在录不到声音 > 音频源断开
  const pendingText = () => `已在这台设备上暂存 ${fmtDur(REC.pendingSec())}`;
  const showLost = () => {
    const k = REC.lost, st = REC.stall;
    let html = "";
    if (REC.stopping) html = `<div class="banner info"><b class="grow">正在把剩下的录音传到电脑…<span class="muted small" id="pendTx"> ${REC.conn === "ok" ? "" : "连接断开了，正在重连；"}${pendingText()}</span></b>
      <button class="sm" id="giveUpBtn">不等了，直接结束</button></div>`;
    else if (REC.conn === "reconnecting") html = `<div class="banner warn"><b class="grow">和电脑的连接断开了，正在重连…<span class="muted small" id="pendTx"> 录音没有停，${pendingText()}（最多 15 分钟），连上后自动补传</span></b></div>`;
    if (!REC.stopping && st) html += `<div class="banner err"><b class="grow">现在录不到声音：${GAP_TEXT[st.reason] || GAP_TEXT.stall}</b><button class="sm" id="wakeBtn">继续录音</button></div>`;
    if (!REC.stopping && k) html += `<div class="banner err"><b class="grow">${k === "sys" ? "电脑声音已断开（停止了共享），现在只录到麦克风" : "麦克风断开了，现在什么都录不到"}</b>
      <button class="sm" id="reconBtn">重新连接${k === "sys" ? "电脑声音" : "麦克风"}</button></div>`;
    $("#lostSlot").innerHTML = html;
    $("#rDot").classList.toggle("paused", !!k || !!st || REC.paused || REC.stopping);
    $("#rState").textContent = REC.stopping ? "正在保存" : k === "mic" ? "麦克风已断开" : st ? "录不到声音" : REC.paused ? "已暂停（暂停期间不录音）"
      : REC.conn === "reconnecting" ? "录音中 · 等待重连" : k === "sys" ? "只录麦克风" : "正在录音并实时转写";
    $("#reconBtn") && ($("#reconBtn").onclick = async e => {
      e.currentTarget.disabled = true;
      try { await REC.reconnect(); toast("已重新连接"); } catch (err) { toast("重新连接失败：" + err.message, 6000); showLost(); }
    });
    $("#wakeBtn") && ($("#wakeBtn").onclick = () => REC.wakeAudio());
    $("#giveUpBtn") && ($("#giveUpBtn").onclick = () => REC.giveUp());
  };
  showLost();
  let lastTick = 0;
  REC.onUpdate = type => {
    if (type === "tick") {
      const now = performance.now(); if (now - lastTick < 100) return; lastTick = now;
      $("#rTimer").textContent = fmtTs(REC.elapsedMs());
      $("#rMeter").style.width = Math.min(100, Math.sqrt(REC.level) * 140) + "%";
      if ($("#pendTx") && REC.conn !== "ok") $("#pendTx").textContent = " 录音没有停，" + pendingText() + "（最多 15 分钟），连上后自动补传";
    } else if (type === "closed") { showMeeting(d.meta.id); loadMeetings(); }
    else if (type === "lost" || type === "conn") showLost();
    else if (type === "ack") { if (REC.stopping && $("#pendTx")) $("#pendTx").textContent = " " + pendingText(); }
    else draw();
  };
  $("#rPause").onclick = () => {
    if (REC.paused) { REC.resume(); $("#rPause").innerHTML = `${ic("pause")}暂停`; }
    else { REC.pause(); $("#rPause").innerHTML = `${ic("play")}继续`; }
    showLost();
  };
  $("#rStop").onclick = async () => {
    $("#rStop").disabled = true; $("#rPause").disabled = true; $("#rStop").textContent = "保存中…";
    await saveNotesNow();
    const r = await REC.stop();
    if (r && r.gaveUp && r.lost >= CHUNK) toast(`没等传完就结束了：最后 ${fmtDur(r.lost / 32000)} 的录音没有保存`, 8000);
    await loadMeetings(); S.tab = "transcript"; await showMeeting(d.meta.id);
  };
  bindNotes();
  $("#insTs").onclick = () => insertAtCursor($("#notes"), `[${fmtTs(REC.elapsedMs())}] `);
}

// ----- 笔记（自动保存） -----
let notesDirty = false;
let notesRetry = null;
async function saveNotesNow() {
  const ta = $("#notes"); if (!ta || !notesDirty) return;
  const id = S.cur.meta.id, v = ta.value;
  notesDirty = false; S.cur.notes = v; clearTimeout(notesRetry);
  try {
    await api(`/api/meetings/${id}`, { method: "PATCH", body: { notes: v } });
    $("#noteState") && ($("#noteState").textContent = "已保存 " + new Date().toTimeString().slice(0, 8));
  } catch (e) {
    // 保存失败：保持“未保存”，5 秒后自动重试；关闭网页前会提醒
    if (!S.cur || S.cur.meta.id !== id) return;
    notesDirty = true;
    const st = $("#noteState"); st && (st.innerHTML = `<span style="color:var(--red)">没保存上：${esc(e.message)}，5 秒后自动重试</span>`);
    notesRetry = setTimeout(saveNotesNow, 5000);
  }
}
const saveNotes = debounce(saveNotesNow, 800);
function bindNotes() {
  const ta = $("#notes"); if (!ta) return;
  ta.oninput = () => { notesDirty = true; $("#noteState").textContent = "编辑中…"; saveNotes(); };
  ta.onblur = saveNotesNow;
}
function insertAtCursor(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); ta.selectionStart = ta.selectionEnd = s + text.length; ta.focus();
  ta.dispatchEvent(new Event("input"));
}

// ----- 会后详情 -----
// 分屏：左边纪要 / 笔记 / 问答，右边转写稿，两栏各自滚动；主区域够宽才分
const canSplit = () => $("#main").clientWidth >= 1100;
const useSplit = () => S.split && canSplit();
function toggleSplit(on) {
  S.split = on; localStorage.setItem("splitView", on ? "1" : "0");
  saveNotesNow(); saveMdEditNow(); clearTimeout(pollT);
  renderDetail(true);
  const a = $("#audio"); a && highlightPlaying(a.currentTime * 1000, true);
}
// 窗口拉宽/变窄跨过阈值时切换布局（播放不中断）
window.addEventListener("resize", debounce(() => {
  if (!S.cur || !$("#tabBody") || $("#peText") || $("#mdEdit")) return; // 正在编辑时不换布局
  if (useSplit() !== !!$("#trPane") || canSplit() !== !!$("#splitBtn")) { saveNotesNow(); clearTimeout(pollT); renderDetail(true); }
}, 200));
function renderDetail(keepPlayer = false) {
  const d = S.cur, m = d.meta;
  const sp = useSplit();
  $("#main > .wrap").classList.toggle("split", sp);
  if (sp && S.tab === "transcript") S.tab = "minutes";
  const busy = ["queued", "transcribing"].includes(m.status);
  let banner = "";
  if (busy) {
    banner = jobBanner(m);
    pollJob(m.id);
  } else if (d.ambient_active) {
    const split = (S.amb && S.amb.cfg.split_min) || 5;
    banner = `<div class="banner info"><span class="recdot"></span><b>全天模式正在记录这段对话</b>
      <span class="muted small grow">边说边出字（灰色是正在说的，说完一句后定稿）；静音 ${split} 分钟后自动结束，随后精准转写并区分说话人</span>
      <button class="sm" id="ambSplit">现在结束这段</button></div>`;
    refreshMeeting(m.id, ambLive ? 15000 : 4000); // 有推送时只做兜底
  } else if (m.status === "error") {
    banner = `<div class="banner err"><span class="grow">转写失败：${esc(m.error)}</span>${d.has_audio ? `<button class="sm" id="errRetry">${ic("refresh")}重新转写</button>` : ""}</div>`;
  } else if (d.live_active) {
    const ls = d.live_state || {}, dev = ls.device ? `（${esc(ls.device)}）` : "";
    banner = ls.state === "reconnecting"
      ? `<div class="banner warn"><span class="grow">录音的设备${dev}和电脑断开了，正在等它连回来接着录；${fmtDur(ls.grace_left)}内没连回来会自动结束并开始转写</span>
        <button class="sm" id="liveEnd">现在结束</button></div>`
      : `<div class="banner info"><span class="recdot"></span><span class="grow">这个会议正在另一个页面${dev}录音，录完后这里会自动更新</span><button class="sm" id="liveEnd">结束那边的录音</button></div>`;
    refreshMeeting(m.id, 3000);
  }
  const tabs = [["minutes", "AI 纪要"], ...(sp ? [] : [["transcript", "转写稿"]]), ["notes", "我的笔记"], ["qa", "AI 问答"]];
  const tabsHTML = `<div class="tabs">${tabs.map(([k, v]) => `<button data-tab="${k}" class="${S.tab === k ? "on" : ""}">${v}</button>`).join("")}
    ${canSplit() ? `<span class="grow"></span><button class="tab-x${sp ? " is-split" : ""}" id="splitBtn" title="${sp ? "改回单栏：转写稿放回标签页" : "分屏：左边看纪要，右边同时看转写稿"}">${ic("columns")}${sp ? "单栏" : "分屏"}</button>` : ""}</div>`;
  // 切换布局时沿用原来的播放器节点，正在播放的录音不会停
  const oldPlayer = keepPlayer && $("#player");
  $("#mBody").innerHTML = banner + (d.has_audio ? playerHTML(m) : "") + (sp
    ? `<div class="splitgrid"><section class="pane">${tabsHTML}<div class="pane-body" id="tabBody"></div></section><section class="pane" id="trPane"></section></div>`
    : tabsHTML + `<div id="tabBody"></div>`);
  if (oldPlayer && $("#player")) $("#player").replaceWith(oldPlayer); else bindPlayer();
  const tabBox = $(".tabs");
  hoverFill(tabBox, "button[data-tab]"); tabInd(tabBox, false);
  $$("button[data-tab]", tabBox).forEach(b => b.onclick = async () => {
    if (S.tab === b.dataset.tab) return;
    if (!(await saveMdEditNow())) return; // 纪要修改没保存上：留在编辑框，免得改的内容丢掉
    saveNotesNow(); S.tab = b.dataset.tab; $$("button[data-tab]", tabBox).forEach(x => x.classList.toggle("on", x === b)); tabInd(tabBox, true); renderTab();
  });
  $("#splitBtn") && ($("#splitBtn").onclick = () => toggleSplit(!sp));
  $("#liveEnd") && ($("#liveEnd").onclick = async e => {
    e.currentTarget.disabled = true;
    try { const r = await api(`/api/meetings/${m.id}/live/end`, { method: "POST" }); toast(r.pending ? "已通知录音的设备结束，剩下的录音传完后开始转写" : "已结束，开始转写"); }
    catch (err) { toast(err.message); }
    setTimeout(() => showMeeting(m.id), 1200);
  });
  $("#ambSplit") && ($("#ambSplit").onclick = async () => {
    if (!confirmSplit()) return;
    await saveNotesNow(); await ambAct({ action: "split" }); setTimeout(() => showMeeting(m.id), 800);
  });
  $("#errRetry") && ($("#errRetry").onclick = () => retranscribeDialog());
  renderTab();
  if (sp) tabTranscript();
}
function seek(sec) { const a = $("#audio"); if (!a) return; a.currentTime = sec; a.play(); }

// ----- 播放器：倍速、前进后退、拖动定位，进度条下方是“谁在什么时候说话”的色条 -----
function playerHTML(m) {
  const durMs = (m.duration || 0) * 1000, ps = S.cur.transcript ? paras().filter(p => p.spk >= 0) : [];
  const strip = durMs && ps.length ? `<div class="pspk">${ps.map(p => `<i style="left:${(p.start / durMs * 100).toFixed(3)}%;width:${Math.max(.12, (p.end - p.start) / durMs * 100).toFixed(3)}%;background:${spkColor(p.spk)}"></i>`).join("")}</div>` : "";
  return `<div class="player" id="player"><audio id="audio" preload="metadata" src="/api/meetings/${m.id}/audio?v=${m.duration}"></audio>
    <button class="pbtn play" id="pPlay" title="播放 / 暂停（空格）">${icSwap("play", "pause")}</button>
    <button class="pbtn" id="pBack" title="后退 15 秒（←）">${ic("back")}</button>
    <button class="pbtn" id="pFwd" title="前进 15 秒（→）">${ic("fwd")}</button>
    <span class="ptime"><b id="pCur">00:00</b> / <span id="pDur">${durMs ? fmtTs(durMs) : "--:--"}</span></span>
    <div class="ptrack" id="pTrack"><div class="pbar"><i class="pbuf" id="pBuf"></i><i class="pfill" id="pFill"></i></div>${strip}
      <i class="phead" id="pHead"></i><span class="ptip" id="pTip"></span></div>
    <button class="pbtn prate" id="pRate" title="播放速度">1×</button></div>`;
}
function bindPlayer() {
  const a = $("#audio"); if (!a) return;
  const track = $("#pTrack"), fill = $("#pFill"), buf = $("#pBuf"), head = $("#pHead"), tip = $("#pTip"), play = $("#pPlay");
  const D = () => (a.duration && isFinite(a.duration) ? a.duration : (S.cur.meta.duration || 0));
  let drag = false;
  const paint = (t = a.currentTime) => {
    const p = D() ? Math.min(1, Math.max(0, t / D())) : 0;
    fill.style.transform = `scaleX(${p})`; head.style.left = p * 100 + "%"; $("#pCur").textContent = fmtTs(t * 1000);
  };
  a.onloadedmetadata = () => { $("#pDur").textContent = fmtTs(D() * 1000); paint(); };
  a.ontimeupdate = () => { if (!drag) paint(); highlightPlaying(a.currentTime * 1000); };
  a.onprogress = () => { try { const e = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0; buf.style.transform = `scaleX(${D() ? Math.min(1, e / D()) : 0})`; } catch {} };
  a.onplay = a.onpause = () => play.classList.toggle("alt", !a.paused);
  play.onclick = () => (a.paused ? a.play() : a.pause());
  $("#pBack").onclick = () => { a.currentTime = Math.max(0, a.currentTime - 15); paint(); };
  $("#pFwd").onclick = () => { a.currentTime = Math.min(D(), a.currentTime + 15); paint(); };
  const RATES = [1, 1.25, 1.5, 2], rb = $("#pRate");
  const setRate = r => { a.playbackRate = r; rb.textContent = r + "×"; localStorage.setItem("playRate", r); };
  setRate(RATES.includes(+localStorage.getItem("playRate")) ? +localStorage.getItem("playRate") : 1);
  rb.onclick = () => setRate(RATES[(RATES.indexOf(a.playbackRate) + 1) % RATES.length]);
  const at = e => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const who = ms => { if (!S.cur.transcript) return ""; const p = paras().find(x => x.spk >= 0 && ms >= x.start && ms < x.end); return p ? " · " + spkName(p.spk) : ""; };
  track.onpointermove = e => { const p = at(e), ms = p * D() * 1000; tip.textContent = fmtTs(ms) + who(ms); tip.style.left = p * 100 + "%"; if (drag) paint(p * D()); };
  track.onpointerdown = e => { drag = true; track.setPointerCapture(e.pointerId); track.classList.add("drag"); paint(at(e) * D()); };
  const end = e => { if (!drag) return; drag = false; track.classList.remove("drag"); a.currentTime = at(e) * D(); };
  track.onpointerup = end; track.onpointercancel = () => { drag = false; track.classList.remove("drag"); paint(); };
  if (a.readyState >= 1) a.onloadedmetadata();
  // 转写稿的搜索条吸附在播放器下面：手机上播放器是两行，高度不固定，量出来给 CSS 用
  const pl = $("#player");
  S.phObs && S.phObs.disconnect();
  if (pl && window.ResizeObserver) (S.phObs = new ResizeObserver(() => $("#main").style.setProperty("--ph", pl.offsetHeight + "px"))).observe(pl);
}
// 空格播放/暂停，左右方向键前进后退（输入框里不响应）
document.addEventListener("keydown", e => {
  const a = $("#audio");
  if (!a || !$("#modal").hidden || e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select, button, [contenteditable]")) return;
  if (e.key === " ") { e.preventDefault(); a.paused ? a.play() : a.pause(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 5); }
  else if (e.key === "ArrowRight") { e.preventDefault(); a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 5); }
});
// 点时间戳跳播；在纪要里点的话，分屏右边的转写稿也滚到对应那段
document.addEventListener("click", e => {
  const t = e.target.closest("a.ts[data-ts]"); if (!t || !$("#audio")) return;
  seek(tsToSec(t.dataset.ts));
  if (!t.closest("#paras")) highlightPlaying(tsToSec(t.dataset.ts) * 1000, true);
});

function renderTab() {
  ({ minutes: tabMinutes, transcript: tabTranscript, notes: tabNotes, qa: tabQA })[S.tab]();
}

function providerOptions() {
  if (!S.settings) return "";
  return S.settings.providers.map(p => `<option value="${p.id}" ${p.id === S.settings.active ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}
async function ensureSettings() { if (!S.settings) S.settings = await api("/api/settings"); }

// 纪要
// 正在生成纪要的会议：id → {text, status, t0}。切到别的标签、页面刷新（转写进度、全天模式推送）后回来，接着显示进度
const GEN = {};
let genErr = null; // 最近一次生成失败 {id, msg}，回到纪要页时显示一次
let mdEditOrig = null; // 纪要编辑框打开时的原文；null = 没在编辑
const mdEditDirty = () => !!($("#mdEdit") && mdEditOrig !== null && $("#mdEdit").value !== mdEditOrig);
// 保存编辑中的纪要（切标签、离开页面、重新生成前调用）；没在编辑或没改动直接返回 true，保存失败返回 false
async function saveMdEditNow() {
  const ta = $("#mdEdit"); if (!ta || mdEditOrig === null || !S.cur) return true;
  const v = ta.value, id = S.cur.meta.id;
  if (v === mdEditOrig) { mdEditOrig = null; return true; }
  try {
    await api(`/api/meetings/${id}`, { method: "PATCH", body: { minutes_markdown: v } });
  } catch (e) { toast("纪要的修改没保存上：" + e.message, 6000); return false; }
  mdEditOrig = null;
  if (S.cur && S.cur.meta.id === id && S.cur.minutes) Object.assign(S.cur.minutes, { markdown: v, edited: true });
  toast("纪要修改已保存");
  return true;
}
async function tabMinutes() {
  await ensureSettings();
  const d = S.cur, m = d.meta, mn = d.minutes, g = GEN[m.id];
  if (!S.cur || S.cur.meta.id !== m.id || S.tab !== "minutes") return;
  const hasText = paras().length > 0;
  const draft = !d.transcript && hasText; // 还没精准转写，只有实时草稿
  const stale = (!g && mn && d.minutes_stale) || [];
  const genMeta = mn ? [mn.provider, mn.model, mn.created.replace("T", " ").slice(0, 16), mn.cost ? `用时 ${mn.cost}s` : "", mn.edited ? "已手动编辑" : ""]
    .filter(Boolean).map(esc).join(" · ") : "";
  const err = genErr && genErr.id === m.id ? genErr.msg : ""; genErr = null;
  const note = stale.includes("transcript")
    ? `<div class="banner warn"><span class="grow">纪要生成后，转写有改动（改了文字或说话人姓名、新的纠错规则、重新转写或续录），纪要里可能还是旧内容。</span><button class="sm" id="regen2">${ic("sparkle")}重新生成</button></div>`
    : stale.includes("notes") ? `<div class="banner warn"><span class="grow">生成纪要后你的笔记有更新，重新生成可以把新笔记也整理进去。</span><button class="sm" id="regen2">${ic("sparkle")}重新生成</button></div>`
    : draft && !g ? `<div class="banner info small"><span class="grow">${["queued", "transcribing"].includes(m.status) || d.ambient_active || d.live_active ? "精准转写还没完成" : "还没有精准转写"}，现在生成会用实时草稿（没有区分说话人）；精准转写完成后建议重新生成。</span></div>` : "";
  $("#tabBody").innerHTML = `<div class="toolbar">
      <select id="tplSel" aria-label="纪要模板">${templateOptions((mn && mn.template) || m.template)}</select>
      <select id="provSel" aria-label="用哪个模型生成">${providerOptions()}</select>
      <button class="pri" id="genBtn" ${hasText && !g ? "" : "disabled"}>${ic("sparkle")}${g ? "生成中…" : mn ? "重新生成" : "生成纪要"}</button>
      ${mn && !g ? `<button id="editBtn">${ic("pencil")}编辑</button>` : ""}
      <span class="gen-meta" id="genState">${g ? esc(g.status) : genMeta}</span></div>
    ${note}
    <div class="card"><div class="md" id="mdBox">${g ? (g.text ? md(g.text) : `<div class="empty">${esc(g.status)}</div>`)
      : err ? `<div class="empty" style="color:var(--red)">${esc(err)}${/本地模型还没启动/.test(err) ? `<div style="margin-top:10px"><button class="sm" id="llmStart">启动本地模型</button></div>` : ""}</div>`
      : mn ? md(mn.markdown) : `<div class="empty">${hasText ? "选择模板后点击“生成纪要”，AI 会整理出会议概要、议题、决议、待办和发言人观点" : "等转写出文字后即可生成纪要"}</div>`}</div></div>`;
  if (g) { const box = $("#mdBox"); box.lastElementChild && g.text && box.lastElementChild.classList.add("cursor"); }
  $("#genBtn").onclick = genMinutes;
  $("#regen2") && ($("#regen2").onclick = genMinutes);
  $("#llmStart") && ($("#llmStart").onclick = e => startLocalLlm(e.currentTarget));
  $("#editBtn") && ($("#editBtn").onclick = () => {
    const box = $("#mdBox"), bar = $("#editBtn").parentElement;
    mdEditOrig = mn.markdown;
    $("#editBtn").remove(); $("#genBtn").disabled = true;
    bar.insertAdjacentHTML("beforeend", `<button class="pri" id="mdSave">${ic("check")}保存</button><button id="mdCancel">取消</button>`);
    box.innerHTML = `<textarea id="mdEdit" style="width:100%;min-height:60vh;font-family:ui-monospace,Menlo,monospace;font-size:13px">${esc(mn.markdown)}</textarea>`;
    $("#mdEdit").focus();
    $("#mdSave").onclick = async () => { if (await saveMdEditNow()) tabMinutes(); };
    $("#mdCancel").onclick = () => { if (mdEditDirty() && !confirm("放弃对纪要的修改？")) return; mdEditOrig = null; tabMinutes(); };
  });
}
async function genMinutes() {
  const d = S.cur, id = d.meta.id, title = d.meta.title;
  if (GEN[id]) return;
  if (!(await saveMdEditNow())) return;
  if (d.minutes && d.minutes.edited && !confirm("纪要已手动编辑过，重新生成会覆盖，确定？")) return;
  const body = { template: $("#tplSel").value, provider: $("#provSel").value };
  const g = GEN[id] = { text: "", status: "准备中…", t0: Date.now() };
  const here = () => S.cur && S.cur.meta.id === id && S.tab === "minutes" && $("#mdBox") && !$("#mdEdit");
  let raf = 0;
  const paint = () => { raf = 0; if (!here()) return; const box = $("#mdBox"); box.innerHTML = md(g.text); box.lastElementChild && box.lastElementChild.classList.add("cursor"); };
  const setSt = t => { g.status = t; here() && ($("#genState").textContent = t); };
  if (here()) { tabMinutes(); }
  try {
    await streamNd(`/api/meetings/${id}/minutes`, body, ev => {
      if (ev.type === "status") setSt(ev.msg);
      else if (ev.type === "delta") { g.text += ev.text; setSt(`生成中… ${g.text.length} 字 · ${Math.round((Date.now() - g.t0) / 1000)}s`); if (!raf) raf = requestAnimationFrame(paint); }
      else if (ev.type === "done") { if (S.cur && S.cur.meta.id === id) S.cur.minutes = ev.minutes; }
      else if (ev.type === "error") throw new Error(ev.msg);
    });
    delete GEN[id];
    if (S.cur && S.cur.meta.id === id) await showMeeting(id); else toast(`「${title}」的纪要已生成`);
    loadMeetings();
  } catch (e) {
    delete GEN[id];
    genErr = { id, msg: e.message };
    toast("生成失败：" + e.message, 6000);
    if (S.cur && S.cur.meta.id === id && S.tab === "minutes") tabMinutes();
  }
}
// 启动本地模型（llama-server）：模型约 38GB，加载要几十秒，按钮上显示进度
async function startLocalLlm(btn) {
  btn && (btn.disabled = true, btn.textContent = "启动中…");
  try { await api("/api/llm/local", { method: "POST", body: { action: "start" } }); } catch (e) { toast(e.message, 6000); btn && (btn.disabled = false, btn.textContent = "启动本地模型"); return; }
  for (let i = 0; i < 180; i++) {
    let st; try { st = await api("/api/llm/local"); } catch { break; }
    if (st.running) { toast("本地模型已启动"); btn && (btn.textContent = "已启动"); return st; }
    if (!st.ours) { toast("本地模型启动失败：" + (st.log || `退出码 ${st.exit_code}`), 8000); break; }
    btn && (btn.textContent = `启动中… ${i * 2}s`);
    await new Promise(r => setTimeout(r, 2000));
  }
  btn && (btn.disabled = false, btn.textContent = "启动本地模型");
}

// 转写稿：一段一行——时间 | 说话人（换人时才写名字）| 文字；栏太窄时名字放到文字上方
function tabTranscript() {
  const d = S.cur, ps = paras(), isLive = !d.transcript, pane = $("#trPane"), root = pane || $("#tabBody");
  if (!root) return;
  const canEdit = !d.ambient_active && !d.live_active && !["queued", "transcribing", "recording"].includes(d.meta.status);
  const hasSpk = ps.some(p => p.spk >= 0);
  const durBy = {}; ps.forEach(p => durBy[spkName(p.spk)] = (durBy[spkName(p.spk)] || 0) + (p.end - p.start));
  const tot = Object.values(durBy).reduce((a, b) => a + b, 0) || 1;
  const spkIds = [...new Set(ps.map(p => p.spk))].sort((a, b) => a - b);
  const gaps = (recHealth(d.meta) || { gaps: [] }).gaps;
  let gi = 0;
  const gapRow = g => `<div class="gapmark"><span>${ic("clock")}${tsLabel(g.at_ms)} 这里有 ${fmtDur(Math.max(1, g.dur_ms / 1000))} 没录到：${GAP_TEXT[g.reason] || GAP_TEXT.stall}</span></div>`;
  const rows = ps.map((p, i) => {
    const first = hasSpk && (i === 0 || ps[i - 1].spk !== p.spk);
    let pre = "";
    while (gi < gaps.length && gaps[gi].at_ms <= p.start) pre += gapRow(gaps[gi++]);
    return pre + `<div class="para${first ? " first" : ""}${p.edited ? " edited" : ""}" data-i="${i}" data-s="${p.start}" data-e="${p.end}"${hasSpk ? ` style="--c:${spkColor(p.spk)}"` : ""}>`
      + `<a class="ts" data-ts="${fmtTs(p.start)}">${tsLabel(p.start)}</a>`
      + (hasSpk ? `<span class="who">${first ? `<b data-spk="${p.spk}" title="${esc(spkName(p.spk))} · 点击改名">${esc(spkName(p.spk))}</b>` : ""}</span>` : "")
      + `<div class="txt"${p.edited ? ` title="已手动修改"` : ""}>${esc(p.text)}</div>`
      + (canEdit ? `<a class="pedit" data-i="${i}" title="修改这段（也可以双击文字）">${ic("pencil")}</a>` : "") + `</div>`;
  }).join("") + (ps.length ? gaps.slice(gi).map(gapRow).join("") : "");
  const keep = ($("#trScroll") || {}).scrollTop || 0;
  root.innerHTML = `
    <div class="tr-tool">${pane ? `<b class="pane-t">转写稿</b>` : ""}
      <input id="tSearch" class="search" placeholder="搜索转写内容"><span class="muted small num" id="tCount"></span>
      <span class="grow"></span><label class="small muted follow"><input type="checkbox" id="follow" ${S.follow ? "checked" : ""}>跟随播放</label></div>
    ${isLive && ps.length ? `<div class="muted small tr-note">当前显示的是实时转写稿，精准转写完成后会自动替换并区分说话人。</div>` : ""}
    ${!isLive && (d.suspects || []).length ? `<div class="banner small hw-sus"><span class="muted">可能认错的热词</span>${d.suspects.map((s, i) =>
      `<span class="hw-item"><a class="ts" data-ts="${fmtTs(s.at[0])}" title="跳到第一处，听一下">${esc(s.text)}</a><span class="muted">→ ${esc(s.hotword)}${s.count > 1 ? ` · ${s.count} 处` : ""}</span>`
      + (canEdit ? `<button class="sm" data-sus="${i}" title="加一条纠错规则：以后所有记录里的“${esc(s.text)}”都显示成“${esc(s.hotword)}”">改</button>` : "") + `</span>`).join("")}</div>` : ""}
    ${hasSpk ? `<div class="spk-chips">${spkIds.map(s => `<span class="chip" data-spk="${s}" title="点击改名；改成同一个名字即合并"><i class="dot" style="background:${spkColor(s)}"></i>${esc(spkName(s))}
      <span class="muted num">${Math.round((durBy[spkName(s)] || 0) / tot * 100)}%</span></span>`).join("")}${!isLive && canEdit && spkIds.length > 1
        ? `<button class="sm ghost" id="guessNames" title="让 AI 从转写里找自我介绍、点名后回应这类线索，推测说话人是谁；你确认后才改名">推测姓名</button>` : ""}</div>` : ""}
    <div class="tr-scroll" id="trScroll"><div id="paras" class="${hasSpk ? "" : "nospk"}">${rows
      || `<div class="empty">${["queued", "transcribing"].includes(d.meta.status) ? "转写中…" : "没有识别到语音内容"}</div>`}</div></div>`;
  if (pane) $("#trScroll").scrollTop = keep;
  hoverFill($("#paras"), ".para");
  $("#follow").onchange = e => { S.follow = e.target.checked; };
  $$("[data-spk]", root).forEach(el => el.onclick = () => renameSpeaker(+el.dataset.spk));
  $("#guessNames", root) && ($("#guessNames", root).onclick = () => guessNames());
  $$("[data-sus]", root).forEach(el => el.onclick = async () => {
    const s = d.suspects[+el.dataset.sus]; el.disabled = true;
    try { await api("/api/vocab/fix", { method: "POST", body: { from: s.text, to: s.hotword } }); }
    catch (e) { el.disabled = false; return toast("没改成：" + e.message, 5000); }
    toast(`已加纠错规则：${s.text} → ${s.hotword}`); await showMeeting(d.meta.id);
  });
  $$(".pedit", root).forEach(el => el.onclick = () => editPara(+el.dataset.i));
  $$(".para .txt", root).forEach(el => { if (canEdit) el.ondblclick = () => editPara(+el.closest(".para").dataset.i); });
  $("#tSearch").oninput = e => {
    const q = e.target.value.trim(); let n = 0, first = null; const hits = [];
    $$(".para", root).forEach(el => {
      const p = ps[+el.dataset.i], t = $(".txt", el);
      if (!q) { t.innerHTML = esc(p.text); return; }
      const parts = p.text.split(q); n += parts.length - 1;
      t.innerHTML = parts.map(esc).join(`<mark>${esc(q)}</mark>`);
      if (parts.length > 1) { hits.push(el); first = first || el; }
    });
    $("#tCount").textContent = q ? `${n} 处匹配` : "";
    sbMarks(pane ? $("#trScroll") : $("#main"), hits);
    first && scrollToPara(first, true);
  };
  renderPartial(true); // 重建转写稿后接上正在说的那一行，免得兜底刷新时闪一下
}
// 修改一段转写：改字、改说话人、清空即删除；改字后提示把改法存进纠错表
function editPara(i) {
  const d = S.cur, id = d.meta.id, ps = paras(), p = ps[i], el = $(`.para[data-i="${i}"]`);
  if (!p || !el || $("#peText")) return;
  const hasSpk = !!d.transcript;
  const ids = [...new Set(ps.map(x => x.spk))].filter(s => s >= 0).sort((a, b) => a - b);
  const next = ids.length ? Math.max(...ids) + 1 : 0;
  const box = $(".txt", el);
  box.innerHTML = `<textarea id="peText" class="pe-text">${esc(p.text)}</textarea>
    <div class="muted small" style="margin-top:4px">清空文字再保存 = 删除这段<span class="kbd"> · ⌘↩ 保存 · Esc 取消</span></div>
    <div class="row small" style="gap:8px;margin-top:6px;flex-wrap:wrap">
      ${hasSpk ? `<select id="peSpk" title="说话人">${ids.map(s => `<option value="${s}" ${s === p.spk ? "selected" : ""}>${esc(spkName(s))}</option>`).join("")}
        <option value="${next}">新说话人（${esc(spkName(next))}）</option></select>` : ""}
      <span class="grow"></span><button class="sm" id="peCancel">取消</button><button class="sm pri" id="peSave">保存</button></div>`;
  const ta = $("#peText", box);
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
  fit(); ta.oninput = fit; ta.focus();
  const save = async () => {
    const text = ta.value.trim(), body = {};
    if (text !== p.text) body.text = text;
    if (hasSpk && +$("#peSpk", box).value !== p.spk) body.spk = +$("#peSpk", box).value;
    if (!Object.keys(body).length) return tabTranscript();
    if (text === "" && !confirm("删除这段转写？")) return;
    try {
      const r = await api(`/api/meetings/${id}/paragraphs/${i}`, { method: "PUT", body });
      Object.assign(S.cur, { meta: r.meta, transcript: r.transcript, live: r.live });
    } catch (e) { return toast(e.message, 4000); }
    tabTranscript();
    if (body.text) suggestFix(p.text, text);
  };
  $("#peSave", box).onclick = save;
  $("#peCancel", box).onclick = () => tabTranscript();
  ta.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); else if (e.key === "Escape") tabTranscript(); };
}
// 找出改动的那几个字；太短（1 个字）容易误伤，向两边扩到至少 2 个字
function diffFix(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const cut = () => [a.slice(i, a.length - j), b.slice(i, b.length - j)];
  let [from, to] = cut();
  while (from.length < 2 && (i > 0 || j > 0)) { if (i > 0 && !/[，。？！、；：,.?!;:\s]/.test(a[i - 1])) i--; else if (j > 0) j--; else break; [from, to] = cut(); }
  return { from: from.trim(), to: to.trim() };
}
async function suggestFix(oldText, newText) {
  const { from, to } = diffFix(oldText, newText);
  const strip = s => s.replace(/[\s，。？！、；：,.?!;:“”"']/g, "");
  if (!from || !to || from.length > 16 || to.length > 16 || strip(from) === strip(to)) return toast("已保存");
  // 把被纠错规则改掉的词改回原样（如人名“艾森”被规则改成了 ASIN）：这一段以后不再套规则，不要再建议一条反向规则
  const v = await api("/api/vocab").catch(() => ({ fixes: [] }));
  const rev = v.fixes.find(f => f.to && to.toLowerCase().includes(f.from.toLowerCase()) && from.toLowerCase().includes(f.to.toLowerCase()));
  if (rev) return toast(`已保存。这段是手动改过的，纠错规则「${rev.from} → ${rev.to}」不会再改动它`, 5000);
  const count = f => paras().reduce((n, p) => n + (p.text.toLowerCase().split(f.toLowerCase()).length - 1), 0);
  const dlg = modal(`<h2>以后自动纠正这个错吗？</h2>
    <p class="muted">加入纠错表后，所有记录（包括以前的）里相同的写法都会自动改正；删掉规则即恢复原文。词太短容易误伤，可以先调整范围。</p>
    <div class="row" style="margin:12px 0;gap:8px"><input id="fxFrom" class="grow" value="${esc(from)}"><span>→</span><input id="fxTo" class="grow" value="${esc(to)}"></div>
    <div class="muted small" id="fxPrev"></div>
    <label class="small" style="display:block;margin-top:8px"><input type="checkbox" id="fxHot" ${/[\u4e00-\u9fff]/.test(to) && to.length >= 2 ? "checked" : ""}> 同时把「<span id="fxHotW">${esc(to)}</span>」加入常用热词（帮助以后直接识别对）</label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button id="fxNo">只改这一处</button><button class="pri" id="fxYes">加入纠错表</button></div>`);
  const prev = () => { const f = $("#fxFrom", dlg).value.trim(); $("#fxPrev", dlg).textContent = f ? `本场还有 ${count(f)} 处「${f}」会被改正` : ""; $("#fxHotW", dlg).textContent = $("#fxTo", dlg).value.trim(); };
  prev(); $("#fxFrom", dlg).oninput = prev; $("#fxTo", dlg).oninput = prev;
  $("#fxNo", dlg).onclick = () => { closeModal(); toast("已保存"); };
  $("#fxYes", dlg).onclick = async () => {
    const f = $("#fxFrom", dlg).value.trim(), t = $("#fxTo", dlg).value.trim();
    if (!f || f === t) return toast("规则不完整");
    if (f.length < 2 && !confirm(`「${f}」只有一个字，可能把别的地方也改掉，确定？`)) return;
    try { await api("/api/vocab/fix", { method: "POST", body: { from: f, to: t, hotword: $("#fxHot", dlg).checked } }); }
    catch (e) { return toast(e.message); }
    closeModal(); await showMeeting(S.cur.meta.id); toast(`已加入纠错表：${f} → ${t}`);
  };
}
// 高亮正在播放的段；跟随播放时滚到可见处。reveal：不管是否跟随，都把这个时间点所在的段滚出来
function highlightPlaying(ms, reveal = false) {
  const box = $("#paras"); if (!box) return;
  const all = $$(".para", box);
  let cur = null;
  all.forEach(el => { const on = ms >= +el.dataset.s && ms < +el.dataset.e + 300; el.classList.toggle("active", on); if (on) cur = el; });
  if (reveal) { cur = cur || all.filter(el => +el.dataset.s <= ms).pop(); cur && scrollToPara(cur); }
  else if (cur && S.follow && !$("#audio").paused) scrollToPara(cur);
}
// 把一段滚到转写区中间（已在可见范围内就不动，center=true 时总是居中）
function scrollToPara(el, center = false) {
  const pane = $("#trPane"), sc = pane ? $("#trScroll") : $("#main");
  if (!sc) return;
  const cr = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (!center && r.top >= cr.top + (pane ? 8 : 120) && r.bottom <= cr.bottom - 40) return;
  sc.scrollTo({ top: sc.scrollTop + (r.top - cr.top) - (sc.clientHeight - r.height) / 2, behavior: "smooth" });
}
// 推测姓名：服务端核对过摘句的候选，用户勾选、可改名字后才保存
async function guessNames() {
  const d = S.cur, id = d.meta.id;
  const dlg = modal(`<h2>推测说话人姓名</h2><p class="muted" id="gnSt">AI 正在从转写里找自我介绍、点名后回应这类线索…</p><div id="gnBody"></div>`);
  let r;
  try { r = await api(`/api/meetings/${id}/speaker-names`, { method: "POST", body: {} }); }
  catch (e) { $("#gnSt", dlg).textContent = "没推测出来：" + e.message; $("#gnBody", dlg).innerHTML = `<div class="row" style="justify-content:flex-end"><button onclick="closeModal()">关闭</button></div>`; return; }
  if (!S.cur || S.cur.meta.id !== id) return;
  const cs = r.candidates || [];
  $("#gnSt", dlg).innerHTML = cs.length
    ? `下面是有原话为证的推测（${esc(r.provider)}，${r.cost}s）。只是推测：先点时间听一下，确认后勾选再改名。`
    : `转写里没有找到能确定身份的直接线索（自我介绍、点名后回应等），没有可推荐的名字。`;
  $("#gnBody", dlg).innerHTML = (cs.length ? `<div class="gn-list">${cs.map((c, i) => `<div class="gn-row">
      <label class="gn-head"><input type="checkbox" data-gi="${i}"> ${esc(spkName(c.spk))} →
        <input class="gn-name" data-gn="${i}" value="${esc(c.name)}"> <span class="muted small">把握：${esc(c.confidence)}</span></label>
      <div class="muted small">${esc(c.reason)}</div>
      ${c.evidence.map(e => `<div class="small gn-ev"><a class="ts" data-ts="${esc(e.ts)}">[${esc(e.ts)}]</a> ${esc(spkName(e.spk))}：${esc(e.quote)}</div>`).join("")}</div>`).join("")}</div>` : "")
    + `<div class="row" style="justify-content:flex-end;margin-top:12px"><button onclick="closeModal()">${cs.length ? "取消" : "关闭"}</button>${cs.length ? `<button class="pri" id="gnOk">按勾选的改名</button>` : ""}</div>`;
  const ok = $("#gnOk", dlg); if (!ok) return;
  ok.onclick = async () => {
    const sp = { ...(S.cur.meta.speakers || {}) }; let n = 0;
    $$("[data-gi]", dlg).forEach(cb => { if (!cb.checked) return; const c = cs[+cb.dataset.gi], v = $(`[data-gn="${cb.dataset.gi}"]`, dlg).value.trim(); if (v) { sp[String(c.spk)] = v; n++; } });
    if (!n) return toast("没有勾选要改名的说话人");
    try { S.cur.meta = await api(`/api/meetings/${id}`, { method: "PATCH", body: { speakers: sp } }); }
    catch (e) { return toast("改名没保存上：" + e.message, 5000); }
    closeModal(); toast(`已改名 ${n} 位说话人`); await showMeeting(id);
  };
}
function renameSpeaker(spk) {
  const cur = spkName(spk);
  const names = [...new Set(Object.values(S.cur.meta.speakers || {}))];
  const dlg = modal(`<h2>修改发言人姓名</h2><p class="muted">“${esc(cur)}”的所有发言都会改名。改成已有的名字即可合并两个说话人。</p>
    <input id="nName" style="width:100%;margin:10px 0" value="${esc(cur)}" list="nameList"><datalist id="nameList">${names.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    <div class="row" style="justify-content:flex-end"><button onclick="closeModal()">取消</button><button class="pri" id="nOk">保存</button></div>`);
  const inp = $("#nName", dlg); inp.select();
  const ok = async () => {
    const v = inp.value.trim(); const sp = { ...(S.cur.meta.speakers || {}) };
    if (v && v !== `说话人${spk + 1}`) sp[String(spk)] = v; else delete sp[String(spk)];
    try { S.cur.meta = await api(`/api/meetings/${S.cur.meta.id}`, { method: "PATCH", body: { speakers: sp } }); }
    catch (e) { return toast("改名没保存上：" + e.message, 5000); }
    closeModal(); await showMeeting(S.cur.meta.id); // 整页刷新：纪要页的“已过期”提示、播放器色条跟着更新
  };
  $("#nOk", dlg).onclick = ok; inp.onkeydown = e => e.key === "Enter" && ok();
}

// 笔记
function tabNotes() {
  $("#tabBody").innerHTML = `<div class="card"><div class="row" style="margin-bottom:8px"><span class="muted small grow">笔记会作为生成纪要的重点参考，自动保存</span>
    <button class="sm lt" id="insTs">${ic("clock")}插入当前播放时间</button></div>
    <textarea class="notes-area" id="notes" style="height:60vh" placeholder="记录重点、决定、待办……">${esc(S.cur.notes)}</textarea>
    <div class="muted small" id="noteState"></div></div>`;
  bindNotes();
  $("#insTs").onclick = () => insertAtCursor($("#notes"), `[${fmtTs(($("#audio") ? $("#audio").currentTime : 0) * 1000)}] `);
}

// 问答
async function tabQA() {
  await ensureSettings();
  const d = S.cur, id = d.meta.id;
  const sugg = ["这次会议的主要结论是什么？", "有哪些待办？分别是谁负责？", "讨论中有哪些分歧或风险？", "帮我写一封会后跟进邮件"];
  $("#tabBody").innerHTML = `<div class="qa-list" id="qaList">${(d.qa || []).map(h => `<div class="q">${esc(h.q)}</div><div class="a md">${md(h.a)}</div>`).join("")}</div>
    ${!(d.qa || []).length ? `<div class="sugg">${sugg.map(s => `<button class="sm">${s}</button>`).join("")}</div>` : ""}
    <div class="qa-input"><select id="provSel" style="max-width:180px" title="用哪个模型回答" aria-label="用哪个模型回答">${providerOptions()}</select><input id="qIn" placeholder="就这场会议提问，例如：张伟负责哪些事？" enterkeyhint="send"><button class="pri" id="qGo" aria-label="发送">${ic("send")}<span class="lbl">发送</span></button>
      ${(d.qa || []).length ? `<button class="ghost" id="qClr" title="清空问答" aria-label="清空问答">${ic("trash")}<span class="lbl">清空</span></button>` : ""}</div>`;
  $$(".sugg button").forEach(b => b.onclick = () => { $("#qIn").value = b.textContent; send(); });
  $("#qClr") && ($("#qClr").onclick = async () => {
    if (!confirm(`清空这场会议的全部 ${d.qa.length} 条问答？清空后不能恢复。`)) return;
    try { await api(`/api/meetings/${id}/qa`, { method: "DELETE" }); } catch (e) { return toast("清空失败：" + e.message, 5000); }
    d.qa = []; tabQA();
  });
  let sending = false; // 回答还没出完时不能再发（回车也不行），否则两条问答会互相覆盖
  const send = async () => {
    const q = $("#qIn").value.trim(); if (!q || sending) return;
    sending = true;
    $("#qIn").value = ""; $("#qGo").disabled = true; $("#qIn").placeholder = "正在回答，请稍候…"; $(".sugg") && $(".sugg").remove();
    const list = $("#qaList");
    list.insertAdjacentHTML("beforeend", `<div class="q">${esc(q)}</div><div class="a md cursor">…</div>`);
    const box = list.lastElementChild; let text = "";
    box.scrollIntoView({ block: "end" });
    try {
      await streamNd(`/api/meetings/${id}/ask`, { question: q, provider: $("#provSel").value }, ev => {
        if (ev.type === "delta") { text += ev.text; box.innerHTML = md(text); }
        else if (ev.type === "error") throw new Error(ev.msg);
      });
      box.classList.remove("cursor");
      (d.qa = d.qa || []).push({ q, a: text });
    } catch (e) { box.classList.remove("cursor"); box.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
    sending = false;
    if ($("#qGo")) { $("#qGo").disabled = false; $("#qIn").placeholder = "就这场会议提问，例如：张伟负责哪些事？"; }
  };
  $("#qGo").onclick = send;
  $("#qIn").onkeydown = e => e.key === "Enter" && !e.isComposing && send();
}

// ---------------- 设置 ----------------
async function openSettings() {
  S.settings = await api("/api/settings");
  const s = S.settings;
  const ac = (S.amb && S.amb.cfg) || {};
  const asr = await api("/api/asr").catch(() => null);
  const vocab = await api("/api/vocab").catch(() => ({ hotwords: "", fixes: [] }));
  const fixRow = f => `<div class="row fx-row" style="gap:6px;margin-bottom:6px"><input class="fx-from grow" placeholder="识别成" value="${esc(f.from)}"><span class="muted">${ic("right")}</span>
    <input class="fx-to grow" placeholder="应为" value="${esc(f.to)}"><button class="sm ghost danger fx-del" title="删除">${ic("x")}</button></div>`;
  const card = (p, i) => `<div class="prov ${p.id === s.active ? "on" : ""}" data-i="${i}">
    <div class="row"><label class="row grow" style="gap:6px;cursor:pointer"><input type="radio" name="active" title="设为默认" ${p.id && p.id === s.active ? "checked" : ""}>
      <input class="p-name" value="${esc(p.name)}" style="font-weight:500;background-color:transparent;width:70%"></label>
      <button class="sm p-test">测试连接</button><button class="sm ghost danger p-del">删除</button></div>
    <div class="grid">
      <div><label class="f">接口地址（OpenAI 兼容）</label><input class="p-url" value="${esc(p.base_url)}"></div>
      <div><label class="f">模型名</label><input class="p-model" value="${esc(p.model)}"></div>
      <div><label class="f">API Key ${p.api_key_from_env ? `<span class="tag">已从环境变量 ${p.env_key} 读取</span>` : ""}
          ${p.api_key_masked ? `<a class="p-clr small" style="float:right;cursor:pointer;color:var(--muted)">清除已保存的 Key</a>` : ""}</label>
        <input class="p-key" type="password" placeholder="${p.api_key_masked ? "已设置 " + esc(p.api_key_masked) + "（留空不修改）" : "未设置"}"></div>
      <div><label class="f">单次最多输入字数（超出则分段总结）</label><input class="p-max" type="number" value="${p.max_input_chars}"></div>
      <div style="grid-column:1/-1"><label class="f">额外请求参数（JSON，可选）</label><input class="p-extra" value='${esc(JSON.stringify(p.extra_body || {}))}'></div>
    </div>${p.id === "local" ? `<div class="row small p-llm" style="margin-top:8px;gap:8px"><span class="muted">本地模型状态：检查中…</span></div>` : ""}
    <div class="small p-res" style="margin-top:6px"></div></div>`;
  const dlg = modal(`<h2>AI 纪要模型</h2>
    <p class="muted small">纪要、问答和当日汇总会把转写文字发给下面选中（圆点）的模型。选“本地”则完全离线，用之前在下面点“启动本地模型”。</p>
    <div id="provs">${s.providers.map(card).join("") || `<div class="muted small" style="padding:8px 0">还没有模型接口：点“恢复默认接口”加回阿里百炼、DeepSeek 和本地模型，或添加其他接口。</div>`}</div>
    <div class="row"><button class="lt" id="addProv">${ic("plus")}添加其他接口</button><button class="lt" id="restoreProv">${ic("refresh")}恢复默认接口</button></div>
    ${asr ? `<div class="sec"><h2>语音识别</h2>
    <label class="f">识别模型（对之后的录音生效；已有记录可点“重新转写”）</label>
    <select id="asrModel" style="width:100%">${Object.entries(asr.options).map(([k, v]) => `<option value="${k}" ${k === asr.model ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
    <div class="small row" id="asrSt" style="margin-top:6px;gap:8px"></div>
    ${asr.diarizers ? `<label class="f" style="margin-top:10px">区分说话人（对之后的转写生效）</label>
    <select id="asrDiar" style="width:100%">${Object.entries(asr.diarizers).map(([k, v]) => `<option value="${k}" ${k === asr.diarizer ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>` : ""}</div>` : ""}
    <div class="sec"><h2>词库</h2>
    <p class="muted small">常用热词帮助识别（同事姓名、项目名、术语），所有录音都会用；只填真正常说的词，太多反而干扰。
      纠错规则把固定认错的写法替换成正确的（如“艾森 → ASIN”），对已有记录也立即生效，删掉即恢复原文；在转写稿里改字时也可以一键加入。</p>
    <label class="f">常用热词（空格分隔）</label><input id="vHot" style="width:100%" value="${esc(vocab.hotwords)}">
    <label class="f" style="margin-top:10px">纠错规则（${vocab.fixes.length} 条）</label>
    <div id="vFix">${vocab.fixes.map(fixRow).join("")}</div><button class="sm lt" id="vAdd">${ic("plus")}添加规则</button></div>
    <div class="sec"><h2>全天模式</h2>
    <div class="grid2">
      <div><label class="f">麦克风</label><select id="aDev" style="width:100%"><option value="">系统默认输入</option>
        ${ac.device ? `<option value="${esc(ac.device)}" selected>${esc(ac.device)}</option>` : ""}</select></div>
      <div><label class="f">收音灵敏度</label><select id="aSens" style="width:100%">${[["normal", "标准：只录离得近、清楚的人声"], ["high", "高（推荐）：离得远、小声也能录到"], ["max", "很高：再远也录，可能把杂音当说话"]]
        .map(([k, t]) => `<option value="${k}" ${k === (ac.sensitivity || "high") ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label class="f">静音多少分钟算一段对话结束</label><input id="aSplit" type="number" min="1" max="60" step="0.5" value="${ac.split_min ?? 5}"></div>
      <div><label class="f">发言少于多少秒的片段不保存</label><input id="aMin" type="number" min="0" max="600" value="${ac.min_speech_s ?? 20}"></div>
      <div><label class="f">单段对话最长（分钟，超出自动切开）</label><input id="aMax" type="number" min="10" max="240" value="${ac.max_conv_min ?? 120}"></div>
      <div><label class="f">每天自动生成汇总的时间（留空不自动）</label><input id="aSum" type="time" value="${esc(ac.summary_time || "")}"></div>
      <div><label class="f">自动记录的录音保留天数（0 = 永久；文字一直保留）</label><input id="aKeep" type="number" min="0" value="${ac.audio_keep_days ?? 30}"></div>
      <div style="align-self:end"><label class="small"><input type="checkbox" id="aAwake" ${ac.keep_awake !== false ? "checked" : ""}> 开启期间阻止电脑空闲休眠（屏幕照常熄灭）</label></div>
    </div></div>
    <div class="sec"><h2>平板、手机访问</h2>
    <p class="muted small">打开后，和这台电脑连着同一个 Wi-Fi 的 iPad、手机可以用浏览器打开会议记录：查看、整理、生成纪要，也能用它们的麦克风录音。
      只有输对访问口令的设备才能进来；在这台电脑上打开不需要口令。</p>
    <div id="lanBox" class="small muted">检查中…</div></div>
    <div class="row" style="margin-top:22px"><span class="grow"></span><button onclick="closeModal()">取消</button><button class="pri" id="saveSet">保存</button></div>`);
  api("/api/ambient/devices").then(r => {
    const sel = $("#aDev", dlg); if (!sel) return;
    // 选好的外接麦克风暂时没连着也要留在列表里，否则一保存就被改回“系统默认”，设备回来后也不会切回去
    const off = ac.device && !r.devices.includes(ac.device);
    sel.innerHTML = `<option value="">系统默认输入</option>` + r.devices.map(n => `<option ${n === ac.device ? "selected" : ""}>${esc(n)}</option>`).join("")
      + (off ? `<option value="${esc(ac.device)}" selected>${esc(ac.device)}（未连接，暂用系统默认）</option>` : "");
  }).catch(() => {});
  // ASR 模型状态：Nano 加载中 / 加载失败（可重试）
  const asrStatus = async () => {
    const box = $("#asrSt", dlg); if (!box) return;
    const a = await api("/api/asr").catch(() => null); if (!a || !dlg.isConnected) return;
    const wantNano = ["nano", "hanbao"].includes(a.model);
    box.innerHTML = a.nano_loading ? `<span class="muted">正在加载 Fun-ASR-Nano（约 15 秒），这期间实时文字会暂停…</span>`
      : wantNano && a.nano_error ? `<span style="color:var(--red)" class="grow">Fun-ASR-Nano 加载失败，暂用 Paraformer：${esc(a.nano_error.slice(0, 120))}</span><button class="sm" id="asrRetry">重试加载</button>`
      : wantNano && a.nano_loaded ? `<span class="muted">✓ Fun-ASR-Nano 已加载</span>` : "";
    $("#asrRetry", dlg) && ($("#asrRetry", dlg).onclick = async () => { await api("/api/asr", { method: "PUT", body: { model: a.model } }).catch(e => toast(e.message)); asrStatus(); });
    if (a.nano_loading) setTimeout(asrStatus, 2000);
  };
  asrStatus();
  // 本地模型（llama-server）：显示是否在运行，可以直接启动/停止
  const llmStatus = async () => {
    const box = $(".p-llm", dlg); if (!box) return;
    const st = await api("/api/llm/local").catch(() => null); if (!st || !dlg.isConnected) return;
    box.innerHTML = st.running ? `<span style="color:var(--green)">✓ 本地模型正在运行</span>${st.ours ? `<button class="sm" id="llmStop">停止（释放约 38GB 内存）</button>` : ""}`
      : st.starting ? `<span class="muted">本地模型启动中…（加载约 38GB，需要几十秒）</span>`
      : `<span class="muted grow">本地模型没有运行${st.exit_code != null && st.log ? `，上次启动失败：${esc(st.log.split("\n").pop().slice(0, 100))}` : ""}</span>
         ${st.script ? `<button class="sm" id="llmGo">启动本地模型</button>` : `<span class="muted">（找不到启动脚本 scripts/start-local-llm.sh）</span>`}`;
    $("#llmGo", dlg) && ($("#llmGo", dlg).onclick = async e => { await startLocalLlm(e.currentTarget); llmStatus(); });
    $("#llmStop", dlg) && ($("#llmStop", dlg).onclick = async () => {
      try { await api("/api/llm/local", { method: "POST", body: { action: "stop" } }); } catch (e) { toast(e.message, 5000); }
      llmStatus();
    });
    if (st.starting) setTimeout(llmStatus, 3000);
  };
  llmStatus();
  // 平板、手机访问（局域网 HTTPS + 访问口令）：开关、口令、端口立即生效，开着时显示地址和二维码
  let lanLast = null;
  const lanPut = async body => {
    const st = $("#lanSt", dlg);
    st && (st.innerHTML = `<span class="muted">${body.enabled ? "正在开启…（第一次要生成证书，几秒钟）" : "正在保存…"}</span>`);
    try { lanRender(await api("/api/lan", { method: "PUT", body: { port: +$("#lanPort", dlg).value, password: $("#lanPw", dlg).value, ...body } })); return true; }
    catch (e) { toast(e.message, 5000); lanRender(await api("/api/lan").catch(() => lanLast)); return false; }
  };
  const lanRender = st => {
    const box = $("#lanBox", dlg); if (!box || !st) return;
    lanLast = st; box.className = "";
    if (!st.local) {
      box.innerHTML = `<p class="small" style="margin-top:0">你正在通过局域网访问这台电脑。开关和访问口令只能在电脑上修改。</p><a class="btn" href="/lan/logout">退出登录</a>`;
      return;
    }
    const sel = Math.min(S.lanSel || 0, Math.max(0, st.urls.length - 1));
    box.innerHTML = `
      <label class="row" style="gap:10px;cursor:pointer;flex-wrap:nowrap"><span class="switch"><input type="checkbox" id="lanOn" ${st.enabled ? "checked" : ""}><i></i></span><b>允许同一网络里的设备访问</b></label>
      <div class="grid2" style="margin-top:12px">
        <div><label class="f">访问口令（至少 6 位）</label><input id="lanPw" type="password" autocomplete="new-password" style="width:100%" placeholder="${st.has_password ? "已设置（留空不修改）" : "还没有设置"}"></div>
        <div><label class="f">端口</label><div class="row" style="gap:8px;flex-wrap:nowrap"><input id="lanPort" type="number" min="1024" max="65535" class="grow" style="min-width:0" value="${st.port}">
          <button class="sm" id="lanSave">保存口令和端口</button></div></div>
      </div>
      ${st.ca_replaced ? `<div class="banner warn small" style="margin:12px 0 0">证书在 ${new Date(st.ca_replaced * 1000).toLocaleDateString()} 换成了带“名称限制”的新证书：就算证书文件被人拿走，也冒充不了任何公网网站。
        <b>之前在手机上装过旧证书的</b>：到“设置 → 通用 → VPN 与设备管理”删掉旧的“会议记录 本机根证书”，再从登录页重新下载安装、打开信任开关。</div>` : ""}
      <div class="small" id="lanSt" style="margin-top:10px">${st.running ? `<span style="color:var(--green)">✓ 已开启</span>`
        : st.error ? `<span style="color:var(--red)">没有开启：${esc(st.error)}</span>` : `<span class="muted">未开启</span>`}</div>
      ${st.running && st.urls.length ? `<div class="lan-urls"><div class="lan-qr" id="lanQr">${st.urls[sel].qr}</div>
        <div class="lan-list">${st.urls.map((u, i) => `<a class="lan-url${i === sel ? " on" : ""}" data-i="${i}"><b>${esc(u.url)}</b><small>${esc(u.label)}</small></a>`).join("")}
          <span class="muted small">用手机相机扫二维码，或者在浏览器里输入地址；点地址可以复制</span></div></div>
        <details class="steps"><summary>第一次在手机、平板上打开</summary><ol>
          <li>手机连上和这台电脑同一个 Wi-Fi，扫上面的二维码。</li>
          <li>浏览器提示“不是私密连接 / 不安全”：这是电脑自己签发的证书。iPhone 点“显示详细信息 → 访问此网站”，安卓 Chrome 点“高级 → 继续前往”。</li>
          <li>输入访问口令登录，这台设备 30 天内不用再输。</li>
          <li><b>建议装上证书</b>（不装每次都有警告，部分 iOS 版本上录音会连不上）：在登录页点“下载证书”，按页面上的步骤安装并信任。证书指纹：<span class="fp">${esc(st.ca_sha256 || "")}</span></li>
          ${st.firewall ? `<li>电脑的防火墙开着：第一次有设备连进来时，电脑可能弹窗问是否允许“python”接受传入连接，请点“允许”。</li>` : ""}
          <li>电脑睡眠时手机连不上；开着全天模式时电脑不会自动睡眠。</li></ol></details>
        <details class="steps"><summary>手机、平板打不开？按这个顺序查</summary><ol>
          <li>手机是不是连着<b>同一个 Wi-Fi</b>：用 4G/5G、连着“访客网络”都连不上电脑。</li>
          <li>公司、酒店、商场的 Wi-Fi 常开着<b>客户端隔离</b>（同一个 Wi-Fi 里的设备互相看不见）：让电脑连手机热点，或者两边都装 Tailscale 后用 Tailscale 地址。</li>
          <li><b>用名字（.local）打不开</b>：部分安卓手机和路由器不支持，改用上面的 IP 地址。</li>
          <li><b>用 IP 打不开</b>：电脑换过网络或重连 Wi-Fi 后 IP 会变，收藏的旧地址就失效了，重新扫这里最新的二维码。</li>
          <li>电脑睡眠或合上盖子时连不上。${st.firewall ? "电脑的防火墙开着：到“系统设置 → 网络 → 防火墙 → 选项”里允许 python 接受传入连接。" : ""}</li>
          <li><b>用微信扫的码</b>：会在微信里打开，证书提示和录音都可能不正常，点右上角“…”选“在浏览器打开”。</li></ol></details>
        <div class="row" style="margin-top:10px"><button class="sm ghost danger" id="lanKick">让所有已登录的设备退出</button></div>` : ""}`;
    $("#lanOn", dlg).onchange = e => lanPut({ enabled: e.target.checked });
    $("#lanSave", dlg).onclick = () => lanPut({ enabled: st.enabled }).then(ok => ok && toast("已保存"));
    $$(".lan-url", dlg).forEach(a => a.onclick = () => {
      S.lanSel = +a.dataset.i; $("#lanQr", dlg).innerHTML = st.urls[S.lanSel].qr;
      $$(".lan-url", dlg).forEach(x => x.classList.toggle("on", x === a));
      navigator.clipboard && navigator.clipboard.writeText(st.urls[S.lanSel].url).then(() => toast("已复制地址"), () => {});
    });
    $("#lanKick", dlg) && ($("#lanKick", dlg).onclick = async () => {
      if (!confirm("让所有已登录的平板、手机退出？它们要重新输入访问口令才能进来。")) return;
      try { lanRender(await api("/api/lan/logout-all", { method: "POST" })); toast("已让所有设备退出"); } catch (e) { toast(e.message, 5000); }
    });
  };
  api("/api/lan").then(lanRender).catch(() => { const b = $("#lanBox", dlg); b && (b.textContent = "读取局域网访问状态失败"); });
  // 调小录音保留天数会马上删掉一批旧录音：先说清楚删多少段
  const confirmPurge = async () => {
    const nk = +$("#aKeep", dlg).value, ok = ac.audio_keep_days ?? 30;
    if (!(nk > 0 && (ok === 0 || nk < ok))) return true;
    const r = await api("/api/ambient/purge-preview?days=" + nk).catch(() => ({ count: 0 }));
    return !r.count || confirm(`录音保留天数改成 ${nk} 天后，会删除 ${r.count} 段超过 ${nk} 天的自动记录录音（转写文字和纪要保留，删除后不能恢复）。确定？`);
  };
  const saveAmb = async () => {
    S.amb = await api("/api/ambient/config", { method: "PUT", body: {
      device: $("#aDev", dlg).value, sensitivity: $("#aSens", dlg).value, split_min: +$("#aSplit", dlg).value, min_speech_s: +$("#aMin", dlg).value,
      max_conv_min: +$("#aMax", dlg).value, summary_time: $("#aSum", dlg).value, audio_keep_days: +$("#aKeep", dlg).value, keep_awake: $("#aAwake", dlg).checked } });
    renderAmb();
  };
  const bindFix = () => $$(".fx-del", dlg).forEach(b => b.onclick = () => b.closest(".fx-row").remove());
  bindFix();
  $("#vAdd", dlg).onclick = () => { $("#vFix", dlg).insertAdjacentHTML("beforeend", fixRow({ from: "", to: "" })); bindFix(); $$(".fx-from", dlg).pop().focus(); };
  const saveVocab = () => api("/api/vocab", { method: "PUT", body: { hotwords: $("#vHot", dlg).value,
    fixes: $$(".fx-row", dlg).map(r => ({ from: $(".fx-from", r).value, to: $(".fx-to", r).value })) } });
  const collect = () => ({
    // 默认接口按序号传：刚添加、还没保存过的接口没有 id
    active_index: $$(".prov", dlg).findIndex(el => $("input[name=active]", el).checked),
    providers: $$(".prov", dlg).map(el => {
      const p = s.providers[+el.dataset.i] || {};
      return { id: p.id, env_key: p.env_key, name: $(".p-name", el).value, base_url: $(".p-url", el).value, model: $(".p-model", el).value,
        api_key: $(".p-key", el).value, keep_key: !el.dataset.clearKey, max_input_chars: +$(".p-max", el).value, extra_body: $(".p-extra", el).value };
    }),
  });
  const save = async () => {
    const saved = S.settings = await api("/api/settings", { method: "PUT", body: collect() });
    // 保存后新接口有了 id，同步回 s，之后再点“测试连接”“保存”都按新 id
    s.providers = saved.providers; s.active = saved.active;
    $$(".prov", dlg).forEach((el, i) => { el.dataset.i = i; delete el.dataset.clearKey; });
    return saved;
  };
  $("#addProv", dlg).onclick = () => {
    s.providers.push({ id: "", name: "自定义接口", base_url: "https://", model: "", max_input_chars: 60000, extra_body: {} });
    const box = $("#provs", dlg); $(".muted", box) && !$(".prov", box) && (box.innerHTML = "");
    box.insertAdjacentHTML("beforeend", card(s.providers[s.providers.length - 1], s.providers.length - 1)); bind();
    const radios = $$("input[name=active]", dlg); if (!radios.some(r => r.checked)) radios[radios.length - 1].checked = true;
  };
  $("#restoreProv", dlg).onclick = async () => {
    try { await save(); const r = await api("/api/settings/restore-providers", { method: "POST" }); toast(r.restored ? `已加回 ${r.restored} 个默认接口` : "默认接口都在，没有需要恢复的"); }
    catch (e) { return toast(e.message, 5000); }
    openSettings();
  };
  const bind = () => {
    $$(".prov", dlg).forEach(el => {
      $(".p-del", el).onclick = () => { if (confirm("删除这个接口配置？")) el.remove(); };
      $(".p-clr", el) && ($(".p-clr", el).onclick = e => {
        el.dataset.clearKey = 1; const k = $(".p-key", el); k.value = ""; k.placeholder = "保存后清除已保存的 Key";
        e.currentTarget.textContent = "保存后清除"; e.currentTarget.style.color = "var(--red)";
      });
      $(".p-test", el).onclick = async () => {
        const res = $(".p-res", el); res.textContent = "保存并测试中…"; res.style.color = "";
        try {
          const idx = $$(".prov", dlg).indexOf(el);
          const saved = await save(); const pid = saved.providers[idx].id;
          const r = await api("/api/settings/test", { method: "POST", body: { id: pid } });
          res.textContent = r.ok ? `✓ 连接成功（${r.latency}s）：${r.reply}` : "✗ " + r.msg; res.style.color = r.ok ? "var(--green)" : "var(--red)";
        } catch (e) { res.textContent = "✗ " + e.message; res.style.color = "var(--red)"; }
      };
    });
    $$("input[name=active]", dlg).forEach(r => r.onchange = () => $$(".prov", dlg).forEach(el => el.classList.toggle("on", $("input[name=active]", el).checked)));
  };
  bind();
  const saveAsr = async () => {
    const sel = $("#asrModel", dlg), dz = $("#asrDiar", dlg);
    if (dz && asr && dz.value !== asr.diarizer) await api("/api/asr", { method: "PUT", body: { diarizer: dz.value } });
    if (sel && asr && sel.value !== asr.model) await api("/api/asr", { method: "PUT", body: { model: sel.value } });
  };
  $("#saveSet", dlg).onclick = async () => {
    if (!(await confirmPurge())) return;
    // 填了访问口令却没点它旁边的“保存”：一起存掉，免得白填
    if ($("#lanPw", dlg) && $("#lanPw", dlg).value && lanLast && !(await lanPut({ enabled: lanLast.enabled }))) return;
    const nano = $("#asrModel", dlg) && asr && $("#asrModel", dlg).value !== asr.model && ["nano", "hanbao"].includes($("#asrModel", dlg).value) && !asr.nano_loaded;
    try { await save(); await saveVocab(); await saveAmb(); await saveAsr(); closeModal(); toast(nano ? "已保存，正在后台加载 Fun-ASR-Nano（约 15 秒）" : "已保存", 4000); pollHealth(); S.cur && showMeeting(S.cur.meta.id); }
    catch (e) { toast(e.message, 5000); }
  };
}

// ---------------- 每日时间线 + 汇总 ----------------
async function showDay(date) {
  let d;
  try { d = await api("/api/days/" + date); } catch (e) { $("#main").innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}</div></div>`; return; }
  await ensureSettings();
  const dt = new Date(date + "T00:00:00");
  const label = `${dt.getMonth() + 1}月${dt.getDate()}日 周${"日一二三四五六"[dt.getDay()]}`;
  const shift = n => { const x = new Date(dt); x.setDate(x.getDate() + n); return ymd(x); };
  const ms = d.meetings, sm = d.summary, isToday = date === ymd(new Date());
  const speech = ms.reduce((a, m) => a + (m.source === "ambient" ? (m.speech_s || 0) : (m.duration || 0)), 0);
  const busy = ms.filter(m => ["recording", "queued", "transcribing"].includes(m.status)).length;
  const ae = d.auto_error, stale = d.summary_stale;
  const dayNote = ae ? `<div class="banner err small"><span class="grow">${ae.final ? "自动汇总失败，今天不会再自动重试" : ae.tries ? `自动汇总失败（第 ${ae.tries} 次，30 分钟后自动重试）` : "自动汇总没有生成"}：${esc(ae.error)}</span></div>`
    : stale ? `<div class="banner warn small"><span class="grow">这份汇总生成后${stale.new ? `新增了 ${stale.new} 段记录` : ""}${stale.new && stale.changed ? "，" : ""}${stale.changed && !stale.new ? "记录内容有改动（文字、说话人姓名或纪要）" : stale.changed ? "已有记录也有改动" : ""}，汇总里没有包含。</span><button class="sm" id="dayRegen">${ic("sparkle")}重新生成</button></div>` : "";
  $("#main").innerHTML = `<div class="wrap">
    <div class="mhead"><div class="grow"><h1>${label}${isToday ? ` <span class="tag">今天</span>` : ""}</h1>
      <div class="meta-line"><span>${ic("file")}${ms.length} 段记录</span><span>${ic("speech")}发言约 ${fmtDur(speech)}</span>${busy ? `<span>${busy} 段还在记录/转写</span>` : ""}</div></div>
      <div class="row" style="gap:6px"><a class="btn" href="#/day/${shift(-1)}">${ic("left")}前一天</a>${isToday ? "" : `<a class="btn" href="#/day/${shift(1)}">后一天${ic("right")}</a>`}</div></div>
    <div class="daygrid">
      <div class="card"><h2>时间线</h2><div class="timeline">${ms.map(m => `<a class="tl" href="#/m/${m.id}">
        <span class="tm">${m.clock_start}${m.clock_end && m.clock_end !== m.clock_start ? "–" + m.clock_end : ""}</span>
        <span class="tb"><span class="t">${esc(m.title)}</span><span class="s">${fmtDur(m.source === "ambient" ? m.speech_s : m.duration)}${m.num_speakers ? ` · ${m.num_speakers} 人` : ""}${autoIc(m)}${statusTag(m)}</span></span></a>`).join("")
        || `<div class="empty">这一天没有记录</div>`}</div></div>
      <div class="card"><div class="toolbar"><h2 style="margin:0" class="grow">当日汇总</h2>
          <select id="provSel" style="max-width:210px" aria-label="用哪个模型生成">${providerOptions()}</select>
          <button class="pri" id="dayGen" ${ms.length ? "" : "disabled"}>${ic("sparkle")}${sm ? "重新生成" : "生成汇总"}</button>
          ${sm ? `<button id="dayCopy">${icSwap("copy", "check")}复制</button>` : ""}</div>
        <div class="muted small" id="dayState" style="margin:-6px 0 10px">${sm ? `${esc(sm.provider)} · ${sm.model} · ${sm.created.replace("T", " ").slice(0, 16)} · 用时 ${sm.cost}s` : ""}</div>
        ${dayNote}
        <div class="md" id="dayBox">${sm ? md(sm.markdown) : `<div class="empty">${ms.length ? "把这一天的所有对话和会议整理成一份工作汇总：概览、时间线、决定、待办、值得记住的信息" : "这一天没有记录"}</div>`}</div></div>
    </div></div>`;
  hoverFill($(".timeline"), ".tl");
  $("#dayCopy") && ($("#dayCopy").onclick = e => { const b = e.currentTarget;
    navigator.clipboard.writeText(sm.markdown).then(() => flashDone(b), () => toast("复制失败，请检查浏览器的剪贴板权限")); });
  const gen = async () => {
    const btn = $("#dayGen"), box = $("#dayBox"), st = $("#dayState");
    if (busy && !confirm(`还有 ${busy} 段在记录或转写，现在生成会用它们的临时文字。继续？`)) return;
    btn.disabled = true; st.textContent = "准备中…";
    let text = "", raf = 0; const t0 = Date.now();
    const paint = () => { raf = 0; box.innerHTML = md(text); box.lastElementChild && box.lastElementChild.classList.add("cursor"); };
    try {
      await streamNd(`/api/days/${date}/summary`, { provider: $("#provSel").value }, ev => {
        if (ev.type === "status") st.textContent = ev.msg;
        else if (ev.type === "delta") { text += ev.text; st.textContent = `生成中… ${text.length} 字 · ${Math.round((Date.now() - t0) / 1000)}s`; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === "error") throw new Error(ev.msg);
      });
      if (location.hash === "#/day/" + date) showDay(date);
    } catch (e) {
      st.textContent = ""; btn.disabled = false; toast("生成失败：" + e.message, 6000);
      if (!text) box.innerHTML = `<div class="empty" style="color:var(--red)">${esc(e.message)}${/本地模型还没启动/.test(e.message) ? `<div style="margin-top:10px"><button class="sm" id="llmStart">启动本地模型</button></div>` : ""}</div>`;
      $("#llmStart") && ($("#llmStart").onclick = ev => startLocalLlm(ev.currentTarget));
    }
  };
  $("#dayGen").onclick = gen;
  $("#dayRegen") && ($("#dayRegen").onclick = gen);
}

// ---------------- 启动 ----------------
(async () => {
  await pollHealth();
  ambConnect();
  pollAmbient();
  await loadMeetings();
  await route();
  setInterval(() => { if (!REC.active) loadMeetings(); }, 15000);
})();
