// 首页、会议详情、实时录音页、打点、笔记（独立于 DOM 的持久重试）、纪要生成与问答
import {
  $, $$, CAN_MIC, CAN_SYS, GAP_TEXT, IN_APP, REMOTE, S, TOUCH, TYPING,
  asrInfo, autoIc, debounce, esc, flashDone, fmtDur, fmtTs, getSpeakerMap, hm, hooks, ic, icSwap,
  isOnMeeting, paras, providerOptions, recHealthHTML, safeJSONParse, safeLSGet,
  safeLSSet, scrollBehavior, spkColor, spkName, statusTag, templateOptions, ymd,
} from "./utils.js";
import { api, ensureSettings, needLogin, streamNd } from "./api.js";
import { countMarkdownTodos, md, toggleMarkdownTodo } from "./markdown.js";
import { closeModal, confirmAction, copyText, hoverFill, isOverlayOpen, linkLabels, modal, popMenu, sbCleanup, tabInd, toast } from "./ui.js";
import { MONO_CHUNK, REC } from "./recorder.js";
import { bindPlayer, playerHTML, syncPlayerMarks } from "./player.js";
import {
  atBottom, ensureSelectionPopover, guessNames, highlightPlaying, liveScroller,
  renderPartial, syncTranscriptMarks, tabTranscript,
} from "./transcript.js";
import { loadRelatedMeetings } from "./hub.js";

// ---------------- 轮询与实时刷新状态 ----------------
let pollT = null;
export function clearPoll() { clearTimeout(pollT); pollT = null; }

// ---------------- 笔记（脱离 DOM 的独立待保存 Map，多场会议断网切页也能各自重试） ----------------
const pendingNotes = new Map(); // id -> { id, value, rev, timer, promise }
let noteRev = 0;

export const hasPendingNotes = () => pendingNotes.size > 0;
export function clearPendingNoteFor(id) {
  const e = pendingNotes.get(id);
  if (e) { clearTimeout(e.timer); pendingNotes.delete(id); }
}

function markNotesDirty(value) {
  if (!S.cur) return;
  noteRev++;
  const id = S.cur.meta.id;
  const prev = pendingNotes.get(id);
  if (prev) { prev.value = value; prev.rev = noteRev; }
  else pendingNotes.set(id, { id, value, rev: noteRev, timer: null, promise: null });
  S.cur.notes = value;
}

async function flushOneNote(id) {
  const entry = pendingNotes.get(id);
  if (!entry) return true;
  if (entry.promise) {
    await entry.promise;
    return pendingNotes.has(id) ? flushOneNote(id) : true;
  }
  const snapRev = entry.rev, snapVal = entry.value;
  clearTimeout(entry.timer); entry.timer = null;
  const run = (async () => {
    try {
      await api(`/api/meetings/${id}`, { method: "PATCH", body: { notes: snapVal } });
      const cur = pendingNotes.get(id);
      if (cur && cur.rev === snapRev) {
        pendingNotes.delete(id);
        if (S.cur && S.cur.meta.id === id && $("#noteState")) {
          $("#noteState").textContent = "已保存 " + new Date().toTimeString().slice(0, 8);
        }
      }
      return true;
    } catch (e) {
      const cur = pendingNotes.get(id);
      if (cur && cur.rev === snapRev) {
        if (S.cur && S.cur.meta.id === id) {
          const st = $("#noteState");
          st && (st.innerHTML = `<span style="color:var(--red)">没保存上：${esc(e.message)}，5 秒后自动重试</span>`);
        }
        cur.timer = setTimeout(() => { flushOneNote(id); }, 5000);
      }
      return false;
    } finally {
      const cur = pendingNotes.get(id);
      if (cur) {
        cur.promise = null;
        if (cur.rev !== snapRev) flushOneNote(id);
      }
    }
  })();
  entry.promise = run;
  return run;
}

export async function saveNotesNow(targetId = null) {
  if (targetId) return flushOneNote(targetId);
  if (!pendingNotes.size) return true;
  const res = await Promise.all([...pendingNotes.keys()].map(flushOneNote));
  return res.every(Boolean);
}

