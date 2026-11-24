// 转写稿渲染、二分定位高亮、防抖增量搜索与步进、说话人筛选/改名、段落快捷操作与划词浮层
import {
  $, $$, GAP_TEXT, S, debounce, esc, escRe, fmtDur, fmtTs, getSpeakerMap,
  hl, hooks, ic, paras, recHealth, scrollBehavior, spkColor, spkName, tsLabel, whoLabel,
} from "./utils.js";
import { api } from "./api.js";
import { closeModal, confirmAction, copyText, hoverFill, isOverlayOpen, modal, sbCleanup, sbMarks, toast } from "./ui.js";

let paraCache = []; // { el, s, e, p, txtEl }[]
let prevActiveEls = [];
let prevScrollEl = null;
let partialT = null;
let activeSpkFilter = null;
let activeSpkFilterMid = null;
let selPopEl = null;
let selPopAbort = null;
let selPopTimer = null;
const dismissedRsiBanners = new Set();

const isGenericSpeakerName = name => {
  const v = String(name || "").trim();
  return !v || /^说话人\s*\d+$/.test(v) || ["我", "对方", "主持人"].includes(v);
};

function computeMarkedSet(marks, ps) {
  const out = new Set();
  if (!ps || !ps.length || !marks || !marks.length) return out;
  for (const mk of marks) {
    let lo = 0, hi = ps.length - 1, k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid].start <= mk.t_ms) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    out.add(k);
  }
  return out;
}

export function hideSelPop(clearSelection = false) {
  clearTimeout(selPopTimer);
  selPopTimer = null;
  if (selPopEl) {
    selPopEl.remove();
    selPopEl = null;
  }
  if (clearSelection) {
    try { const s = window.getSelection(); s && s.removeAllRanges(); } catch {}
  }
}

function openQuickVocabFixModal(selectedText, prefillTo = "") {
  const id = S.cur && S.cur.meta.id;
  if (!id) return;
  const fromInit = String(selectedText || "").trim();
  const toInit = String(prefillTo || "").trim();
  const count = f => paras().reduce((n, p) => n + (p.text.toLowerCase().split(f.toLowerCase()).length - 1), 0);
  const dlg = modal(`<h2>添加纠错规则</h2>
    <p class="muted">加入纠错表后，所有记录（包括以前的）里相同的写法都会自动改正；删掉规则即恢复原文。</p>
    <div class="row" style="margin:12px 0;gap:8px">
      <input id="qfxFrom" class="grow" aria-label="错误写法" value="${esc(fromInit)}">
      <span>→</span>
      <input id="qfxTo" class="grow" aria-label="正确写法" placeholder="输入正确写法" value="${esc(toInit)}" autofocus>
    </div>
    <div class="muted small" id="qfxPrev"></div>
    <label class="small" style="display:block;margin-top:8px"><input type="checkbox" id="qfxHot"> 同时把「<span id="qfxHotW"></span>」加入常用热词（帮助以后直接识别对）</label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" data-close-modal>取消</button><button type="button" class="pri" id="qfxYes">加入纠错表</button></div>`);
  const fromInp = $("#qfxFrom", dlg), toInp = $("#qfxTo", dlg), hotCb = $("#qfxHot", dlg);
  let hotTouched = false;
  hotCb.addEventListener("change", () => { hotTouched = true; });
  const sync = () => {
    const f = fromInp.value.trim(), t = toInp.value.trim();
    $("#qfxPrev", dlg).textContent = f ? `本场共有 ${count(f)} 处「${f}」会被改正` : "";
    $("#qfxHotW", dlg).textContent = t;
    if (!hotTouched) hotCb.checked = /[\u4e00-\u9fff]/.test(t) && t.length >= 2;
  };
  sync();
  fromInp.oninput = sync;
  toInp.oninput = sync;
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const f = fromInp.value.trim(), t = toInp.value.trim();
    if (!f || !t || f === t) return toast("请填写不同的错误写法与正确写法");
    if (f.length < 2 && !(await confirmAction({
      title: "单字规则可能范围过大",
      message: `「${f}」只有一个字，加入全局纠错表可能会误改其他词。确定继续添加吗？`,
      confirmText: "确定添加",
      cancelText: "我再调一下",
    }))) return;
    busy = true;
    const yes = $("#qfxYes", dlg);
    yes.disabled = true;
    try {
      await api("/api/vocab/fix", { method: "POST", body: { from: f, to: t, hotword: hotCb.checked } });
    } catch (err) {
      busy = false;
      if (yes.isConnected) yes.disabled = false;
      return toast("添加失败：" + err.message, 5000);
    }
    closeModal();
    if (S.cur && S.cur.meta.id === id && hooks.showMeeting) await hooks.showMeeting(id, { keepPlayer: true });
    toast(`已加入纠错表：${f} → ${t}`);
  };
  $("#qfxYes", dlg).onclick = submit;
  toInp.onkeydown = e => { if (e.key === "Enter" && !e.isComposing) submit(); };
  fromInp.onkeydown = e => { if (e.key === "Enter" && !e.isComposing) toInp.focus(); };
}

