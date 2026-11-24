// 入口模块：路由、集中视图清理、侧栏、健康检查、全天模式推送与启动引导
import {
  $, $$, OFFLINE, S, autoIc, debounce, esc, fmtDur, fmtTs, hl, hms, hooks,
  ic, isOnMeeting, safeLSGet, safeLSSet, statusTag, ymd,
} from "./js/utils.js";
import { api } from "./js/api.js";
import {
  closeModal, closePopMenus, confirmAction, hoverFill, initGlobalUI, modal, navOpen, popMenu, sbCleanup, toast,
} from "./js/ui.js";
import { REC, initRecorderListeners } from "./js/recorder.js";
import { clearRange, initPlayerListeners } from "./js/player.js";
import { highlightPlaying, renderPartial, resetTranscriptCache, tabTranscript } from "./js/transcript.js";
import {
  clearPoll, editingNow, hasPendingNotes, initMarkListeners, mdEditDirty,
  refreshLive, renderTab, resetMdEdit, saveMdEditNow, saveNotesNow,
  showHome, showMeeting, switchTab,
} from "./js/meeting.js";
import { openSettings } from "./js/settings.js";
import { showDay } from "./js/day.js";
import { showPeople, showPerson, showTodos } from "./js/hub.js";
import {
  closePalette, cycleTheme, initDragUpload, initPaletteListeners, initTheme,
  openPalette, openShortcuts,
} from "./js/palette.js";

// ---------------- 集中视图销毁（防止幽灵音频、rAF/Observer/滚动条残留） ----------------
function teardownView() {
  if (S.playerCleanup) {
    try { S.playerCleanup(); } catch {}
    S.playerCleanup = null;
  } else {
    const a = $("#audio");
    if (a) { try { a.pause(); a.removeAttribute("src"); a.load(); } catch {} }
  }
  clearRange();
  if (S.phObs) { S.phObs.disconnect(); S.phObs = null; }
  if (S.waveObs) { S.waveObs.disconnect(); S.waveObs = null; }
  if (S.waveThemeUnsub) { S.waveThemeUnsub(); S.waveThemeUnsub = null; }
  resetTranscriptCache();
  closePopMenus();
  sbCleanup(true);
}

// ---------------- 侧栏 ----------------
async function loadMeetings() {
  try { S.meetings = await api("/api/meetings"); } catch { return; }
  renderSide();
  void loadTrashCount();
}

async function loadTrashCount() {
  try {
    const r = await api("/api/trash");
    const n = Array.isArray(r && r.items) ? r.items.length : 0;
    const btn = $("#trashBtn"), cnt = $("#trashCnt");
    if (btn) btn.hidden = n === 0;
    if (cnt) cnt.textContent = n > 0 ? String(n) : "";
    return n;
  } catch {
    return 0;
  }
}

let hideShort = safeLSGet("hideShort") === "1";

let sideResizeT = 0;
function setSideCollapsed(on) {
  document.body.classList.toggle("side-collapsed", !!on);
  safeLSSet("sideCollapsed", on ? "1" : "0");
  const tg = $("#sideToggle");
  if (tg) tg.setAttribute("aria-expanded", on ? "false" : "true");
  clearTimeout(sideResizeT);
  sideResizeT = setTimeout(() => window.dispatchEvent(new Event("resize")), 280);
}

