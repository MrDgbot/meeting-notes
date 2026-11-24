import {
  $, $$, S, autoIc, debounce, esc, fmtDur, hl, hooks, ic, isOnMeeting,
  safeLSGet, safeLSSet, statusTag, ymd,
} from "./utils.js";
import { api } from "./api.js";
import { closeModal, closePopMenus, copyText, isOverlayOpen, modal, navOpen, NARROW, toast } from "./ui.js";
import { REC } from "./recorder.js";

const THEME_MODES = ["auto", "light", "dark"];
const THEME_LABELS = { auto: "跟随系统", light: "浅色", dark: "深色" };
const THEME_TOAST = {
  auto: "已切换为跟随系统",
  light: "已切换为浅色主题",
  dark: "已切换为深色主题",
};
const THEME_COLOR = { light: "#f5f5f5", dark: "#141414" };
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
const themeListeners = new Set();
let themeInited = false;

export function getThemeMode() {
  const v = safeLSGet("theme", "auto");
  return THEME_MODES.includes(v) ? v : "auto";
}

export function getResolvedTheme(mode = getThemeMode()) {
  const m = THEME_MODES.includes(mode) ? mode : "auto";
  if (m === "auto") return darkMQ.matches ? "dark" : "light";
  return m;
}

function themeIconName(mode) {
  return mode === "light" ? "sun" : mode === "dark" ? "moon" : "contrast";
}

