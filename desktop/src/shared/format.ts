import type {
  MeetingAsrMeta,
  MeetingDetail,
  MeetingMeta,
  MeetingStatus,
  RecGap,
  SegMapEntry,
  TranscriptParagraph,
} from "./types";

export const COLORS = [
  "#3b6ef5",
  "#e5484d",
  "#12a594",
  "#e38a00",
  "#8e4ec6",
  "#0b8fc4",
  "#d6409f",
  "#687076",
  "#5f9e1b",
  "#c2410c",
] as const;

export const STATUS_LABELS: Record<MeetingStatus, string> = {
  new: "未开始",
  recording: "录音中",
  queued: "排队中",
  transcribing: "转写中",
  ready: "",
  error: "出错",
};

export const GAP_TEXT: Record<string, string> = {
  hidden: "页面在后台或锁屏了",
  interrupted: "被系统打断（来电、Siri 或别的应用在用麦克风）",
  muted: "麦克风没有声音（可能被别的应用占用）",
  overflow: "和电脑断开太久，超出了这台设备能暂存的 15 分钟",
  stall: "浏览器暂停了收音",
};

const GENERIC_SPK_RE = /^说话人\s*\d+$/;
const GENERIC_SPK_NAMES = new Set(["我", "对方", "主持人", "系统", "未知", "发言人"]);

export function isGenericSpeakerName(name: string): boolean {
  const v = String(name || "").trim();
  return !v || GENERIC_SPK_RE.test(v) || GENERIC_SPK_NAMES.has(v);
}

export function fmtTs(ms: number): string {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const x = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}

export function fmtDur(sec: number): string {
  const rounded = Math.round(sec || 0);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor(rounded / 60) % 60;
  return h ? `${h}小时${m}分` : m ? `${m}分${rounded % 60}秒` : `${rounded}秒`;
}