function renderSide() {
  const q = S.filter.trim().toLowerCase();
  const hits = q && S.searchQ === q ? S.searchHits : null;
  const kind = S.sideKind || "all";
  const curId = S.cur && S.cur.meta.id;
  const matchKind = m => {
    if (kind === "all") return true;
    if (kind === "ambient") return m.source === "ambient";
    if (kind === "upload") return m.source === "upload";
    return m.source !== "ambient" && m.source !== "upload";
  };
  const effDur = m => (m.source === "ambient" ? (m.speech_s || 0) : (m.duration || 0));
  const isShortClip = m => m.source === "ambient" && effDur(m) < 60 && m.title_auto !== false && !["recording", "queued", "transcribing"].includes(m.status);
  const shortBtn = $("#hideShortBtn");
  if (shortBtn) {
    const hasShort = S.meetings.some(m => matchKind(m) && isShortClip(m));
    shortBtn.hidden = !hasShort && !hideShort;
  }
  const list = S.meetings.filter(m => {
    if (!matchKind(m)) return false;
    if (hideShort && !q && m.id !== curId && isShortClip(m)) return false;
    return !q || m.title.toLowerCase().includes(q) || (hits && hits[m.id]);
  });
  // 按完整 YYYY-MM-DD 分组，避免跨年同月同日合并
  const groups = new Map();
  const now = new Date(), curYear = now.getFullYear();
  const today = ymd(now), yest = ymd(new Date(Date.now() - 864e5));
  for (const m of list) {
    const d = new Date(m.created);
    const dk = ymd(d);
    let g = groups.get(dk);
    if (!g) {
      const label = dk === today ? "今天" : dk === yest ? "昨天"
        : d.getFullYear() === curYear ? `${d.getMonth() + 1}月${d.getDate()}日`
        : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      g = { label, date: dk, items: [] };
      groups.set(dk, g);
    }
    g.items.push(m);
  }
  const emptyText = q ? (hits ? "没有找到相关的会议" : "搜索中…")
    : hideShort ? "没有大于 1 分钟的记录（关闭「隐藏短片段」查看全部）"
    : kind !== "all" ? "这个分类下还没有记录"
    : "还没有会议";
  $("#mlist").innerHTML = [...groups.values()].map(g =>
    `<div class="group-h"><span>${esc(g.label)}</span><a href="#/day/${esc(g.date)}" title="查看这一天的时间线和汇总">当日汇总</a></div>`
    + g.items.map(m => {
      const dur = effDur(m);
      const cls = `mi${m.id === curId ? " on" : ""}${dur >= 300 ? " mi-long" : isShortClip(m) ? " mi-short" : ""}`;
      return `
      <a class="${cls}" href="#/m/${esc(m.id)}">
        <div class="t"><span class="tt">${esc(m.title)}</span>${statusTag(m)}</div>
        <div class="s"><span class="num">${new Date(m.created).toTimeString().slice(0, 5)}</span><span>·</span><span>${fmtDur(dur)}</span>${autoIc(m)}</div>
        ${hits && hits[m.id] && hits[m.id].snippet ? `<div class="s snip">${hits[m.id].hits > 1 ? `<b class="num">${hits[m.id].hits} 处</b> ` : ""}${hl(hits[m.id].snippet, S.filter.trim())}</div>` : ""}
      </a>`;
    }).join("")
  ).join("") || `<div class="muted small" style="padding:10px">${emptyText}</div>`;
  hoverFill($("#mlist"), ".mi");
  renderPill();
}

// 录音状态条：在 REC.active 或 REC.stopping 期间保持可见，原地更新时长数字（不每秒重建 DOM）
let pillSig = "";
function renderPill() {
  const pill = $("#recPill"), tb = $("#tbRec");
  const show = REC.active || REC.stopping;
  if (!show) {
    if (!pill.hidden) { pill.hidden = true; tb.hidden = true; pillSig = ""; }
    return;
  }
  const mode = REC.stopping ? "stopping" : REC.paused ? "paused" : "rec";
  const sig = `${mode}|${REC.mid}`;
  const tm = fmtTs(REC.elapsedMs());
  if (sig !== pillSig || pill.hidden) {
    pillSig = sig;
    pill.hidden = false;
    pill.href = "#/m/" + REC.mid;
    const label = REC.stopping ? "正在保存" : REC.paused ? "已暂停" : "录音中";
    pill.innerHTML = `<span class="recdot${REC.paused || REC.stopping ? " paused" : ""}" style="width:8px;height:8px;flex-basis:8px"></span><span class="grow">${label} <span class="num">${tm}</span></span><span>返回</span>`;
    tb.hidden = false;
    tb.href = "#/m/" + REC.mid;
    tb.innerHTML = `<span class="recdot${REC.paused || REC.stopping ? " paused" : ""}" style="width:7px;height:7px;flex-basis:7px"></span><span class="num">${tm}</span>`;
  } else {
    const n1 = $(".num", pill), n2 = $(".num", tb);
    if (n1) n1.textContent = tm;
    if (n2) n2.textContent = tm;
  }
}
setInterval(renderPill, 1000);