function syncThemeControls(mode, resolved) {
  const btn = $("#themeBtn");
  if (btn) {
    const label = THEME_LABELS[mode];
    btn.innerHTML = ic(themeIconName(mode));
    btn.title = `外观主题：${label}（点击切换）`;
    btn.setAttribute("aria-label", `切换外观主题（当前：${label}）`);
  }
  $$("[data-theme-set]").forEach(el => {
    const on = el.dataset.themeSet === mode;
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const hint = $("#themeHint");
  if (hint) {
    hint.textContent = mode === "auto"
      ? `跟随系统偏好自动切换（当前为${resolved === "dark" ? "深色" : "浅色"}）`
      : mode === "dark" ? "始终使用深色外观" : "始终使用浅色外观";
  }
}

function applyTheme(mode = getThemeMode()) {
  const m = THEME_MODES.includes(mode) ? mode : "auto";
  const resolved = getResolvedTheme(m);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = m;
  root.style.colorScheme = resolved;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[resolved]);
  syncThemeControls(m, resolved);
  themeListeners.forEach(fn => { try { fn(m, resolved); } catch {} });
  return resolved;
}

export function setThemeMode(mode) {
  const next = THEME_MODES.includes(mode) ? mode : "auto";
  safeLSSet("theme", next);
  return applyTheme(next);
}

export function cycleTheme() {
  const cur = getThemeMode();
  const next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
  setThemeMode(next);
  toast(THEME_TOAST[next]);
  return next;
}

export function onThemeChange(fn) {
  if (typeof fn !== "function") return () => {};
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

export function initTheme() {
  applyTheme();
  if (themeInited) return;
  themeInited = true;
  darkMQ.addEventListener("change", () => {
    if (getThemeMode() === "auto") applyTheme("auto");
  });
  window.addEventListener("storage", e => {
    if (e.key === "theme") applyTheme();
  });
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
let cmdkOpen = false;
let cmdkT = null;
let cmdkPrevFocus = null;
let cmdkItems = [];
let cmdkIdx = 0;
let cmdkSearchSeq = 0;
let cmdkAbort = null;
let cmdkRemote = null;
let cmdkRemoteQ = "";
let cmdkHoverLock = false;
let listenersInited = false;

export function isPaletteOpen() {
  return cmdkOpen;
}

async function focusTranscriptSearch() {
  if (typeof hooks.focusTranscriptSearch === "function") {
    if (!(await hooks.focusTranscriptSearch())) focusSidebarSearch();
    return;
  }
  let inp = $("#tSearch");
  if (!inp && S.cur && isOnMeeting(S.cur.meta.id) && $('button[data-tab="transcript"]') && hooks.switchTab) {
    await hooks.switchTab("transcript");
    inp = $("#tSearch");
  }
  if (inp) {
    inp.focus();
    inp.select();
    return;
  }
  focusSidebarSearch();
}

function focusSidebarSearch() {
  if (NARROW.matches && !document.body.classList.contains("nav-open")) navOpen(true);
  const inp = $("#searchMeetings");
  if (inp) {
    inp.focus();
    inp.select();
  }
}

function getCmdkEl() {
  let el = $("#cmdk");
  if (!el) {
    el = document.createElement("div");
    el.id = "cmdk";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "快速命令与搜索");
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function buildActions() {
  const list = [
    {
      id: "act-todos",
      icon: "check",
      title: "待办总览（跨会待办）",
      sub: "查看全部会议纪要里的未完成与已完成行动项",
      keywords: "待办 清单 任务 行动 todo action items",
      run: () => { location.hash = "#/todos"; },
    },
    {
      id: "act-people",
      icon: "users",
      title: "人物与话题关联",
      sub: "按参会人查看全部历史会议、高频话题与待办",
      keywords: "人物 参会人 关联 说话人 话题 people speaker timeline",
      run: () => { location.hash = "#/people"; },
    },
  ];
  const onCur = !!(S.cur && isOnMeeting(S.cur.meta.id));
  if (onCur) {
    const hasMin = !!(S.cur.minutes && S.cur.minutes.markdown);
    list.push({
      id: "act-copy-min",
      icon: "copy",
      title: "复制当前会议纪要",
      sub: hasMin ? "复制 Markdown 纪要到剪贴板" : "当前会议还没有生成纪要",
      keywords: "复制 纪要 copy minutes markdown",
      run: () => copyText(S.cur && S.cur.minutes && S.cur.minutes.markdown, "已复制纪要", "还没有纪要"),
    });
    const splitBtn = $("#splitBtn");
    if (splitBtn) {
      const isSplit = splitBtn.classList.contains("is-split");
      list.push({
        id: "act-split",
        icon: "columns",
        title: isSplit ? "切换到单栏视图" : "切换到分屏视图",
        sub: isSplit ? "转写稿放回标签页" : "左侧看纪要，右侧同时看转写稿",
        keywords: "分屏 单栏 视图 布局 split view",
        keepFocus: true,
        run: () => { const b = $("#splitBtn"); b && b.click(); },
      });
    }
    const privBtn = $("#rsiPrivBtn");
    if (privBtn) {
      const isPriv = !!(S.cur.meta && S.cur.meta.rsi_exclude);
      list.push({
        id: "act-priv",
        icon: "lock",
        title: isPriv ? "取消隐私会议" : "切换隐私会议",
        sub: isPriv ? "当前不参与本机自学习，点击恢复" : "标记为隐私会议，不参与声纹与词库自学习",
        keywords: "隐私 会议 自学习 privacy rsi exclude lock",
        run: () => { const b = $("#rsiPrivBtn"); b && b.click(); },
      });
    }
    const isRecordingCur = !!(REC.active && REC.mid === S.cur.meta.id);
    if (!isRecordingCur && Boolean($("#tSearch") || $('button[data-tab="transcript"]'))) {
      list.push({
        id: "act-tr-search",
        icon: "search",
        title: "聚焦转写内搜索",
        sub: "在当前会议转写稿中查找关键词",
        kbd: "/",
        keywords: "转写 搜索 查找 transcript search /",
        keepFocus: true,
        run: () => focusTranscriptSearch(),
      });
    }
  }

  const mode = getThemeMode();
  const today = ymd(new Date());
  list.push(
    {
      id: "act-home",
      icon: "home",
      title: "新建会议 / 回到首页",
      sub: "开始录音或上传录音 / 视频文件",
      keywords: "新建 会议 首页 录音 上传 home new record",
      keepFocus: true,
      run: () => {
        if (location.hash === "#/" || location.hash === "") hooks.route && hooks.route();
        else location.hash = "#/";
      },
    },
    {
      id: "act-day",
      icon: "calendar",
      title: "查看今日时间线与汇总",
      sub: `今天 · ${today}`,
      keywords: "今日 今天 时间线 汇总 日报 today day summary",
      keepFocus: true,
      run: () => { location.hash = "#/day/" + today; },
    },
    {
      id: "act-settings",
      icon: "sliders",
      title: "打开设置（含自学习中心）",
      sub: "AI 模型、语音识别、词库、全天模式、声纹与局域网",
      keywords: "设置 模型 词库 声纹 自学习 局域网 settings rsi",
      keepFocus: true,
      run: () => hooks.openSettings && hooks.openSettings(),
    },
    {
      id: "act-trash",
      icon: "trash",
      title: "打开废纸篓（恢复已删除的会议）",
      sub: "找回 30 天内删除的会议记录或彻底删除",
      keywords: "废纸篓 回收站 恢复 删除 trash restore",
      keepFocus: true,
      run: () => hooks.openTrashModal && hooks.openTrashModal(),
    },
    {
      id: "act-theme",
      icon: themeIconName(mode),
      title: "切换外观主题（浅色 / 深色 / 跟随系统）",
      sub: `当前：${THEME_LABELS[mode]}`,
      keywords: "外观 主题 深色 浅色 暗黑 夜间 跟随系统 theme dark light auto",
      run: () => cycleTheme(),
    },
    {
      id: "act-kbd",
      icon: "keyboard",
      title: "查看键盘快捷键（?）",
      sub: "全局、播放复听与录音编辑快捷键",
      kbd: "?",
      keywords: "快捷键 键盘 帮助 shortcuts help ?",
      keepFocus: true,
      run: () => openShortcuts(),
    },
  );
  return list;
}

function matchTokens(haystack, tokens) {
  const lower = haystack.toLowerCase();
  return tokens.every(tk => lower.includes(tk));
}

function fmtMeetingMeta(m) {
  const d = new Date(m.created);
  const datePart = ymd(d) === ymd(new Date()) ? "今天" : `${d.getMonth() + 1}/${d.getDate()}`;
  const timePart = d.toTimeString().slice(0, 5);
  const dur = fmtDur(m.source === "ambient" ? m.speech_s : m.duration);
  return `${datePart} ${timePart} · ${dur}`;
}

function renderCmdkList(rawQ, resetIdx = false) {
  const box = $("#cmdkList");
  if (!box) return;
  const q = rawQ.trim();
  const ql = q.toLowerCase();
  const tokens = ql ? ql.split(/\s+/).filter(Boolean) : [];

  const actions = buildActions().filter(a => !tokens.length || matchTokens(`${a.title} ${a.sub || ""} ${a.keywords || ""}`, tokens));

  const remoteMap = q && cmdkRemoteQ === ql && cmdkRemote ? cmdkRemote : null;
  const meetingMap = new Map(S.meetings.map(m => [m.id, m]));
  let meetings = [];
  if (!q) {
    meetings = S.meetings.slice(0, 8).map(m => ({ m, hit: null }));
  } else {
    const seen = new Set();
    for (const m of S.meetings) {
      if (matchTokens(m.title || "", tokens)) {
        seen.add(m.id);
        meetings.push({ m, hit: remoteMap ? remoteMap[m.id] || null : null });
      }
    }
    if (remoteMap) {
      for (const hit of Object.values(remoteMap)) {
        if (seen.has(hit.id)) continue;
        const m = meetingMap.get(hit.id) || hit;
        if (!m || !m.id) continue;
        seen.add(m.id);
        meetings.push({ m, hit });
      }
    }
    meetings = meetings.slice(0, 16);
  }

  const flat = [];
  let html = "";

  if (actions.length) {
    html += `<div class="cmdk-sec">快捷操作</div>`;
    for (const a of actions) {
      const idx = flat.length;
      flat.push(a);
      html += `<button type="button" class="cmdk-item" data-cmdk-idx="${idx}">
        <span class="cmdk-ic">${ic(a.icon)}</span>
        <span class="cmdk-body">
          <span class="cmdk-t">${q ? hl(a.title, q) : esc(a.title)}</span>
          ${a.sub ? `<span class="cmdk-s">${esc(a.sub)}</span>` : ""}
        </span>
        ${a.kbd ? `<kbd class="cmdk-kbd">${esc(a.kbd)}</kbd>` : ""}
      </button>`;
    }
  }

  if (meetings.length || (q && !remoteMap)) {
    const secLabel = !q ? "最近会议" : remoteMap ? "会议搜索结果" : "匹配的会议 · 正在搜索正文…";
    html += `<div class="cmdk-sec">${esc(secLabel)}</div>`;
    for (const { m, hit } of meetings) {
      const idx = flat.length;
      flat.push({
        id: "m-" + m.id,
        keepFocus: true,
        run: () => { location.hash = "#/m/" + m.id; },
      });
      const snip = hit && hit.snippet
        ? `<span class="cmdk-snip">${hit.hits > 1 ? `<b class="num">${hit.hits} 处</b> ` : ""}${hl(hit.snippet, q)}</span>`
        : "";
      html += `<button type="button" class="cmdk-item" data-cmdk-idx="${idx}">
        <span class="cmdk-ic">${ic(m.source === "ambient" ? "radio" : m.source === "upload" ? "file" : "speech")}</span>
        <span class="cmdk-body">
          <span class="cmdk-t"><span>${q ? hl(m.title || "未命名会议", q) : esc(m.title || "未命名会议")}</span>${statusTag(m)}</span>
          <span class="cmdk-s"><span class="num">${esc(fmtMeetingMeta(m))}</span>${autoIc(m)}</span>
          ${snip}
        </span>
      </button>`;
    }
    if (!meetings.length && q && !remoteMap) {
      html += `<div class="cmdk-empty muted small">正在搜索会议正文…</div>`;
    }
  }

  if (!flat.length && (!q || remoteMap)) {
    html = `<div class="cmdk-empty muted small">没有找到匹配的命令或会议</div>`;
  }

  cmdkItems = flat;
  if (resetIdx) cmdkIdx = 0;
  if (cmdkIdx >= flat.length) cmdkIdx = Math.max(0, flat.length - 1);
  box.innerHTML = html;
  syncCmdkActive(false);
}

function syncCmdkActive(scroll = true) {
  const box = $("#cmdkList");
  if (!box) return;
  const nodes = $$(".cmdk-item", box);
  nodes.forEach((el, i) => {
    const on = i === cmdkIdx;
    el.classList.toggle("on", on);
    if (on && scroll) {
      cmdkHoverLock = true;
      el.scrollIntoView({ block: "nearest" });
      requestAnimationFrame(() => { cmdkHoverLock = false; });
    }
  });
}

function runCmdkItem(idx) {
  const item = cmdkItems[idx];
  if (!item) return;
  const restoreFocus = !item.keepFocus;
  closePalette(restoreFocus);
  try { item.run(); } catch (err) { toast("操作失败：" + (err && err.message ? err.message : String(err)), 4000); }
}

const searchPaletteRemote = debounce(async rawQ => {
  const q = rawQ.trim();
  const ql = q.toLowerCase();
  if (!cmdkOpen || !q) return;
  if (cmdkAbort) { try { cmdkAbort.abort(); } catch {} cmdkAbort = null; }
  const seq = ++cmdkSearchSeq;
  const ac = new AbortController();
  cmdkAbort = ac;
  let res;
  try {
    res = await api("/api/search?q=" + encodeURIComponent(q), { signal: ac.signal });
  } catch {
    return;
  }
  if (!cmdkOpen || seq !== cmdkSearchSeq) return;
  const inp = $("#cmdkIn");
  if (!inp || inp.value.trim().toLowerCase() !== ql) return;
  cmdkRemoteQ = ql;
  cmdkRemote = Object.fromEntries((Array.isArray(res) ? res : []).map(x => [x.id, x]));
  renderCmdkList(inp.value, false);
}, 180);

export function openPalette() {
  const el = getCmdkEl();
  clearTimeout(cmdkT);
  closePopMenus();
  navOpen(false);
  const m = $("#modal");
  if (m && !m.hidden) closeModal(true);

  if (!cmdkOpen) {
    cmdkPrevFocus = document.activeElement;
  }
  cmdkOpen = true;
  cmdkIdx = 0;
  cmdkRemote = null;
  cmdkRemoteQ = "";
  cmdkSearchSeq++;
  if (cmdkAbort) { try { cmdkAbort.abort(); } catch {} cmdkAbort = null; }

  el.classList.remove("closing");
  el.innerHTML = `<div class="cmdk-box">
    <div class="cmdk-head">
      <span class="cmdk-sicon">${ic("search")}</span>
      <input id="cmdkIn" class="cmdk-in" type="text" autocomplete="off" spellcheck="false"
        placeholder="搜索会议标题、正文或命令…" aria-label="搜索会议标题、正文或命令">
      <button type="button" class="ghost sm ic-btn cmdk-close" id="cmdkClose" aria-label="关闭快速命令面板" title="关闭 (Esc)">${ic("x")}</button>
    </div>
    <div id="cmdkList" class="cmdk-list"></div>
    <div class="cmdk-foot small muted">
      <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
      <span><kbd>↩</kbd> 执行</span>
      <span><kbd>Esc</kbd> 关闭</span>
    </div>
  </div>`;

  el.hidden = false;
  renderCmdkList("", true);
  void el.offsetWidth;
  el.classList.add("show");

  const inp = $("#cmdkIn", el);
  const listEl = $("#cmdkList", el);
  $("#cmdkClose", el).onclick = () => closePalette(true);
  el.onmousedown = e => { if (e.target === el) closePalette(true); };

  inp.addEventListener("input", () => {
    const v = inp.value;
    if (!v.trim()) {
      cmdkRemote = null;
      cmdkRemoteQ = "";
      cmdkSearchSeq++;
      if (cmdkAbort) { try { cmdkAbort.abort(); } catch {} cmdkAbort = null; }
    } else {
      searchPaletteRemote(v);
    }
    renderCmdkList(v, true);
  });

  el.onkeydown = e => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!cmdkItems.length) return;
      cmdkIdx = (cmdkIdx + 1) % cmdkItems.length;
      if (document.activeElement !== inp) inp.focus({ preventScroll: true });
      syncCmdkActive(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!cmdkItems.length) return;
      cmdkIdx = (cmdkIdx - 1 + cmdkItems.length) % cmdkItems.length;
      if (document.activeElement !== inp) inp.focus({ preventScroll: true });
      syncCmdkActive(true);
    } else if (e.key === "Enter" && document.activeElement === inp) {
      e.preventDefault();
      if (cmdkItems.length) runCmdkItem(cmdkIdx);
    }
  };

  listEl.addEventListener("pointermove", e => {
    if (cmdkHoverLock || e.pointerType === "touch") return;
    const it = e.target.closest(".cmdk-item");
    if (!it) return;
    const idx = +it.dataset.cmdkIdx;
    if (Number.isInteger(idx) && idx !== cmdkIdx) {
      cmdkIdx = idx;
      syncCmdkActive(false);
    }
  });
  listEl.addEventListener("click", e => {
    const it = e.target.closest(".cmdk-item");
    if (!it) return;
    runCmdkItem(+it.dataset.cmdkIdx);
  });

  try { inp.focus({ preventScroll: true }); } catch {}
}

export function closePalette(restoreFocus = true) {
  const el = $("#cmdk");
  if (!cmdkOpen && (!el || el.hidden)) return;
  cmdkOpen = false;
  cmdkSearchSeq++;
  if (cmdkAbort) { try { cmdkAbort.abort(); } catch {} cmdkAbort = null; }
  const prev = cmdkPrevFocus;
  cmdkPrevFocus = null;
  if (!el || el.hidden) return;
  el.classList.remove("show");
  el.classList.add("closing");
  clearTimeout(cmdkT);
  cmdkT = setTimeout(() => {
    el.hidden = true;
    el.innerHTML = "";
    el.classList.remove("closing");
    if (restoreFocus && prev && prev.isConnected && typeof prev.focus === "function") {
      try { prev.focus({ preventScroll: true }); } catch {}
    }
  }, 160);
}

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const SHORTCUT_GROUPS = [
  {
    title: "全局",
    rows: [
      [[IS_MAC ? "⌘K" : "Ctrl+K"], "快速跳转与命令"],
      [[IS_MAC ? "⌘\\" : "Ctrl+\\"], "收起 / 展开侧栏"],
      [["/"], "搜索转写或会议"],
      [["?"], "快捷键速查"],
      [["Esc"], "关闭弹窗 / 浮层"],
    ],
  },
  {
    title: "播放与复听",
    rows: [
      [["Space"], "播放 / 暂停"],
      [["←", "→"], "快退 / 快进 5 秒"],
      [["J", "L"], "快退 / 快进 10 秒"],
      [["[", "]"], "调节播放速度"],
      [[",", "."], "跳到上一句 / 下一句"],
    ],
  },
  {
    title: "录音与编辑",
    rows: [
      [["M"], "录音中一键打点（输入时 Alt+M）"],
      [["Enter", "Shift+Enter"], "转写搜索下一处 / 上一处"],
      [[IS_MAC ? "⌘↩" : "Ctrl+↩"], "保存段落编辑"],
    ],
  },
];

export function openShortcuts() {
  if (cmdkOpen) closePalette(false);
  closePopMenus();
  navOpen(false);
  const html = `<h2>键盘快捷键</h2>
    <p class="muted small">在非输入框状态下直接按键即可生效；<code>${IS_MAC ? "⌘K" : "Ctrl+K"}</code> 在任意位置都可唤起。</p>
    <div class="kbd-grid">${SHORTCUT_GROUPS.map(g => `<section class="kbd-grp">
      <h3>${esc(g.title)}</h3>
      <dl class="kbd-dl">${g.rows.map(([keys, desc]) => `<div class="kbd-row">
        <dt>${keys.map(k => `<kbd>${esc(k)}</kbd>`).join(`<span class="kbd-sep">/</span>`)}</dt>
        <dd>${esc(desc)}</dd>
      </div>`).join("")}</dl>
    </section>`).join("")}</div>
    <div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" data-close-modal>关闭</button></div>`;
  modal(html);
}

export function initPaletteListeners() {
  if (listenersInited) return;
  listenersInited = true;

  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (cmdkOpen) closePalette(true);
      else openPalette();
      return;
    }

    if (cmdkOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePalette(true);
        return;
      }
      if (e.key === "Tab") {
        const el = $("#cmdk");
        const box = el && el.firstElementChild;
        if (!box) return;
        const list = $$(FOCUSABLE, box).filter(n => n.offsetParent !== null || n === document.activeElement);
        if (!list.length) { e.preventDefault(); return; }
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) {
          e.preventDefault(); first.focus();
        }
      }
      return;
    }

    if (isOverlayOpen()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;

    if (e.key === "?") {
      e.preventDefault();
      openShortcuts();
      return;
    }
    if (e.key === "/" && !e.shiftKey) {
      e.preventDefault();
      if (S.cur && isOnMeeting(S.cur.meta.id)) focusTranscriptSearch();
      else focusSidebarSearch();
    }
  }, true);
}

