import {
  $, $$, S, esc, fmtDur, fmtTs, hms, hooks, ic, icSwap, paras,
  safeLSGet, safeLSSet, spkColor, spkName, tsLabel, tsToSec,
} from "./utils.js";
import { api } from "./api.js";
import { isOverlayOpen, playAudio, toast } from "./ui.js";
import { findParaAt, highlightPlaying } from "./transcript.js";
import { onThemeChange } from "./palette.js";

export const SIL_OPTS = [["fast2", "静音×2"], ["fast3", "静音×3"], ["fast4", "静音×4"], ["fast6", "静音×6"], ["fast8", "静音×8"], ["skip", "跳过静音"], ["off", "静音原速"]];
const RATES = [0.75, 1, 1.25, 1.5, 2];
const ZOOMS = [1, 2, 4, 8, 16];
const SKIP_FADE_S = 0.25;
const GLIDE_MS = 500;

const VOL_ON_SVG = '<svg class="ic i-vol" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
const VOL_OFF_SVG = '<svg class="ic i-mute" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M21 9.5l-5 5M16 9.5l5 5"/></svg>';
const MINUS_SVG = '<svg class="ic i-minus" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
const SEL_SVG = '<svg class="ic i-sel" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5H5v14h3M16 5h3v14h-3"/></svg>';

let rangeEnd = null, rangeT = null;
let activePlayerCtl = null;
let activeSpkFilter = null;

export function clearRange() {
  rangeEnd = null;
  clearTimeout(rangeT);
  rangeT = null;
}

function stopAtRangeEnd() {
  const a = $("#audio"); if (!a || rangeEnd === null) return;
  const t = a.currentTime * 1000;
  const tol = Math.max(1200, 1200 * (a.playbackRate || 1));
  if (t >= rangeEnd) { if (t - rangeEnd < tol) a.pause(); rangeEnd = null; }
}

export function markRange(s, e) {
  $$("#paras .para.inrange").forEach(el => el.classList.remove("inrange"));
  clearTimeout(rangeT);
  const hit = $$("#paras .para[data-s]").filter(el => +el.dataset.s < (e ?? s + 1) && +el.dataset.e > s);
  hit.forEach(el => el.classList.add("inrange"));
  rangeT = setTimeout(() => hit.forEach(el => el.classList.remove("inrange")), 8000);
}

// 点要点/打点：先在用户点击手势内同步触发 a.play()（保证 iOS Safari 不拒播），再切转写稿并高亮
export async function jumpRange(s, e, focus) {
  const a = $("#audio");
  if (a) {
    rangeEnd = e ?? null;
    a.removeEventListener("timeupdate", stopAtRangeEnd);
    a.addEventListener("timeupdate", stopAtRangeEnd);
    a.currentTime = s / 1000;
    playAudio(a);
  }
  if (!$("#paras") && hooks.switchTab && $('button[data-tab="transcript"]')) {
    await hooks.switchTab("transcript");
  }
  markRange(s, e);
  highlightPlaying(focus, true);
  if (!a) toast("这场没有保存录音，只能看转写");
}

export function seek(sec) {
  const a = $("#audio"); if (!a) return;
  clearRange();
  a.currentTime = sec;
  playAudio(a);
}

function mergedSpeakers(durMs) {
  const ps = S.cur && S.cur.transcript ? paras().filter(p => p.spk >= 0) : [];
  if (!durMs || !ps.length) return [];
  const merged = [];
  const gapTol = durMs * 0.002;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], color = spkColor(p.spk);
    const last = merged[merged.length - 1];
    if (last && last.spk === p.spk && last.color === color && p.start - last.end <= gapTol) {
      if (p.end > last.end) last.end = p.end;
    } else {
      merged.push({ start: p.start, end: p.end, color, spk: p.spk });
    }
  }
  return merged;
}

function spkSegsHTML(merged, vsMs, veMs, spkFilter = null) {
  const vdMs = veMs - vsMs;
  if (!(vdMs > 0) || !merged.length) return "";
  const on = spkFilter !== null && spkFilter !== undefined;
  const out = [];
  for (const seg of merged) {
    if (seg.end <= vsMs || seg.start >= veMs) continue;
    const s = Math.max(vsMs, seg.start), e = Math.min(veMs, seg.end);
    const left = ((s - vsMs) / vdMs) * 100;
    const width = Math.max(0.12, ((e - s) / vdMs) * 100);
    const match = on && Number(seg.spk) === Number(spkFilter) ? ' class="spk-match"' : "";
    out.push(`<i data-spk="${seg.spk}"${match} style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${seg.color}"></i>`);
  }
  return out.join("");
}

function bigSkips(durMs) {
  const amb = S.cur && S.cur.meta && S.cur.meta.source === "ambient";
  const sk = (amb && S.cur.skips) || [];
  if (!durMs || !sk.length) return [];
  const big = [];
  for (const x of sk) {
    if (x.skipped_s < 5) continue;
    const l = big[big.length - 1];
    if (l && (x.pos_ms - l.pos_ms) / durMs < .004) { l.skipped_s += x.skipped_s; l.to = x.to; }
    else big.push({ ...x });
  }
  return big;
}

function skipsHTML(big, vsMs, veMs) {
  const vdMs = veMs - vsMs;
  if (!(vdMs > 0) || !big.length) return "";
  const out = [];
  for (const x of big) {
    if (x.pos_ms < vsMs || x.pos_ms > veMs) continue;
    const left = ((x.pos_ms - vsMs) / vdMs) * 100;
    out.push(`<i class="pskip" style="left:${left.toFixed(3)}%" title="跳过 ${fmtDur(x.skipped_s)} 静音（${hms(x.from).slice(0, 5)} → ${hms(x.to).slice(0, 5)}）"></i>`);
  }
  return out.join("");
}