const searchContent = debounce(async q => {
  let r; try { r = await api("/api/search?q=" + encodeURIComponent(q)); } catch { return; }
  if (S.filter.trim().toLowerCase() !== q.toLowerCase()) return;
  S.searchQ = q.toLowerCase();
  S.searchHits = Object.fromEntries(r.map(x => [x.id, x]));
  renderSide();
}, 250);
function syncSearchControls() {
  const has = S.filter.length > 0;
  const clr = $("#searchClr"), cmdk = $("#cmdkBtn");
  if (clr) clr.hidden = !has;
  if (cmdk) cmdk.hidden = has;
}
$("#searchMeetings").oninput = e => {
  S.filter = e.target.value;
  const q = S.filter.trim();
  if (q) searchContent(q);
  else { S.searchQ = ""; S.searchHits = null; }
  syncSearchControls();
  renderSide();
};
$("#searchClr") && ($("#searchClr").onclick = () => {
  const inp = $("#searchMeetings");
  if (inp) inp.value = "";
  S.filter = "";
  S.searchQ = "";
  S.searchHits = null;
  syncSearchControls();
  renderSide();
  inp && inp.focus();
});
const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
if (!IS_MAC) {
  const cb = $("#cmdkBtn"), stg = $("#sideToggle"), sep = $("#sideExpand");
  if (cb) { cb.innerHTML = "<kbd>Ctrl+K</kbd>"; cb.setAttribute("aria-label", "打开快速命令面板 Ctrl+K"); cb.title = "快速命令与搜索 (Ctrl+K)"; }
  if (stg) stg.title = "收起侧栏 (Ctrl+\\)";
  if (sep) sep.title = "展开侧栏 (Ctrl+\\)";
}
$("#cmdkBtn") && ($("#cmdkBtn").onclick = () => openPalette());
$$("#sideFilters .sf-pill[data-kind]").forEach(btn => {
  btn.onclick = () => {
    const kind = btn.dataset.kind || "all";
    if (S.sideKind === kind) return;
    S.sideKind = kind;
    $$("#sideFilters .sf-pill[data-kind]").forEach(b => {
      const on = b.dataset.kind === kind;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    renderSide();
  };
});
const hideShortBtn = $("#hideShortBtn");
if (hideShortBtn) {
  const syncShortBtn = () => {
    hideShortBtn.classList.toggle("on", hideShort);
    hideShortBtn.setAttribute("aria-pressed", hideShort ? "true" : "false");
  };
  syncShortBtn();
  hideShortBtn.onclick = () => {
    hideShort = !hideShort;
    safeLSSet("hideShort", hideShort ? "1" : "0");
    syncShortBtn();
    renderSide();
  };
}
if (safeLSGet("sideCollapsed") === "1") setSideCollapsed(true);
$("#sideToggle") && ($("#sideToggle").onclick = () => setSideCollapsed(true));
$("#sideExpand") && ($("#sideExpand").onclick = () => setSideCollapsed(false));
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "\\") {
    if (window.innerWidth < 900) return;
    e.preventDefault();
    setSideCollapsed(!document.body.classList.contains("side-collapsed"));
  }
});

function goHome(e) {
  e && e.preventDefault();
  if (location.hash === "#/" || location.hash === "") route();
  else location.hash = "#/";
}
$("#newBtn").onclick = goHome;
$("#homeLink").onclick = goHome;
$("#tbHome").onclick = goHome;
$("#tbNew").onclick = goHome;
$("#settingsBtn").onclick = openSettings;
$("#trashBtn") && ($("#trashBtn").onclick = () => openTrashModal());
$("#themeBtn") && ($("#themeBtn").onclick = () => cycleTheme());
$("#kbdBtn") && ($("#kbdBtn").onclick = () => openShortcuts());