function showSelPop() {
  if (!S.cur || isOverlayOpen()) return hideSelPop();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return hideSelPop();
  const rawText = sel.toString();
  const text = rawText.trim();
  if (text.length < 2) return hideSelPop();
  const elOf = node => node && (node.nodeType === 1 ? node : node.parentElement);
  const aEl = elOf(sel.anchorNode), fEl = elOf(sel.focusNode);
  if (!aEl || !fEl) return hideSelPop();
  const blocked = "input, textarea, select, button, .pacts, .sel-pop";
  if (aEl.closest(blocked) || fEl.closest(blocked)) return hideSelPop();

  const parasBox = $("#paras"), mdBox = $("#mdBox");
  const inParas = !!(parasBox && parasBox.contains(aEl) && parasBox.contains(fEl) && !$("#peText", parasBox));
  const inMd = !!(mdBox && mdBox.contains(aEl) && mdBox.contains(fEl) && !$("#mdEdit"));
  if (!inParas && !inMd) return hideSelPop();

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return hideSelPop();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return hideSelPop();

  const d = S.cur;
  let quoteLine = text;
  let askPrompt = `关于纪要中的「${text}」：`;
  if (inParas) {
    const commonEl = elOf(range.commonAncestorContainer);
    const paraEl = (commonEl && commonEl.closest(".para[data-i]")) || aEl.closest(".para[data-i]");
    const p = paraEl ? paras(d)[+paraEl.dataset.i] : null;
    if (p) {
      const ts = fmtTs(p.start), who = whoLabel(p, d);
      quoteLine = `[${ts}] ${who ? who + "：" : ""}${text}`;
      askPrompt = `关于 [${ts}] ${who ? who + "说的" : ""}「${text}」：`;
    } else {
      askPrompt = `关于转写中的「${text}」：`;
    }
  }
  const canEdit = !d.ambient_active && !d.live_active && !["queued", "transcribing", "recording"].includes(d.meta.status);
  const canFix = inParas && canEdit && text.length <= 24 && !/\n/.test(text);

  if (selPopEl) selPopEl.remove();
  const pop = document.createElement("div");
  pop.className = "sel-pop";
  pop.setAttribute("role", "toolbar");
  pop.setAttribute("aria-label", "选中文字快捷操作");
  pop.innerHTML = `<button type="button" data-sel="quote">${ic("file")}引用</button>`
    + `<button type="button" data-sel="ask">${ic("sparkle")}问 AI</button>`
    + (canFix ? `<button type="button" data-sel="fix">${ic("pencil")}加纠错</button>` : "")
    + `<button type="button" data-sel="copy">${ic("copy")}复制</button>`;
  pop.addEventListener("mousedown", e => e.preventDefault());
  pop.addEventListener("click", e => {
    const btn = e.target.closest("button[data-sel]");
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.sel;
    if (act === "quote") {
      hideSelPop(true);
      hooks.quoteToNotes && hooks.quoteToNotes(quoteLine);
    } else if (act === "ask") {
      hideSelPop(true);
      hooks.askWithQuote && hooks.askWithQuote(askPrompt);
    } else if (act === "fix") {
      hideSelPop(true);
      openQuickVocabFixModal(text);
    } else if (act === "copy") {
      hideSelPop();
      copyText(text, "已复制选中文字");
    }
  });
  document.body.appendChild(pop);
  selPopEl = pop;

  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const margin = 8;
  let top = rect.top - ph - 8;
  if (top < margin) top = Math.min(window.innerHeight - ph - margin, rect.bottom + 8);
  const left = Math.max(margin, Math.min(window.innerWidth - pw - margin, rect.left + rect.width / 2 - pw / 2));
  pop.style.left = Math.round(left) + "px";
  pop.style.top = Math.round(top) + "px";
}

export function ensureSelectionPopover() {
  if (selPopAbort) return;
  const ac = new AbortController();
  selPopAbort = ac;
  const sig = ac.signal;
  const schedule = () => {
    clearTimeout(selPopTimer);
    selPopTimer = setTimeout(() => { selPopTimer = null; showSelPop(); }, 120);
  };
  document.addEventListener("selectionchange", schedule, { signal: sig });
  document.addEventListener("pointerup", e => {
    if (selPopEl && selPopEl.contains(e.target)) return;
    schedule();
  }, { signal: sig });
  document.addEventListener("keyup", e => {
    if (e.key === "Escape") { hideSelPop(); return; }
    schedule();
  }, { signal: sig });
  document.addEventListener("pointerdown", e => {
    if (selPopEl && !selPopEl.contains(e.target)) hideSelPop();
  }, { signal: sig });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && selPopEl) hideSelPop();
  }, { signal: sig });
  document.addEventListener("scroll", e => {
    if (selPopEl && !(e.target instanceof Node && selPopEl.contains(e.target))) hideSelPop();
  }, { capture: true, passive: true, signal: sig });
}

export function syncTranscriptMarks() {
  const d = S.cur;
  if (!d || !paraCache.length || !paraCache[0].el.isConnected) return;
  const markedAt = computeMarkedSet(d.marks, paras(d));
  for (let i = 0; i < paraCache.length; i++) {
    const el = paraCache[i].el;
    const idx = +el.dataset.i;
    const on = markedAt.has(idx);
    el.classList.toggle("marked", on);
    const mb = el.querySelector('.pact[data-pact="mark"]');
    if (mb) mb.classList.toggle("on", on);
  }
}

export function resetTranscriptCache() {
  paraCache = [];
  prevActiveEls = [];
  prevScrollEl = null;
  clearTimeout(partialT);
  partialT = null;
  hideSelPop();
  if (selPopAbort) {
    selPopAbort.abort();
    selPopAbort = null;
  }
}

// 二分查找指定时间（ms）对应的段落（用于悬浮提示与高亮定位）
export function findParaAt(ms, list = paras()) {
  if (!list.length) return null;
  let lo = 0, hi = list.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return null;
  // 向回检查少量重叠段落（如双声道/重叠发言）
  for (let i = idx; i >= Math.max(0, idx - 6); i--) {
    const p = list[i];
    if (ms >= p.start && ms < p.end) return p;
  }
  return null;
}

export function liveScroller() {
  return $("#paras") && ($("#trPane") ? $("#trScroll") : $("#main"));
}
export const atBottom = el => !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;