function marksHTML(durMs, vsMs = 0, veMs = durMs) {
  const ms = (S.cur && S.cur.marks) || [];
  const vdMs = veMs - vsMs;
  if (!durMs || !(vdMs > 0) || !ms.length) return "";
  const out = [];
  for (const m of ms) {
    if (m.t_ms < vsMs || m.t_ms > veMs) continue;
    const pct = Math.max(0, Math.min(100, ((m.t_ms - vsMs) / vdMs) * 100));
    const desc = (m.snippet || m.label || "").trim().slice(0, 40);
    const title = `打点 ${fmtTs(m.t_ms)}${desc ? " · " + desc : ""}`;
    out.push(`<i class="pmark" data-ms="${Math.round(m.t_ms)}" style="left:${pct.toFixed(3)}%" title="${esc(title)}"></i>`);
  }
  return out.join("");
}

export function syncPlayerMarks() {
  if (activePlayerCtl && activePlayerCtl.renderMarks) {
    activePlayerCtl.renderMarks();
    return;
  }
  const box = $("#pMarks");
  if (!box || !S.cur) return;
  const a = $("#audio");
  const dur = (a && a.duration && isFinite(a.duration)) ? a.duration : (S.cur.meta.duration || 0);
  box.innerHTML = marksHTML(dur * 1000);
}

export function syncPlayerSpeakerFilter(activeSpk = null) {
  activeSpkFilter = activeSpk;
  const strip = $(".pspk");
  if (!strip) return;
  const on = activeSpk !== null && activeSpk !== undefined;
  strip.classList.toggle("has-spk-filter", on);
  $$("i[data-spk]", strip).forEach(el => {
    el.classList.toggle("spk-match", on && Number(el.dataset.spk) === Number(activeSpk));
  });
}
hooks.syncPlayerSpeakerFilter = syncPlayerSpeakerFilter;

export function playerHTML(m) {
  const durMs = (m.duration || 0) * 1000;
  const amb = m.source === "ambient";
  const merged = mergedSpeakers(durMs);
  const strip = merged.length ? `<div class="pspk">${spkSegsHTML(merged, 0, durMs, activeSpkFilter)}</div>` : "";
  const skips = `<div class="pskips" id="pSkips">${skipsHTML(bigSkips(durMs), 0, durMs)}</div>`;
  const marks = `<div class="pmarks" id="pMarks">${marksHTML(durMs)}</div>`;
  return `<div class="player" id="player"><audio id="audio" preload="metadata" src="/api/meetings/${esc(m.id)}/audio?v=${esc(m.duration)}"></audio>
    <button class="pbtn play" id="pPlay" title="播放 / 暂停（空格）" aria-label="播放或暂停">${icSwap("play", "pause")}</button>
    <button class="pbtn" id="pBack" title="后退 15 秒（← 后退 5 秒 · J 后退 10 秒）" aria-label="后退 15 秒">${ic("back")}</button>
    <button class="pbtn" id="pFwd" title="前进 15 秒（→ 前进 5 秒 · L 前进 10 秒）" aria-label="前进 15 秒">${ic("fwd")}</button>
    <span class="ptime"><b id="pCur">${amb && S.cur.segmap && S.cur.segmap.length ? tsLabel(0) : "00:00"}</b> / <span id="pDur">${durMs ? fmtTs(durMs) : "--:--"}</span></span>
    <div class="ptrack haswave" id="pTrack"><canvas class="pwave" id="pWave"></canvas><div class="pbar"><i class="pbuf" id="pBuf"></i><i class="pfill" id="pFill"></i></div>
      <div class="psel-range" id="pSelRange" hidden></div>${strip}${skips}${marks}
      <div class="psel-handle psel-start" id="pSelStart" role="slider" tabindex="0" aria-label="选区起点" hidden></div>
      <div class="psel-handle psel-end" id="pSelEnd" role="slider" tabindex="0" aria-label="选区终点" hidden></div>
      <i class="phead" id="pHead"></i><span class="ptip" id="pTip"></span><span class="pskipnote" id="pSkipNote"></span><span class="pfast" id="pFast"></span></div>
    <select class="psil" id="pSil" aria-label="静音处理" title="静音处理：安静的地方加速带过 / 直接跳过 / 照常播放">${SIL_OPTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
    <button class="pbtn pmute" id="pMute" title="静音（M）" aria-label="静音" aria-pressed="false"><span class="swap">${VOL_ON_SVG}${VOL_OFF_SVG}</span></button>
    <button class="pbtn prate" id="pRate" title="播放速度（[ / ]）" aria-label="播放速度 1×">1×</button>
    <div class="pbar-sub" id="pSub">
      <div class="pzoom" role="group" aria-label="波形缩放">
        <button type="button" class="pzoom-btn pzoom-step" id="pZoomOut" title="缩小波形" aria-label="缩小波形" disabled>${MINUS_SVG}</button>
        <div class="pzoom-lvls" id="pZoomLvls">${ZOOMS.map(z => `<button type="button" class="pzoom-btn${z === 1 ? " on" : ""}" data-zoom="${z}" aria-pressed="${z === 1}">${z}×</button>`).join("")}</div>
        <button type="button" class="pzoom-btn pzoom-step" id="pZoomIn" title="放大波形" aria-label="放大波形">${ic("plus")}</button>
      </div>
      <div class="ppan" id="pPanWrap" hidden>
        <input type="range" class="ppan-rng" id="pPan" min="0" max="1000" value="0" aria-label="平移波形窗口">
        <span class="ppan-lbl num" id="pPanLbl"></span>
      </div>
      <div class="psel-tools">
        <button type="button" class="psel-btn" id="pSelBtn" aria-pressed="false" title="框选波形片段（或按住 Shift 拖动）">${SEL_SVG}<span>选区</span></button>
        <div class="psel-bar" id="pSelBar" hidden>
          <span class="psel-lbl num" id="pSelRangeTxt"></span>
          <button type="button" class="psel-act pri" id="pSelPlay" title="试听选区">${ic("play")}<span>试听选区</span></button>
          <button type="button" class="psel-act" id="pSelExport" title="导出片段 WAV">${ic("download")}<span>导出片段</span></button>
          <button type="button" class="psel-act ghost" id="pSelClear" title="清除选区">${ic("x")}<span>清除</span></button>
        </div>
      </div>
    </div></div>`;
}