// ---------------- 后端健康检查 ----------------
async function pollHealth() {
  clearTimeout(S.healthT);
  if (document.hidden && S.health && S.health.asr_ready && !S.health.asr_note) {
    S.healthT = setTimeout(pollHealth, 30000);
    return;
  }
  let h = null;
  try { h = await api("/api/health"); } catch {}
  const b = $("#asrBadge");
  b.onclick = null; b.onkeydown = null; b.removeAttribute("role"); b.removeAttribute("tabindex"); b.classList.remove("act");
  if (!h) {
    b.className = "badge err"; b.textContent = "服务未连接"; b.title = OFFLINE + "；连上后自动恢复";
    S.healthT = setTimeout(pollHealth, document.hidden ? 10000 : 3000);
    return;
  }
  const was = S.health; S.health = h;
  if (h.asr_loading || (!h.asr_ready && !h.asr_error)) {
    b.className = "badge"; b.textContent = "语音模型加载中…"; b.title = "";
  } else if (h.asr_error) {
    b.className = "badge err act"; b.textContent = "语音模型加载失败 · 重试"; b.title = h.asr_error + "\n点击重新加载";
    b.setAttribute("role", "button"); b.setAttribute("tabindex", "0");
    const reload = async () => { b.textContent = "重新加载中…"; try { await api("/api/asr/reload", { method: "POST" }); } catch (e) { toast(e.message); } pollHealth(); };
    b.onclick = reload;
    b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reload(); } };
    if (!was || !was.asr_error) toast("语音模型加载失败：" + h.asr_error.slice(0, 120) + "。点左下角“重试”", 8000);
  } else if (h.asr_note) {
    b.className = "badge warn"; b.textContent = h.asr_note.startsWith("正在") ? "高精度模型加载中…" : "离线模型兼容模式"; b.title = h.asr_note;
  } else {
    const dev = String(h.device || "").toUpperCase();
    b.className = "badge ok"; b.textContent = "就绪" + (dev ? " · " + dev : ""); b.title = "语音模型就绪" + (dev ? " · " + dev : "");
  }
  // 模型就绪后若用户没在编辑/录音再刷新当前页，避免打断输入
  if (was && !was.asr_ready && h.asr_ready && S.cur && !editingNow() && !REC.active && !REC.stopping) {
    showMeeting(S.cur.meta.id, { keepPlayer: true });
  }
  S.healthT = setTimeout(pollHealth, h.asr_ready && !h.asr_note ? 15000 : 2000);
}

// ---------------- 全天模式 ----------------
const AMB_TXT = {
  off: "已关闭", starting: "等待语音模型就绪…", listening: "正在听 · 没人说话时不录音",
  speech: "有人在说话，正在记录", held: "手动录音中，自动记录已暂停",
};
let ambSig = "", ambCardSig = "", ambWS = null, ambPollT = null;