const saveNotes = debounce(() => { saveNotesNow(); }, 800);
function bindNotes() {
  const ta = $("#notes"); if (!ta) return;
  ta.oninput = () => {
    markNotesDirty(ta.value);
    const st = $("#noteState");
    st && (st.textContent = "编辑中…");
    saveNotes();
  };
  ta.onblur = () => { saveNotesNow(); };
}
function insertAtCursor(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

// ---------------- 纪要编辑与交互式待办串行保存队列 ----------------
export const GEN = {};
let genErr = null; // 最近一次生成失败 { id, msg }
let mdEditOrig = null; // 纪要编辑框打开时的原文；null = 没在编辑
const todoQueues = new Map(); // id -> Promise
const todoBaseMd = new Map(); // id -> 最新已落盘 markdown
export const mdEditDirty = () => !!($("#mdEdit") && mdEditOrig !== null && $("#mdEdit").value !== mdEditOrig);
export function resetMdEdit() { mdEditOrig = null; }

export async function saveMdEditNow() {
  const ta = $("#mdEdit"); if (!ta || mdEditOrig === null || !S.cur) return true;
  const v = ta.value, id = S.cur.meta.id;
  if (v === mdEditOrig) { mdEditOrig = null; return true; }
  try {
    await api(`/api/meetings/${id}`, { method: "PATCH", body: { minutes_markdown: v } });
  } catch (e) { toast("纪要的修改没保存上：" + e.message, 6000); return false; }
  mdEditOrig = null;
  todoBaseMd.set(id, v);
  if (S.cur && S.cur.meta.id === id && S.cur.minutes) Object.assign(S.cur.minutes, { markdown: v, edited: true });
  toast("纪要修改已保存");
  return true;
}

// ---------------- 通用媒体上传（供首页按钮与全局拖拽浮层共用） ----------------
let activeUploads = 0;

export function uploadMediaFile(file, opts = {}) {
  if (!file) return;
  let f = opts.formData;
  if (!f) {
    if ($("#fTitle") && $("#fSpk") && $("#fHot") && $("#fTpl")) {
      const srcEl = $("input[name=src]:checked");
      f = {
        title: $("#fTitle").value,
        num_spk: +$("#fSpk").value,
        hotword: $("#fHot").value,
        template: $("#fTpl").value,
        src: srcEl ? srcEl.value : "mic",
      };
      safeLSSet("lastForm", JSON.stringify({ tpl: f.template, src: f.src }));
    } else {
      const last = safeJSONParse(safeLSGet("lastForm"), {});
      f = {
        title: "",
        num_spk: 0,
        hotword: "",
        template: last.tpl || "general",
      };
    }
  }
  const startHash = location.hash || "#/";
  const fd = new FormData();
  fd.append("file", file);
  fd.append("title", f.title || "");
  fd.append("num_spk", String(f.num_spk || 0));
  fd.append("hotword", f.hotword || "");
  fd.append("template", f.template || "general");
  const x = new XMLHttpRequest();
  let lastToastAt = 0;
  const setHomeBtnDisabled = on => {
    const btn = $("#upBtn");
    if (btn) btn.disabled = on;
  };
  const prog = (t, forceToast = false) => {
    const el = $("#upProg");
    if (el) { el.textContent = t; return; }
    if (!t) return;
    const now = Date.now();
    if (forceToast || now - lastToastAt >= 500) {
      lastToastAt = now;
      toast(t, 15000);
    }
  };
  const doneUpload = () => {
    activeUploads = Math.max(0, activeUploads - 1);
    if (activeUploads === 0) setHomeBtnDisabled(false);
  };
  const fail = msg => {
    doneUpload();
    const el = $("#upProg");
    if (el) el.textContent = "";
    toast("上传失败：" + msg, 6000);
  };
  activeUploads++;
  setHomeBtnDisabled(true);
  if (!$("#upProg")) prog(`正在上传「${file.name}」…`, true);
  x.open("POST", "/api/meetings/upload");
  x.upload.onprogress = ev => {
    const label = ev.lengthComputable && ev.total > 0
      ? `上传中 ${Math.round(ev.loaded / ev.total * 100)}%`
      : "上传中…";
    prog(label);
  };
  x.upload.onload = () => prog("上传完成，正在转换音频…", true);
  x.onload = async () => {
    let j = null; try { j = JSON.parse(x.responseText); } catch {}
    if (needLogin(x.status, j)) { doneUpload(); return; }
    if (x.status !== 200) return fail((j && j.detail) || `服务返回 ${x.status}`);
    if (!j) return fail("服务返回的内容无法识别");
    doneUpload();
    const el = $("#upProg");
    if (el) el.textContent = "";
    hooks.loadMeetings && await hooks.loadMeetings();
    const curHash = location.hash || "#/";
    // 若仍在首页，或拖拽上传期间未切换页面且未录音/未编辑，则直接跳到新会议页
    if (curHash === "" || curHash === "#/") {
      location.hash = "#/m/" + j.id;
    } else if (curHash === startHash && !REC.active && !REC.stopping && !editingNow()) {
      toast("录音上传完成，已加入转写队列", 3000);
      location.hash = "#/m/" + j.id;
    } else {
      toast("录音上传完成，已加入转写队列", 4500);
    }
  };
  x.onerror = () => fail(REMOTE ? "网络中断，或者电脑上的服务没有运行" : "网络中断或服务没有运行");
  x.onabort = () => fail("已取消");
  x.send(fd);
}

export function editingNow() {
  const ae = document.activeElement;
  return !!((ae && TYPING.includes(ae.id)) || $("#mdEdit") || $("#peText") || ($("#qIn") && $("#qIn").value.trim()) || isOverlayOpen());
}

// ---------------- 首页 ----------------
function srcMixLabel(name, checked, desc) {
  const head = `<b>${ic("monitor")}麦克风 + 电脑声音</b>`;
  if (!CAN_SYS) return `<label class="dis" title="这台设备的浏览器不支持录电脑声音"><input type="radio" name="${name}" value="mix" disabled>${head}${desc ? `<small>这台设备的浏览器录不了电脑声音，线上会议请在电脑上录</small>` : ""}</label>`;
  return `<label><input type="radio" name="${name}" value="mix" ${checked ? "checked" : ""}>${head}${desc ? `<small>${desc}</small>` : ""}</label>`;
}

export function showHome() {
  const last = safeJSONParse(safeLSGet("lastForm"), {});
  const mix = last.src === "mix" && CAN_SYS;
  const today = ymd(new Date());
  const todayList = S.meetings.filter(m => String(m.created || "").startsWith(today));
  const todaySpeech = todayList.reduce((sum, m) => sum + (m.source === "ambient" ? (m.speech_s || 0) : (m.duration || 0)), 0);
  const cmdKey = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl+K";
  const main = $("#main");
  const srcPill = m => m.source === "ambient"
    ? `<span class="mcard-src">${ic("radio")}全天</span>`
    : m.source === "upload"
      ? `<span class="mcard-src">${ic("file")}上传</span>`
      : `<span class="mcard-src">${ic("mic")}会议</span>`;
  main.innerHTML = `<div class="wrap home-wrap">
    <div class="home-top">
      <div class="home-h">
        <h1>开始会议记录</h1>
        <p>实时转写 · 自动区分说话人 · AI 整理纪要与待办</p>
      </div>
      <div class="home-pills">
        <a class="home-pill" href="#/todos" title="跨会议待办中心">${ic("check")}<span>待办中心</span></a>
        <a class="home-pill" href="#/people" title="按人物查看跨会议关联与话题">${ic("users")}<span>人物</span></a>
        <a class="home-pill" href="#/day/${esc(today)}" title="查看今天的时间线与当日汇总">${ic("calendar")}<span>今日汇总</span>${todayList.length ? `<span class="home-pill-num num">${todayList.length}</span>` : ""}</a>
        <button type="button" class="home-pill" id="homeCmdk" title="全局搜索会议或执行快捷命令">${ic("search")}<span>快速搜索</span><kbd class="kbd">${cmdKey}</kbd></button>
      </div>
    </div>

    <div class="home-bento">
      <section class="card home-rec" aria-label="开始录音">
        <div class="home-title-row">
          <input id="fTitle" class="home-title-in" aria-label="会议标题" placeholder="输入会议标题（留空则由 AI 自动命名）">
        </div>
        <div class="seg home-seg">
          <label title="线下会议、面对面交流"><input type="radio" name="src" value="mic" ${!mix ? "checked" : ""}><b>${ic("mic")}麦克风</b><small>线下会议 · 面对面交流</small></label>
          ${srcMixLabel("src", mix, "线上会议 · 腾讯 / 飞书 / Zoom")}
        </div>
        <div class="home-cta-row">
          <button type="button" class="rec big home-start" id="startBtn" ${CAN_MIC ? "" : `disabled title="要用 https 地址打开才能录音"`}><span class="rdot"></span>开始录音</button>
          <div class="home-inline-opts">
            <select id="fTpl" class="home-sel" aria-label="纪要模板" title="纪要模板">${templateOptions(last.tpl || "general")}</select>
            <select id="fSpk" class="home-sel" aria-label="参会人数（说话人区分用）" title="参会人数（说话人区分用；不确定选自动判断）"><option value="0">自动人数</option>${[2, 3, 4, 5, 6, 7, 8, 10, 12].map(n => `<option value="${n}">${n} 人</option>`).join("")}</select>
          </div>
          <button type="button" class="ghost sm home-more-btn" id="homeMoreBtn" aria-expanded="false" aria-controls="homeMorePanel"><span>热词与提示</span>${ic("chev")}</button>
        </div>
        ${TOUCH && CAN_MIC ? `<div class="home-touch-warn small muted">手机/平板录音请保持页面在前台并插电；断网会先缓存在本机，连上自动补传。${IN_APP ? `（${IN_APP}内置浏览器切后台会停录）` : ""}</div>` : ""}
        <div class="mn-disc" id="homeMoreDisc"><div>
          <div class="home-more" id="homeMorePanel" inert>
            <div class="home-more-field">
              <label class="f" for="fHot">本场额外热词（人名、产品名、术语，空格分隔）</label>
              <input id="fHot" style="width:100%" value="" placeholder="例如：张伟 李娜 通义千问 OKR">
              <div class="muted small" style="margin-top:4px">常用词库、参会人、标题、笔记和以往会议专名会自动合并，最多 30 个</div>
            </div>
            <ul class="tips home-tips">
              <li>线上会议（腾讯/飞书/Zoom）选「麦克风 + 电脑声音」分开录，抢话少漏字，共享屏幕时勾选共享音频。</li>
              <li>知道实际发言人数时填写可提高区分准确度；不确定就选「自动人数」。</li>
              <li>会后点击说话人改真名，改成同名即可合并；录音中记的笔记会优先融入 AI 纪要。</li>
            </ul>
          </div>
        </div></div>
      </section>

      <section class="card home-drop" aria-label="上传录音或视频">
        <button type="button" class="home-drop-btn" id="upBtn">
          <span class="home-drop-ic">${ic("upload")}</span>
          <span class="home-drop-title">上传录音 / 视频</span>
          <span class="home-drop-sub">拖放文件到这里，或点击选择本地文件</span>
          <span class="home-drop-fmts" aria-hidden="true"><span>MP3</span><span>M4A</span><span>WAV</span><span>MP4</span><span>MOV</span></span>
          <span id="upProg" class="home-drop-prog muted small"></span>
        </button>
        <input type="file" id="upFile" accept="audio/*,video/*" hidden>
      </section>
    </div>

    <div class="sec-h home-sec-h">
      <div class="row" style="gap:10px">
        <h2>最近的会议</h2>
        ${S.meetings.length ? `<span class="muted small num">共 ${S.meetings.length} 条${todayList.length ? ` · 今日 ${todayList.length} 段（${fmtDur(todaySpeech)}）` : ""}</span>` : ""}
      </div>
      ${S.meetings.length > 9 ? `<button type="button" class="ghost sm" id="homeSearchAll">查看全部 ${ic("right")}</button>` : ""}
    </div>
    <div class="recent home-recent stagger">${S.meetings.slice(0, 9).map((m, i) => `<a class="mcard home-mcard" style="--i:${i}" href="#/m/${esc(m.id)}">
      <div class="mcard-head">${srcPill(m)}${statusTag(m)}<span class="grow"></span><span class="mcard-arr" aria-hidden="true">${ic("right")}</span></div>
      <div class="t">${esc(m.title)}</div>
      <div class="m"><span class="num">${esc(m.created.slice(5, 10))} ${hm(m.created)}</span><span>·</span><span>${fmtDur(m.source === "ambient" ? m.speech_s : m.duration)}</span>${m.num_speakers ? `<span>·</span><span>${m.num_speakers} 人</span>` : ""}</div></a>`).join("")
      || `<div class="card home-empty muted">还没有会议记录，点击上方「开始录音」或直接拖入一段音视频试试。</div>`}</div></div>`;
  linkLabels(main);
  sbCleanup();

  const moreBtn = $("#homeMoreBtn"), morePanel = $("#homeMorePanel"), moreDisc = $("#homeMoreDisc");
  if (moreBtn && morePanel && moreDisc) {
    moreBtn.addEventListener("click", () => {
      const open = !moreDisc.classList.contains("open");
      moreDisc.classList.toggle("open", open);
      morePanel.inert = !open;
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      moreBtn.classList.toggle("open", open);
    });
  }
  const openCmdk = () => {
    const btn = $("#cmdkBtn");
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  };
  $("#homeCmdk") && $("#homeCmdk").addEventListener("click", openCmdk);
  $("#homeSearchAll") && $("#homeSearchAll").addEventListener("click", openCmdk);

  const form = () => ({
    title: $("#fTitle").value, num_spk: +$("#fSpk").value, hotword: $("#fHot").value, template: $("#fTpl").value,
    src: $("input[name=src]:checked").value,
  });
  const remember = f => safeLSSet("lastForm", JSON.stringify({ tpl: f.template, src: f.src }));
  $("#startBtn").onclick = async () => {
    const f = form(); remember(f);
    if (REC.active || REC.stopping) return toast("已有会议在录音");
    REC.prime();
    const startBtn = $("#startBtn");
    startBtn.disabled = true;
    let meta;
    try {
      meta = await api("/api/meetings", { method: "POST", body: f });
      await REC.start(meta.id, f.src);
      hooks.loadMeetings && await hooks.loadMeetings();
      location.hash = "#/m/" + meta.id;
    } catch (e) {
      REC.dropCtx0();
      toast("无法开始录音：" + e.message, 5000);
      if (meta) { await api(`/api/meetings/${meta.id}`, { method: "DELETE" }).catch(() => {}); hooks.loadMeetings && hooks.loadMeetings(); }
      const btnNow = $("#startBtn");
      if (btnNow) btnNow.disabled = false;
    }
  };
  $("#upBtn").onclick = () => $("#upFile").click();
  $("#upFile").onchange = e => {
    const file = e.target.files[0]; e.target.value = ""; if (!file) return;
    const f = form(); remember(f);
    uploadMediaFile(file, { formData: f });
  };
}

// ---------------- 会议详情加载与轮询 ----------------
export async function showMeeting(id, optsOrSeq = S.routeSeq) {
  const opts = typeof optsOrSeq === "number" ? { seq: optsOrSeq } : (optsOrSeq || {});
  const seq = opts.seq ?? S.routeSeq;
  const keepPlayer = !!opts.keepPlayer;
  const initialSeekSec = Number.isFinite(opts.initialSeekSec) ? opts.initialSeekSec : null;
  let data;
  try {
    data = await api("/api/meetings/" + id);
  } catch (e) {
    if (seq !== S.routeSeq || !isOnMeeting(id)) return;
    const x = S.amb && S.amb.discarded;
    if (x && x.id === id) return hooks.showDiscarded && hooks.showDiscarded(x);
    if (S.cur && S.cur.meta.id === id && /连不上|超时/.test(e.message)) return refreshMeeting(id, 5000);
    hooks.teardownView && hooks.teardownView();
    S.cur = null;
    $("#main").innerHTML = `<div class="wrap"><div class="empty">${esc(e.message)}<div style="margin-top:12px"><a class="btn" href="#/">回到首页</a></div></div></div>`;
    sbCleanup();
    return;
  }
  if (seq !== S.routeSeq || !isOnMeeting(id)) return;
  const sameMeeting = S.cur && S.cur.meta.id === id;
  // 若该会议存在尚未保存成功的本地笔记，保留本地版本防止被服务端旧值覆盖
  const pn = pendingNotes.get(id);
  if (pn) data.notes = pn.value;
  S.cur = data;
  if (!sameMeeting) S.tab = data.minutes ? "minutes" : "transcript";
  const st = $("#main").scrollTop, pst = ["#tabBody", "#trScroll"].map(s => ($(s) || {}).scrollTop || 0);
  renderMeeting(keepPlayer && sameMeeting);
  if (sameMeeting) {
    $("#main").scrollTop = st;
    ["#tabBody", "#trScroll"].forEach((s, i) => $(s) && ($(s).scrollTop = pst[i]));
  }
  if (initialSeekSec !== null && initialSeekSec >= 0) {
    const a = $("#audio");
    const applySeek = () => {
      if (!isOnMeeting(id)) return;
      if (a && a.isConnected) { try { a.currentTime = initialSeekSec; } catch {} }
      highlightPlaying(initialSeekSec * 1000, true);
    };
    if (a && a.readyState < 1) a.addEventListener("loadedmetadata", applySeek, { once: true });
    else applySeek();
  }
}

export function refreshMeeting(id, ms = 4000) {
  clearPoll();
  pollT = setTimeout(async () => {
    if (!isOnMeeting(id)) return;
    if (document.hidden) return refreshMeeting(id, Math.max(ms, 8000));
    if (editingNow()) return refreshMeeting(id, ms);
    const prevStatus = S.cur && S.cur.meta.id === id ? S.cur.meta.status : null;
    await saveNotesNow();
    if (!isOnMeeting(id)) return;
    await showMeeting(id, { keepPlayer: true });
    if (S.cur && S.cur.meta.id === id && S.cur.meta.status !== prevStatus) {
      hooks.loadMeetings && hooks.loadMeetings();
    }
  }, ms);
}

export function pollJob(id) {
  clearPoll();
  pollT = setTimeout(async () => {
    if (!S.cur || S.cur.meta.id !== id || !isOnMeeting(id)) return;
    if (document.hidden) return pollJob(id);
    let d;
    try { d = await api("/api/meetings/" + id); }
    catch {
      if (!S.cur || S.cur.meta.id !== id || !isOnMeeting(id)) return;
      return pollJob(id);
    }
    if (!S.cur || S.cur.meta.id !== id || !isOnMeeting(id)) return;
    const m = d.meta;
    if (["queued", "transcribing"].includes(m.status)) {
      Object.assign(S.cur.meta, { status: m.status, job_started: m.job_started, job_estimate: m.job_estimate, duration: m.duration });
      const b = $("#jobBanner"), bar = b && $(".progress > i", b);
      if (b && bar) {
        const el = m.job_started ? (Date.now() / 1000 - m.job_started) : 0, est = m.job_estimate || 30;
        const pct = m.status === "queued" ? 3 : Math.min(95, el / est * 100);
        const titleEl = $("b", b), subEl = $("span.muted.small", b);
        if (titleEl) titleEl.textContent = m.status === "queued" ? "排队中" : "正在精准转写并区分说话人";
        bar.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
        if (subEl) subEl.textContent = m.status === "transcribing" ? `已用 ${Math.round(el)}s / 预计 ${Math.round(est)}s` : "";
      } else if (b) {
        b.outerHTML = jobBanner(S.cur.meta);
      }
      return pollJob(id);
    }
    if (editingNow()) {
      S.cur.meta.status = m.status;
      const b = $("#jobBanner"); b && (b.outerHTML = jobBanner(m));
      return refreshMeeting(id, 2000);
    }
    await saveNotesNow();
    if (!isOnMeeting(id)) return;
    await showMeeting(id, { keepPlayer: true });
    hooks.loadMeetings && hooks.loadMeetings();
  }, 2000);
}

function jobBanner(m) {
  if (!["queued", "transcribing"].includes(m.status))
    return `<div class="banner info" id="jobBanner"><b>转写完成</b><span class="muted small">编辑结束后自动刷新显示结果</span></div>`;
  const el = m.job_started ? (Date.now() / 1000 - m.job_started) : 0, est = m.job_estimate || 30;
  const pct = m.status === "queued" ? 3 : Math.min(95, el / est * 100);
  return `<div class="banner info" id="jobBanner"><b>${m.status === "queued" ? "排队中" : "正在精准转写并区分说话人"}</b>
    <div class="progress"><i style="transform:scaleX(${(pct / 100).toFixed(4)})"></i></div><span class="muted small">${m.status === "transcribing" ? `已用 ${Math.round(el)}s / 预计 ${Math.round(est)}s` : ""}</span></div>`;
}

let liveBusy = false, liveAgain = false;
export async function refreshLive(id) {
  if (editingNow() || !isOnMeeting(id)) return;
  if (liveBusy) { liveAgain = true; return; }
  liveBusy = true;
  try {
    const stick = atBottom(liveScroller());
    clearPoll();
    await showMeeting(id, { keepPlayer: true });
    renderPartial(true);
    const sc = liveScroller(); if (stick && sc) sc.scrollTop = sc.scrollHeight;
  } finally { liveBusy = false; }
  if (liveAgain) { liveAgain = false; if (isOnMeeting(id)) refreshLive(id); }
}

// ---------------- 会议主壳渲染 ----------------
export function renderMeeting(keepPlayer = false) {
  if (!keepPlayer) hooks.teardownView && hooks.teardownView();
  const d = S.cur, m = d.meta;
  const recHere = (REC.active || REC.stopping) && REC.mid === m.id;
  const busy = ["queued", "transcribing"].includes(m.status);
  const isAmb = m.source === "ambient";
  const canContinue = m.source !== "upload" && !isAmb && !REC.active && !REC.stopping && !busy && !d.live_active;
  const oldPlayer = keepPlayer && $("#player");
  $("#main").innerHTML = `<div class="wrap">
    <div class="mhead"><div class="grow">
      <input class="title" id="mTitle" value="${esc(m.title)}" title="点击修改标题" aria-label="会议标题">
      <div class="meta-line">${isAmb ? `<span>${ic("calendar")}<span class="num">${esc(m.created.slice(0, 10))} ${hm(m.started_at || m.created)}–${hm(m.ended_at)}</span></span>
        <span>${ic("speech")}发言 ${fmtDur(m.speech_s)}</span><span>${ic("radio")}全天自动记录</span>`
        : `<span>${ic("calendar")}<span class="num">${esc(m.created.slice(0, 10))} ${hm(m.created)}</span></span><span>${ic("clock")}${fmtDur(m.duration)}</span>`}
        ${m.num_speakers ? `<span>${ic("users")}${m.num_speakers} 位发言人</span>` : ""}${m.source === "upload" ? `<span>${ic("file")}${esc(m.filename || "上传文件")}</span>` : ""}
        ${d.transcript ? `<span class="meta-asr" title="${esc(asrInfo(d.transcript.asr, true))} · 用时 ${esc(d.transcript.cost)}s">${ic("mic")}${esc(asrInfo(d.transcript.asr))}</span>` : ""}${m.audio_purged ? `<span>录音已按保留期限删除</span>` : ""}${recHealthHTML(m)}<span id="rsiPrivTag" class="tag rsi-priv-tag"${m.rsi_exclude ? "" : " hidden"}>不参与自学习</span></div></div>
      <div class="row mact" id="mAct">
        ${canContinue && !recHere ? `<button class="lt" id="contBtn"><span class="rdot" style="color:var(--red)"></span>${m.duration ? "继续录音" : "开始录音"}</button>` : ""}
        ${!recHere && d.has_audio && !busy && !d.ambient_active ? `<button class="lt" id="reBtn">${ic("refresh")}${isAmb && m.status === "recording" ? "精准转写" : "重新转写"}</button>` : ""}
        <button type="button" class="lt" id="rsiPrivBtn" data-rsi-exclude="${m.rsi_exclude ? "1" : "0"}" aria-pressed="${m.rsi_exclude ? "true" : "false"}" title="${m.rsi_exclude ? "已设为隐私会议：不参与本机自学习（点击恢复）" : "设为隐私会议：不参与本机自学习"}">${ic("lock")}隐私会议</button>
        <div class="menu"><button class="lt" id="expBtn">${ic("download")}导出</button></div>
        ${!recHere ? `<button class="lt danger" id="delBtn" title="移入废纸篓" aria-label="删除会议">${ic("trash")}</button>` : ""}
      </div></div>
    ${isAmb && m.status === "recording" && !d.ambient_active && d.has_audio ? `<div class="banner warn">这段全天记录已经停了，但还停在「记录中」，没有做会后精准转写和说话人区分。点「精准转写」现在开始；平时静音够久会自动开始。</div>` : ""}
    <div id="mBody"></div></div>`;
  hoverFill($("#mAct"), "button.lt");
  $("#mTitle").onchange = async e => {
    const v = e.target.value.trim();
    if (!v) { e.target.value = m.title; return toast("标题不能为空"); }
    try { await api(`/api/meetings/${m.id}`, { method: "PATCH", body: { title: v } }); }
    catch (err) { e.target.value = m.title; return toast("标题没有保存：" + err.message, 5000); }
    m.title = v; m.title_auto = false; hooks.loadMeetings && hooks.loadMeetings();
  };
  $("#mTitle").onkeydown = e => e.key === "Enter" && e.target.blur();
  $("#delBtn") && ($("#delBtn").onclick = async () => {
    const ok = await confirmAction({
      title: "移入废纸篓",
      message: d.ambient_active
        ? `「${m.title}」正在记录中，移入废纸篓会移除已录下的部分，之后新的发言会重新建一段（30 天内可找回）。`
        : `将「${m.title}」移入废纸篓？30 天内随时可以撤销找回。`,
      confirmText: "移入废纸篓",
      cancelText: "保留",
      danger: true,
    });
    if (!ok) return;
    try { await api(`/api/meetings/${m.id}/trash`, { method: "POST" }); } catch (e) { return toast("移入废纸篓失败：" + e.message, 5000); }
    clearPendingNoteFor(m.id); todoBaseMd.delete(m.id); mdEditOrig = null;
    hooks.loadMeetings && await hooks.loadMeetings();
    location.hash = "#/";
    toast("已移入废纸篓（30 天内可找回）", {
      ms: 6000,
      action: {
        label: "撤销",
        onClick: async () => {
          await api(`/api/trash/${m.id}/restore`, { method: "POST" });
          hooks.loadMeetings && await hooks.loadMeetings();
          location.hash = "#/m/" + m.id;
          toast("已恢复会议");
        },
      },
    });
  });
  $("#reBtn") && ($("#reBtn").onclick = () => retranscribeDialog());
  $("#contBtn") && ($("#contBtn").onclick = () => continueDialog());
  const privBtn = $("#rsiPrivBtn");
  if (privBtn) {
    let privBusy = false;
    privBtn.addEventListener("click", async () => {
      if (privBusy) return;
      privBusy = true;
      privBtn.disabled = true;
      const next = !m.rsi_exclude;
      try {
        const updated = await api(`/api/meetings/${m.id}`, { method: "PATCH", body: { rsi_exclude: next } });
        if (updated && typeof updated === "object") Object.assign(m, updated);
        else m.rsi_exclude = next;
        const on = !!m.rsi_exclude;
        privBtn.setAttribute("aria-pressed", on ? "true" : "false");
        privBtn.dataset.rsiExclude = on ? "1" : "0";
        privBtn.title = on ? "已设为隐私会议：不参与本机自学习（点击恢复）" : "设为隐私会议：不参与本机自学习";
        const tag = $("#rsiPrivTag");
        if (tag) tag.hidden = !on;
        toast(on ? "已设为隐私会议，不参与自学习" : "已恢复参与自学习");
      } catch (err) {
        toast("设置失败：" + err.message, 5000);
      } finally {
        privBusy = false;
        if (privBtn.isConnected) privBtn.disabled = false;
      }
    });
  }
  $("#expBtn").onclick = e => {
    e.stopPropagation();
    const pop = popMenu(e.currentTarget.parentElement, `
      <a href="/api/meetings/${esc(m.id)}/export?fmt=md">${ic("file")}Markdown（纪要 + 转写）</a>
      <a href="/api/meetings/${esc(m.id)}/export?fmt=txt">${ic("text")}TXT 转写稿</a>
      <a href="/api/meetings/${esc(m.id)}/export?fmt=srt">${ic("subtitle")}SRT 字幕</a>
      <a href="/api/meetings/${esc(m.id)}/export?fmt=zip" title="音频原文件、转写 TXT、纪要 Markdown（含要点和打点）">${ic("archive")}打包下载（音频 + 转写 + 纪要）</a>
      <a id="copyMin">${ic("copy")}复制纪要</a>`);
    pop && ($("#copyMin").onclick = () => copyText(d.minutes && d.minutes.markdown, "已复制纪要", "还没有纪要"));
  };
  if (recHere) return renderRecording();
  renderDetail(keepPlayer ? oldPlayer : false);
}

function continueDialog() {
  if (!S.cur) return;
  const mid = S.cur.meta.id;
  const last = safeJSONParse(safeLSGet("lastForm"), {});
  const edited = paras().some(p => p.edited) && !!S.cur.transcript;
  const dlg = modal(`<h2>${S.cur.meta.duration ? "继续录音" : "开始录音"}</h2>
    <p class="muted">新录音会接在已有录音后面，结束后重新整体转写。${S.cur.transcript ? "已改的说话人姓名会保留，但编号可能变化，请复核。" : ""}</p>
    ${edited ? `<div class="banner err small" style="margin:8px 0">这场有手动修改过的段落，继续录音结束后的重新转写会覆盖这些修改（纠错表里的规则不受影响）。</div>` : ""}
    ${S.cur.minutes ? `<p class="muted small">已有的 AI 纪要不会自动更新，录完后到“AI 纪要”里重新生成。</p>` : ""}
    <div class="seg" style="margin:14px 0">
      <label><input type="radio" name="src2" value="mic" ${last.src !== "mix" || !CAN_SYS ? "checked" : ""}><b>${ic("mic")}麦克风</b></label>
      ${srcMixLabel("src2", last.src === "mix" && CAN_SYS, "")}</div>
    <div class="row" style="justify-content:flex-end"><button data-close-modal>取消</button><button class="rec" id="goRec"><span class="rdot"></span>开始</button></div>`);
  let busy = false;
  $("#goRec", dlg).onclick = async () => {
    if (busy) return;
    busy = true;
    const src = $("input[name=src2]:checked", dlg).value;
    REC.prime(); closeModal(false);
    try {
      await REC.start(mid, src);
      if (isOnMeeting(mid)) await showMeeting(mid);
      else location.hash = "#/m/" + mid;
      hooks.loadMeetings && hooks.loadMeetings();
    } catch (e) {
      REC.dropCtx0();
      toast("无法开始录音：" + e.message, 5000);
    }
  };
}

function retranscribeDialog() {
  if (!S.cur) return;
  const m = S.cur.meta;
  const edited = paras().some(p => p.edited);
  const first = m.source === "ambient" && m.status === "recording";
  const dlg = modal(`<h2>${first ? "精准转写" : "重新转写"}</h2><p class="muted">${first ? "用整段录音再识别一遍，并区分说话人。实时稿会换成这份结果。" : "调整参会人数或热词后重新识别。已改的说话人姓名会保留，但编号可能变化，请复核。"}</p>
    ${edited ? `<div class="banner err small" style="margin:8px 0">这场有手动修改过的段落，重新转写会覆盖这些修改（纠错表里的规则不受影响，会自动重新套用）。</div>` : ""}
    <div class="row" style="margin:14px 0"><div><label class="f">参会人数</label><select id="rSpk"><option value="0">自动判断</option>
      ${[2, 3, 4, 5, 6, 7, 8, 10, 12].map(n => `<option value="${n}" ${m.num_spk == n ? "selected" : ""}>${n} 人</option>`).join("")}</select></div>
      <div class="grow"><label class="f">本场额外热词（常用词库和会议上下文会自动合并，最多 30 个）</label><input id="rHot" style="width:100%" value="${esc(m.hotword)}"></div></div>
    <div class="row" style="justify-content:flex-end"><button data-close-modal>取消</button><button class="pri" id="rGo">开始</button></div>`);
  let busy = false;
  $("#rGo", dlg).onclick = async e => {
    if (busy) return;
    busy = true; e.currentTarget.disabled = true;
    try { await api(`/api/meetings/${m.id}/transcribe`, { method: "POST", body: { num_spk: +$("#rSpk", dlg).value, hotword: $("#rHot", dlg).value } }); }
    catch (err) { busy = false; e.currentTarget.disabled = false; return toast(err.message); }
    closeModal(false); await showMeeting(m.id); hooks.loadMeetings && hooks.loadMeetings();
  };
}

// ---------------- 录音中视图（#liveBox 增量追加 + 独立 #livePartial 节点） ----------------
function renderRecording() {
  const d = S.cur;
  const pn = pendingNotes.get(d.meta.id);
  const noteText = pn ? pn.value : d.notes;
  $("#mBody").innerHTML = `
    <div id="lostSlot"></div>
    <div class="recbar"><span class="recdot" id="rDot"></span><span class="timer" id="rTimer">${fmtTs(REC.elapsedMs())}</span>
      <div class="meter"><i id="rMeter"></i></div><span class="muted small" id="rState">正在录音并实时转写</span>
      <span class="grow"></span><button class="mark" id="rMark" ${REC.stopping ? "disabled" : ""} title="给当前时刻打个点，生成纪要时优先覆盖这里（快捷键 M）">${ic("flag")}标记<kbd>M</kbd></button><button id="rPause" ${REC.stopping ? "disabled" : ""}>${REC.paused ? `${ic("play")}继续` : `${ic("pause")}暂停`}</button><button class="rec" id="rStop" ${REC.stopping ? "disabled" : ""}>${REC.stopping ? "保存中…" : `${ic("stop")}结束录音`}</button></div>
    <div class="markbar" id="markBar"></div>
    ${TOUCH ? `<div class="muted small" style="margin:-8px 2px 12px">请让这个页面一直在前台：锁屏、切到别的应用或来电时浏览器可能停止收音，没录到的地方会标出来。网络断了录音不停，先存在这台设备上。</div>` : ""}
    <div class="livegrid">
      <div class="card"><h2>实时转写 <span class="muted small" style="font-weight:normal">${REC.channels === 2 ? "麦克风和电脑声音分开识别；会后还会再精转" : "会后会重新精准转写并区分说话人"}</span></h2>
        <div class="livebox" id="liveBox"><div id="liveFinals"></div><div class="lv partial" id="livePartial" hidden></div><div class="empty" id="liveEmpty">开始说话，文字会实时出现在这里</div></div></div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h2 style="margin:0" class="grow">我的笔记</h2>
        <button class="sm lt" id="insTs">${ic("clock")}插入时间点</button></div>
        <textarea class="notes-area" id="notes" aria-label="我的笔记" placeholder="记录重点、决定、待办……&#10;AI 生成纪要时会重点参考这里的内容">${esc(noteText)}</textarea>
        <div class="muted small" id="noteState">${pn ? "未保存，将自动重试…" : ""}</div></div>
    </div>`;

  const box = $("#liveBox"), finalsEl = $("#liveFinals"), partialEl = $("#livePartial"), emptyEl = $("#liveEmpty");
  const prev = (d.live || []).filter(x => x.start < REC.offsetMs);
  let shown = prev.length + REC.finals.length;
  let renderedItems = 0, renderedGaps = 0, lastStart = -1;
  const gapRow = g => `<div class="lv gap">${ic("clock")}<span>这里有 ${fmtDur(Math.max(1, g.dur_ms / 1000))} 没录到：${GAP_TEXT[g.reason] || GAP_TEXT.stall}</span></div>`;
  const finalRow = (x, animate) => {
    const tag = x.ch === 0 ? "我" : x.ch === 1 ? "对方" : "";
    return `<div class="lv${animate ? " in" : ""}"><a class="ts" data-ts="${fmtTs(x.start)}">${fmtTs(x.start)}</a>${tag ? `<span class="muted">${tag} · </span>` : ""}${esc(x.text)}</div>`;
  };
  const syncPartial = () => {
    const p = REC.partial;
    if (!p) { partialEl.hidden = true; return; }
    partialEl.hidden = false;
    const tag = p.ch === 0 ? `<span class="muted">我 · </span>` : p.ch === 1 ? `<span class="muted">对方 · </span>` : "";
    partialEl.innerHTML = `<a class="ts">${fmtTs(p.start)}</a>${tag}${esc(p.text)}…`;
  };
  const syncFinals = (forceFull = false) => {
    const items = [...prev, ...REC.finals];
    const gaps = [...REC.gaps].sort((a, b) => a.at_ms - b.at_ms);
    const hasOutOfOrderGap = !forceFull && gaps.length > renderedGaps && gaps.slice(renderedGaps).some(g => g.at_ms < lastStart);
    if (forceFull || hasOutOfOrderGap || items.length < renderedItems) {
      let gi = 0, html = "";
      for (let i = 0; i < items.length; i++) {
        while (gi < gaps.length && gaps[gi].at_ms <= items[i].start) html += gapRow(gaps[gi++]);
        html += finalRow(items[i], i >= shown);
        lastStart = items[i].start;
      }
      while (gi < gaps.length) html += gapRow(gaps[gi++]);
      finalsEl.innerHTML = html;
      renderedItems = items.length;
      renderedGaps = gaps.length;
    } else if (items.length > renderedItems || gaps.length > renderedGaps) {
      let gi = renderedGaps, html = "";
      for (let i = renderedItems; i < items.length; i++) {
        while (gi < gaps.length && gaps[gi].at_ms <= items[i].start) html += gapRow(gaps[gi++]);
        html += finalRow(items[i], i >= shown);
        lastStart = items[i].start;
      }
      while (gi < gaps.length) html += gapRow(gaps[gi++]);
      if (html) finalsEl.insertAdjacentHTML("beforeend", html);
      renderedItems = items.length;
      renderedGaps = gaps.length;
    }
    shown = items.length;
    emptyEl.hidden = !!(items.length || REC.partial || gaps.length);
  };
  const draw = (type = "full") => {
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    if (type === "partial") {
      syncPartial();
      emptyEl.hidden = !!(renderedItems || REC.partial || renderedGaps);
    } else {
      syncFinals(type === "full");
      syncPartial();
    }
    if (stick) box.scrollTop = box.scrollHeight;
  };
  draw("full");

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
      $("#rMeter").style.transform = `scaleX(${Math.min(1, Math.sqrt(REC.level) * 1.4).toFixed(4)})`;
      if ($("#pendTx") && REC.conn !== "ok") $("#pendTx").textContent = " 录音没有停，" + pendingText() + "（最多 15 分钟），连上后自动补传";
    } else if (type === "closed") {
      showMeeting(d.meta.id); hooks.loadMeetings && hooks.loadMeetings();
    } else if (type === "lost" || type === "conn") {
      showLost();
    } else if (type === "ack") {
      if (REC.stopping && $("#pendTx")) $("#pendTx").textContent = " " + pendingText();
    } else {
      draw(type);
    }
  };
  $("#rPause").onclick = () => {
    if (REC.paused) { REC.resume(); $("#rPause").innerHTML = `${ic("pause")}暂停`; }
    else { REC.pause(); $("#rPause").innerHTML = `${ic("play")}继续`; }
    showLost();
  };
  $("#rStop").onclick = async () => {
    $("#rStop").disabled = true; $("#rPause").disabled = true; $("#rMark").disabled = true; $("#rStop").textContent = "保存中…";
    await saveNotesNow();
    const r = await REC.stop();
    if (r && r.gaveUp && r.lost >= (REC.chunkBytes ? REC.chunkBytes() : MONO_CHUNK)) {
      toast(`没等传完就结束了：最后 ${fmtDur(r.lost / (REC.bytesPerSec ? REC.bytesPerSec() : 32000))} 的录音没有保存`, 8000);
    }
    hooks.loadMeetings && await hooks.loadMeetings();
    S.tab = "transcript";
    if (isOnMeeting(d.meta.id)) await showMeeting(d.meta.id);
  };
  bindNotes();
  $("#insTs").onclick = () => insertAtCursor($("#notes"), `[${fmtTs(REC.elapsedMs())}] `);
  $("#rMark").onclick = () => addMark();
  drawMarkBar();
}