// 说话过程中的临时文字（全天模式）
export function renderPartial(fresh = false) {
  const box = $("#paras"), a = S.amb, d = S.cur;
  if (!box || !d || d.transcript || !a || !a.conv || a.conv.id !== d.meta.id) return;
  let el = $("#ambPartial");
  if (!a.partial) {
    if (el && !fresh) { clearTimeout(partialT); partialT = setTimeout(() => el.isConnected && el.remove(), 3000); }
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

export function tabTranscript() {
  const d = S.cur, ps = paras(), isLive = !d.transcript, pane = $("#trPane"), root = pane || $("#tabBody");
  if (!root || !d) return;
  const spkMeta = getSpeakerMap(d); // 单次 O(N) 预计算说话人名与颜色
  const canEdit = !d.ambient_active && !d.live_active && !["queued", "transcribing", "recording"].includes(d.meta.status);
  const hasSpk = spkMeta.ids.length > 0;
  const spkIds = spkMeta.ids;
  if (activeSpkFilterMid !== d.meta.id) {
    activeSpkFilter = null;
    activeSpkFilterMid = d.meta.id;
  }
  if (activeSpkFilter !== null && !spkIds.includes(activeSpkFilter)) activeSpkFilter = null;
  const durBy = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], name = whoLabel(p, d);
    durBy[name] = (durBy[name] || 0) + (p.end - p.start);
  }
  const tot = Object.values(durBy).reduce((a, b) => a + b, 0) || 1;
  const curSpeakers = (d.meta && d.meta.speakers) || {};
  const spkRsi = (d.meta && d.meta.speaker_meta) || {};
  const vpAutoMap = spkRsi.auto || {};
  const vpSuggestMap = spkRsi.suggest || {};
  const getAutoInfo = s => vpAutoMap[String(s)] ?? vpAutoMap[Number(s)] ?? null;
  const isAutoNamed = s => {
    const info = getAutoInfo(s);
    if (!info) return false;
    const cur = curSpeakers[String(s)] ?? curSpeakers[Number(s)];
    if (!cur) return false;
    return !info.name || cur === info.name;
  };
  const suggestions = [];
  if (!isLive && canEdit) {
    for (const [rawSpk, info] of Object.entries(vpSuggestMap)) {
      const spk = Number(rawSpk);
      if (!Number.isInteger(spk) || !info || !info.name) continue;
      const assigned = curSpeakers[String(spk)] ?? curSpeakers[spk];
      if (assigned && !isGenericSpeakerName(assigned)) continue;
      suggestions.push({ spk, name: String(info.name), score: Number(info.score) });
    }
  }
  const mergeHints = [];
  if (!isLive && canEdit && Array.isArray(spkRsi.merge_hints)) {
    for (const h of spkRsi.merge_hints) {
      if (!h || !h.name || !Array.isArray(h.spks)) continue;
      const spks = h.spks.map(Number).filter(Number.isInteger);
      if (spks.length < 2) continue;
      const names = spks.map(s => String(curSpeakers[String(s)] ?? curSpeakers[s] ?? "").trim());
      if (names.every(nm => nm && nm === names[0])) continue;
      mergeHints.push({ spks, name: String(h.name) });
    }
  }
  const bannerKey = (suggestions.length || mergeHints.length)
    ? `${d.meta.id}|${JSON.stringify(suggestions)}|${JSON.stringify(mergeHints)}`
    : "";
  const showRsiBanner = !!bannerKey && !dismissedRsiBanners.has(bannerKey);
  const fmtSpkList = list => {
    const labels = list.map(s => `「${esc(spkName(s, d))}」`);
    return labels.length === 2 ? `${labels[0]}与${labels[1]}` : `${labels.slice(0, -1).join("、")}与${labels[labels.length - 1]}`;
  };
  const spkChipHtml = s => {
    const name = spkName(s, d);
    const pct = Math.round((durBy[name] || 0) / tot * 100);
    const auto = isAutoNamed(s);
    const info = auto ? getAutoInfo(s) : null;
    const scoreTip = info && Number.isFinite(Number(info.score)) ? `（声纹相似度 ${Math.round(Number(info.score) * 100)}%）` : "";
    const isFiltered = activeSpkFilter === s;
    return `<span class="spk-item">`
      + `<button type="button" class="chip spk-filter${isFiltered ? " on" : ""}" data-spk-filter="${s}" aria-pressed="${isFiltered ? "true" : "false"}" title="点击筛选只看「${esc(name)}」的发言${esc(scoreTip)}">`
      + `<i class="dot" style="background:${spkColor(s, d)}"></i><span class="spk-nm">${esc(name)}</span>${auto ? `<span class="vp-tag">声纹</span>` : ""}<span class="muted num">${pct}%</span></button>`
      + `<button type="button" class="spk-ren" data-spk="${s}" aria-label="修改 ${esc(name)} 姓名" title="修改姓名（改成同名即可合并）">${ic("pencil")}</button>`
      + `${auto && !isLive && canEdit ? `<button type="button" class="vp-undo" data-vp-undo="${s}" title="撤销声纹自动认人">不是此人</button>` : ""}`
      + `</span>`;
  };
  const rsiBannerHtml = showRsiBanner ? `<div class="banner small rsi-banner" role="region" aria-label="声纹识别建议">
    <div class="rsi-banner-head">
      <span class="rsi-banner-title">声纹识别建议</span>
      <button type="button" class="sm ghost rsi-banner-close" data-rsi-banner-close>收起</button>
    </div>
    <div class="rsi-banner-list">
      ${suggestions.map((item, i) => `<div class="rsi-banner-row">
        <span class="grow">「${esc(spkName(item.spk, d))}」疑似 <b>${esc(item.name)}</b>${Number.isFinite(item.score) ? ` <span class="muted num">(${Math.round(item.score * 100)}%)</span>` : ""}</span>
        <button type="button" class="sm pri" data-vp-accept="${i}">确认</button>
      </div>`).join("")}
      ${mergeHints.map((h, i) => `<div class="rsi-banner-row">
        <span class="grow">${fmtSpkList(h.spks)}疑似同一人（<b>${esc(h.name)}</b>）</span>
        <button type="button" class="sm pri" data-vp-merge="${i}">合并命名</button>
      </div>`).join("")}
    </div>
  </div>` : "";
  const gaps = (recHealth(d.meta) || { gaps: [] }).gaps;
  let gi = 0;
  const gapRow = g => `<div class="gapmark"><span>${ic("clock")}${tsLabel(g.at_ms)} 这里有 ${fmtDur(Math.max(1, g.dur_ms / 1000))} 没录到：${GAP_TEXT[g.reason] || GAP_TEXT.stall}</span></div>`;
  const markedAt = computeMarkedSet(d.marks, ps);
  const whoKey = x => (x.spks && x.spks.length ? x.spks.join(",") : String(x.spk));
  const rows = ps.map((p, i) => {
    const first = hasSpk && (i === 0 || whoKey(ps[i - 1]) !== whoKey(p));
    let pre = "";
    while (gi < gaps.length && gaps[gi].at_ms <= p.start) pre += gapRow(gaps[gi++]);
    const label = first ? whoLabel(p, d) : "";
    const autoTip = first && isAutoNamed(p.spk) ? "（声纹自动识别）" : "";
    return pre + `<div class="para${first ? " first" : ""}${p.edited ? " edited" : ""}${markedAt.has(i) ? " marked" : ""}" data-i="${i}" data-s="${p.start}" data-e="${p.end}"${hasSpk ? ` style="--c:${spkColor(p.spk, d)}"` : ""}>`
      + `<a class="ts" data-ts="${fmtTs(p.start)}">${tsLabel(p.start)}</a>`
      + (hasSpk ? `<span class="who">${first ? `<b data-spk="${p.spk}" title="${esc(label)}${autoTip} · 点击改名">${esc(label)}</b>` : ""}</span>` : "")
      + `<div class="txt"${p.edited ? ` title="已手动修改"` : ""}>${esc(p.text)}</div>`
      + `<span class="pacts">`
      + `<button type="button" class="pact" data-pact="quote" data-i="${i}" title="引用到我的笔记" aria-label="引用这段到笔记">${ic("file")}</button>`
      + `<button type="button" class="pact" data-pact="ask" data-i="${i}" title="就这段向 AI 提问" aria-label="就这段向 AI 提问">${ic("sparkle")}</button>`
      + `<button type="button" class="pact${markedAt.has(i) ? " on" : ""}" data-pact="mark" data-i="${i}" title="在这里打点标记" aria-label="在这里打点标记">${ic("flag")}</button>`
      + `<button type="button" class="pact" data-pact="copy" data-i="${i}" title="复制这段" aria-label="复制这段">${ic("copy")}</button>`
      + (canEdit ? `<button type="button" class="pact pedit" data-pact="edit" data-i="${i}" title="修改这段（也可以双击文字）" aria-label="修改这段">${ic("pencil")}</button>` : "")
      + `</span></div>`;
  }).join("") + (ps.length ? gaps.slice(gi).map(gapRow).join("") : "");

  const keep = ($("#trScroll") || {}).scrollTop || 0;
  root.innerHTML = `
    <div class="tr-tool">${pane ? `<b class="pane-t">转写稿</b>` : ""}
      <div class="search-box">
        <input id="tSearch" class="search" placeholder="搜索转写内容" aria-label="搜索转写内容">
        <button type="button" class="search-clr" id="tSearchClr" hidden aria-label="清空转写搜索" title="清空搜索">${ic("x")}</button>
      </div>
      <span class="muted small num tr-cnt" id="tCount"></span>
      <span class="tr-nav" id="tNav" hidden>
        <button type="button" class="sm ghost tr-step" id="tPrev" aria-label="上一处" title="上一处（Shift+Enter）">${ic("chev")}</button>
        <button type="button" class="sm ghost tr-step" id="tNext" aria-label="下一处" title="下一处（Enter）">${ic("chev")}</button>
      </span>
      <span class="grow"></span><label class="small muted follow"><input type="checkbox" id="follow" ${S.follow ? "checked" : ""}>跟随播放</label></div>
    ${isLive && ps.length ? `<div class="muted small tr-note">当前显示的是实时转写稿，精准转写完成后会自动替换并区分说话人。</div>` : ""}
    ${!isLive && (d.suspects || []).length ? `<div class="banner small hw-sus"><span class="muted">可能认错的热词</span>${d.suspects.map((s, i) =>
      `<span class="hw-item"><a class="ts" data-ts="${fmtTs(s.at[0])}" title="跳到第一处，听一下">${esc(s.text)}</a><span class="muted">→ ${esc(s.hotword)}${s.count > 1 ? ` · ${s.count} 处` : ""}</span>`
      + (canEdit ? `<button type="button" class="sm" data-sus="${i}" title="加一条纠错规则：以后所有记录里的“${esc(s.text)}”都显示成“${esc(s.hotword)}”">改</button>`
        + `<button type="button" class="sm ghost hw-dismiss" data-sus-dismiss="${i}" data-hw="${esc(s.hotword)}" data-text="${esc(s.text)}" title="标记为误报，后续不再提示">忽略</button>` : "") + `</span>`).join("")}</div>` : ""}
    ${hasSpk ? `<div class="spk-chips">${spkIds.map(spkChipHtml).join("")}<span class="spk-filter-bar" id="spkFilterBar" hidden></span>${!isLive && canEdit && spkIds.length > 1
        ? `<button type="button" class="sm ghost" id="guessNames" title="让 AI 从转写里找自我介绍、点名后回应这类线索，推测说话人是谁；你确认后才改名">推测姓名</button>` : ""}</div>` : ""}
    ${rsiBannerHtml}
    <div class="tr-scroll" id="trScroll"><div id="paras" class="${hasSpk ? "" : "nospk"}">${rows
      || `<div class="empty">${["queued", "transcribing"].includes(d.meta.status) ? "转写中…" : "没有识别到语音内容"}</div>`}</div></div>`;

  if (pane) $("#trScroll").scrollTop = keep;
  sbCleanup();
  hoverFill($("#paras"), ".para");
  ensureSelectionPopover();

  // 仅索引带 data-i 的真实段落，排除 #ambPartial，支撑 O(log N) 高亮与差量搜索
  paraCache = $$(".para[data-i]", root).map(el => {
    const idx = +el.dataset.i;
    return { el, s: +el.dataset.s, e: +el.dataset.e, p: ps[idx], txtEl: $(".txt", el) };
  });
  prevActiveEls = [];
  prevScrollEl = null;

  $("#follow").onchange = e => { S.follow = e.target.checked; };
  $$("[data-spk]", root).forEach(el => el.onclick = () => renameSpeaker(+el.dataset.spk));
  $("#guessNames", root) && ($("#guessNames", root).onclick = () => guessNames());
  $$("[data-vp-undo]", root).forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    const spk = Number(btn.dataset.vpUndo);
    btn.disabled = true;
    try {
      const updatedMeta = await api("/api/rsi/voiceprints/undo", {
        method: "POST",
        body: { mid: d.meta.id, spk },
      });
      if (S.cur && S.cur.meta.id === d.meta.id && updatedMeta && typeof updatedMeta === "object") {
        S.cur.meta = updatedMeta;
      }
    } catch (err) {
      if (btn.isConnected) btn.disabled = false;
      return toast("撤销失败：" + err.message, 5000);
    }
    toast("已撤销自动认人，声纹模型已记录反馈");
    if (hooks.showMeeting && S.cur && S.cur.meta.id === d.meta.id) await hooks.showMeeting(d.meta.id, { keepPlayer: true });
    else tabTranscript();
  }));
  const closeBannerBtn = $("[data-rsi-banner-close]", root);
  if (closeBannerBtn && bannerKey) {
    closeBannerBtn.addEventListener("click", () => {
      dismissedRsiBanners.add(bannerKey);
      const b = closeBannerBtn.closest(".rsi-banner");
      if (b) b.remove();
    });
  }
  $$("[data-vp-accept]", root).forEach(btn => btn.addEventListener("click", async () => {
    const item = suggestions[+btn.dataset.vpAccept];
    if (!item || !S.cur || S.cur.meta.id !== d.meta.id) return;
    btn.disabled = true;
    const sp = { ...(S.cur.meta.speakers || {}), [String(item.spk)]: item.name };
    try {
      const updated = await api(`/api/meetings/${d.meta.id}`, { method: "PATCH", body: { speakers: sp } });
      if (S.cur && S.cur.meta.id === d.meta.id && updated && typeof updated === "object") S.cur.meta = updated;
    } catch (err) {
      if (btn.isConnected) btn.disabled = false;
      return toast("确认失败：" + err.message, 5000);
    }
    toast(`已确认发言人：${item.name}`);
    if (hooks.showMeeting && S.cur && S.cur.meta.id === d.meta.id) await hooks.showMeeting(d.meta.id, { keepPlayer: true });
    else tabTranscript();
  }));
  $$("[data-vp-merge]", root).forEach(btn => btn.addEventListener("click", async () => {
    const h = mergeHints[+btn.dataset.vpMerge];
    if (!h || !S.cur || S.cur.meta.id !== d.meta.id) return;
    btn.disabled = true;
    const sp = { ...(S.cur.meta.speakers || {}) };
    for (const s of h.spks) sp[String(s)] = h.name;
    try {
      const updated = await api(`/api/meetings/${d.meta.id}`, { method: "PATCH", body: { speakers: sp } });
      if (S.cur && S.cur.meta.id === d.meta.id && updated && typeof updated === "object") S.cur.meta = updated;
    } catch (err) {
      if (btn.isConnected) btn.disabled = false;
      return toast("合并失败：" + err.message, 5000);
    }
    toast(`已合并命名为：${h.name}`);
    if (hooks.showMeeting && S.cur && S.cur.meta.id === d.meta.id) await hooks.showMeeting(d.meta.id, { keepPlayer: true });
    else tabTranscript();
  }));
  $$("[data-sus]", root).forEach(el => el.onclick = async () => {
    const s = d.suspects[+el.dataset.sus]; el.disabled = true;
    try { await api("/api/vocab/fix", { method: "POST", body: { from: s.text, to: s.hotword } }); }
    catch (e) { el.disabled = false; return toast("没改成：" + e.message, 5000); }
    toast(`已加纠错规则：${s.text} → ${s.hotword}`);
    hooks.showMeeting && await hooks.showMeeting(d.meta.id, { keepPlayer: true });
  });
  $$("[data-sus-dismiss]", root).forEach(el => el.addEventListener("click", async () => {
    const s = (d.suspects || [])[+el.dataset.susDismiss];
    const hotword = (s && s.hotword) || el.dataset.hw || "";
    const text = (s && s.text) || el.dataset.text || "";
    if (!hotword || !text) return;
    el.disabled = true;
    try { await api("/api/rsi/vocab/suspect/dismiss", { method: "POST", body: { hotword, text } }); }
    catch (e) { if (el.isConnected) el.disabled = false; return toast("忽略失败：" + e.message, 5000); }
    if (S.cur && S.cur.meta.id === d.meta.id && Array.isArray(S.cur.suspects)) {
      S.cur.suspects = S.cur.suspects.filter(x => !(x.hotword === hotword && x.text === text));
    }
    toast("后续将不再提示该误报");
    tabTranscript();
  }));

  // 单一事件委托处理段落快捷栏与双击编辑
  const parasBox = $("#paras", root);
  parasBox.addEventListener("click", async e => {
    const btn = e.target.closest(".pact[data-i]");
    if (!btn) return;
    e.stopPropagation();
    const idx = +btn.dataset.i;
    const p = ps[idx];
    if (!p) return;
    const act = btn.dataset.pact;
    const who = whoLabel(p, d);
    const ts = fmtTs(p.start);
    const quoteLine = `[${ts}] ${who ? who + "：" : ""}${p.text}`;
    if (act === "quote") {
      hooks.quoteToNotes && hooks.quoteToNotes(quoteLine);
    } else if (act === "ask") {
      hooks.askWithQuote && hooks.askWithQuote(`关于 [${ts}] ${who ? who + "说的" : ""}「${p.text}」：`);
    } else if (act === "mark") {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        hooks.addMarkAt && await hooks.addMarkAt(p.start, p.text.slice(0, 60));
      } finally {
        if (btn.isConnected) btn.disabled = false;
      }
    } else if (act === "copy") {
      const ok = await copyText(quoteLine, "已复制该段转写");
      if (ok && btn.isConnected) {
        btn.classList.add("copied");
        setTimeout(() => btn.isConnected && btn.classList.remove("copied"), 1200);
      }
    } else if (act === "edit") {
      editPara(idx);
    }
  });
  parasBox.addEventListener("click", e => {
    if (e.target.closest("a, button, [data-spk], textarea, select, input")) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) return;
    const row = e.target.closest(".para[data-i]");
    if (!row) return;
    const wasOpen = row.classList.contains("pacts-open");
    $$(".para.pacts-open", parasBox).forEach(el => el.classList.remove("pacts-open"));
    if (!wasOpen) row.classList.add("pacts-open");
  });
  if (canEdit) {
    parasBox.addEventListener("dblclick", e => {
      const txt = e.target.closest(".para[data-i] .txt");
      if (!txt || $("#peText", txt)) return;
      editPara(+txt.closest(".para[data-i]").dataset.i);
    });
  }

  // 搜索步进（↑ / ↓ + Enter / Shift+Enter + 清空 ×）与说话人筛选协同
  const searchInp = $("#tSearch", root);
  const searchClr = $("#tSearchClr", root);
  const cntEl = $("#tCount", root);
  const navEl = $("#tNav", root);
  const prevBtn = $("#tPrev", root);
  const nextBtn = $("#tNext", root);
  let composing = false;
  let lastQuery = "";
  let matchMarks = [];
  let curMatchIdx = -1;

  const scrollToMark = markEl => {
    if (!markEl) return;
    const sc = pane ? $("#trScroll") : $("#main");
    const behavior = scrollBehavior();
    if (!sc) { markEl.scrollIntoView({ behavior, block: "center" }); return; }
    const cr = sc.getBoundingClientRect(), r = markEl.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + (r.top - cr.top) - (sc.clientHeight - r.height) / 2, behavior });
  };

  const syncMatchCursor = (idx, scroll = true) => {
    if (curMatchIdx >= 0 && matchMarks[curMatchIdx]) matchMarks[curMatchIdx].classList.remove("cur");
    if (!matchMarks.length) {
      curMatchIdx = -1;
      if (cntEl) cntEl.textContent = lastQuery ? "0 处匹配" : "";
      if (navEl) navEl.hidden = true;
      return;
    }
    curMatchIdx = ((idx % matchMarks.length) + matchMarks.length) % matchMarks.length;
    const cur = matchMarks[curMatchIdx];
    cur.classList.add("cur");
    if (cntEl) cntEl.textContent = `${curMatchIdx + 1} / ${matchMarks.length}`;
    if (navEl) navEl.hidden = false;
    if (scroll) scrollToMark(cur);
  };

  const collectVisibleMarks = (scroll = false) => {
    const prevEl = curMatchIdx >= 0 ? matchMarks[curMatchIdx] : null;
    if (prevEl) prevEl.classList.remove("cur");
    matchMarks = [];
    const hits = [];
    if (lastQuery) {
      for (let i = 0; i < paraCache.length; i++) {
        const item = paraCache[i];
        if (!item.el.dataset.hit || item.el.classList.contains("f-hide")) continue;
        const marks = $$("mark", item.txtEl);
        if (marks.length) {
          hits.push(item.el);
          for (let j = 0; j < marks.length; j++) matchMarks.push(marks[j]);
        }
      }
    }
    sbMarks(pane ? $("#trScroll") : $("#main"), hits);
    const keepIdx = prevEl ? matchMarks.indexOf(prevEl) : -1;
    syncMatchCursor(keepIdx >= 0 ? keepIdx : 0, scroll && matchMarks.length > 0);
  };

  const runSearch = (scroll = true) => {
    if (!searchInp.isConnected) return;
    const q = searchInp.value.trim();
    lastQuery = q;
    if (searchClr) searchClr.hidden = !searchInp.value;
    const re = q ? new RegExp(escRe(q), "gi") : null;
    for (let i = 0; i < paraCache.length; i++) {
      const item = paraCache[i], el = item.el, t = item.txtEl, p = item.p;
      if (!p || !t || $("#peText", t)) continue;
      if (!q) {
        if (el.dataset.hit) { t.textContent = p.text; delete el.dataset.hit; }
        continue;
      }
      const matches = p.text.match(re);
      if (matches && matches.length > 0) {
        t.innerHTML = hl(p.text, q);
        el.dataset.hit = "1";
      } else if (el.dataset.hit) {
        t.textContent = p.text;
        delete el.dataset.hit;
      }
    }
    curMatchIdx = -1;
    collectVisibleMarks(scroll);
  };

  const debouncedSearch = debounce(() => runSearch(true), 120);
  searchInp.addEventListener("compositionstart", () => { composing = true; });
  searchInp.addEventListener("compositionend", () => { composing = false; runSearch(true); });
  searchInp.addEventListener("input", () => {
    if (searchClr) searchClr.hidden = !searchInp.value;
    if (!composing) debouncedSearch();
  });
  searchInp.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchInp.value.trim() !== lastQuery) runSearch(true);
      else if (matchMarks.length) syncMatchCursor(curMatchIdx + (e.shiftKey ? -1 : 1), true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (searchInp.value) { searchInp.value = ""; runSearch(false); }
      searchInp.blur();
    }
  });
  if (searchClr) {
    searchClr.onclick = () => {
      searchInp.value = "";
      runSearch(false);
      searchInp.focus();
    };
  }
  if (prevBtn) prevBtn.onclick = () => { if (matchMarks.length) syncMatchCursor(curMatchIdx - 1, true); };
  if (nextBtn) nextBtn.onclick = () => { if (matchMarks.length) syncMatchCursor(curMatchIdx + 1, true); };

  // 说话人筛选（纯 CSS class 切换，不重建 DOM）
  const applySpeakerFilter = () => {
    let shown = 0;
    const total = paraCache.length;
    for (let i = 0; i < paraCache.length; i++) {
      const item = paraCache[i], p = item.p;
      const ok = activeSpkFilter === null
        || (p && (p.spk === activeSpkFilter || (Array.isArray(p.spks) && p.spks.includes(activeSpkFilter))));
      item.el.classList.toggle("f-hide", !ok);
      if (ok) shown++;
    }
    $$(".spk-filter", root).forEach(btn => {
      const on = activeSpkFilter !== null && +btn.dataset.spkFilter === activeSpkFilter;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const fbar = $("#spkFilterBar", root);
    if (fbar) {
      if (activeSpkFilter === null) {
        fbar.hidden = true;
        fbar.innerHTML = "";
      } else {
        fbar.hidden = false;
        const nm = spkName(activeSpkFilter, d);
        const personLink = !isGenericSpeakerName(nm)
          ? `<a class="spk-person-link" href="#/people/${encodeURIComponent(nm)}">查看 TA 的全部会议 →</a>`
          : "";
        fbar.innerHTML = `<span class="muted small">仅看 ${esc(nm)}（<span class="num">${shown}/${total}</span> 段）</span>`
          + personLink
          + `<button type="button" class="sm ghost" id="spkFilterClr">显示全部</button>`;
        const clr = $("#spkFilterClr", fbar);
        if (clr) clr.onclick = () => { activeSpkFilter = null; applySpeakerFilter(); };
      }
    }
    if (lastQuery) collectVisibleMarks(false);
    hooks.syncPlayerSpeakerFilter && hooks.syncPlayerSpeakerFilter(activeSpkFilter);
    sbCleanup();
  };
  $$(".spk-filter", root).forEach(btn => btn.addEventListener("click", () => {
    const s = +btn.dataset.spkFilter;
    activeSpkFilter = activeSpkFilter === s ? null : s;
    applySpeakerFilter();
  }));
  if (activeSpkFilter !== null) applySpeakerFilter();
  else hooks.syncPlayerSpeakerFilter && hooks.syncPlayerSpeakerFilter(null);

  renderPartial(true);
}

// 修改一段转写：双声道实时稿使用原始未排序索引 _idx，避免改错/删错段落
export function editPara(i) {
  hideSelPop();
  const d = S.cur, id = d && d.meta.id, ps = paras(), p = ps[i], el = $(`.para[data-i="${i}"]`);
  if (!d || !p || !el || $("#peText")) return;
  const origIdx = p._idx ?? i;
  const hasSpk = !!d.transcript;
  const ids = getSpeakerMap(d).ids;
  const next = ids.length ? Math.max(...ids) + 1 : 0;
  const box = $(".txt", el);
  box.innerHTML = `<textarea id="peText" class="pe-text" aria-label="编辑转写段落">${esc(p.text)}</textarea>
    <div class="muted small" style="margin-top:4px">清空文字再保存 = 删除这段<span class="kbd"> · ⌘↩ 保存 · Esc 取消</span></div>
    <div class="row small" style="gap:8px;margin-top:6px;flex-wrap:wrap">
      ${hasSpk ? `<select id="peSpk" title="说话人" aria-label="说话人">${ids.map(s => `<option value="${s}" ${s === p.spk ? "selected" : ""}>${esc(spkName(s, d))}</option>`).join("")}
        <option value="${next}">新说话人（${esc(spkName(next, d))}）</option></select>` : ""}
      <span class="grow"></span><button class="sm" id="peCancel">取消</button><button class="sm pri" id="peSave">保存</button></div>`;
  const ta = $("#peText", box);
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
  fit(); ta.oninput = fit; ta.focus();
  let saving = false;
  const save = async () => {
    if (saving) return;
    const text = ta.value.trim(), body = {};
    if (text !== p.text) body.text = text;
    if (hasSpk && +$("#peSpk", box).value !== p.spk) body.spk = +$("#peSpk", box).value;
    if (!Object.keys(body).length) return tabTranscript();
    if (text === "" && !(await confirmAction({
      title: "删除这段转写？",
      message: "内容已清空，保存后会移除这一段转写记录。",
      confirmText: "删除段落",
      cancelText: "继续编辑",
      danger: true,
    }))) return;
    saving = true;
    const sb = $("#peSave", box), cb = $("#peCancel", box);
    if (sb) sb.disabled = true;
    if (cb) cb.disabled = true;
    try {
      const r = await api(`/api/meetings/${id}/paragraphs/${origIdx}`, { method: "PUT", body });
      if (!S.cur || S.cur.meta.id !== id) return;
      Object.assign(S.cur, { meta: r.meta, transcript: r.transcript, live: r.live, minutes_stale: r.minutes_stale, suspects: r.suspects });
    } catch (e) {
      saving = false;
      if (sb) sb.disabled = false;
      if (cb) cb.disabled = false;
      return toast(e.message, 4000);
    }
    tabTranscript();
    if (body.text) suggestFix(p.text, text);
  };
  $("#peSave", box).onclick = save;
  $("#peCancel", box).onclick = () => !saving && tabTranscript();
  ta.onkeydown = e => {
    if (e.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
    else if (e.key === "Escape" && !saving) tabTranscript();
  };
}

function diffFix(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const cut = () => [a.slice(i, a.length - j), b.slice(i, b.length - j)];
  let [from, to] = cut();
  while (from.length < 2 && (i > 0 || j > 0)) {
    if (i > 0 && !/[，。？！、；：,.?!;:\s]/.test(a[i - 1])) i--;
    else if (j > 0) j--;
    else break;
    [from, to] = cut();
  }
  return { from: from.trim(), to: to.trim() };
}

async function suggestFix(oldText, newText) {
  const id = S.cur && S.cur.meta.id;
  if (!id) return;
  const { from, to } = diffFix(oldText, newText);
  const strip = s => s.replace(/[\s，。？！、；：,.?!;:“”"']/g, "");
  if (!from || !to || from.length > 16 || to.length > 16 || strip(from) === strip(to)) return toast("已保存");
  const v = await api("/api/vocab").catch(() => ({ fixes: [] }));
  if (!S.cur || S.cur.meta.id !== id) return; // 离开该会议后不再弹旧建议
  const rev = v.fixes.find(f => f.to && to.toLowerCase().includes(f.from.toLowerCase()) && from.toLowerCase().includes(f.to.toLowerCase()));
  if (rev) return toast(`已保存。这段是手动改过的，纠错规则「${rev.from} → ${rev.to}」不会再改动它`, 5000);
  toast(`已保存 · 将「${from} → ${to}」加入自动纠错？`, {
    ms: 6500,
    action: {
      label: "加入词库",
      onClick: () => openQuickVocabFixModal(from, to),
    },
  });
}

// 二分定位 + 差量切换 .active，只在当前段变化或显式 reveal 时触发滚动
export function highlightPlaying(ms, reveal = false) {
  if (!paraCache.length || !paraCache[0].el.isConnected) return;
  const n = paraCache.length;
  let lo = 0, hi = n - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paraCache[mid].s <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const nextActive = [];
  let cur = null;
  if (idx >= 0) {
    // 向前检查少量可能仍在播的重叠段落（双声道/长段）
    const startScan = Math.max(0, idx - 16);
    for (let i = startScan; i <= idx; i++) {
      const it = paraCache[i];
      if (ms >= it.s && ms < it.e + 300) {
        nextActive.push(it.el);
        cur = it.el;
      }
    }
  }
  // 差量更新 .active，仅修改变化节点
  const nextSet = new Set(nextActive);
  for (let i = 0; i < prevActiveEls.length; i++) {
    const el = prevActiveEls[i];
    if (!nextSet.has(el)) el.classList.remove("active");
  }
  for (let i = 0; i < nextActive.length; i++) {
    const el = nextActive[i];
    if (!el.classList.contains("active")) el.classList.add("active");
  }
  prevActiveEls = nextActive;

  if (reveal) {
    cur = cur || (idx >= 0 ? paraCache[idx].el : null);
    if (cur) { prevScrollEl = cur; scrollToPara(cur); }
  } else if (cur && cur !== prevScrollEl && S.follow) {
    const a = $("#audio");
    if (a && !a.paused) { prevScrollEl = cur; scrollToPara(cur); }
  }
}

export function scrollToPara(el, center = false) {
  const pane = $("#trPane"), sc = pane ? $("#trScroll") : $("#main");
  if (!sc || !el || !el.isConnected || el.classList.contains("f-hide")) return;
  const cr = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (!center && r.top >= cr.top + (pane ? 8 : 120) && r.bottom <= cr.bottom - 40) return;
  sc.scrollTo({ top: sc.scrollTop + (r.top - cr.top) - (sc.clientHeight - r.height) / 2, behavior: scrollBehavior() });
}

export async function guessNames() {
  const d = S.cur, id = d && d.meta.id;
  if (!id) return;
  const dlg = modal(`<h2>推测说话人姓名</h2><p class="muted" id="gnSt">AI 正在从转写里找自我介绍、点名后回应这类线索…</p><div id="gnBody"></div>`);
  let r;
  try { r = await api(`/api/meetings/${id}/speaker-names`, { method: "POST", body: {}, timeout: 90000 }); }
  catch (e) {
    if (!dlg.isConnected) return;
    $("#gnSt", dlg).textContent = "没推测出来：" + e.message;
    $("#gnBody", dlg).innerHTML = `<div class="row" style="justify-content:flex-end"><button data-close-modal>关闭</button></div>`;
    return;
  }
  if (!dlg.isConnected || !S.cur || S.cur.meta.id !== id) return;
  const cs = r.candidates || [];
  $("#gnSt", dlg).innerHTML = cs.length
    ? `下面是有原话为证的推测（${esc(r.provider)}，${esc(r.cost)}s）。只是推测：先点时间听一下，确认后勾选再改名。`
    : `转写里没有找到能确定身份的直接线索（自我介绍、点名后回应等），没有可推荐的名字。`;
  $("#gnBody", dlg).innerHTML = (cs.length ? `<div class="gn-list">${cs.map((c, i) => `<div class="gn-row">
      <label class="gn-head"><input type="checkbox" data-gi="${i}"> ${esc(spkName(c.spk))} →
        <input class="gn-name" data-gn="${i}" aria-label="说话人姓名" value="${esc(c.name)}"> <span class="muted small">把握：${esc(c.confidence)}</span></label>
      <div class="muted small">${esc(c.reason)}</div>
      ${c.evidence.map(e => `<div class="small gn-ev"><a class="ts" data-ts="${esc(e.ts)}">[${esc(e.ts)}]</a> ${esc(spkName(e.spk))}：${esc(e.quote)}</div>`).join("")}</div>`).join("")}</div>` : "")
    + `<div class="row" style="justify-content:flex-end;margin-top:12px"><button data-close-modal>${cs.length ? "取消" : "关闭"}</button>${cs.length ? `<button class="pri" id="gnOk">按勾选的改名</button>` : ""}</div>`;
  const ok = $("#gnOk", dlg); if (!ok) return;
  let busy = false;
  ok.onclick = async () => {
    if (busy) return;
    const sp = { ...(S.cur.meta.speakers || {}) }; let n = 0;
    $$("[data-gi]", dlg).forEach(cb => {
      if (!cb.checked) return;
      const c = cs[+cb.dataset.gi], v = $(`[data-gn="${cb.dataset.gi}"]`, dlg).value.trim();
      if (v) { sp[String(c.spk)] = v; n++; }
    });
    if (!n) return toast("没有勾选要改名的说话人");
    busy = true; ok.disabled = true;
    try { S.cur.meta = await api(`/api/meetings/${id}`, { method: "PATCH", body: { speakers: sp } }); }
    catch (e) { busy = false; ok.disabled = false; return toast("改名没保存上：" + e.message, 5000); }
    closeModal(); toast(`已改名 ${n} 位说话人`);
    hooks.showMeeting && await hooks.showMeeting(id);
  };
}

export function renameSpeaker(spk) {
  if (!S.cur) return;
  const id = S.cur.meta.id;
  const cur = spkName(spk);
  const names = [...new Set(Object.values(S.cur.meta.speakers || {}))];
  const dlg = modal(`<h2>修改发言人姓名</h2><p class="muted">“${esc(cur)}”的所有发言都会改名。改成已有的名字即可合并两个说话人。</p>
    <input id="nName" style="width:100%;margin:10px 0" aria-label="发言人姓名" value="${esc(cur)}" list="nameList"><datalist id="nameList">${names.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    <div class="row" style="justify-content:flex-end"><button data-close-modal>取消</button><button class="pri" id="nOk">保存</button></div>`);
  const inp = $("#nName", dlg); inp.select();
  let busy = false;
  const ok = async () => {
    if (busy || !S.cur || S.cur.meta.id !== id) return;
    const v = inp.value.trim(); const sp = { ...(S.cur.meta.speakers || {}) };
    if (v && v !== `说话人${spk + 1}`) sp[String(spk)] = v; else delete sp[String(spk)];
    busy = true; $("#nOk", dlg).disabled = true;
    try { S.cur.meta = await api(`/api/meetings/${id}`, { method: "PATCH", body: { speakers: sp } }); }
    catch (e) { busy = false; $("#nOk", dlg).disabled = false; return toast("改名没保存上：" + e.message, 5000); }
    closeModal();
    hooks.showMeeting && await hooks.showMeeting(id);
  };
  $("#nOk", dlg).onclick = ok;
  inp.onkeydown = e => e.key === "Enter" && ok();
}