function ambConnect() {
  if (ambWS || document.visibilityState !== "visible") return;
  let ws;
  try { ws = ambWS = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ambient`); }
  catch { ambWS = null; return; }
  ws.onmessage = e => {
    if (ambWS !== ws) return;
    S.ambLive = true;
    try { onAmb(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
    if (ambWS === ws) { ambWS = null; S.ambLive = false; setTimeout(ambConnect, 3000); }
  };
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    ambConnect();
    pollHealth();
    if (!REC.active && !REC.stopping) loadMeetings();
    return;
  }
  if (ambWS) { const ws = ambWS; ambWS = null; S.ambLive = false; ws.close(); }
});

async function pollAmbient() {
  clearTimeout(ambPollT);
  if (!S.ambLive && !document.hidden) {
    let a = null;
    try { a = await api("/api/ambient"); } catch { S.amb = null; renderAmb(); }
    if (a && !S.ambLive) onAmb(a);
  }
  const a = S.amb;
  const delay = document.hidden ? 15000 : S.ambLive ? 5000 : a && a.enabled ? 2000 : 8000;
  ambPollT = setTimeout(pollAmbient, delay);
}

function onAmb(a) {
  const prev = S.amb; S.amb = a;
  const sig = (a.conv ? a.conv.id : "") + "|" + a.today.count;
  if (sig !== ambSig) { const first = !ambSig; ambSig = sig; if (!first && !REC.active && !REC.stopping) loadMeetings(); }
  renderAmb();
  const id = S.cur && S.cur.meta.id;
  if (a.discarded && a.discarded.at !== S.discardSeen) {
    S.discardSeen = a.discarded.at;
    if (isOnMeeting(a.discarded.id)) return showDiscarded(a.discarded);
  }
  if (!id || !isOnMeeting(id)) return;
  const was = prev && prev.conv && prev.conv.id === id, now = a.conv && a.conv.id === id;
  if ((now && prev && prev.live_rev !== a.live_rev) || (was && !now)) refreshLive(id);
  else if (now) renderPartial();
}

function showDiscarded(x) {
  clearPoll(); teardownView(); S.cur = null;
  $("#main").innerHTML = `<div class="wrap"><div class="empty">这段对话能认出字的发言只有 ${esc(x.voiced_s)} 秒，不足 ${esc(x.min_s)} 秒，已放进「最近丢弃的片段」，7 天内可以恢复。
    <div style="margin-top:12px"><button class="btn pri" id="dRestore">恢复这段</button> <a class="btn" href="#/">回到首页</a> <a class="btn" id="dSet">调整“发言少于多少秒不保存”</a></div></div></div>`;
  $("#dRestore").onclick = () => restoreDiscarded(x.id);
  $("#dSet").onclick = openSettings;
  sbCleanup();
  renderSide();
}

async function restoreDiscarded(id) {
  try { await api("/api/discarded/" + id + "/restore", { method: "POST", body: {} }); }
  catch (e) { return toast("恢复失败：" + e.message, 5000); }
  toast("已恢复，正在精准转写");
  closeModal(false);
  await loadMeetings();
  location.hash = "#/m/" + id;
  showMeeting(id);
}

function renderDiscarded(box, items) {
  if (!box) return;
  if (!items.length) { box.innerHTML = `<p class="muted small">最近丢弃的片段：没有。发言太短被自动丢掉的对话会在这里留 7 天。</p>`; return; }
  box.innerHTML = `<label class="f">最近丢弃的片段</label>` + items.map(it => `<div class="row" style="gap:8px;margin:6px 0">
    <span class="grow small">${esc((it.time || "").replace("T", " "))} · ${esc(String(it.voiced_s))} 秒 · ${esc(it.text || "（没有文字）")}</span>
    <button class="sm" data-id="${esc(it.id)}">恢复</button></div>`).join("")
    + `<p class="muted small">超过 7 天会自动清除。</p>`;
  $$("button", box).forEach(b => b.onclick = () => restoreDiscarded(b.dataset.id));
}

function renderTrashList(box, initialItems, { onMutated } = {}) {
  if (!box) return;
  let items = Array.isArray(initialItems) ? initialItems.slice() : [];
  const draw = () => {
    if (!items.length) {
      box.innerHTML = `<p class="muted small">废纸篓是空的，已删除的会议记录会在这里保留 30 天。</p>`;
      return;
    }
    box.innerHTML = items.map(it => {
      const when = `${ymd(it.created || "")} ${(it.created || "").slice(11, 16)}`.trim();
      const dur = it.duration > 0 ? ` · ${fmtDur(it.duration)}` : "";
      const trashed = it.trashed_at ? ` · 删除于 ${ymd(it.trashed_at)}` : "";
      return `<div class="trash-row" data-trash-row="${esc(it.id)}">
        <div class="grow">
          <div class="trash-title">${esc(it.title || "未命名会议")}</div>
          <div class="trash-meta">${esc(when + dur + trashed)}</div>
        </div>
        <div class="trash-acts">
          <button type="button" class="sm" data-trash-restore="${esc(it.id)}">恢复</button>
          <button type="button" class="ghost sm danger" data-trash-purge="${esc(it.id)}">彻底删除</button>
        </div>
      </div>`;
    }).join("");

    $$("[data-trash-restore]", box).forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.trashRestore;
        btn.disabled = true;
        try {
          await api(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST", body: {} });
          items = items.filter(x => x.id !== id);
          draw();
          await loadMeetings();
          onMutated && onMutated(items.length);
          toast("已恢复会议记录", {
            ms: 5000,
            action: {
              label: "查看",
              onClick: () => {
                closeModal(false);
                location.hash = "#/m/" + id;
              },
            },
          });
        } catch (e) {
          btn.disabled = false;
          toast("恢复失败：" + e.message, 4500);
        }
      };
    });

    $$("[data-trash-purge]", box).forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.trashPurge;
        const ok = await confirmAction({
          title: "彻底删除这条记录？",
          message: "彻底删除后无法找回。",
          confirmText: "彻底删除",
          cancelText: "取消",
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await api(`/api/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
          items = items.filter(x => x.id !== id);
          draw();
          void loadTrashCount();
          onMutated && onMutated(items.length);
          toast("已彻底删除");
        } catch (e) {
          btn.disabled = false;
          toast("删除失败：" + e.message, 4500);
        }
      };
    });
  };
  draw();
}