// ---------------- 录音打点（支持删除乐观 tmp 标记而不发 404 DELETE） ----------------
const pendingMarks = new Map(); // tmpId -> { cancelled: false }

function markSnippet(tMs, ps) {
  if (!ps || !ps.length) return "";
  let hit = ps.find(p => p.start <= tMs && tMs <= p.end);
  if (!hit) {
    let bestD = Infinity;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const dist = Math.min(Math.abs(p.start - tMs), Math.abs(p.end - tMs));
      if (dist < bestD) { bestD = dist; hit = p; }
    }
  }
  return hit && hit.text ? hit.text.trim().slice(0, 40) : "";
}

function enrichMarks(marks) {
  const ps = paras();
  return (marks || []).map(m => ({ ...m, snippet: m.snippet || markSnippet(m.t_ms, ps) || m.label || "" }));
}

function syncMarkViews() {
  syncPlayerMarks();
  if ($("#markBar")) { drawMarkBar(); return; }
  const hlSlot = $("#hlSlot");
  if (hlSlot && S.cur && !$("#mdEdit") && !GEN[S.cur.meta.id]) {
    hlSlot.innerHTML = hlCards(S.cur);
  } else if (!$("#mdEdit") && $("#tabBody") && S.tab === "minutes") {
    renderTab();
  }
  syncTranscriptMarks();
}