const MEDIA_EXT_RE = /\.(mp3|m4a|wav|ogg|flac|aac|webm|mp4|mov|mkv|amr|opus|wma)$/i;
let dragInited = false;
let dragDepth = 0;

function hasDraggedFiles(e) {
  const dt = e.dataTransfer;
  if (!dt || !dt.types) return false;
  for (let i = 0; i < dt.types.length; i++) {
    if (dt.types[i] === "Files") return true;
  }
  return false;
}

function isMediaFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("audio/") || type.startsWith("video/")) return true;
  return MEDIA_EXT_RE.test(file.name || "");
}

function getDropEl() {
  let el = $("#dropOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "dropOverlay";
    el.className = "drop-overlay";
    el.setAttribute("aria-hidden", "true");
    el.hidden = true;
    document.body.appendChild(el);
  }
  if (!el.firstElementChild) {
    el.innerHTML = `<div class="drop-card">
      <div class="drop-ic">${ic("upload")}</div>
      <div class="drop-title">松开即可上传录音 / 视频</div>
      <div class="drop-sub">支持 mp3 / m4a / wav / ogg / flac / webm / mp4 / mov 等，上传后自动转写</div>
    </div>`;
  }
  return el;
}

let dropT = 0;
function setDropVisible(on) {
  const el = getDropEl();
  clearTimeout(dropT);
  if (on) {
    if (el.hidden) {
      el.hidden = false;
      void el.offsetWidth;
    }
    el.classList.add("show");
  } else {
    el.classList.remove("show");
    dropT = setTimeout(() => { el.hidden = true; }, 190);
  }
}

