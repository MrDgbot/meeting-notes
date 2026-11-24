// 通用工具、常量、共享状态与 O(1) 说话人映射缓存
export const COLORS = ["#3b6ef5", "#e5484d", "#12a594", "#e38a00", "#8e4ec6", "#0b8fc4", "#d6409f", "#687076", "#5f9e1b", "#c2410c"];

// 线性图标（24 网格）；线宽由 CSS 统一成 1.5px 且不随尺寸缩放，14/16/18px 下粗细一致。
// 值以 "<" 开头的是多段图形：class="mv" 的部分会单独动（箭头、盖子、分隔线）；f: 前缀的是实心
export const ICONS = {
  plus: "M12 5v14M5 12h14", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-3.5-3.5",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M3 10h18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4l3 2",
  flag: "M5 21V4M5 4h12l-2.5 4 2.5 4H5",
  archive: "M4 5h16v4H4zM6 9v10h12V9M10 13h4",
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
  // 后退/前进 15 秒：用矢量路径画“15”，避免浏览器最小字号（如 12px）把 SVG <text> 撑破圆环
  back: '<path d="M12 4.5a8 8 0 1 1-8 8"/><path d="M14.5 2 12 4.5 14.5 7"/><path d="M8.8 11.3l1.1-.8v5.3M15.1 10.5h-2.7v2.2h1.3a1.55 1.55 0 0 1 0 3.1h-1.6"/>',
  fwd: '<path d="M12 4.5a8 8 0 1 0 8 8"/><path d="M9.5 2 12 4.5 9.5 7"/><path d="M8.8 11.3l1.1-.8v5.3M15.1 10.5h-2.7v2.2h1.3a1.55 1.55 0 0 1 0 3.1h-1.6"/>',
  send: "M5 12h14M13 6l6 6-6 6", text: "M5 6h14M5 12h14M5 18h9", subtitle: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 14h4M14 14h3M7 10h10",
  columns: '<path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path class="mv" d="M12 4v16"/>',
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  moon: "M20.2 14.5A8 8 0 0 1 9.5 3.8a8.5 8.5 0 1 0 10.7 10.7z",
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.1 1.1c0 1.8-2.5 2.1-2.5 3.6"/><circle cx="12" cy="17.2" r=".7" fill="currentColor" stroke="none"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  home: "M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5",
  "f:play": "M8 5.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8A.8.8 0 0 0 8 5.2z",
  "f:pause": "M7 5h3.2v14H7zM13.8 5H17v14h-3.2z", "f:stop": "M7 7h10v10H7z",
};

export const ic = (name, cls = "") => {
  const f = ICONS["f:" + name], v = f || ICONS[name] || "";
  return `<svg class="ic i-${name}${f ? " f" : ""}${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${v[0] === "<" ? v : `<path d="${v}"/>`}</svg>`;
};
export const icSwap = (a, b) => `<span class="swap">${ic(a)}${ic(b)}</span>`;
export function flashDone(btn, ms = 1600) {
  btn.classList.add("alt");
  clearTimeout(btn._doneT);
  btn._doneT = setTimeout(() => btn.classList.remove("alt"), ms);
}

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// HTML 转义（包含单引号，防止单引号属性逃逸与 XSS）
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
export const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 大小写不敏感高亮，保留原文大小写
export function hl(s, q) {
  const str = String(s ?? "");
  if (!q) return esc(str);
  const re = new RegExp(escRe(q), "gi");
  let out = "", last = 0, m;
  while ((m = re.exec(str))) {
    out += esc(str.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (!m[0].length) re.lastIndex++;
  }
  return out + esc(str.slice(last));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function safeLSGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
export function safeLSSet(key, val) {
  try { localStorage.setItem(key, String(val)); } catch {}
}
export function safeJSONParse(str, fallback = {}) {
  if (!str) return fallback;
  try { const v = JSON.parse(str); return v && typeof v === "object" ? v : fallback; } catch { return fallback; }
}

export const fmtTs = ms => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(x).padStart(2, "0");
};
export const fmtDur = sec => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60;
  return h ? `${h}小时${m}分` : m ? `${m}分${sec % 60}秒` : `${sec}秒`;
};
export const tsToSec = t => String(t || "").split(":").map(Number).reduce((a, b) => a * 60 + (Number.isFinite(b) ? b : 0), 0);
export const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const hms = ts => new Date(ts * 1000).toTimeString().slice(0, 8);
export const hm = iso => (iso || "").slice(11, 16);

export const STATUS = { new: "未开始", recording: "录音中", queued: "排队中", transcribing: "转写中", ready: "", error: "出错" };
export const statusTag = m => {
  const t = m.status === "recording" && m.source === "ambient" ? "记录中" : STATUS[m.status];
  return t ? `<span class="tag ${esc(m.status)}">${esc(t)}</span>` : "";
};
export const autoIc = m => m.source === "ambient" ? `<span class="auto-ic" title="全天模式自动记录">${ic("radio")}</span>`
  : m.source === "upload" ? `<span class="auto-ic" title="上传的文件">${ic("file")}</span>` : "";