export function bindPlayer() {
  const pl = $("#player");
  const a = pl && $("#audio", pl);
  if (!a) return;
  const track = $("#pTrack", pl), fill = $("#pFill", pl), buf = $("#pBuf", pl), head = $("#pHead", pl);
  const tip = $("#pTip", pl), play = $("#pPlay", pl), curEl = $("#pCur", pl), durEl = $("#pDur", pl);
  const note = $("#pSkipNote", pl), silSel = $("#pSil", pl), fastEl = $("#pFast", pl), rb = $("#pRate", pl), cv = $("#pWave", pl);
  const muteBtn = $("#pMute", pl), skipsBox = $("#pSkips", pl), marksBox = $("#pMarks", pl), spkStrip = $(".pspk", pl);
  const zoomOutBtn = $("#pZoomOut", pl), zoomInBtn = $("#pZoomIn", pl), zoomLvls = $("#pZoomLvls", pl);
  const panWrap = $("#pPanWrap", pl), panInp = $("#pPan", pl), panLbl = $("#pPanLbl", pl);
  const selBtn = $("#pSelBtn", pl), selBar = $("#pSelBar", pl), selRangeEl = $("#pSelRange", pl);
  const selStartH = $("#pSelStart", pl), selEndH = $("#pSelEnd", pl), selTxt = $("#pSelRangeTxt", pl);
  const selPlayBtn = $("#pSelPlay", pl), selExportBtn = $("#pSelExport", pl), selClearBtn = $("#pSelClear", pl);
  const mid = S.cur.meta.id;
  const metaDur = S.cur.meta.duration || 0;
  const D = () => (a.duration && isFinite(a.duration) ? a.duration : metaDur);
  let drag = false, selDrag = null, handleDrag = null, disposed = false;
  let glideEnd = 0, glideRaf = 0, raf = 0, noteT = 0;
  let zoom = 1, viewStart = 0, panning = false, followPaused = false;
  let selectMode = false, selStart = null, selEnd = null, redrawWave = null;

  const amb = S.cur.meta.source === "ambient";
  const sk = (amb && S.cur.skips) || [];
  let cachedSpkDur = -1, cachedSpk = [];
  let cachedSkDur = -1, cachedSk = [];

  const getView = () => {
    const dur = D() || 0;
    if (!(dur > 0) || zoom <= 1) return { dur, vs: 0, ve: dur, vd: dur };
    const vd = dur / zoom;
    const maxS = Math.max(0, dur - vd);
    const vs = Math.max(0, Math.min(maxS, viewStart));
    return { dur, vs, ve: vs + vd, vd };
  };
  const timeToRatio = tSec => {
    const { vs, vd } = getView();
    return vd > 0 ? (tSec - vs) / vd : 0;
  };
  const ratioToTime = r => {
    const { vs, vd } = getView();
    return vs + Math.max(0, Math.min(1, r)) * vd;
  };
  const fmtViewTime = ms => (amb ? tsLabel(ms) : fmtTs(ms));

  const renderMarks = () => {
    if (!marksBox || disposed) return;
    const { dur, vs, ve } = getView();
    marksBox.innerHTML = marksHTML(dur * 1000, vs * 1000, ve * 1000);
  };

  const renderTrackOverlays = () => {
    if (disposed) return;
    const { dur, vs, ve } = getView();
    const durMs = dur * 1000, vsMs = vs * 1000, veMs = ve * 1000;
    if (spkStrip) {
      if (cachedSpkDur !== durMs) {
        cachedSpk = mergedSpeakers(durMs);
        cachedSpkDur = durMs;
      }
      spkStrip.innerHTML = spkSegsHTML(cachedSpk, vsMs, veMs, activeSpkFilter);
      const on = activeSpkFilter !== null && activeSpkFilter !== undefined;
      spkStrip.classList.toggle("has-spk-filter", on);
    }
    if (skipsBox) {
      if (cachedSkDur !== durMs) {
        cachedSk = bigSkips(durMs);
        cachedSkDur = durMs;
      }
      skipsBox.innerHTML = skipsHTML(cachedSk, vsMs, veMs);
    }
    renderMarks();
  };

  const updateBuffered = () => {
    if (disposed || !a.isConnected || !buf) return;
    try {
      const { vs, ve, vd } = getView();
      if (!(vd > 0) || !a.buffered.length) { buf.style.transform = "scaleX(0)"; return; }
      let bestEnd = 0;
      for (let i = 0; i < a.buffered.length; i++) {
        const bs = a.buffered.start(i), be = a.buffered.end(i);
        if (bs <= ve && be >= vs && be > bestEnd) bestEnd = be;
      }
      if (!bestEnd) bestEnd = a.buffered.end(a.buffered.length - 1);
      const r = Math.max(0, Math.min(1, (bestEnd - vs) / vd));
      buf.style.transform = `scaleX(${r})`;
    } catch {}
  };

  const renderSelection = () => {
    if (disposed) return;
    const dur = D() || 0;
    const valid = selStart !== null && selEnd !== null && selEnd > selStart && dur > 0;
    if (!valid) {
      if (selRangeEl) selRangeEl.hidden = true;
      if (selStartH) selStartH.hidden = true;
      if (selEndH) selEndH.hidden = true;
      if (selBar) selBar.hidden = true;
      return;
    }
    const minLen = Math.min(0.1, dur);
    const s = Math.max(0, Math.min(dur - minLen, selStart));
    const e = Math.min(dur, Math.max(s + minLen, selEnd));
    const sr = timeToRatio(s), er = timeToRatio(e);
    if (selRangeEl) {
      if (er <= 0 || sr >= 1) {
        selRangeEl.hidden = true;
      } else {
        const l = Math.max(0, sr) * 100, r = Math.min(1, er) * 100;
        selRangeEl.hidden = false;
        selRangeEl.style.left = l.toFixed(3) + "%";
        selRangeEl.style.width = Math.max(0, r - l).toFixed(3) + "%";
      }
    }
    if (selStartH) {
      selStartH.hidden = sr < 0 || sr > 1;
      selStartH.style.left = (Math.max(0, Math.min(1, sr)) * 100).toFixed(3) + "%";
      selStartH.setAttribute("aria-valuemin", "0");
      selStartH.setAttribute("aria-valuemax", (e - minLen).toFixed(2));
      selStartH.setAttribute("aria-valuenow", s.toFixed(2));
      selStartH.setAttribute("aria-valuetext", fmtTs(s * 1000));
    }
    if (selEndH) {
      selEndH.hidden = er < 0 || er > 1;
      selEndH.style.left = (Math.max(0, Math.min(1, er)) * 100).toFixed(3) + "%";
      selEndH.setAttribute("aria-valuemin", (s + minLen).toFixed(2));
      selEndH.setAttribute("aria-valuemax", dur.toFixed(2));
      selEndH.setAttribute("aria-valuenow", e.toFixed(2));
      selEndH.setAttribute("aria-valuetext", fmtTs(e * 1000));
    }
    if (selTxt) selTxt.textContent = `${fmtTs(s * 1000)} – ${fmtTs(e * 1000)}`;
    if (selBar) selBar.hidden = false;
  };

  const syncPanUI = () => {
    const { dur, vs, ve, vd } = getView();
    const zoomed = zoom > 1 && dur > 0;
    if (panWrap) panWrap.hidden = !zoomed;
    if (!zoomed) return;
    const maxS = Math.max(0, dur - vd);
    if (panInp && !panning) panInp.value = String(maxS > 0 ? Math.round((vs / maxS) * 1000) : 0);
    if (panLbl) panLbl.textContent = `${fmtViewTime(vs * 1000)} – ${fmtViewTime(ve * 1000)}`;
  };

  const syncZoomUI = () => {
    if (zoomLvls) {
      $$("button[data-zoom]", zoomLvls).forEach(b => {
        const on = Number(b.dataset.zoom) === zoom;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
    const idx = ZOOMS.indexOf(zoom);
    if (zoomOutBtn) zoomOutBtn.disabled = idx <= 0;
    if (zoomInBtn) zoomInBtn.disabled = idx >= ZOOMS.length - 1;
    syncPanUI();
  };

  const refreshView = () => {
    syncZoomUI();
    renderTrackOverlays();
    renderSelection();
    updateBuffered();
    if (redrawWave) redrawWave();
  };

  const setZoom = (nextZoom, anchorTime = null) => {
    if (!ZOOMS.includes(nextZoom) || nextZoom === zoom) return;
    const { dur, vs, vd } = getView();
    if (anchorTime === null) {
      const cur = a.currentTime;
      anchorTime = (cur >= vs && cur <= vs + vd) ? cur : vs + vd / 2;
    }
    const ratio = vd > 0 ? Math.max(0, Math.min(1, (anchorTime - vs) / vd)) : 0.5;
    zoom = nextZoom;
    followPaused = false;
    if (zoom <= 1 || !(dur > 0)) {
      viewStart = 0;
    } else {
      const newVd = dur / zoom;
      viewStart = Math.max(0, Math.min(Math.max(0, dur - newVd), anchorTime - ratio * newVd));
    }
    refreshView();
    paint();
  };

  const setSelectMode = on => {
    selectMode = !!on;
    track.classList.toggle("selecting", selectMode);
    if (selBtn) selBtn.setAttribute("aria-pressed", String(selectMode));
  };

  const paint = (t = a.currentTime) => {
    if (disposed || !a.isConnected) return;
    if (zoom > 1 && !a.paused && !drag && !selDrag && !handleDrag && !panning && !followPaused && D() > 0) {
      const { dur, vs, vd } = getView();
      if (t < vs || t > vs + vd * 0.92) {
        const nextVs = Math.max(0, Math.min(Math.max(0, dur - vd), t - vd * 0.15));
        if (Math.abs(nextVs - viewStart) > 0.01) {
          viewStart = nextVs;
          refreshView();
        }
      }
    }
    const p = timeToRatio(t);
    const pClamped = Math.max(0, Math.min(1, p));
    const tw = track.clientWidth || 0;
    fill.style.transform = `scaleX(${pClamped})`;
    if (p < -0.005 || p > 1.005) {
      head.style.display = "none";
    } else {
      head.style.display = "";
      head.style.setProperty("--hx", (pClamped * tw).toFixed(2) + "px");
    }
    if (performance.now() >= glideEnd) curEl.textContent = amb ? tsLabel(t * 1000) : fmtTs(t * 1000);
  };

  let lastT = a.currentTime;
  const showNote = txt => {
    if (!note || disposed) return;
    note.textContent = txt; note.classList.add("on");
    clearTimeout(noteT); noteT = setTimeout(() => note.classList.remove("on"), 3000);
  };
  const glide = (from, to) => {
    if (!(to > from) || disposed) return;
    cancelAnimationFrame(glideRaf);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      glideEnd = 0; paint(); return;
    }
    const t0 = performance.now(); glideEnd = t0 + GLIDE_MS;
    const step = () => {
      glideRaf = 0;
      if (disposed || !a.isConnected) return;
      const k = Math.min(1, (performance.now() - t0) / GLIDE_MS), e = 1 - (1 - k) ** 3;
      curEl.textContent = hms(from + (to - from) * e);
      if (k < 1) glideRaf = requestAnimationFrame(step);
      else { glideEnd = 0; paint(); }
    };
    glideRaf = requestAnimationFrame(step);
  };
  const skipNote = t => {
    const x = sk.find(x => lastT * 1000 < x.pos_ms && t * 1000 >= x.pos_ms && t - lastT < 2);
    lastT = t; if (!x || !note) return;
    showNote(`⤼ 跳过 ${fmtDur(x.skipped_s)} 静音 · ${hms(x.from).slice(0, 5)} → ${hms(x.to).slice(0, 5)}`);
    glide(x.from, x.to);
  };

  let quiet = [], fasting = false, userRate = 1, fadeInFrom = 0;
  if (silSel) {
    const v = safeLSGet("silenceMode");
    silSel.value = SIL_OPTS.some(o => o[0] === v) ? v : "fast4";
    silSel.onchange = () => { safeLSSet("silenceMode", silSel.value); fastOff(); tick(); silSel.blur(); };
  }
  const quietAt = t => {
    let lo = 0, hi = quiet.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, q = quiet[m];
      if (t < q[0]) hi = m - 1; else if (t >= q[1]) lo = m + 1; else return q;
    }
    return null;
  };
  const fastOff = () => { if (!fasting) return; fasting = false; a.playbackRate = userRate; fastEl && fastEl.classList.remove("on"); };
  const setVol = v => { if (Math.abs(a.volume - v) > .01) try { a.volume = v; } catch {} };
  const syncMuteUI = () => {
    if (!muteBtn || disposed) return;
    const muted = !!a.muted;
    muteBtn.classList.toggle("alt", muted);
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.setAttribute("aria-label", muted ? "取消静音" : "静音");
    muteBtn.title = muted ? "取消静音（M）" : "静音（M）";
  };
  const toggleMute = () => { a.muted = !a.muted; syncMuteUI(); };

  const tick = () => {
    if (disposed || !a.isConnected) return;
    const t = a.currentTime, mode = silSel ? silSel.value : "off";
    if (amb) skipNote(t);
    let g = 1;
    if (amb) {
      for (const x of sk) { const d = Math.abs(t - x.pos_ms / 1000); if (d < SKIP_FADE_S) g = Math.min(g, .1 + .9 * d / SKIP_FADE_S); }
    }
    if (fadeInFrom) { const k = (performance.now() - fadeInFrom) / 250; if (k >= 1) fadeInFrom = 0; else g = Math.min(g, k); }
    setVol(g);
    if (a.paused || drag || mode === "off") return fastOff();
    const q = quietAt(t);
    if (q && mode === "skip") {
      if (q[1] - t > .3) {
        fastOff();
        if (rangeEnd !== null && q[1] * 1000 >= rangeEnd) {
          a.pause();
          a.currentTime = rangeEnd / 1000;
          rangeEnd = null;
          return;
        }
        fadeInFrom = performance.now();
        setVol(0);
        a.currentTime = q[1];
        showNote(`⤼ 跳过 ${fmtDur(q[1] - t)} 静音`);
      }
      return;
    }
    if (q && mode.startsWith("fast")) {
      const r = +mode.slice(4);
      if (!fasting || a.playbackRate !== r) { fasting = true; a.playbackRate = r; if (fastEl) { fastEl.textContent = `静音 ×${r}`; fastEl.classList.add("on"); } }
    } else fastOff();
  };
  const loop = () => {
    raf = 0;
    if (disposed || !a.isConnected || a.paused) return;
    if (!drag) paint();
    stopAtRangeEnd();
    tick();
    if (!a.paused) raf = requestAnimationFrame(loop);
  };
  a.addEventListener("play", () => { followPaused = false; if (!disposed && !raf) raf = requestAnimationFrame(loop); });
  a.addEventListener("pause", () => { cancelAnimationFrame(raf); raf = 0; fastOff(); });
  if (cv) {
    drawWave(mid, cv, getView).then(pk => {
      if (disposed) return;
      quiet = (pk && pk.quiet) || [];
      redrawWave = pk && pk.redraw ? pk.redraw : null;
      if (redrawWave && zoom > 1) redrawWave();
    });
  }
  a.onloadedmetadata = () => {
    if (disposed || !a.isConnected) return;
    durEl.textContent = fmtTs(D() * 1000);
    refreshView();
    paint();
  };
  a.ontimeupdate = () => { if (disposed || !a.isConnected) return; if (!drag) paint(); highlightPlaying(a.currentTime * 1000); tick(); };
  a.onseeked = () => { lastT = a.currentTime; if (!panning) { followPaused = false; paint(); } };
  a.onprogress = updateBuffered;
  a.onvolumechange = syncMuteUI;
  a.onplay = a.onpause = () => play.classList.toggle("alt", !a.paused);
  syncMuteUI();
  syncZoomUI();

  if (muteBtn) muteBtn.onclick = toggleMute;
  play.onclick = () => (a.paused ? playAudio(a) : a.pause());
  $("#pBack", pl).onclick = () => { clearRange(); followPaused = false; a.currentTime = Math.max(0, a.currentTime - 15); paint(); };
  $("#pFwd", pl).onclick = () => { clearRange(); followPaused = false; a.currentTime = Math.min(D(), a.currentTime + 15); paint(); };
  const setRate = r => {
    userRate = r;
    if (!fasting) a.playbackRate = r;
    rb.textContent = r + "×";
    rb.setAttribute("aria-label", `播放速度 ${r}×`);
    safeLSSet("playRate", r);
    return r;
  };
  const stepRate = delta => {
    const idx = Math.max(0, RATES.indexOf(userRate));
    const nextIdx = Math.max(0, Math.min(RATES.length - 1, idx + delta));
    return setRate(RATES[nextIdx]);
  };
  setRate(RATES.includes(+safeLSGet("playRate")) ? +safeLSGet("playRate") : 1);
  rb.onclick = () => setRate(RATES[(RATES.indexOf(userRate) + 1) % RATES.length]);

  if (zoomOutBtn) zoomOutBtn.onclick = () => { const idx = ZOOMS.indexOf(zoom); if (idx > 0) setZoom(ZOOMS[idx - 1]); };
  if (zoomInBtn) zoomInBtn.onclick = () => { const idx = ZOOMS.indexOf(zoom); if (idx < ZOOMS.length - 1) setZoom(ZOOMS[idx + 1]); };
  if (zoomLvls) {
    zoomLvls.onclick = e => {
      const btn = e.target && e.target.closest && e.target.closest("button[data-zoom]");
      if (!btn) return;
      setZoom(Number(btn.dataset.zoom));
    };
  }
  if (panInp) {
    panInp.oninput = () => {
      const dur = D() || 0;
      if (zoom <= 1 || !(dur > 0)) return;
      panning = true;
      if (!a.paused) followPaused = true;
      const vd = dur / zoom;
      const maxS = Math.max(0, dur - vd);
      viewStart = (Number(panInp.value) / 1000) * maxS;
      refreshView();
      paint();
    };
    const endPan = () => { panning = false; };
    panInp.onchange = endPan;
    panInp.onpointerup = endPan;
    panInp.onpointercancel = endPan;
  }

  if (selBtn) selBtn.onclick = () => setSelectMode(!selectMode);
  if (selPlayBtn) {
    selPlayBtn.onclick = () => {
      if (selStart === null || selEnd === null || selEnd <= selStart) return;
      rangeEnd = selEnd * 1000;
      a.removeEventListener("timeupdate", stopAtRangeEnd);
      a.addEventListener("timeupdate", stopAtRangeEnd);
      followPaused = false;
      a.currentTime = selStart;
      paint(selStart);
      playAudio(a);
    };
  }
  if (selExportBtn) {
    selExportBtn.onclick = () => {
      if (selStart === null || selEnd === null || selEnd <= selStart) return;
      const url = `/api/meetings/${encodeURIComponent(mid)}/audio/clip?start=${selStart.toFixed(3)}&end=${selEnd.toFixed(3)}&fmt=wav`;
      const link = document.createElement("a");
      link.href = url;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
  }
  if (selClearBtn) {
    selClearBtn.onclick = () => {
      selStart = null;
      selEnd = null;
      setSelectMode(false);
      clearRange();
      renderSelection();
    };
  }

  const at = e => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const skipAt = ms => {
    const vdMs = getView().vd * 1000;
    const x = sk.find(x => Math.abs(x.pos_ms - ms) < vdMs * 0.006);
    return x ? ` · 跳过 ${fmtDur(x.skipped_s)} 静音` : "";
  };
  const markAt = (ms, target) => {
    if (target && target.closest && target.closest(".pmark[data-ms]")) return " · ⚑ 打点";
    const list = (S.cur && S.cur.marks) || [];
    const vdMs = getView().vd * 1000;
    if (!list.length || !vdMs) return "";
    const tol = Math.max(400, vdMs * 0.012);
    return list.some(m => Math.abs(m.t_ms - ms) <= tol) ? " · ⚑ 打点" : "";
  };
  const paraPreview = ms => {
    if (!S.cur) return null;
    const p = findParaAt(ms);
    if (!p) return null;
    const raw = String(p.text || "").replace(/\s+/g, " ").trim();
    const text = raw.length > 72 ? raw.slice(0, 72) + "…" : raw;
    const hasSpk = !!S.cur.transcript && p.spk >= 0;
    return {
      who: hasSpk ? spkName(p.spk) : "",
      color: hasSpk ? spkColor(p.spk) : "",
      text,
      key: `${p.start}:${p.end}:${p.spk}`,
    };
  };
  let lastTipSig = "";
  const updateTip = e => {
    const p = at(e), tSec = ratioToTime(p), ms = tSec * 1000;
    const tStr = fmtViewTime(ms);
    const prev = paraPreview(ms);
    const mkStr = markAt(ms, e.target);
    const skStr = amb ? skipAt(ms) : "";
    const sig = `${tStr}|${prev ? prev.key : ""}|${mkStr}|${skStr}`;
    if (sig !== lastTipSig) {
      lastTipSig = sig;
      const h = `<span class="ptip-head"><span class="num">${esc(tStr)}</span>${prev && prev.who ? `<span class="ptip-sep">·</span><i class="ptip-dot" style="background:${esc(prev.color)}"></i><span>${esc(prev.who)}</span>` : ""}${mkStr ? `<span class="ptip-meta">${esc(mkStr)}</span>` : ""}${skStr ? `<span class="ptip-meta">${esc(skStr)}</span>` : ""}</span>`;
      const body = prev && prev.text ? `<span class="ptip-txt">${esc(prev.text)}</span>` : "";
      tip.innerHTML = h + body;
      tip.classList.toggle("has-txt", !!(prev && prev.text));
    }
    const tr = track.getBoundingClientRect();
    tip.classList.toggle("below", tr.top < 86);
    const tw = tr.width || track.clientWidth || 1;
    const half = Math.min(tw / 2, (tip.offsetWidth || 0) / 2);
    const x = Math.max(half, Math.min(tw - half, p * tw));
    tip.style.setProperty("--tx", x.toFixed(1) + "px");
    return tSec;
  };

  const bindHandle = (handle, edge) => {
    if (!handle) return;
    handle.onpointerdown = e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      handle.focus();
      handle.setPointerCapture(e.pointerId);
      handleDrag = { edge, handle };
      track.classList.add("drag-sel");
    };
    handle.onpointermove = e => {
      if (!handleDrag || handleDrag.handle !== handle) return;
      e.stopPropagation();
      const dur = D() || 0, minLen = Math.min(0.1, dur);
      const tSec = updateTip(e);
      if (edge === "start") selStart = Math.max(0, Math.min((selEnd ?? dur) - minLen, tSec));
      else selEnd = Math.min(dur, Math.max((selStart ?? 0) + minLen, tSec));
      renderSelection();
    };
    const stopHandle = e => {
      if (!handleDrag || handleDrag.handle !== handle) return;
      e.stopPropagation();
      handleDrag = null;
      track.classList.remove("drag-sel");
    };
    handle.onpointerup = stopHandle;
    handle.onpointercancel = stopHandle;
    handle.onkeydown = e => {
      const dur = D() || 0;
      if (!(dur > 0) || selStart === null || selEnd === null) return;
      const minLen = Math.min(0.1, dur);
      const base = zoom >= 4 ? 0.2 : 0.5;
      const step = e.shiftKey ? base * 10 : base;
      let handled = true;
      if (e.key === "ArrowLeft") {
        if (edge === "start") selStart = Math.max(0, selStart - step);
        else selEnd = Math.max(selStart + minLen, selEnd - step);
      } else if (e.key === "ArrowRight") {
        if (edge === "start") selStart = Math.min(selEnd - minLen, selStart + step);
        else selEnd = Math.min(dur, selEnd + step);
      } else if (e.key === "Home") {
        if (edge === "start") selStart = 0;
        else selEnd = selStart + minLen;
      } else if (e.key === "End") {
        if (edge === "start") selStart = selEnd - minLen;
        else selEnd = dur;
      } else {
        handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      renderSelection();
    };
  };
  bindHandle(selStartH, "start");
  bindHandle(selEndH, "end");

  track.addEventListener("wheel", e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const idx = ZOOMS.indexOf(zoom);
    const nextIdx = e.deltaY < 0 ? Math.min(ZOOMS.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (nextIdx !== idx) setZoom(ZOOMS[nextIdx], ratioToTime(at(e)));
  }, { passive: false });

  track.onpointermove = e => {
    const tSec = updateTip(e);
    if (selDrag) {
      if (Math.abs(e.clientX - selDrag.startX) >= 3) selDrag.moved = true;
      if (selDrag.moved) {
        selStart = Math.min(selDrag.anchor, tSec);
        selEnd = Math.max(selDrag.anchor, tSec);
        renderSelection();
      }
      return;
    }
    if (drag) paint(tSec);
  };
  track.onpointerdown = e => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && (e.target.closest(".pmark[data-ms]") || e.target.closest(".psel-handle"))) return;
    if (e.shiftKey || selectMode) {
      selDrag = { anchor: ratioToTime(at(e)), moved: false, startX: e.clientX, prevStart: selStart, prevEnd: selEnd };
      track.setPointerCapture(e.pointerId);
      track.classList.add("drag-sel");
      return;
    }
    drag = true; track.setPointerCapture(e.pointerId); track.classList.add("drag"); paint(ratioToTime(at(e)));
  };
  track.onclick = e => {
    const mk = e.target && e.target.closest && e.target.closest(".pmark[data-ms]");
    if (!mk) return;
    e.stopPropagation();
    const tMs = +mk.dataset.ms;
    if (!Number.isFinite(tMs)) return;
    followPaused = false;
    seek(Math.max(0, tMs - 3000) / 1000);
    paint();
    highlightPlaying(tMs, true);
  };
  const end = e => {
    if (selDrag) {
      const sd = selDrag;
      selDrag = null;
      track.classList.remove("drag-sel");
      if (sd.moved && selStart !== null && selEnd !== null && selEnd - selStart >= 0.05) {
        if (selectMode) setSelectMode(false);
        renderSelection();
      } else {
        selStart = sd.prevStart;
        selEnd = sd.prevEnd;
        renderSelection();
      }
      return;
    }
    if (!drag) return;
    drag = false;
    track.classList.remove("drag");
    clearRange();
    followPaused = false;
    a.currentTime = ratioToTime(at(e));
    paint();
  };
  track.onpointerup = end;
  track.onpointercancel = () => {
    if (selDrag) {
      selStart = selDrag.prevStart;
      selEnd = selDrag.prevEnd;
      selDrag = null;
      track.classList.remove("drag-sel");
      renderSelection();
      return;
    }
    drag = false;
    track.classList.remove("drag");
    paint();
  };
  if (a.readyState >= 1) a.onloadedmetadata();

  const ctl = {
    stepRate,
    paint,
    toggleMute,
    renderMarks,
    seekBy: delta => {
      clearRange();
      followPaused = false;
      a.currentTime = Math.max(0, Math.min(D() || 1e9, a.currentTime + delta));
      paint();
    },
  };
  activePlayerCtl = ctl;

  S.phObs && S.phObs.disconnect();
  if (pl && window.ResizeObserver) {
    S.phObs = new ResizeObserver(() => {
      $("#main").style.setProperty("--ph", pl.offsetHeight + "px");
      paint();
    });
    S.phObs.observe(pl);
  }

  S.playerCleanup = () => {
    disposed = true;
    if (activePlayerCtl === ctl) activePlayerCtl = null;
    cancelAnimationFrame(raf); raf = 0;
    cancelAnimationFrame(glideRaf); glideRaf = 0;
    clearTimeout(noteT); noteT = 0;
    if (S.waveThemeUnsub) { S.waveThemeUnsub(); S.waveThemeUnsub = null; }
    a.removeEventListener("timeupdate", stopAtRangeEnd);
    a.ontimeupdate = a.onloadedmetadata = a.onseeked = a.onprogress = a.onvolumechange = a.onplay = a.onpause = null;
    try { a.pause(); a.removeAttribute("src"); a.load(); } catch {}
  };
}