export function drawMarkBar() {
  const bar = $("#markBar"); if (!bar || !S.cur) return;
  const ms = S.cur.marks || [];
  bar.innerHTML = ms.length
    ? `<span class="muted small">打点 ${ms.length}</span>` + ms.map(m => `<span class="chip mk">${ic("flag")}${fmtTs(m.t_ms)}<button class="mk-x" data-mkdel="${esc(m.id)}" title="删除这个打点" aria-label="删除打点">×</button></span>`).join("")
    : `<span class="muted small">按「标记」或键盘 M，给重要的地方打个点；生成纪要时会优先覆盖这些地方</span>`;
}

export async function addMarkAt(tMs, snippetLabel = "") {
  if (!S.cur) return false;
  const id = S.cur.meta.id;
  const t = Math.max(0, Math.round(Number(tMs) || 0));
  const label = String(snippetLabel || "").trim().slice(0, 60);
  let r;
  try {
    r = await api(`/api/meetings/${id}/marks`, { method: "POST", body: { t_ms: t, label } });
  } catch (err) {
    toast("打点失败：" + err.message, 5000);
    return false;
  }
  if (!S.cur || S.cur.meta.id !== id) return false;
  S.cur.marks = enrichMarks(r.marks || []);
  syncMarkViews();
  const shownMs = r.mark && Number.isFinite(r.mark.t_ms) ? r.mark.t_ms : t;
  toast(r.created === false ? `附近已有打点 ${fmtTs(shownMs)}` : `已打点 ${fmtTs(t)}`);
  return true;
}