export function tsToSec(t: string): number {
  return String(t || "")
    .split(":")
    .map(Number)
    .reduce((a, b) => a * 60 + (Number.isFinite(b) ? b : 0), 0);
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function hms(tsSec: number): string {
  return new Date(tsSec * 1000).toTimeString().slice(0, 8);
}

export function hm(iso: string): string {
  return (iso || "").slice(11, 16);
}

export function getParas(d: MeetingDetail | null | undefined): TranscriptParagraph[] {
  if (!d) return [];
  if (d.transcript?.paragraphs) return d.transcript.paragraphs;
  const raw = d.live || [];
  const live: TranscriptParagraph[] = raw.map((x, idx) => ({
    ...x,
    _idx: idx,
    spk: Number.isInteger(x.ch) ? (x.ch as number) : -1,
  }));
  if (live.some((x) => Number.isInteger(x.ch))) {
    live.sort((a, b) => a.start - b.start || (a.ch || 0) - (b.ch || 0));
  }
  return live;
}

export interface SpeakerMapInfo {
  ids: number[];
  names: string[];
  spkName: (spk: number) => string;
  spkColor: (spk: number) => string;
  whoLabel: (p: TranscriptParagraph) => string;
}

export function buildSpeakerMap(d: MeetingDetail | null | undefined): SpeakerMapInfo {
  const ps = getParas(d);
  const speakers = d?.meta?.speakers || {};
  const idSet = new Set<number>();
  const chBySpk = new Map<number, number>();
  for (const p of ps) {
    if (p.spk >= 0) idSet.add(p.spk);
    if (p.spks?.length) {
      for (const s of p.spks) {
        if (s >= 0) idSet.add(s);
      }
    }
    const multi = (p.spks?.length ?? 0) > 1;
    if (!multi && (p.ch === 0 || p.ch === 1)) {
      if (p.spk >= 0 && !chBySpk.has(p.spk)) chBySpk.set(p.spk, p.ch);
      if (p.spks?.length === 1 && p.spks[0] !== undefined && !chBySpk.has(p.spks[0])) {
        chBySpk.set(p.spks[0], p.ch);
      }
    }
  }
  const ids = [...idSet].sort((a, b) => a - b);
  const computeName = (spk: number): string => {
    const custom = speakers[String(spk)];
    if (custom) return custom;
    const ch = chBySpk.get(spk);
    if (ch === 0) return "我";
    if (ch === 1) return "对方";
    return `说话人${Number(spk) + 1}`;
  };
  const nameMap = new Map<number, string>();
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  for (const id of ids) {
    const nm = computeName(id);
    nameMap.set(id, nm);
    if (!nameIdx.has(nm)) {
      nameIdx.set(nm, names.length);
      names.push(nm);
    }
  }
  const colorMap = new Map<number, string>();
  for (const id of ids) {
    const idx = nameIdx.get(nameMap.get(id) ?? "") ?? 0;
    colorMap.set(id, COLORS[idx % COLORS.length] ?? COLORS[0]);
  }
  const spkName = (spk: number) => nameMap.get(spk) ?? computeName(spk);
  const spkColor = (spk: number) => {
    const hit = colorMap.get(spk);
    if (hit) return hit;
    const nm = computeName(spk);
    const idx = Math.max(0, nameIdx.get(nm) ?? 0);
    return COLORS[idx % COLORS.length] ?? COLORS[0];
  };
  const whoLabel = (p: TranscriptParagraph) => {
    const list = p.spks && p.spks.length > 1 ? p.spks : [p.spk];
    return list
      .filter((s) => s >= 0)
      .map(spkName)
      .join("、");
  };
  return { ids, names, spkName, spkColor, whoLabel };
}

export function wallOf(ms: number, segmap: SegMapEntry[] | null | undefined): number | null {
  if (!segmap?.length) return null;
  let lo = 0;
  let hi = segmap.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = segmap[mid];
    if (row && row[0] <= ms) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const base = segmap[idx];
  return base ? base[1] + (ms - base[0]) / 1000 : null;
}

export function tsLabel(ms: number, segmap: SegMapEntry[] | null | undefined): string {
  const w = wallOf(ms, segmap);
  return w ? hms(w) : fmtTs(ms);
}

export function asrInfo(a: MeetingAsrMeta | undefined | null, long = false): string {
  if (!a?.engine) return "本机识别";
  if (a.engine !== "doubao") {
    const nameMap: Record<string, string> = {
      nano: "本机 Fun-ASR-Nano",
      paraformer: "本机 Paraformer",
    };
    const name = nameMap[a.engine] ?? "本机识别";
    if (a.cloud_failed) {
      return long
        ? `豆包云端识别失败（${a.cloud_failed}），已改用${name}`
        : `${name}（豆包云端失败，已改用本机）`;
    }
    if (a.nano_failed) {
      return long
        ? `Fun-ASR-Nano 加载失败（${a.nano_failed}），已改用 Paraformer`
        : `${name}（Nano 加载失败）`;
    }
    return name;
  }
  const fix = (a.failed || 0) + (a.local || 0);
  return long
    ? `豆包云端识别 ${a.units ?? 0} 段；云端失败 ${a.failed || 0} 段、没出字 ${a.local || 0} 段由本机模型补上`
    : `豆包云端${fix ? `（本机补 ${a.local || 0} 段）` : ""}`;
}

export interface ComputedRecHealth {
  gaps: RecGap[];
  gapMs: number;
  reconnects: number;
  lostMs: number;
  tip: string;
  hasIssue: boolean;
  summaryText: string;
}

export function computeRecHealth(m: MeetingMeta | null | undefined): ComputedRecHealth | null {
  const hs = m?.rec_health || [];
  if (!hs.length || !m) return null;
  const gaps = hs.flatMap((h) => h.gaps || []).sort((a, b) => a.at_ms - b.at_ms);
  const lost = hs.reduce(
    (acc, h) =>
      acc + (h.ended && h.produced ? Math.max(0, h.produced - (h.received || 0) - (h.dropped || 0)) : 0),
    0,
  );
  const gapMs = gaps.reduce((acc, g) => acc + g.dur_ms, 0);
  const reconnects = hs.reduce((acc, h) => acc + (h.reconnects || 0), 0);
  const lostMs = lost / (m.audio_channels === 2 ? 64 : 32);
  const why = [...new Set(gaps.map((g) => GAP_TEXT[g.reason] || GAP_TEXT.stall))].join("；");
  const tip = [
    `网络断开后重连 ${reconnects} 次（断开期间的录音会补传）`,
    gaps.length ? `没录到 ${gaps.length} 段，共 ${fmtDur(gapMs / 1000)}：${why}` : "",
    lostMs >= 1000 ? `另有约 ${fmtDur(lostMs / 1000)} 录到了但没传上电脑` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const hasIssue = gaps.length > 0 || lostMs >= 1000;
  const issueCount = gaps.length + (lostMs >= 1000 ? 1 : 0);
  const summaryText = hasIssue
    ? `录音有 ${issueCount} 处缺口，共 ${fmtDur((gapMs + lostMs) / 1000)}`
    : `录音完整${reconnects ? `（断网重连 ${reconnects} 次，已补传）` : ""}`;
  return { gaps, gapMs, reconnects, lostMs, tip, hasIssue, summaryText };
}

export function effDuration(m: MeetingMeta): number {
  return m.source === "ambient" ? m.speech_s || 0 : m.duration || 0;
}

export function isShortClip(m: MeetingMeta): boolean {
  return (
    m.source === "ambient" &&
    effDuration(m) < 60 &&
    m.title_auto !== false &&
    !["recording", "queued", "transcribing"].includes(m.status)
  );
}
