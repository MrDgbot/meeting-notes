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
const SKIP_FADE_S = 0.25;
const GLIDE_MS = 500;

let rangeEnd = null, rangeT = null;
let activePlayerCtl = null;

export function clearRange() {
  rangeEnd = null;
  clearTimeout(rangeT);
  rangeT = null;
}

function stopAtRangeEnd() {
  const a = $("#audio"); if (!a || rangeEnd === null) return;
  const t = a.currentTime * 1000;
  if (t >= rangeEnd) { if (t - rangeEnd < 1200) a.pause(); rangeEnd = null; }
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

function marksHTML(durMs) {
  const ms = (S.cur && S.cur.marks) || [];
  if (!durMs || !ms.length) return "";
  return ms.map(m => {
    const pct = Math.max(0, Math.min(100, (m.t_ms / durMs) * 100));
    const desc = (m.snippet || m.label || "").trim().slice(0, 40);
    const title = `打点 ${fmtTs(m.t_ms)}${desc ? " · " + desc : ""}`;
    return `<i class="pmark" data-ms="${Math.round(m.t_ms)}" style="left:${pct.toFixed(3)}%" title="${esc(title)}"></i>`;
  }).join("");
}

export function syncPlayerMarks() {
  const box = $("#pMarks");
  if (!box || !S.cur) return;
  const a = $("#audio");
  const dur = (a && a.duration && isFinite(a.duration)) ? a.duration : (S.cur.meta.duration || 0);
  box.innerHTML = marksHTML(dur * 1000);
}

export function syncPlayerSpeakerFilter(activeSpk = null) {
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
  const ps = S.cur.transcript ? paras().filter(p => p.spk >= 0) : [];
  let strip = "";
  if (durMs && ps.length) {
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
    strip = `<div class="pspk">${merged.map(seg =>
      `<i data-spk="${seg.spk}" style="left:${(seg.start / durMs * 100).toFixed(3)}%;width:${Math.max(.12, (seg.end - seg.start) / durMs * 100).toFixed(3)}%;background:${seg.color}"></i>`
    ).join("")}</div>`;
  }
  const wave = m.source === "ambient", sk = (wave && S.cur.skips) || [];
  const big = [];
  for (const x of sk) {
    if (x.skipped_s < 5) continue;
    const l = big[big.length - 1];
    if (l && (x.pos_ms - l.pos_ms) / durMs < .004) { l.skipped_s += x.skipped_s; l.to = x.to; }
    else big.push({ ...x });
  }
  const skips = durMs ? big.map(x => `<i class="pskip" style="left:${(x.pos_ms / durMs * 100).toFixed(3)}%" title="跳过 ${fmtDur(x.skipped_s)} 静音（${hms(x.from).slice(0, 5)} → ${hms(x.to).slice(0, 5)}）"></i>`).join("") : "";
  const marks = `<div class="pmarks" id="pMarks">${marksHTML(durMs)}</div>`;
  return `<div class="player" id="player"><audio id="audio" preload="metadata" src="/api/meetings/${esc(m.id)}/audio?v=${esc(m.duration)}"></audio>
    <button class="pbtn play" id="pPlay" title="播放 / 暂停（空格）" aria-label="播放或暂停">${icSwap("play", "pause")}</button>
    <button class="pbtn" id="pBack" title="后退 15 秒（← 后退 5 秒 · J 后退 10 秒）" aria-label="后退 15 秒">${ic("back")}</button>
    <button class="pbtn" id="pFwd" title="前进 15 秒（→ 前进 5 秒 · L 前进 10 秒）" aria-label="前进 15 秒">${ic("fwd")}</button>
    <span class="ptime"><b id="pCur">${wave && S.cur.segmap && S.cur.segmap.length ? tsLabel(0) : "00:00"}</b> / <span id="pDur">${durMs ? fmtTs(durMs) : "--:--"}</span></span>
    <div class="ptrack${wave ? " haswave" : ""}" id="pTrack">${wave ? `<canvas class="pwave" id="pWave"></canvas>` : ""}<div class="pbar"><i class="pbuf" id="pBuf"></i><i class="pfill" id="pFill"></i></div>${strip}${skips}${marks}
      <i class="phead" id="pHead"></i><span class="ptip" id="pTip"></span></div><span class="pskipnote" id="pSkipNote"></span><span class="pfast" id="pFast"></span>
    ${wave ? `<select class="psil" id="pSil" aria-label="静音处理" title="静音处理：安静的地方加速带过 / 直接跳过 / 照常播放">${SIL_OPTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>` : ""}
    <button class="pbtn prate" id="pRate" title="播放速度（[ / ]）" aria-label="播放速度 1×">1×</button></div>`;
}

export function bindPlayer() {
  const pl = $("#player");
  const a = pl && $("#audio", pl);
  if (!a) return;
  const track = $("#pTrack", pl), fill = $("#pFill", pl), buf = $("#pBuf", pl), head = $("#pHead", pl);
  const tip = $("#pTip", pl), play = $("#pPlay", pl), curEl = $("#pCur", pl), durEl = $("#pDur", pl);
  const note = $("#pSkipNote", pl), silSel = $("#pSil", pl), fastEl = $("#pFast", pl), rb = $("#pRate", pl), cv = $("#pWave", pl);
  const mid = S.cur.meta.id;
  const metaDur = S.cur.meta.duration || 0;
  const D = () => (a.duration && isFinite(a.duration) ? a.duration : metaDur);
  let drag = false, disposed = false, glideEnd = 0, glideRaf = 0, raf = 0, noteT = 0;

  const amb = S.cur.meta.source === "ambient";
  const sk = (amb && S.cur.skips) || [];

  const paint = (t = a.currentTime) => {
    if (disposed || !a.isConnected) return;
    const p = D() ? Math.min(1, Math.max(0, t / D())) : 0;
    const tw = track.clientWidth || 0;
    fill.style.transform = `scaleX(${p})`;
    head.style.setProperty("--hx", (p * tw).toFixed(2) + "px");
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
  const tick = () => {
    if (disposed || !amb || !a.isConnected) return;
    const t = a.currentTime, mode = silSel ? silSel.value : "off";
    skipNote(t);
    let g = 1;
    for (const x of sk) { const d = Math.abs(t - x.pos_ms / 1000); if (d < SKIP_FADE_S) g = Math.min(g, .1 + .9 * d / SKIP_FADE_S); }
    if (fadeInFrom) { const k = (performance.now() - fadeInFrom) / 250; if (k >= 1) fadeInFrom = 0; else g = Math.min(g, k); }
    setVol(g);
    if (a.paused || drag || mode === "off") return fastOff();
    const q = quietAt(t);
    if (q && mode === "skip") {
      if (q[1] - t > .3) { fastOff(); fadeInFrom = performance.now(); setVol(0); a.currentTime = q[1]; showNote(`⤼ 跳过 ${fmtDur(q[1] - t)} 静音`); }
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
    tick();
    raf = requestAnimationFrame(loop);
  };
  a.addEventListener("play", () => { if (!disposed && !raf) raf = requestAnimationFrame(loop); });
  a.addEventListener("pause", () => { cancelAnimationFrame(raf); raf = 0; fastOff(); });
  if (amb && cv) drawWave(mid, cv).then(pk => { if (!disposed) quiet = (pk && pk.quiet) || []; });
  a.onloadedmetadata = () => { if (disposed || !a.isConnected) return; durEl.textContent = fmtTs(D() * 1000); syncPlayerMarks(); paint(); };
  a.ontimeupdate = () => { if (disposed || !a.isConnected) return; if (!drag) paint(); highlightPlaying(a.currentTime * 1000); tick(); };
  a.onseeked = () => { lastT = a.currentTime; };
  a.onprogress = () => {
    if (disposed || !a.isConnected) return;
    try { const e = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0; buf.style.transform = `scaleX(${D() ? Math.min(1, e / D()) : 0})`; } catch {}
  };
  a.onplay = a.onpause = () => play.classList.toggle("alt", !a.paused);
  play.onclick = () => (a.paused ? playAudio(a) : a.pause());
  $("#pBack", pl).onclick = () => { clearRange(); a.currentTime = Math.max(0, a.currentTime - 15); paint(); };
  $("#pFwd", pl).onclick = () => { clearRange(); a.currentTime = Math.min(D(), a.currentTime + 15); paint(); };
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

  const at = e => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const skipAt = ms => { const x = sk.find(x => Math.abs(x.pos_ms - ms) < D() * 1000 * 0.006); return x ? ` · 跳过 ${fmtDur(x.skipped_s)} 静音` : ""; };
  const markAt = (ms, target) => {
    if (target && target.closest && target.closest(".pmark[data-ms]")) return " · ⚑ 打点";
    const list = (S.cur && S.cur.marks) || [];
    if (!list.length || !D()) return "";
    const tol = Math.max(1500, D() * 1000 * 0.012);
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
  track.onpointermove = e => {
    const p = at(e), ms = p * D() * 1000;
    const tStr = amb ? tsLabel(ms) : fmtTs(ms);
    const prev = paraPreview(ms);
    const mkStr = markAt(ms, e.target);
    const skStr = amb ? skipAt(ms) : "";
    const sig = `${tStr}|${prev ? prev.key : ""}|${mkStr}|${skStr}`;
    if (sig !== lastTipSig) {
      lastTipSig = sig;
      const head = `<span class="ptip-head"><span class="num">${esc(tStr)}</span>${prev && prev.who ? `<span class="ptip-sep">·</span><i class="ptip-dot" style="background:${esc(prev.color)}"></i><span>${esc(prev.who)}</span>` : ""}${mkStr ? `<span class="ptip-meta">${esc(mkStr)}</span>` : ""}${skStr ? `<span class="ptip-meta">${esc(skStr)}</span>` : ""}</span>`;
      const body = prev && prev.text ? `<span class="ptip-txt">${esc(prev.text)}</span>` : "";
      tip.innerHTML = head + body;
      tip.classList.toggle("has-txt", !!(prev && prev.text));
    }
    const tr = track.getBoundingClientRect();
    tip.classList.toggle("below", tr.top < 86);
    const tw = tr.width || track.clientWidth || 1;
    const half = Math.min(tw / 2, (tip.offsetWidth || 0) / 2);
    const x = Math.max(half, Math.min(tw - half, p * tw));
    tip.style.setProperty("--tx", x.toFixed(1) + "px");
    if (drag) paint(p * D());
  };
  track.onpointerdown = e => {
    if (e.target && e.target.closest && e.target.closest(".pmark[data-ms]")) return;
    drag = true; track.setPointerCapture(e.pointerId); track.classList.add("drag"); paint(at(e) * D());
  };
  track.onclick = e => {
    const mk = e.target && e.target.closest && e.target.closest(".pmark[data-ms]");
    if (!mk) return;
    e.stopPropagation();
    const tMs = +mk.dataset.ms;
    if (!Number.isFinite(tMs)) return;
    seek(Math.max(0, tMs - 3000) / 1000);
    paint();
    highlightPlaying(tMs, true);
  };
  const end = e => { if (!drag) return; drag = false; track.classList.remove("drag"); clearRange(); a.currentTime = at(e) * D(); };
  track.onpointerup = end;
  track.onpointercancel = () => { drag = false; track.classList.remove("drag"); paint(); };
  if (a.readyState >= 1) a.onloadedmetadata();

  const ctl = {
    stepRate,
    paint,
    seekBy: delta => {
      clearRange();
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
    a.ontimeupdate = a.onloadedmetadata = a.onseeked = a.onprogress = a.onplay = a.onpause = null;
    try { a.pause(); a.removeAttribute("src"); a.load(); } catch {}
  };
}

export async function drawWave(mid, cv) {
  if (!cv) return null;
  let pk = S.peaks && S.peaks.mid === mid && S.peaks.quiet ? S.peaks : null;
  if (!pk) {
    try { pk = { mid, ...(await api(`/api/meetings/${mid}/peaks`)) }; S.peaks = pk; }
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
    for (let i = 0; i < n; i++) {
      const a0 = Math.floor(i * L.length / n), a1 = Math.max(a0 + 1, Math.floor((i + 1) * L.length / n));
      let v = 0; for (let j = a0; j < a1 && j < L.length; j++) v = Math.max(v, L[j]);
      const bh = Math.max(1, v * h); g.fillRect(i * 2, (h - bh) / 2, 1.2, bh);
    }
  };
  paintWave();
  S.waveObs && S.waveObs.disconnect();
  if (window.ResizeObserver) (S.waveObs = new ResizeObserver(paintWave)).observe(cv);
  if (S.waveThemeUnsub) { S.waveThemeUnsub(); S.waveThemeUnsub = null; }
  S.waveThemeUnsub = onThemeChange(paintWave);
  return pk;
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
      || (e.target && e.target.closest && e.target.closest("input, textarea, select, button, [contenteditable]"))) return;
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