export async function addMark() {
  if (!REC.active || REC.stopping || !S.cur || REC.mid !== S.cur.meta.id) return;
  const id = REC.mid, t = Math.round(REC.elapsedMs());
  const list = S.cur.marks = S.cur.marks || [];
  let tmpId = null;
  if (!list.some(m => Math.abs(m.t_ms - t) < 2000)) {
    tmpId = "tmp" + t + "_" + Math.random().toString(36).slice(2, 6);
    pendingMarks.set(tmpId, { cancelled: false });
    list.push({ id: tmpId, t_ms: t });
    list.sort((a, b) => a.t_ms - b.t_ms);
  }
  drawMarkBar(); toast("已标记 " + fmtTs(t), 1200);
  const btn = $("#rMark"); if (btn) { btn.classList.remove("hit"); void btn.offsetWidth; btn.classList.add("hit"); }
  const state = tmpId ? pendingMarks.get(tmpId) : null;
  for (let i = 0; i < 8; i++) {
    if (state && state.cancelled) { pendingMarks.delete(tmpId); return; }
    try {
      const r = await api(`/api/meetings/${id}/marks`, { method: "POST", body: { t_ms: t } });
      if (state && state.cancelled) {
        pendingMarks.delete(tmpId);
        // 若用户在入库前就点了删除，补发真实 ID 的删除请求清理服务端
        if (r && r.mark && r.mark.id) api(`/api/meetings/${id}/marks/${encodeURIComponent(r.mark.id)}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      if (tmpId) pendingMarks.delete(tmpId);
      if (S.cur && S.cur.meta.id === id) {
        // 保留其他仍在途且未取消的乐观打点
        const extras = (S.cur.marks || []).filter(m => String(m.id).startsWith("tmp") && m.id !== tmpId && pendingMarks.has(m.id) && !pendingMarks.get(m.id).cancelled);
        S.cur.marks = [...enrichMarks(r.marks || []), ...extras].sort((a, b) => a.t_ms - b.t_ms);
        drawMarkBar();
      }
      return;
    } catch (e) {
      if (/404|不存在/.test(e.message)) { if (tmpId) pendingMarks.delete(tmpId); return; }
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  if (tmpId) pendingMarks.delete(tmpId);
  toast("这个打点没有存上，请检查和电脑的连接后再标一次", 6000);
}

export function initMarkListeners() {
  document.addEventListener("keydown", e => {
    if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.shiftKey || !$("#rMark")
      || isOverlayOpen()) return;
    const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
    if (typing && !e.altKey) return;
    e.preventDefault(); addMark();
  });
  document.addEventListener("click", async e => {
    const x = e.target.closest("[data-mkdel]"); if (!x || !S.cur) return;
    e.stopPropagation(); x.disabled = true;
    const id = S.cur.meta.id, mkId = x.dataset.mkdel;
    // 乐观打点尚未落盘：本地直接取消并移除，避免发 404 DELETE
    if (mkId.startsWith("tmp")) {
      const st = pendingMarks.get(mkId);
      if (st) st.cancelled = true;
      S.cur.marks = (S.cur.marks || []).filter(m => m.id !== mkId);
      syncMarkViews();
      return;
    }
    try {
      const removed = (S.cur.marks || []).find(mk => mk.id === mkId) || null;
      const r = await api(`/api/meetings/${id}/marks/${encodeURIComponent(mkId)}`, { method: "DELETE" });
      if (!S.cur || S.cur.meta.id !== id) return;
      S.cur.marks = enrichMarks(r.marks || []);
      const deleted = (r && r.deleted) || removed;
      if (deleted && Number.isFinite(deleted.t_ms)) {
        toast("已删除打点", {
          ms: 5000,
          action: {
            label: "撤销",
            onClick: async () => {
              const res = await api(`/api/meetings/${id}/marks`, { method: "POST", body: { t_ms: deleted.t_ms, label: deleted.label || "" } });
              if (S.cur && S.cur.meta.id === id) {
                S.cur.marks = enrichMarks(res.marks || []);
                syncMarkViews();
              }
              toast("已恢复打点");
            },
          },
        });
      }
    } catch (err) { x.disabled = false; return toast("没删掉：" + err.message, 4000); }
    syncMarkViews();
  }, true);
}

function hlCards(d) {
  const mn = d.minutes, hl = mn && Array.isArray(mn.highlights) ? mn.highlights : null, ms = d.marks || [];
  const canDel = !["queued", "transcribing", "recording"].includes(d.meta.status) && !d.live_active && !d.ambient_active;
  let html = "";
  if (hl && hl.length) {
    html += `<div class="card hl-card"><h2>要点 <span class="muted small">点时间：跳到转写并播放那一段${hl.some(h => h.marked) ? "　带旗的是你打过点的地方" : ""}</span></h2><ul class="hl-list">`
      + hl.map(h => {
        const span = h.start_ms == null ? `<span class="muted small" title="这条要点的时间对不上转写，没有出处">无出处</span>`
          : `<a class="hl-ts" data-hs="${h.start_ms}" data-he="${h.end_ms || ""}" title="跳到转写并播放这一段">${fmtTs(h.start_ms)}${h.end_ms && Math.floor(h.end_ms / 1000) !== Math.floor(h.start_ms / 1000) ? "–" + fmtTs(h.end_ms) : ""}</a>`;
        return `<li class="${h.marked ? "marked" : ""}">${h.marked ? ic("flag") : ""}<span class="hl-t">${esc(h.text)}</span>${span}</li>`;
      }).join("") + `</ul></div>`;
  } else if (mn && hl === null && !GEN[d.meta.id]) {
    html += `<div class="muted small hl-hint">这份纪要生成时还没有「要点」区，重新生成后会出现。</div>`;
  }
  if (ms.length) {
    html += `<div class="card hl-card"><h2>打点 · ${ms.length} <span class="muted small">录音时你标记的地方，点时间跳到转写并播放</span></h2><ul class="hl-list">`
      + ms.map(m => `<li>${ic("flag")}<span class="hl-t">${m.snippet ? esc(m.snippet) : `<span class="muted">（这里没有转写）</span>`}</span>`
        + `<a class="hl-ts" data-hs="${Math.max(0, m.t_ms - 5000)}" data-focus="${m.t_ms}" title="从打点前 5 秒开始播放">${fmtTs(m.t_ms)}</a>`
        + (canDel ? `<button class="mk-x" data-mkdel="${esc(m.id)}" title="删除这个打点" aria-label="删除打点">×</button>` : "") + `</li>`).join("") + `</ul></div>`;
  }
  return html;
}

// ---------------- 会后详情与分屏 ----------------
const canSplit = () => $("#main").clientWidth >= 1100;
const useSplit = () => S.split && canSplit();

function toggleSplit(on) {
  S.split = on; safeLSSet("splitView", on ? "1" : "0");
  saveNotesNow(); saveMdEditNow(); clearPoll();
  renderDetail(true);
  const a = $("#audio"); a && highlightPlaying(a.currentTime * 1000, true);
}

window.addEventListener("resize", debounce(() => {
  if (!S.cur || !$("#tabBody") || $("#peText") || $("#mdEdit")) return;
  if (useSplit() !== !!$("#trPane") || canSplit() !== !!$("#splitBtn")) {
    saveNotesNow(); clearPoll(); renderDetail(true);
  }
}, 200));

export async function switchTab(tabName) {
  if (S.tab === tabName) return true;
  if (!(await saveMdEditNow())) return false;
  saveNotesNow();
  S.tab = tabName;
  const tabBox = $(".tabs");
  if (tabBox) {
    $$("button[data-tab]", tabBox).forEach(x => x.classList.toggle("on", x.dataset.tab === tabName));
    tabInd(tabBox, true);
  }
  await renderTab();
  return true;
}

export function renderDetail(keepPlayer = false) {
  const savedPlayer = keepPlayer instanceof Element ? keepPlayer : (keepPlayer && $("#player"));
  if (!keepPlayer) hooks.teardownView && hooks.teardownView();
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
    refreshMeeting(m.id, S.ambLive ? 15000 : 4000);
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
  const oldPlayer = savedPlayer || (keepPlayer && $("#player"));
  const savedSplit = Math.min(68, Math.max(32, parseFloat(safeLSGet("splitRatio")) || 50));
  $("#mBody").innerHTML = banner + (d.has_audio ? playerHTML(m) : "") + (sp
    ? `<div class="splitgrid" id="splitGrid" style="--split-left:${savedSplit}%"><section class="pane pane-l">${tabsHTML}<div class="pane-body" id="tabBody"></div></section><div class="split-handle" id="splitHandle" role="separator" aria-orientation="vertical" aria-valuemin="32" aria-valuemax="68" aria-valuenow="${Math.round(savedSplit)}" aria-label="拖动调整分屏宽度（双击恢复均分）" title="拖动调整分屏宽度（双击恢复 50/50）" tabindex="0"></div><section class="pane pane-r" id="trPane"></section></div>`
    : tabsHTML + `<div id="tabBody"></div>`);
  if (oldPlayer && $("#player")) {
    $("#player").replaceWith(oldPlayer);
    syncPlayerMarks();
  } else bindPlayer();
  sbCleanup();

  const handle = $("#splitHandle"), grid = $("#splitGrid");
  if (handle && grid) {
    let curPct = savedSplit;
    const applyPct = pct => {
      curPct = Math.min(68, Math.max(32, Math.round(pct * 10) / 10));
      grid.style.setProperty("--split-left", curPct + "%");
      handle.setAttribute("aria-valuenow", String(Math.round(curPct)));
      safeLSSet("splitRatio", String(curPct));
    };
    handle.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("drag");
      grid.classList.add("dragging");
      document.body.classList.add("resizing-split");
      const ac = new AbortController();
      handle.addEventListener("pointermove", ev => {
        const r = grid.getBoundingClientRect();
        if (r.width > 0) applyPct((ev.clientX - r.left) / r.width * 100);
      }, { signal: ac.signal });
      const stop = () => {
        ac.abort();
        handle.classList.remove("drag");
        grid.classList.remove("dragging");
        document.body.classList.remove("resizing-split");
      };
      handle.addEventListener("pointerup", stop, { signal: ac.signal });
      handle.addEventListener("pointercancel", stop, { signal: ac.signal });
    });
    handle.addEventListener("dblclick", () => applyPct(50));
    handle.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft") { e.preventDefault(); applyPct(curPct - 3); }
      else if (e.key === "ArrowRight") { e.preventDefault(); applyPct(curPct + 3); }
      else if (e.key === "Home" || e.key === "0") { e.preventDefault(); applyPct(50); }
    });
  }

  const tabBox = $(".tabs");
  hoverFill(tabBox, "button[data-tab]"); tabInd(tabBox, false);
  $$("button[data-tab]", tabBox).forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $("#splitBtn") && ($("#splitBtn").onclick = () => toggleSplit(!sp));
  $("#liveEnd") && ($("#liveEnd").onclick = async e => {
    e.currentTarget.disabled = true;
    try { const r = await api(`/api/meetings/${m.id}/live/end`, { method: "POST" }); toast(r.pending ? "已通知录音的设备结束，剩下的录音传完后开始转写" : "已结束，开始转写"); }
    catch (err) { toast(err.message); }
    setTimeout(() => isOnMeeting(m.id) && showMeeting(m.id), 1200);
  });
  $("#ambSplit") && ($("#ambSplit").onclick = async () => {
    if (hooks.confirmSplit && !(await hooks.confirmSplit())) return;
    await saveNotesNow();
    hooks.ambAct && await hooks.ambAct({ action: "split" });
    setTimeout(() => isOnMeeting(m.id) && showMeeting(m.id, { keepPlayer: true }), 800);
  });
  $("#errRetry") && ($("#errRetry").onclick = () => retranscribeDialog());
  renderTab();
  if (sp) tabTranscript();
}

export function renderTab() {
  const fn = ({ minutes: tabMinutes, transcript: tabTranscript, notes: tabNotes, qa: tabQA })[S.tab];
  return fn ? fn() : undefined;
}

// ---------------- AI 纪要 ----------------
function todoProgHTML(stats) {
  const pct = stats.total ? Math.round(stats.done / stats.total * 100) : 0;
  const allDone = stats.total > 0 && stats.done === stats.total;
  return `<span class="todo-prog${allDone ? " all-done" : ""}" id="todoProg" aria-live="polite">`
    + `<span class="todo-prog-txt">待办 <span class="num">${stats.done} / ${stats.total}</span></span>`
    + `<span class="todo-prog-bar" aria-hidden="true"><i style="transform:scaleX(${(pct / 100).toFixed(4)})"></i></span></span>`;
}

function updateTodoProgFromBox(box) {
  const prog = $("#todoProg");
  if (!prog || !box) return;
  const cbs = $$("input.cb[data-todo-idx]", box);
  const total = cbs.length;
  const done = cbs.filter(c => c.checked).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  prog.classList.toggle("all-done", total > 0 && done === total);
  const num = $(".num", prog);
  if (num) num.textContent = `${done} / ${total}`;
  const bar = $(".todo-prog-bar > i", prog);
  if (bar) bar.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
}

function enqueueTodoSave(id, todoIdx, checked, cb, box) {
  const li = cb.closest("li");
  const mySeq = (cb._todoSeq || 0) + 1;
  cb._todoSeq = mySeq;
  const prev = todoQueues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const base = todoBaseMd.has(id)
      ? todoBaseMd.get(id)
      : ((S.cur && S.cur.meta.id === id && S.cur.minutes && S.cur.minutes.markdown) || "");
    const updatedMd = toggleMarkdownTodo(base, todoIdx, checked);
    try {
      await api(`/api/meetings/${id}`, { method: "PATCH", body: { minutes_markdown: updatedMd } });
      todoBaseMd.set(id, updatedMd);
      if (S.cur && S.cur.meta.id === id && S.cur.minutes) {
        S.cur.minutes.markdown = updatedMd;
        S.cur.minutes.edited = true;
      }
    } catch (err) {
      if (cb.isConnected && cb._todoSeq === mySeq) {
        cb.checked = !checked;
        if (li) li.classList.toggle("todo-done", !checked);
        updateTodoProgFromBox(box);
      }
      toast("待办状态保存失败：" + err.message, 5000);
    }
  });
  todoQueues.set(id, next);
  next.finally(() => { if (todoQueues.get(id) === next) todoQueues.delete(id); });
}

export async function tabMinutes() {
  const id = S.cur && S.cur.meta.id;
  if (!id) return;
  await ensureSettings();
  if (!S.cur || S.cur.meta.id !== id || S.tab !== "minutes") return;
  const d = S.cur, m = d.meta, mn = d.minutes, g = GEN[m.id];
  const hasFinalMn = !g && !!mn;
  if (hasFinalMn && !todoQueues.has(m.id)) {
    todoBaseMd.set(m.id, mn.markdown || "");
  }
  const activeMd = hasFinalMn ? (todoBaseMd.has(m.id) ? todoBaseMd.get(m.id) : (mn.markdown || "")) : "";
  const todoStats = hasFinalMn ? countMarkdownTodos(activeMd) : { total: 0, done: 0 };
  const hasText = paras().length > 0;
  const draft = !d.transcript && hasText;
  const stale = (!g && mn && d.minutes_stale) || [];
  const genMeta = mn ? [mn.provider, mn.model, mn.created.replace("T", " ").slice(0, 16), mn.cost ? `用时 ${mn.cost}s` : "", mn.edited ? "已手动编辑" : ""]
    .filter(Boolean).map(esc).join(" · ") : "";
  // 只消费当前会议的生成错误，不误清别的会议的 genErr
  const err = genErr && genErr.id === m.id ? genErr.msg : "";
  if (genErr && genErr.id === m.id) genErr = null;
  const note = stale.includes("transcript")
    ? `<div class="banner warn"><span class="grow">纪要生成后，转写有改动（改了文字或说话人姓名、新的纠错规则、重新转写或续录），纪要里可能还是旧内容。</span><button class="sm" id="regen2">${ic("sparkle")}重新生成</button></div>`
    : stale.includes("notes") ? `<div class="banner warn"><span class="grow">生成纪要后你的笔记有更新，重新生成可以把新笔记也整理进去。</span><button class="sm" id="regen2">${ic("sparkle")}重新生成</button></div>`
    : draft && !g ? `<div class="banner info small"><span class="grow">${["queued", "transcribing"].includes(m.status) || d.ambient_active || d.live_active ? "精准转写还没完成" : "还没有精准转写"}，现在生成会用实时草稿（没有区分说话人）；精准转写完成后建议重新生成。</span></div>` : "";
  const checks = (!g && mn && !mn.edited && Array.isArray(mn.checks)) ? mn.checks : [];
  const checkNote = checks.length ? `<div class="banner warn"><span class="grow">已用转写核对期限、负责人和时间戳：${checks.length} 处没有原话支撑，已改成「待定」或在文中标出。</span></div>` : "";
  const buildEmptyLaunchpad = () => {
    if (!hasText) return `<div class="empty">等转写出文字后即可生成纪要</div>`;
    const ps = paras();
    const spkMeta = getSpeakerMap(d);
    const spkIds = spkMeta.ids;
    let distHtml = "";
    if (spkIds.length) {
      const durBySpk = new Map();
      let tot = 0;
      for (const p of ps) {
        if (p.spk >= 0) {
          const dt = Math.max(0, (p.end || 0) - (p.start || 0));
          durBySpk.set(p.spk, (durBySpk.get(p.spk) || 0) + dt);
          tot += dt;
        }
      }
      if (tot > 0) {
        const items = [...durBySpk.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([s, dt]) => ({ s, name: spkName(s, d), color: spkColor(s, d), pct: Math.max(1, Math.round(dt / tot * 100)) }));
        distHtml = `<div class="spk-dist">
          <div class="spk-dist-head"><span class="small muted">发言分布 · <span class="num">${ps.length}</span> 段</span>${spkIds.length > 1 && spkIds.some(s => /^说话人\d+$/.test(spkName(s, d))) ? `<button type="button" class="ghost sm" id="mnGuessBtn">${ic("users")}先推测姓名</button>` : ""}</div>
          <div class="spk-dist-bar">${items.map(it => `<i style="width:${it.pct}%;background:${esc(it.color)}" title="${esc(it.name)} ${it.pct}%"></i>`).join("")}</div>
          <div class="spk-dist-leg">${items.slice(0, 6).map(it => `<span><i style="background:${esc(it.color)}"></i>${esc(it.name)} <b class="num">${it.pct}%</b></span>`).join("")}</div>
        </div>`;
      }
    }
    const tplMap = (S.health && S.health.templates) || { general: "通用会议" };
    const tplEntries = Object.entries(tplMap).slice(0, 4);
    const tplDesc = {
      general: "概要、议题、决议与待办",
      weekly: "进展、下周计划与阻塞风险",
      review: "方案评估、分歧与结论",
      interview: "问答要点与关键洞察",
      one_on_one: "目标对齐、反馈与跟进",
      brainstorm: "核心想法与落地优先级",
    };
    const cardsHtml = tplEntries.length
      ? `<div class="tpl-grid">${tplEntries.map(([k, v]) => {
        const title = typeof v === "string" ? v : (v && v.name) || k;
        const sub = (v && typeof v === "object" && v.desc) || tplDesc[k] || "一键整理结构化纪要";
        return `<button type="button" class="tpl-card" data-tpl-go="${esc(k)}">
          <span class="tpl-card-t">${ic("sparkle")}${esc(title)}</span>
          <span class="tpl-card-s">${esc(sub)}</span>
        </button>`;
      }).join("")}</div>`
      : "";
    return `<div class="mn-launch">
      <div class="mn-launch-head"><h3>选择模板，一键生成 AI 纪要</h3><p class="muted small">结合转写稿与你的笔记，自动提炼概要、决议、待办与时间出处</p></div>
      ${cardsHtml}
      ${distHtml}
    </div>`;
  };
  $("#tabBody").innerHTML = `<div class="toolbar">
      <select id="tplSel" aria-label="纪要模板">${templateOptions((mn && mn.template) || m.template)}</select>
      <select id="provSel" aria-label="用哪个模型生成" ${g ? "disabled" : ""}>${providerOptions(g && g.provider)}</select>
      <button class="pri" id="genBtn" ${hasText && !g ? "" : "disabled"}>${ic("sparkle")}${g ? "生成中…" : mn ? "重新生成" : "生成纪要"}</button>
      ${hasFinalMn ? `<button type="button" id="editBtn">${ic("pencil")}编辑</button>` : ""}
      ${hasFinalMn ? `<button type="button" id="copyMinBtn" title="复制 Markdown 纪要">${icSwap("copy", "check")}复制</button>` : ""}
      ${hasFinalMn && todoStats.total > 0 ? todoProgHTML(todoStats) : ""}
      <span class="gen-meta" id="genState">${g ? esc(g.status) : genMeta}</span></div>
    ${note}${checkNote}
    <div id="hlSlot">${g ? "" : hlCards(d)}</div>
    <div class="card md-card"><div class="md" id="mdBox">${g ? (g.text ? md(g.text) : `<div class="empty">${esc(g.status)}</div>`)
      : err ? `<div class="empty" style="color:var(--red)">${esc(err)}${/本地模型还没启动/.test(err) ? `<div style="margin-top:10px"><button class="sm" id="llmStart">启动本地模型</button></div>` : ""}</div>`
      : mn ? md(activeMd, { interactiveTodo: true }) : buildEmptyLaunchpad()}</div></div>
    <div id="relSlot"></div>`;
  sbCleanup();
  if (!g) loadRelatedMeetings(m.id, $("#relSlot"));
  $$("[data-tpl-go]", $("#tabBody")).forEach(btn => {
    btn.addEventListener("click", () => {
      const sel = $("#tplSel");
      if (sel) sel.value = btn.dataset.tplGo;
      genMinutes();
    });
  });
  $("#mnGuessBtn") && ($("#mnGuessBtn").onclick = () => guessNames());
  const mdBox = $("#mdBox");
  if (g) { mdBox && mdBox.lastElementChild && g.text && mdBox.lastElementChild.classList.add("cursor"); }
  if (hasFinalMn && mdBox) {
    ensureSelectionPopover();
    // 章节目录条：3 个及以上 h2 时在纪要卡片上方渲染横向可滚动胶囊条
    const h2s = $$("h2", mdBox);
    if (h2s.length >= 3) {
      const toc = document.createElement("nav");
      toc.className = "md-toc";
      toc.id = "mdToc";
      toc.setAttribute("aria-label", "纪要章节目录");
      toc.innerHTML = h2s.map((h, i) => {
        h.id = `md-sec-${i}`;
        return `<button type="button" class="toc-pill" data-sec="md-sec-${i}"><span class="toc-num num">${String(i + 1).padStart(2, "0")}</span><span>${esc(h.textContent.trim())}</span></button>`;
      }).join("");
      const mdCard = mdBox.closest(".card");
      if (mdCard && mdCard.parentElement) mdCard.parentElement.insertBefore(toc, mdCard);
      let tocTimer = null;
      toc.addEventListener("click", e => {
        const pill = e.target.closest(".toc-pill[data-sec]");
        if (!pill) return;
        const target = document.getElementById(pill.dataset.sec);
        if (!target) return;
        target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        $$(".toc-pill.on", toc).forEach(x => x.classList.remove("on"));
        pill.classList.add("on");
        target.classList.remove("toc-hit");
        void target.offsetWidth;
        target.classList.add("toc-hit");
        clearTimeout(tocTimer);
        tocTimer = setTimeout(() => {
          pill.isConnected && pill.classList.remove("on");
          target.isConnected && target.classList.remove("toc-hit");
        }, 1600);
      });
    }
    // 委托监听交互式待办复选框变更：立即更新视觉状态与进度胶囊，串行落盘并在失败时回滚
    mdBox.addEventListener("change", e => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.matches("input.cb[data-todo-idx]")) return;
      const todoIdx = Number(cb.dataset.todoIdx);
      if (!Number.isInteger(todoIdx) || todoIdx < 0) return;
      const checked = cb.checked;
      const li = cb.closest("li");
      if (li) li.classList.toggle("todo-done", checked);
      updateTodoProgFromBox(mdBox);
      enqueueTodoSave(m.id, todoIdx, checked, cb, mdBox);
    });
  }
  const copyBtn = $("#copyMinBtn");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const curMd = (S.cur && S.cur.meta.id === m.id && S.cur.minutes ? S.cur.minutes.markdown : activeMd) || "";
      copyText(curMd, "").then(ok => ok && flashDone(copyBtn));
    };
  }
  $("#provSel") && ($("#provSel").onchange = () => { S.provId = $("#provSel").value; });
  $("#genBtn").onclick = genMinutes;
  $("#regen2") && ($("#regen2").onclick = genMinutes);
  $("#llmStart") && ($("#llmStart").onclick = e => startLocalLlm(e.currentTarget));
  $("#editBtn") && ($("#editBtn").onclick = async () => {
    const editBtn = $("#editBtn");
    if (!editBtn) return;
    editBtn.disabled = true;
    const inflight = todoQueues.get(m.id);
    if (inflight) await inflight.catch(() => {});
    if (!editBtn.isConnected || !S.cur || S.cur.meta.id !== m.id) return;
    const curMd = (S.cur.minutes && S.cur.minutes.markdown) || activeMd || "";
    const box = $("#mdBox"), bar = editBtn.parentElement;
    mdEditOrig = curMd;
    editBtn.remove();
    $("#copyMinBtn") && $("#copyMinBtn").remove();
    $("#todoProg") && $("#todoProg").remove();
    $("#mdToc") && $("#mdToc").remove();
    $("#genBtn").disabled = true;
    bar.insertAdjacentHTML("beforeend", `<button id="mdCancel">取消</button><button class="pri" id="mdSave">${ic("check")}保存</button>`);
    box.innerHTML = `<textarea id="mdEdit" class="md-edit" aria-label="编辑纪要内容">${esc(curMd)}</textarea>`;
    const ta = $("#mdEdit");
    ta.focus();
    ta.onkeydown = e => {
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); $("#mdSave").click(); }
      else if (e.key === "Escape") { e.preventDefault(); $("#mdCancel").click(); }
    };
    $("#mdSave").onclick = async () => { if (await saveMdEditNow()) tabMinutes(); };
    $("#mdCancel").onclick = async () => {
      if (mdEditDirty() && !(await confirmAction({
        title: "放弃对纪要的修改？",
        message: "当前编辑尚未保存，放弃后将恢复修改前的内容。",
        confirmText: "放弃修改",
        cancelText: "继续编辑",
        danger: true,
      }))) return;
      mdEditOrig = null; tabMinutes();
    };
  });
}

async function genMinutes() {
  const d = S.cur, id = d && d.meta.id, title = d && d.meta.title;
  if (!id || GEN[id]) return;
  if (!(await saveMdEditNow())) return;
  if (d.minutes && d.minutes.edited && !(await confirmAction({
    title: "覆盖手动编辑的纪要？",
    message: "这份纪要已经手动修改过，重新生成会覆盖现有内容。",
    confirmText: "重新生成",
    cancelText: "取消",
    danger: true,
  }))) return;
  const pid = $("#provSel").value;
  S.provId = pid;
  const body = { template: $("#tplSel").value, provider: pid };
  const g = GEN[id] = { text: "", status: "准备中…", t0: Date.now(), provider: pid };
  const here = () => S.cur && S.cur.meta.id === id && S.tab === "minutes" && $("#mdBox") && !$("#mdEdit");
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (!here() || !GEN[id]) return;
    const box = $("#mdBox");
    box.innerHTML = md(g.text);
    box.lastElementChild && box.lastElementChild.classList.add("cursor");
  };
  const showSt = () => {
    if (!here()) return;
    $("#genState").textContent = g.status;
    if (!g.text) { const empty = $("#mdBox") && $("#mdBox").querySelector(".empty"); if (empty) empty.textContent = g.status; }
  };
  const setSt = t => { g.status = t; showSt(); };
  if (here()) tabMinutes();
  const clock = setInterval(() => {
    if (!GEN[id] || g.text) return;
    if (/已 \d+ 秒/.test(g.status)) return;
    const s = Math.round((Date.now() - g.t0) / 1000);
    setSt(`${g.status.replace(/ · \d+s$/, "")} · ${s}s`);
  }, 1000);
  try {
    await streamNd(`/api/meetings/${id}/minutes`, body, ev => {
      if (ev.type === "status") setSt(ev.msg);
      else if (ev.type === "delta") {
        g.text += ev.text;
        setSt(`生成中… ${g.text.length} 字 · ${Math.round((Date.now() - g.t0) / 1000)}s`);
        if (!raf) raf = requestAnimationFrame(paint);
      } else if (ev.type === "done") {
        todoBaseMd.delete(id);
        if (S.cur && S.cur.meta.id === id) S.cur.minutes = ev.minutes;
      } else if (ev.type === "error") throw new Error(ev.msg);
    });
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(clock);
    delete GEN[id];
    if (S.cur && S.cur.meta.id === id) await showMeeting(id);
    else toast(`「${title}」的纪要已生成`);
    hooks.loadMeetings && hooks.loadMeetings();
  } catch (e) {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(clock);
    delete GEN[id];
    genErr = { id, msg: e.message };
    toast("生成失败：" + e.message, 6000);
    if (S.cur && S.cur.meta.id === id && S.tab === "minutes") tabMinutes();
  }
}

export async function startLocalLlm(btn) {
  btn && (btn.disabled = true, btn.textContent = "启动中…");
  try { await api("/api/llm/local", { method: "POST", body: { action: "start" } }); }
  catch (e) { toast(e.message, 6000); btn && (btn.disabled = false, btn.textContent = "启动本地模型"); return; }
  for (let i = 0; i < 180; i++) {
    if (btn && !btn.isConnected) return;
    let st; try { st = await api("/api/llm/local"); } catch { break; }
    if (st.running) { toast("本地模型已启动"); btn && btn.isConnected && (btn.textContent = "已启动"); return st; }
    if (!st.ours) { toast("本地模型启动失败：" + (st.log || `退出码 ${st.exit_code}`), 8000); break; }
    btn && btn.isConnected && (btn.textContent = `启动中… ${i * 2}s`);
    await new Promise(r => setTimeout(r, 2000));
  }
  btn && btn.isConnected && (btn.disabled = false, btn.textContent = "启动本地模型");
}

// ---------------- 我的笔记 ----------------
function tabNotes() {
  const id = S.cur.meta.id;
  const pn = pendingNotes.get(id);
  const val = pn ? pn.value : S.cur.notes;
  $("#tabBody").innerHTML = `<div class="card"><div class="row" style="margin-bottom:8px"><span class="muted small grow">笔记会作为生成纪要的重点参考，自动保存</span>
    <button class="sm lt" id="insTs">${ic("clock")}插入当前播放时间</button></div>
    <textarea class="notes-area" id="notes" aria-label="我的笔记" style="height:60vh" placeholder="记录重点、决定、待办……">${esc(val)}</textarea>
    <div class="muted small" id="noteState">${pn ? "未保存，将自动重试…" : ""}</div></div>`;
  sbCleanup();
  bindNotes();
  $("#insTs").onclick = () => insertAtCursor($("#notes"), `[${fmtTs(($("#audio") ? $("#audio").currentTime : 0) * 1000)}] `);
}

// ---------------- AI 问答（rAF 节流 + 清理 rAF + 切页守卫） ----------------
async function tabQA() {
  const id = S.cur && S.cur.meta.id;
  if (!id) return;
  await ensureSettings();
  if (!S.cur || S.cur.meta.id !== id || S.tab !== "qa") return;
  const d = S.cur;
  const sugg = ["这次会议的主要结论是什么？", "有哪些待办？分别是谁负责？", "讨论中有哪些分歧或风险？", "帮我写一封会后跟进邮件"];
  $("#tabBody").innerHTML = `<div class="qa-list" id="qaList">${(d.qa || []).map(h => `<div class="q">${esc(h.q)}</div><div class="a md">${md(h.a)}</div>`).join("")}</div>
    ${!(d.qa || []).length ? `<div class="sugg">${sugg.map(s => `<button class="sm">${s}</button>`).join("")}</div>` : ""}
    <div class="qa-input"><select id="provSel" style="max-width:180px" title="用哪个模型回答" aria-label="用哪个模型回答">${providerOptions()}</select><input id="qIn" aria-label="向 AI 提问" placeholder="就这场会议提问，例如：张伟负责哪些事？" enterkeyhint="send"><button class="pri" id="qGo" aria-label="发送">${ic("send")}<span class="lbl">发送</span></button>
      ${(d.qa || []).length ? `<button class="ghost" id="qClr" title="清空问答" aria-label="清空问答">${ic("trash")}<span class="lbl">清空</span></button>` : ""}</div>`;
  sbCleanup();
  $$(".sugg button").forEach(b => b.onclick = () => { $("#qIn").value = b.textContent; send(); });
  $("#qClr") && ($("#qClr").onclick = async () => {
    let res;
    try { res = await api(`/api/meetings/${id}/qa`, { method: "DELETE" }); } catch (e) { return toast("清空失败：" + e.message, 5000); }
    const cleared = (res && Array.isArray(res.cleared) ? res.cleared : d.qa) || [];
    d.qa = []; tabQA();
    if (cleared.length) {
      toast(`已清空 ${cleared.length} 条问答`, {
        ms: 6000,
        action: {
          label: "撤销",
          onClick: async () => {
            const restored = await api(`/api/meetings/${id}/qa/restore`, { method: "POST", body: { items: cleared } });
            if (S.cur && S.cur.meta.id === id) {
              S.cur.qa = (restored && restored.qa) || cleared;
              if (S.tab === "qa") tabQA();
            }
            toast("已恢复问答记录");
          },
        },
      });
    }
  });
  let sending = false;
  const send = async () => {
    const qIn = $("#qIn"), qGo = $("#qGo"), provSel = $("#provSel");
    const q = qIn.value.trim(); if (!q || sending) return;
    sending = true;
    qIn.value = ""; qGo.disabled = true; qIn.placeholder = "正在回答，请稍候…";
    $(".sugg") && $(".sugg").remove();
    const list = $("#qaList");
    list.insertAdjacentHTML("beforeend", `<div class="q">${esc(q)}</div><div class="a md cursor">…</div>`);
    const box = list.lastElementChild;
    let text = "", raf = 0;
    const paint = () => { raf = 0; if (!box.isConnected) return; box.innerHTML = md(text); };
    box.scrollIntoView({ block: "end" });
    try {
      await streamNd(`/api/meetings/${id}/ask`, { question: q, provider: provSel.value }, ev => {
        if (ev.type === "delta") { text += ev.text; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === "error") throw new Error(ev.msg);
      });
      cancelAnimationFrame(raf); raf = 0;
      if (box.isConnected) { box.innerHTML = md(text); box.classList.remove("cursor"); }
      (d.qa = d.qa || []).push({ q, a: text });
    } catch (e) {
      cancelAnimationFrame(raf); raf = 0;
      if (box.isConnected) {
        box.classList.remove("cursor");
        box.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
      }
    } finally {
      sending = false;
      if (qGo.isConnected) { qGo.disabled = false; qIn.placeholder = "就这场会议提问，例如：张伟负责哪些事？"; }
    }
  };
  $("#qGo").onclick = send;
  $("#qIn").onkeydown = e => e.key === "Enter" && !e.isComposing && send();
}

// ---------------- 跨模块协作钩子（供 transcript / player / ux-shell 调用） ----------------
function quoteToNotes(line) {
  if (!S.cur || !line) return;
  const id = S.cur.meta.id;
  const pn = pendingNotes.get(id);
  const ta = $("#notes");
  const cur = ta ? ta.value : (pn ? pn.value : (S.cur.notes || ""));
  const sep = !cur ? "" : cur.endsWith("\n") ? "" : "\n";
  const next = cur + sep + String(line);
  if (ta) {
    ta.value = next;
    ta.scrollTop = ta.scrollHeight;
  }
  markNotesDirty(next);
  const st = $("#noteState");
  if (st) st.textContent = "保存中…";
  saveNotesNow(id);
  toast("已引用到我的笔记");
}

async function askWithQuote(promptText) {
  if (!S.cur) return;
  if (!$(".tabs") && !$("#qIn")) return;
  const ok = await switchTab("qa");
  if (!ok) return;
  if (!$("#qIn")) await ensureSettings();
  const qIn = $("#qIn");
  if (!qIn) return;
  qIn.value = String(promptText ?? "");
  qIn.focus();
  const len = qIn.value.length;
  try { qIn.setSelectionRange(len, len); } catch {}
  qIn.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
}

async function focusTranscriptSearch() {
  if (!S.cur) return false;
  let inp = $("#tSearch");
  if (!inp && $('button[data-tab="transcript"]')) {
    const ok = await switchTab("transcript");
    if (!ok) return false;
    inp = $("#tSearch");
  }
  if (!inp) return false;
  inp.focus();
  try { inp.select(); } catch {}
  return true;
}

Object.assign(hooks, {
  quoteToNotes,
  askWithQuote,
  addMarkAt,
  uploadFile: uploadMediaFile,
  focusTranscriptSearch,
});