export const GAP_TEXT = {
  hidden: "页面在后台或锁屏了",
  interrupted: "被系统打断（来电、Siri 或别的应用在用麦克风）",
  muted: "麦克风没有声音（可能被别的应用占用）",
  overflow: "和电脑断开太久，超出了这台设备能暂存的 15 分钟",
  stall: "浏览器暂停了收音",
};
export const TYPING = ["notes", "qIn", "mdEdit", "mTitle", "peText", "tSearch"];

// 环境探测
export const REMOTE = !["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
export const OFFLINE = REMOTE
  ? "连不上电脑上的会议记录服务（电脑睡眠了、换了网络，或者服务没开）"
  : "连不上会议记录服务，请确认服务还在运行（./start.sh）";
export const TOUCH = matchMedia("(hover: none)").matches;
export const IN_APP = (navigator.userAgent.match(/MicroMessenger|Lark|Feishu|DingTalk|AlipayClient|\bQQ\//) || [""])[0]
  .replace("MicroMessenger", "微信").replace(/Lark|Feishu/, "飞书")
  .replace("DingTalk", "钉钉").replace("AlipayClient", "支付宝").replace(/QQ\//, "QQ");
export const CAN_SYS = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
export const CAN_MIC = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// 共享应用状态
export const S = {
  meetings: [], health: null, cur: null, tab: null, settings: null,
  filter: "", sideKind: "all", searchQ: "", searchHits: null, follow: true,
  split: safeLSGet("splitView") !== "0",
  amb: null, ambLive: false, discardSeen: null, provId: null, lanSel: 0,
  healthT: null, phObs: null, waveObs: null, waveThemeUnsub: null, peaks: null,
  playerCleanup: null, routeSeq: 0,
};

// 跨模块回调（避免循环依赖）
export const hooks = {
  route: null,
  showMeeting: null,
  showHome: null,
  showDay: null,
  showDiscarded: null,
  loadMeetings: null,
  openSettings: null,
  renderSide: null,
  renderAmb: null,
  renderPill: null,
  ambAct: null,
  confirmSplit: null,
  pollHealth: null,
  saveNotesNow: null,
  saveMdEditNow: null,
  teardownView: null,
  editingNow: null,
  renderPartial: null,
  switchTab: null,
  highlightPlaying: null,
  clearRange: null,
  renderDiscarded: null,
  renderTab: null,
  tabTranscript: null,
  uploadFile: null,
  focusTranscriptSearch: null,
};

export function isOnMeeting(id) {
  const h = location.hash;
  return h === "#/m/" + id || h.startsWith("#/m/" + id + "?");
}

// 缓存实时双声道排序后的段落数组（保留原始 _idx，避免编辑/删除索引错位）
let _liveCacheSrc = null, _liveCacheLen = -1, _liveCacheOut = null;
export function paras(d = S.cur) {
  if (!d) return [];
  if (d.transcript && d.transcript.paragraphs) return d.transcript.paragraphs;
  const raw = d.live || [];
  if (_liveCacheSrc === raw && _liveCacheLen === raw.length && _liveCacheOut) return _liveCacheOut;
  const live = raw.map((x, idx) => ({ ...x, _idx: idx, spk: Number.isInteger(x.ch) ? x.ch : -1 }));
  const out = live.some(x => Number.isInteger(x.ch))
    ? live.sort((a, b) => a.start - b.start || (a.ch || 0) - (b.ch || 0))
    : live;
  _liveCacheSrc = raw; _liveCacheLen = raw.length; _liveCacheOut = out;
  return out;
}

// 单次 O(N) 预计算说话人名称与颜色映射，后续查询均为 O(1)
let _spkCache = null;
export function getSpeakerMap(d = S.cur) {
  const ps = paras(d);
  const speakers = (d && d.meta && d.meta.speakers) || {};
  const spkSig = JSON.stringify(speakers);
  if (_spkCache && _spkCache.ps === ps && _spkCache.len === ps.length && _spkCache.spkSig === spkSig) {
    return _spkCache;
  }
  const idSet = new Set();
  const chBySpk = new Map();
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.spk >= 0) idSet.add(p.spk);
    if (p.spks && p.spks.length) {
      for (let j = 0; j < p.spks.length; j++) if (p.spks[j] >= 0) idSet.add(p.spks[j]);
    }
    const multi = p.spks && p.spks.length > 1;
    if (!multi && (p.ch === 0 || p.ch === 1)) {
      if (p.spk >= 0 && !chBySpk.has(p.spk)) chBySpk.set(p.spk, p.ch);
      if (p.spks && p.spks.length === 1 && !chBySpk.has(p.spks[0])) chBySpk.set(p.spks[0], p.ch);
    }
  }
  const ids = [...idSet].sort((a, b) => a - b);
  const nameMap = new Map();
  const computeName = spk => {
    if (speakers[String(spk)]) return speakers[String(spk)];
    const ch = chBySpk.get(spk);
    if (ch === 0) return "我";
    if (ch === 1) return "对方";
    return `说话人${Number(spk) + 1}`;
  };
  const names = [];
  const nameIdx = new Map();
  for (const id of ids) {
    const nm = computeName(id);
    nameMap.set(id, nm);
    if (!nameIdx.has(nm)) { nameIdx.set(nm, names.length); names.push(nm); }
  }
  const colorMap = new Map();
  for (const id of ids) {
    colorMap.set(id, COLORS[(nameIdx.get(nameMap.get(id)) || 0) % COLORS.length]);
  }
  _spkCache = { ps, len: ps.length, spkSig, ids, nameMap, colorMap, names, nameIdx, computeName };
  return _spkCache;
}

export function spkName(spk, d = S.cur) {
  const c = getSpeakerMap(d);
  return c.nameMap.has(spk) ? c.nameMap.get(spk) : c.computeName(spk);
}
export function whoLabel(p, d = S.cur) {
  const ids = (p.spks && p.spks.length > 1) ? p.spks : [p.spk];
  return ids.filter(s => s >= 0).map(s => spkName(s, d)).join("、");
}
export function spkColor(spk, d = S.cur) {
  const c = getSpeakerMap(d);
  if (c.colorMap.has(spk)) return c.colorMap.get(spk);
  const nm = c.computeName(spk);
  return COLORS[Math.max(0, c.nameIdx.get(nm) ?? 0) % COLORS.length];
}

export function wallOf(ms) {
  const sm = S.cur && S.cur.segmap; if (!sm || !sm.length) return null;
  let lo = 0, hi = sm.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sm[mid][0] <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const b = sm[idx];
  return b[1] + (ms - b[0]) / 1000;
}
export const tsLabel = ms => { const w = wallOf(ms); return w ? hms(w) : fmtTs(ms); };

export function asrInfo(a, long) {
  if (!a || !a.engine) return "本机识别";
  if (a.engine !== "doubao") {
    const name = { nano: "高精度离线模型", paraformer: "极速离线模型" }[a.engine] || "本机识别";
    if (a.cloud_failed) return long ? `豆包云端识别失败（${a.cloud_failed}），已改用${name}` : `${name}（云端回退本机）`;
    if (a.nano_failed) return long ? `高精度离线模型加载失败（${a.nano_failed}），已改用极速离线模型` : `${name}（兼容模式）`;
    return name;
  }
  const fix = (a.failed || 0) + (a.local || 0);
  return long
    ? `豆包云端识别 ${a.units} 段；云端失败 ${a.failed || 0} 段、没出字 ${a.local || 0} 段由本机模型补上`
    : `豆包云端${fix ? `（本机补 ${a.local || 0} 段）` : ""}`;
}

export function recHealth(m) {
  const hs = m.rec_health || [];
  if (!hs.length) return null;
  const gaps = hs.flatMap(h => h.gaps || []).sort((a, b) => a.at_ms - b.at_ms);
  const lost = hs.reduce((a, h) => a + (h.ended && h.produced ? Math.max(0, h.produced - h.received - (h.dropped || 0)) : 0), 0);
  return {
    gaps,
    gapMs: gaps.reduce((a, g) => a + g.dur_ms, 0),
    reconnects: hs.reduce((a, h) => a + (h.reconnects || 0), 0),
    lostMs: lost / (m.audio_channels === 2 ? 64 : 32),
  };
}
export function recHealthHTML(m) {
  const h = recHealth(m); if (!h) return "";
  const why = [...new Set(h.gaps.map(g => GAP_TEXT[g.reason] || GAP_TEXT.stall))].join("；");
  const tip = [
    `网络断开后重连 ${h.reconnects} 次（断开期间的录音会补传）`,
    h.gaps.length ? `没录到 ${h.gaps.length} 段，共 ${fmtDur(h.gapMs / 1000)}：${why}` : "",
    h.lostMs >= 1000 ? `另有约 ${fmtDur(h.lostMs / 1000)} 录到了但没传上电脑` : "",
  ].filter(Boolean).join("\n");
  return h.gaps.length || h.lostMs >= 1000
    ? `<span class="rh bad" title="${esc(tip)}">${ic("clock")}录音有 ${h.gaps.length + (h.lostMs >= 1000 ? 1 : 0)} 处缺口，共 ${fmtDur((h.gapMs + h.lostMs) / 1000)}</span>`
    : `<span class="rh" title="${esc(tip)}">${ic("check")}录音完整${h.reconnects ? `（断网重连 ${h.reconnects} 次，已补传）` : ""}</span>`;
}

export function templateOptions(sel) {
  const t = (S.health && S.health.templates) || { general: "通用会议" };
  return Object.entries(t).map(([k, v]) => `<option value="${esc(k)}" ${k === sel ? "selected" : ""}>${esc(v)}</option>`).join("");
}

export function providerOptions(selected) {
  if (!S.settings) return "";
  const sel = selected || S.provId || S.settings.active;
  return S.settings.providers.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

export function scrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