export async function drawWave(mid, cv, getView = null) {
  if (!cv) return null;
  const metaDur = (S.cur && S.cur.meta && S.cur.meta.duration) || 0;
  let pk = S.peaks && S.peaks.mid === mid && S.peaks.quiet && S.peaks.dur === metaDur ? S.peaks : null;
  if (!pk) {
    try { pk = { mid, dur: metaDur, ...(await api(`/api/meetings/${mid}/peaks`)) }; S.peaks = pk; }
    catch { return null; }
  }
  if (!cv.isConnected || !S.cur || S.cur.meta.id !== mid) return null;
  const paintWave = () => {
    if (!cv.isConnected) return;
    const w = cv.clientWidth, h = cv.clientHeight, r = window.devicePixelRatio || 1;
    if (!w || !h) return;
    cv.width = w * r; cv.height = h * r;
    const g = cv.getContext("2d"); g.scale(r, r); g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(cv).color;
    const L = pk.levels, n = Math.max(1, Math.floor(w / 2));
    if (!L || !L.length) return;
    const view = getView ? getView() : null;
    const dur = view && view.dur > 0 ? view.dur : 0;
    const vsFrac = dur > 0 ? Math.max(0, Math.min(1, view.vs / dur)) : 0;
    const veFrac = dur > 0 ? Math.max(vsFrac, Math.min(1, view.ve / dur)) : 1;
    const idx0 = vsFrac * L.length, idxSpan = Math.max(1e-6, (veFrac - vsFrac) * L.length);
    for (let i = 0; i < n; i++) {
      const a0 = Math.max(0, Math.floor(idx0 + (i * idxSpan) / n));
      const a1 = Math.max(a0 + 1, Math.floor(idx0 + ((i + 1) * idxSpan) / n));
      let v = 0;
      for (let j = a0; j < a1 && j < L.length; j++) v = Math.max(v, L[j]);
      const bh = Math.max(1, v * h);
      g.fillRect(i * 2, (h - bh) / 2, 1.2, bh);
    }
  };
  paintWave();
  S.waveObs && S.waveObs.disconnect();
  if (window.ResizeObserver) (S.waveObs = new ResizeObserver(paintWave)).observe(cv);
  if (S.waveThemeUnsub) { S.waveThemeUnsub(); S.waveThemeUnsub = null; }
  S.waveThemeUnsub = onThemeChange(paintWave);
  return { ...pk, redraw: paintWave };
}