async function openTrashModal() {
  const dlg = modal(`<div class="dlg-head"><h3>废纸篓</h3>
    <button type="button" class="ghost sm ic-btn" id="trashClose" aria-label="关闭废纸篓">${ic("x")}</button></div>
    <p class="muted small" style="margin:0 0 10px">已删除的会议记录会在这里保留 30 天，过期后自动清理。</p>
    <div id="trashListBox" style="max-height:60vh;overflow-y:auto"><p class="muted small">加载中…</p></div>`, { width: 540 });
  $("#trashClose", dlg).onclick = () => closeModal();
  try {
    const r = await api("/api/trash");
    if (!dlg.isConnected) return;
    const list = (r && r.items) || [];
    const btn = $("#trashBtn"), cnt = $("#trashCnt");
    if (btn) btn.hidden = list.length === 0;
    if (cnt) cnt.textContent = list.length > 0 ? String(list.length) : "";
    renderTrashList($("#trashListBox", dlg), list);
  } catch (e) {
    const box = $("#trashListBox", dlg);
    if (box) box.innerHTML = `<p class="muted small">加载失败：${esc(e.message || "网络错误")}</p>`;
  }
}

async function confirmSplit() {
  const a = S.amb, c = a && a.conv; if (!c) return true;
  const d = S.cur && S.cur.meta.id === c.id ? S.cur : null;
  const typed = $("#notes") ? $("#notes").value : d && d.notes;
  const mine = d && ((typed || "").trim() || d.minutes || (d.qa || []).length || d.meta.title_auto === false);
  if (mine || c.voiced_s >= a.cfg.min_speech_s) return true;
  return confirmAction({
    title: "提前结束这段对话？",
    message: `这段能认出字的发言只有 ${c.voiced_s} 秒，不足 ${a.cfg.min_speech_s} 秒，结束后会先放进「最近丢弃的片段」，7 天内可以恢复。`,
    confirmText: "确定结束",
    cancelText: "继续记录",
    danger: true,
  });
}