function resetDrop() {
  if (!dragDepth) return;
  dragDepth = 0;
  setDropVisible(false);
}

export function initDragUpload() {
  if (dragInited) return;
  dragInited = true;

  window.addEventListener("dragenter", e => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    setDropVisible(true);
  });

  window.addEventListener("dragover", e => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (!dragDepth) dragDepth = 1;
    setDropVisible(true);
  });

  window.addEventListener("dragleave", e => {
    if (!dragDepth) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || (e.clientX <= 0 && e.clientY <= 0)) {
      dragDepth = 0;
      setDropVisible(false);
    }
  });

  window.addEventListener("drop", e => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDropVisible(false);
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!isMediaFile(file)) {
      toast("不支持的文件格式，请拖入音频或视频文件（如 mp3 / m4a / wav / mp4 / mov 等）", 4500);
      return;
    }
    if (typeof hooks.uploadFile === "function") {
      hooks.uploadFile(file);
    } else {
      if (location.hash !== "#/" && location.hash !== "") location.hash = "#/";
      toast(`已识别文件「${file.name}」，请点击首页「上传录音 / 视频文件」上传`, 4500);
    }
  });

  window.addEventListener("dragend", resetDrop);
  window.addEventListener("blur", resetDrop);
  document.addEventListener("keydown", e => { if (e.key === "Escape") resetDrop(); });
}