function jumpParaStep(delta) {
  const a = $("#audio");
  const ps = paras();
  if (!a || !ps.length) return;
  const curMs = a.currentTime * 1000;
  let idx = -1;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].start <= curMs + 150) idx = i;
    else break;
  }
  const targetIdx = delta < 0 ? Math.max(0, idx - 1) : Math.min(ps.length - 1, idx + 1);
  const target = ps[targetIdx];
  if (!target) return;
  seek(target.start / 1000);
  if (activePlayerCtl) activePlayerCtl.paint();
  highlightPlaying(target.start, true);
}

export function initPlayerListeners() {
  document.addEventListener("keydown", e => {
    const a = $("#audio");
    if (!a || isOverlayOpen() || e.metaKey || e.ctrlKey || e.altKey
      || (e.target && e.target.closest && e.target.closest('input, textarea, select, button, [contenteditable], [role="slider"]'))) return;
    if (e.key === " ") { e.preventDefault(); a.paused ? playAudio(a) : a.pause(); }
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (activePlayerCtl) activePlayerCtl.seekBy(-5);
      else { clearRange(); a.currentTime = Math.max(0, a.currentTime - 5); }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (activePlayerCtl) activePlayerCtl.seekBy(5);
      else { clearRange(); a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 5); }
    } else if (!e.shiftKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      if (activePlayerCtl) activePlayerCtl.seekBy(-10);
      else { clearRange(); a.currentTime = Math.max(0, a.currentTime - 10); }
    } else if (!e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (activePlayerCtl) activePlayerCtl.seekBy(10);
      else { clearRange(); a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 10); }
    } else if (!e.shiftKey && e.key.toLowerCase() === "m" && !$("#rMark")) {
      e.preventDefault();
      if (activePlayerCtl) activePlayerCtl.toggleMute();
      else a.muted = !a.muted;
    } else if (e.key === "[") {
      e.preventDefault();
      if (activePlayerCtl) toast(`播放速度 ${activePlayerCtl.stepRate(-1)}×`, 1400);
    } else if (e.key === "]") {
      e.preventDefault();
      if (activePlayerCtl) toast(`播放速度 ${activePlayerCtl.stepRate(1)}×`, 1400);
    } else if (e.key === ",") {
      e.preventDefault();
      jumpParaStep(-1);
    } else if (e.key === ".") {
      e.preventDefault();
      jumpParaStep(1);
    }
  });
  document.addEventListener("click", e => {
    const ht = e.target.closest("[data-hs]");
    if (ht) {
      e.preventDefault();
      jumpRange(+ht.dataset.hs, ht.dataset.he ? +ht.dataset.he : null, +(ht.dataset.focus || ht.dataset.hs));
      return;
    }
    const t = e.target.closest("a.ts[data-ts]");
    if (!t || !$("#audio")) return;
    seek(tsToSec(t.dataset.ts));
    if (!t.closest("#paras")) highlightPlaying(tsToSec(t.dataset.ts) * 1000, true);
  });
}