function renderAmb() {
  const box = $("#ambCard"), a = S.amb;
  $("#navBtn").dataset.amb = a && a.enabled ? a.state : "";
  if (!a) { box.innerHTML = ""; ambCardSig = ""; return; }
  const lvl = Math.max(0, Math.min(100, (a.level_db + 70) / 55 * 100));
  const sig = JSON.stringify([a.enabled, a.state, a.error, a.fallback, a.paused_until, a.conv && [a.conv.id, a.conv.speech_s], a.today]);
  if (sig === ambCardSig || $(".pop", box)) {
    const m = $(".amb-meter i", box); m && (m.style.transform = `scaleX(${(lvl / 100).toFixed(4)})`);
    ambCaption(box, a);
    return;
  }
  ambCardSig = sig;
  const on = a.enabled;
  let line = AMB_TXT[a.state] || a.state;
  if (a.state === "paused") line = a.paused_until === -1 ? "已暂停，麦克风已关闭" : `已暂停到 ${new Date(a.paused_until * 1000).toTimeString().slice(0, 5)}，麦克风已关闭`;
  if (a.state === "error") line = (a.error || "").startsWith("语音模型") ? a.error + "（点左下角“重试”）" : "出错，自动重试中：" + (a.error || "");
  if (a.fallback && ["listening", "speech"].includes(a.state)) line += ` · ${a.fallback}未连接，暂用电脑麦克风`;
  box.className = "amb " + (on ? "on " + a.state : "off");
  box.title = on ? "" : "全天模式：自动记录身边的对话，有人说话才录音";
  box.innerHTML = `<div class="row" style="gap:8px"><span class="adot"></span><b class="grow">全天模式</b>
      <label class="switch" title="${on ? "关闭" : "开启"}全天模式"><input type="checkbox" id="ambSw" aria-label="${on ? "关闭" : "开启"}全天模式" ${on ? "checked" : ""}><i></i></label></div>
    ${on ? `<div class="small aline" data-line="${esc(line)}">${esc(line)}</div>
      ${["listening", "speech"].includes(a.state) ? `<div class="meter amb-meter"><i style="transform:scaleX(${(lvl / 100).toFixed(4)})"></i></div>` : ""}
      ${a.conv ? `<a class="small aconv" href="#/m/${esc(a.conv.id)}"><span class="rdot"></span>当前对话 <span class="num">${hms(a.conv.started).slice(0, 5)}</span> 起 · 发言 ${fmtDur(a.conv.speech_s)}</a>` : ""}
      <div class="row small" style="gap:6px;margin-top:8px;flex-wrap:nowrap"><a href="#/day/${esc(a.today.date)}" class="grow muted">今天 ${a.today.count} 段 · 发言 ${fmtDur(a.today.speech_s)}</a>
        ${a.state === "paused" ? `<button class="sm" id="ambResume">恢复</button>` : a.state !== "held" ? `<div class="menu"><button class="sm lt" id="ambPause">暂停 ${ic("chev")}</button></div>` : ""}</div>` : ""}`;
  $("#ambSw").onchange = e => toggleAmb(e.target.checked);
  $("#ambResume") && ($("#ambResume").onclick = () => ambAct({ action: "resume" }));
  $("#ambPause") && ($("#ambPause").onclick = e => {
    e.stopPropagation();
    const menu = e.currentTarget.parentElement;
    const pop = popMenu(menu, [[30, "30 分钟"], [60, "1 小时"], [120, "2 小时"], [0, "直到我恢复"]]
      .map(([n, t]) => `<a data-min="${n}">${ic("clock")}暂停 ${t}</a>`).join("") + (a.conv ? `<a data-split="1">${ic("x")}现在结束当前这段对话</a>` : ""));
    pop && $$("a", pop).forEach(x => x.onclick = async () => {
      closePopMenus();
      if (x.dataset.split && !(await confirmSplit())) return;
      ambAct(x.dataset.split ? { action: "split" } : { action: "pause", minutes: +x.dataset.min });
    });
  });
  ambCaption(box, a);
}

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

async function ambAct(body) {
  try { S.amb = await api("/api/ambient", { method: "POST", body }); }
  catch (e) { toast(e.message); ambCardSig = ""; }
  renderAmb();
  if (body.action === "split") setTimeout(loadMeetings, 800);
}

async function toggleAmb(on) {
  const a = S.amb;
  if (on && !safeLSGet("ambIntro")) {
    const ok = await new Promise(res => {
      let settled = false;
      const done = v => { if (settled) return; settled = true; res(v); };
      // 传入 onClose：按 Esc、点遮罩或路由切换关闭弹窗时也能 resolve(false) 把开关拨回“关”
      const dlg = modal(`<h2>开启全天模式</h2>
        <ul class="intro">
          <li>后台直接用电脑麦克风持续监听，<b>不需要开着网页</b>；只有检测到有人说话才录音和转写，没人说话时不保存任何声音。</li>
          <li>静音超过 ${esc(a.cfg.split_min)} 分钟自动结束一段对话，随后精准转写并区分说话人；发言不足 ${esc(a.cfg.min_speech_s)} 秒的片段先放进「最近丢弃的片段」，保留 7 天（写过笔记、改过标题的会直接留下）。</li>
          <li>${a.cfg.summary_time ? `每天 ${esc(a.cfg.summary_time)} 自动生成当日汇总（需在设置里配好 AI 模型的 API Key）` : "可以在“当日汇总”页面一键生成当天的工作汇总"}。</li>
          <li>没人说话时约占单核 3% CPU。开启期间电脑不会自动休眠（屏幕照常熄灭）；合上盖子用电池时电脑会休眠，记录随之暂停。</li>
          <li>菜单栏会一直显示橙色麦克风图标。需要隐私时点“暂停”，麦克风会立即关闭。<b>请告知身边的人正在录音</b>，并遵守所在单位的规定。</li>
        </ul>
        <div class="row" style="justify-content:flex-end"><button id="aNo">取消</button><button class="pri" id="aYes">开启</button></div>`,
        () => done(false));
      $("#aNo", dlg).onclick = () => { closeModal(false); done(false); };
      $("#aYes", dlg).onclick = () => { closeModal(false); done(true); };
    });
    if (!ok) { ambCardSig = ""; return renderAmb(); }
    safeLSSet("ambIntro", "1");
  }
  await ambAct({ action: on ? "start" : "stop" });
  if (on) toast("全天模式已开启");
}

// ---------------- 路由 ----------------
let lastHash = location.hash || "#/";
let revertingHash = false;

async function route() {
  if (revertingHash) { revertingHash = false; return; }
  const targetHash = location.hash || "#/";
  // 若纪要编辑保存失败，不静默丢稿：让用户选择留在编辑页或确认放弃
  if (mdEditDirty()) {
    const ok = await saveMdEditNow();
    if (!ok) {
      const discard = await confirmAction({
        title: "放弃未保存的纪要修改？",
        message: "刚才的修改尚未保存成功，离开页面会丢弃这些内容。",
        confirmText: "放弃并离开",
        cancelText: "继续编辑",
        danger: true,
      });
      if (!discard) {
        if (targetHash !== lastHash) {
          revertingHash = true;
          history.replaceState(null, "", lastHash);
          revertingHash = false;
        }
        return;
      }
      resetMdEdit();
    }
  }
  const seq = ++S.routeSeq;
  lastHash = targetHash;
  clearPoll();
  REC.onUpdate = null;
  navOpen(false);
  closePalette(false);
  closeModal();
  // 笔记先发起保存（失败时 pendingNote 会独立于 DOM 在后台重试，不阻塞也绝不丢稿）
  await saveNotesNow();
  if (seq !== S.routeSeq) return;

  teardownView();
  $$(".side-nav-link").forEach(a => {
    const active = (a.dataset.nav === "todos" && targetHash === "#/todos")
      || (a.dataset.nav === "people" && (targetHash === "#/people" || targetHash.startsWith("#/people/")));
    a.classList.toggle("on", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const m = targetHash.match(/^#\/m\/([\w-]+)(?:\?t=(\d+))?/);
  const day = targetHash.match(/^#\/day\/(\d{4}-\d{2}-\d{2})/);
  const person = targetHash.match(/^#\/people\/(.+)$/);
  if (m) await showMeeting(m[1], m[2] ? { seq, initialSeekSec: Number(m[2]) } : seq);
  else if (day) { S.cur = null; await showDay(day[1], seq); }
  else if (targetHash === "#/todos") { S.cur = null; await showTodos(seq); }
  else if (person) { S.cur = null; await showPerson(decodeURIComponent(person[1]), seq); }
  else if (targetHash === "#/people") { S.cur = null; await showPeople(seq); }
  else { S.cur = null; showHome(); }
  sbCleanup();
  if (seq === S.routeSeq) renderSide();
}
window.addEventListener("hashchange", route);

// 唯一 beforeunload 监听（覆盖录音中、结束上传中、待保存笔记、未保存纪要修改）
window.addEventListener("beforeunload", e => {
  if (REC.active || REC.stopping || hasPendingNotes() || mdEditDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------------- 注册跨模块回调 & Playwright 全局兼容 ----------------
Object.assign(hooks, {
  route, showMeeting, showHome, showDay, showDiscarded, loadMeetings, openSettings,
  renderSide, renderAmb, renderPill, ambAct, confirmSplit, pollHealth,
  saveNotesNow, saveMdEditNow, teardownView, editingNow, renderPartial,
  switchTab, highlightPlaying, clearRange, renderDiscarded, renderTrashList, openTrashModal, loadTrashCount, renderTab, tabTranscript,
});

// Playwright 自动化测试（rec-resume.mjs / sweep.mjs / ui-checks.mjs）直接通过 window 访问这些符号
Object.assign(window, { REC, S, openSettings, closeModal, $ });

// ---------------- 启动 ----------------
initTheme();
initGlobalUI();
initPaletteListeners();
initDragUpload();
initRecorderListeners();
initPlayerListeners();
initMarkListeners();
syncSearchControls();

(async () => {
  await pollHealth();
  ambConnect();
  pollAmbient();
  await loadMeetings();
  await route();
  setInterval(() => { if (!document.hidden && !REC.active && !REC.stopping) loadMeetings(); }, 15000);
})();
