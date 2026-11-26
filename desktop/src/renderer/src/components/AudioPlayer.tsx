import { buildSpeakerMap, fmtTs, tsLabel } from "@shared/format";
import type { AudioPeaks, MarkItem, MeetingDetail, SegMapEntry, TranscriptParagraph } from "@shared/types";
import { Flag, Pause, Play, RotateCcw, RotateCw, Scissors, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";

interface AudioPlayerProps {
  mid: string;
  durationHint: number;
  peaks: AudioPeaks | null;
  marks: MarkItem[];
  segmap: SegMapEntry[] | null;
  paras: TranscriptParagraph[];
  meeting?: MeetingDetail | null;
  onMarkCurrent: (tMs: number) => void;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;
const SIL_OPTS = [
  ["fast2", "静音×2"],
  ["fast3", "静音×3"],
  ["fast4", "静音×4"],
  ["fast6", "静音×6"],
  ["fast8", "静音×8"],
  ["skip", "跳过静音"],
  ["off", "静音原速"],
] as const;

type ZoomLevel = (typeof ZOOM_LEVELS)[number];
type SilenceMode = (typeof SIL_OPTS)[number][0];

function loadSilenceMode(): SilenceMode {
  try {
    const saved = localStorage.getItem("silenceMode");
    if (SIL_OPTS.some(([k]) => k === saved)) return saved as SilenceMode;
    if (localStorage.getItem("skipSilence") === "1") {
      localStorage.setItem("silenceMode", "skip");
      return "skip";
    }
  } catch {}
  return "off";
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem("audioMuted") === "1";
  } catch {
    return false;
  }
}

function quietAt(sec: number, quiet: [number, number][]): [number, number] | null {
  let lo = 0;
  let hi = quiet.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const q = quiet[mid];
    if (!q) break;
    if (sec < q[0]) hi = mid - 1;
    else if (sec >= q[1]) lo = mid + 1;
    else return q;
  }
  return null;
}

function isModalOpenNow(): boolean {
  const app = useAppStore.getState();
  if (
    app.paletteOpen ||
    app.shortcutsOpen ||
    app.settingsOpen ||
    app.sidecarOpen ||
    app.ambientIntroOpen ||
    app.vpWizardOpen ||
    app.trashOpen
  ) {
    return true;
  }
  return Boolean(document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]'));
}

function findParaAt(ms: number, list: TranscriptParagraph[]): TranscriptParagraph | null {
  if (!list.length) return null;
  let lo = 0;
  let hi = list.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = list[mid];
    if (row && row.start <= ms) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  for (let i = idx; i >= Math.max(0, idx - 6); i--) {
    const p = list[i];
    if (p && ms >= p.start && ms < p.end) return p;
  }
  return null;
}

export function AudioPlayer({
  mid,
  durationHint,
  peaks,
  marks,
  segmap,
  paras,
  meeting,
  onMarkCurrent,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const hoverLineRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragModeRef = useRef<"scrub" | "select" | null>(null);
  const selAnchorRef = useRef(0);
  const draggingHandleRef = useRef<"start" | "end" | null>(null);
  const lastUiSyncRef = useRef(0);
  const lastDrawSecRef = useRef(0);
  const curSecRef = useRef(0);
  const durSecRef = useRef(durationHint || 0);
  const fastingRef = useRef(false);
  const speedRef = useRef(1);
  const silenceModeRef = useRef<SilenceMode>("off");
  const zoomRef = useRef<ZoomLevel>(1);
  const viewStartRef = useRef(0);
  const panAutoFollowRef = useRef(true);
  const rangePlayEndRef = useRef<number | null>(null);

  const resolvedTheme = useAppStore((s) => s.resolvedTheme);
  const pushToast = useAppStore((s) => s.pushToast);

  const seekRequest = useMeetingStore((s) => s.seekRequest);
  const setPlaybackState = useMeetingStore((s) => s.setPlaybackState);

  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [curSec, setCurSec] = useState(0);
  const [durSec, setDurSec] = useState(durationHint || 0);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [kickDir, setKickDir] = useState<"back" | "fwd" | null>(null);
  const [skipBadge, setSkipBadge] = useState<string | null>(null);
  const [fastRateBadge, setFastRateBadge] = useState<number | null>(null);
  const [muted, setMuted] = useState<boolean>(loadMuted);
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [viewStart, setViewStart] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [speed, setSpeed] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("playSpeed"));
      return SPEEDS.includes(saved as (typeof SPEEDS)[number]) ? saved : 1;
    } catch {
      return 1;
    }
  });
  const [silenceMode, setSilenceMode] = useState<SilenceMode>(loadSilenceMode);
  const [hoverInfo, setHoverInfo] = useState<{
    xPct: number;
    label: string;
    snippet: string;
    flipBelow: boolean;
  } | null>(null);

  durSecRef.current = durSec;
  curSecRef.current = curSec;
  speedRef.current = speed;
  silenceModeRef.current = silenceMode;
  zoomRef.current = zoom;
  viewStartRef.current = viewStart;

  const totalDur = Math.max(durSec, 0.1);
  const viewSpan = totalDur / zoom;
  const maxViewStart = Math.max(0, totalDur - viewSpan);
  const clampedViewStart = zoom <= 1 ? 0 : Math.max(0, Math.min(maxViewStart, viewStart));
  const viewEnd = Math.min(totalDur, clampedViewStart + viewSpan);
  viewStartRef.current = clampedViewStart;

  const audioSrc = `/api/meetings/${encodeURIComponent(mid)}/audio?v=${encodeURIComponent(String(durationHint || 0))}`;
  const spkMap = useMemo(() => buildSpeakerMap(meeting), [meeting]);

  const quietSecTotal = useMemo(() => {
    const quiet = peaks?.quiet || [];
    return quiet.reduce((acc, [s, e]) => acc + Math.max(0, e - s), 0);
  }, [peaks]);

  const spkSegments = useMemo(() => {
    if (!paras.length) return [];
    const out: Array<{ leftPct: number; widthPct: number; color: string }> = [];
    for (const p of paras) {
      const sSec = Math.max(0, p.start / 1000);
      const eSec = Math.max(sSec + 0.05, p.end / 1000);
      if (eSec <= clampedViewStart || sSec >= viewEnd) continue;
      const cs = Math.max(clampedViewStart, sSec);
      const ce = Math.min(viewEnd, eSec);
      const leftPct = ((cs - clampedViewStart) / viewSpan) * 100;
      const widthPct = Math.min(100 - leftPct, Math.max(0.35, ((ce - cs) / viewSpan) * 100));
      out.push({
        leftPct,
        widthPct,
        color: spkMap.spkColor(p.spk),
      });
    }
    return out;
  }, [paras, clampedViewStart, viewEnd, viewSpan, spkMap]);

  const bufferedSegments = useMemo(() => {
    if (!buffered.length) return [];
    const out: Array<{ leftPct: number; widthPct: number }> = [];
    for (const [bs, be] of buffered) {
      if (be <= clampedViewStart || bs >= viewEnd) continue;
      const cs = Math.max(clampedViewStart, bs);
      const ce = Math.min(viewEnd, be);
      const leftPct = ((cs - clampedViewStart) / viewSpan) * 100;
      const widthPct = Math.min(100 - leftPct, Math.max(0, ((ce - cs) / viewSpan) * 100));
      if (widthPct > 0) out.push({ leftPct, widthPct });
    }
    return out;
  }, [buffered, clampedViewStart, viewEnd, viewSpan]);

  const positionHead = useCallback((sec: number) => {
    const head = headRef.current;
    const canvas = canvasRef.current;
    if (!head || !canvas) return;
    const w = canvas.getBoundingClientRect().width;
    if (w <= 0) return;
    const total = Math.max(durSecRef.current, 0.1);
    const z = zoomRef.current;
    const vSpan = total / z;
    const vStart = z <= 1 ? 0 : Math.max(0, Math.min(total - vSpan, viewStartRef.current));
    const ratio = (sec - vStart) / vSpan;
    if (ratio < 0 || ratio > 1) {
      head.style.opacity = "0";
      return;
    }
    head.style.opacity = "1";
    const headX = Math.max(1, Math.min(w - 1, ratio * w));
    head.style.transform = `translate3d(${headX.toFixed(2)}px, 0, 0)`;
  }, []);

  const drawWave = useCallback(
    (overrideSec?: number, overrideDur?: number, overrideViewStart?: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const style = getComputedStyle(document.documentElement);
      const dark = resolvedTheme === "dark";
      const playedColor =
        style.getPropertyValue("--text").trim() ||
        style.getPropertyValue("--ink").trim() ||
        (dark ? "rgba(255, 255, 255, 0.9)" : "rgba(20, 20, 20, 0.9)");
      const idleColor =
        style.getPropertyValue("--line-focus").trim() ||
        style.getPropertyValue("--line").trim() ||
        (dark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.18)");
      const markColor =
        style.getPropertyValue("--warn").trim() || (dark ? "rgba(255, 159, 10, 1)" : "rgba(217, 119, 6, 1)");

      const total = Math.max(overrideDur ?? durSecRef.current, 0.1);
      const secVal = overrideSec ?? curSecRef.current;
      const z = zoom;
      const vSpan = total / z;
      const vStart =
        z <= 1 ? 0 : Math.max(0, Math.min(total - vSpan, overrideViewStart ?? viewStartRef.current));
      const vEnd = Math.min(total, vStart + vSpan);

      if (peaks?.quiet?.length && silenceMode !== "off") {
        ctx.save();
        ctx.fillStyle = dark ? "rgba(255, 159, 10, 0.16)" : "rgba(217, 119, 6, 0.12)";
        for (const [qs, qe] of peaks.quiet) {
          if (qe <= vStart || qs >= vEnd) continue;
          const cs = Math.max(vStart, qs);
          const ce = Math.min(vEnd, qe);
          const x1 = ((cs - vStart) / vSpan) * rect.width;
          const x2 = ((ce - vStart) / vSpan) * rect.width;
          ctx.fillRect(x1, 0, Math.max(1.5, x2 - x1), rect.height);
        }
        ctx.restore();
      }

      const levels = peaks?.levels;
      if (levels?.length) {
        const bars = Math.max(48, Math.floor(rect.width / 2.6));
        const step = rect.width / bars;
        const barW = Math.max(1.2, step - 1);
        const midY = rect.height / 2;

        for (let i = 0; i < bars; i++) {
          const t0 = vStart + (i / bars) * vSpan;
          const t1 = vStart + ((i + 1) / bars) * vSpan;
          const i0 = Math.max(0, Math.min(levels.length - 1, Math.floor((t0 / total) * levels.length)));
          const i1 = Math.max(i0 + 1, Math.min(levels.length, Math.ceil((t1 / total) * levels.length)));
          let peak = 0;
          for (let j = i0; j < i1; j++) {
            const val = levels[j] ?? 0;
            if (val > peak) peak = val;
          }
          const amp = Math.max(0.08, Math.min(1, peak));
          const barH = Math.max(3, amp * (rect.height - 4));
          const x = i * step;
          const y = midY - barH / 2;
          const barSec = (t0 + t1) * 0.5;
          ctx.fillStyle = barSec <= secVal ? playedColor : idleColor;
          if (typeof ctx.roundRect === "function" && barW >= 1.4) {
            ctx.beginPath();
            ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 1.5));
            ctx.fill();
          } else {
            ctx.fillRect(x, y, barW, barH);
          }
        }
      } else {
        const playedRatioInView = Math.max(0, Math.min(1, (secVal - vStart) / vSpan));
        ctx.fillStyle = idleColor;
        ctx.fillRect(0, rect.height / 2 - 2, rect.width, 4);
        ctx.fillStyle = playedColor;
        ctx.fillRect(0, rect.height / 2 - 2, rect.width * playedRatioInView, 4);
      }

      if (marks.length) {
        ctx.fillStyle = markColor;
        for (const m of marks) {
          const mSec = m.t_ms / 1000;
          if (mSec < vStart || mSec > vEnd) continue;
          const x = Math.max(2, Math.min(rect.width - 2, ((mSec - vStart) / vSpan) * rect.width));
          ctx.fillRect(x - 0.75, 0, 1.5, rect.height);
        }
      }

      ctx.restore();
      positionHead(secVal);
    },
    [peaks, marks, resolvedTheme, positionHead, silenceMode, zoom],
  );

  const stopFastSilence = useCallback(() => {
    if (!fastingRef.current) return;
    fastingRef.current = false;
    setFastRateBadge(null);
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speedRef.current;
  }, []);

  const ensureViewContains = useCallback((sec: number) => {
    const z = zoomRef.current;
    if (z <= 1) return;
    const total = Math.max(durSecRef.current, 0.1);
    const vSpan = total / z;
    const vStart = viewStartRef.current;
    const vEnd = vStart + vSpan;
    if (sec < vStart || sec > vEnd) {
      const nextStart = Math.max(0, Math.min(total - vSpan, sec - vSpan * 0.25));
      viewStartRef.current = nextStart;
      setViewStart(nextStart);
    }
  }, []);

  const applyZoom = useCallback((nextZoom: ZoomLevel, anchorSec?: number) => {
    const total = Math.max(durSecRef.current, 0.1);
    if (nextZoom <= 1) {
      zoomRef.current = 1;
      viewStartRef.current = 0;
      panAutoFollowRef.current = true;
      setZoom(1);
      setViewStart(0);
      return;
    }
    const prevSpan = total / zoomRef.current;
    const prevStart = Math.max(0, Math.min(total - prevSpan, viewStartRef.current));
    const prevEnd = prevStart + prevSpan;
    const anchor = anchorSec ?? curSecRef.current;
    const ratioInView =
      prevSpan > 0 && anchor >= prevStart && anchor <= prevEnd ? (anchor - prevStart) / prevSpan : 0.5;
    const nextSpan = total / nextZoom;
    const nextStart = Math.max(0, Math.min(total - nextSpan, anchor - ratioInView * nextSpan));
    zoomRef.current = nextZoom;
    viewStartRef.current = nextStart;
    panAutoFollowRef.current = true;
    setZoom(nextZoom);
    setViewStart(nextStart);
  }, []);

  const syncBuffered = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const out: Array<[number, number]> = [];
    try {
      for (let i = 0; i < audio.buffered.length; i++) {
        const s = audio.buffered.start(i);
        const e = audio.buffered.end(i);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
          out.push([s, e]);
        }
      }
    } catch {}
    setBuffered(out);
  }, []);

  useEffect(() => {
    drawWave(curSec, durSec, clampedViewStart);
  }, [drawWave, curSec, durSec, clampedViewStart]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => drawWave();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const ro = new ResizeObserver(() => drawWave());
    ro.observe(track);
    return () => ro.disconnect();
  }, [drawWave]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = track.getBoundingClientRect();
        const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
        const total = Math.max(durSecRef.current, 0.1);
        const vSpan = total / zoomRef.current;
        const anchor = viewStartRef.current + ratio * vSpan;
        const curIdx = ZOOM_LEVELS.indexOf(zoomRef.current);
        const nextIdx = e.deltaY < 0 ? Math.min(ZOOM_LEVELS.length - 1, curIdx + 1) : Math.max(0, curIdx - 1);
        const nextZoom = ZOOM_LEVELS[nextIdx] ?? 1;
        if (nextZoom !== zoomRef.current) applyZoom(nextZoom, anchor);
        return;
      }
      if (zoomRef.current > 1 && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) {
        e.preventDefault();
        const total = Math.max(durSecRef.current, 0.1);
        const vSpan = total / zoomRef.current;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const rect = track.getBoundingClientRect();
        const shiftSec = rect.width > 0 ? (delta / rect.width) * vSpan : 0;
        const nextStart = Math.max(0, Math.min(total - vSpan, viewStartRef.current + shiftSec));
        panAutoFollowRef.current = curSecRef.current >= nextStart && curSecRef.current <= nextStart + vSpan;
        viewStartRef.current = nextStart;
        setViewStart(nextStart);
      }
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const applySilenceTick = useCallback(
    (audio: HTMLAudioElement, sec: number): number => {
      const mode = silenceModeRef.current;
      const quiet = peaks?.quiet;
      if (
        audio.paused ||
        draggingRef.current ||
        draggingHandleRef.current ||
        mode === "off" ||
        !quiet?.length
      ) {
        stopFastSilence();
        return sec;
      }
      const q = quietAt(sec, quiet);
      if (q && mode === "skip") {
        stopFastSilence();
        if (q[1] - sec > 0.3 && q[1] - q[0] >= 0.5) {
          const maxD = Number.isFinite(audio.duration) ? audio.duration : durSecRef.current;
          const target = Math.min(maxD || q[1], q[1]);
          const jumped = target - sec;
          audio.currentTime = target;
          if (jumped >= 0.5) {
            setSkipBadge(`已跳过 ${jumped.toFixed(1)}s 停顿`);
          }
          return target;
        }
        return sec;
      }
      if (q && mode.startsWith("fast")) {
        const boost = Number(mode.slice(4));
        const targetRate = Math.max(speedRef.current, Number.isFinite(boost) ? boost : speedRef.current);
        if (!fastingRef.current || audio.playbackRate !== targetRate) {
          fastingRef.current = true;
          audio.playbackRate = targetRate;
          setFastRateBadge(targetRate);
        }
        return sec;
      }
      stopFastSilence();
      return sec;
    },
    [peaks, stopFastSilence],
  );

  // 60fps playhead loop while playing, keeping React state throttled to ~5Hz
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      if (draggingRef.current || draggingHandleRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }
      let sec = audio.currentTime;
      const rangeEnd = rangePlayEndRef.current;
      if (rangeEnd !== null && sec >= rangeEnd) {
        rangePlayEndRef.current = null;
        audio.pause();
        audio.currentTime = rangeEnd;
        curSecRef.current = rangeEnd;
        setCurSec(rangeEnd);
        positionHead(rangeEnd);
        drawWave(rangeEnd);
        setPlaybackState(rangeEnd * 1000, false);
        return;
      }

      sec = applySilenceTick(audio, sec);
      if (rangeEnd !== null && sec >= rangeEnd) {
        rangePlayEndRef.current = null;
        audio.pause();
        audio.currentTime = rangeEnd;
        curSecRef.current = rangeEnd;
        setCurSec(rangeEnd);
        positionHead(rangeEnd);
        drawWave(rangeEnd);
        setPlaybackState(rangeEnd * 1000, false);
        return;
      }

      if (zoomRef.current > 1 && panAutoFollowRef.current) {
        const total = Math.max(durSecRef.current, 0.1);
        const vSpan = total / zoomRef.current;
        const vStart = viewStartRef.current;
        const vEnd = vStart + vSpan;
        if (sec < vStart || sec > vEnd - vSpan * 0.05) {
          const nextStart = Math.max(0, Math.min(total - vSpan, sec - vSpan * 0.15));
          if (Math.abs(nextStart - vStart) > 0.01) {
            viewStartRef.current = nextStart;
            setViewStart(nextStart);
          }
        }
      }

      curSecRef.current = sec;
      positionHead(sec);

      const now = performance.now();
      if (now - lastDrawSecRef.current >= 100) {
        lastDrawSecRef.current = now;
        drawWave(sec);
      }
      if (now - lastUiSyncRef.current >= 200) {
        lastUiSyncRef.current = now;
        setCurSec(sec);
        setPlaybackState(sec * 1000, true);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, applySilenceTick, drawWave, positionHead, setPlaybackState]);

  useEffect(() => {
    if (!skipBadge) return;
    const t = setTimeout(() => setSkipBadge(null), 1300);
    return () => clearTimeout(t);
  }, [skipBadge]);

  useEffect(() => {
    if (!kickDir) return;
    const t = setTimeout(() => setKickDir(null), 180);
    return () => clearTimeout(t);
  }, [kickDir]);

  useEffect(() => {
    if (!mid) return;
    curSecRef.current = 0;
    durSecRef.current = durationHint || 0;
    fastingRef.current = false;
    rangePlayEndRef.current = null;
    panAutoFollowRef.current = true;
    zoomRef.current = 1;
    viewStartRef.current = 0;
    setFastRateBadge(null);
    setDurSec(durationHint || 0);
    setCurSec(0);
    setBuffered([]);
    setPlaying(false);
    setZoom(1);
    setViewStart(0);
    setSelectMode(false);
    setSelection(null);
    setPlaybackState(0, false);
  }, [mid, durationHint, setPlaybackState]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!fastingRef.current) {
      audio.playbackRate = speed;
    }
  }, [speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
  }, [muted]);

  useEffect(() => {
    if (!seekRequest) return;
    const audio = audioRef.current;
    if (!audio) return;
    rangePlayEndRef.current = null;
    const targetSec = Math.max(0, seekRequest.ms / 1000);
    const applySeek = () => {
      const clamped =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.min(targetSec, audio.duration)
          : targetSec;
      audio.currentTime = clamped;
      curSecRef.current = clamped;
      panAutoFollowRef.current = true;
      ensureViewContains(clamped);
      setCurSec(clamped);
      positionHead(clamped);
      setPlaybackState(clamped * 1000, !audio.paused);
      if (seekRequest.autoplay !== false) {
        void audio.play().catch(() => {});
      }
    };
    if (audio.readyState >= 1) {
      applySeek();
    } else {
      audio.addEventListener("loadedmetadata", applySeek, { once: true });
    }
  }, [seekRequest, ensureViewContains, positionHead, setPlaybackState]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      panAutoFollowRef.current = true;
      void audio.play().catch(() => {
        pushToast("当前无法播放音频，请确认音频文件完整", { tone: "error", durationMs: 3500 });
      });
    } else {
      audio.pause();
    }
  }, [pushToast]);

  const seekByDelta = useCallback(
    (deltaSec: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      rangePlayEndRef.current = null;
      const maxD = Number.isFinite(audio.duration) ? audio.duration : durSec;
      const next = Math.max(0, Math.min(maxD || 999999, audio.currentTime + deltaSec));
      audio.currentTime = next;
      curSecRef.current = next;
      panAutoFollowRef.current = true;
      ensureViewContains(next);
      setCurSec(next);
      positionHead(next);
      setPlaybackState(next * 1000, !audio.paused);
      setKickDir(deltaSec < 0 ? "back" : "fwd");
    },
    [durSec, ensureViewContains, positionHead, setPlaybackState],
  );

  const cycleSpeed = useCallback(() => {
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const nextSpeed = SPEEDS[(idx + 1) % SPEEDS.length] ?? 1;
    setSpeed(nextSpeed);
    try {
      localStorage.setItem("playSpeed", String(nextSpeed));
    } catch {}
  }, [speed]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("audioMuted", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const handleSilenceChange = useCallback(
    (nextMode: SilenceMode) => {
      setSilenceMode(nextMode);
      silenceModeRef.current = nextMode;
      try {
        localStorage.setItem("silenceMode", nextMode);
      } catch {}
      if (nextMode === "off" || nextMode === "skip") {
        stopFastSilence();
      }
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        applySilenceTick(audio, audio.currentTime);
      }
    },
    [applySilenceTick, stopFastSilence],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModalOpenNow()) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable]") ||
        target?.isContentEditable ||
        target?.closest("[data-region-handle]")
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === "Space") {
        if (target?.closest("button, a")) return;
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekByDelta(-5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekByDelta(5);
      } else if (!e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        seekByDelta(-10);
      } else if (!e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        seekByDelta(10);
      } else if (e.key === ",") {
        e.preventDefault();
        seekByDelta(-1);
      } else if (e.key === ".") {
        e.preventDefault();
        seekByDelta(1);
      } else if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
        const nextIdx =
          e.key === "["
            ? Math.max(0, (idx < 0 ? 1 : idx) - 1)
            : Math.min(SPEEDS.length - 1, (idx < 0 ? 1 : idx) + 1);
        const nextSpeed = SPEEDS[nextIdx] ?? 1;
        setSpeed(nextSpeed);
        try {
          localStorage.setItem("playSpeed", String(nextSpeed));
        } catch {}
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekByDelta, speed]);

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || draggingRef.current || draggingHandleRef.current) return;
    let sec = audio.currentTime;
    const rangeEnd = rangePlayEndRef.current;
    if (rangeEnd !== null && sec >= rangeEnd) {
      rangePlayEndRef.current = null;
      audio.pause();
      audio.currentTime = rangeEnd;
      curSecRef.current = rangeEnd;
      setCurSec(rangeEnd);
      positionHead(rangeEnd);
      setPlaybackState(rangeEnd * 1000, false);
      return;
    }
    if (!playing) {
      curSecRef.current = sec;
      setCurSec(sec);
      positionHead(sec);
      setPlaybackState(sec * 1000, false);
    } else {
      sec = applySilenceTick(audio, sec);
      curSecRef.current = sec;
    }
  };

  const computePointerState = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const total = Math.max(durSecRef.current, 0.1);
    const z = zoomRef.current;
    const vSpan = total / z;
    const vStart = z <= 1 ? 0 : Math.max(0, Math.min(total - vSpan, viewStartRef.current));
    const sec = Math.max(0, Math.min(total, vStart + ratio * vSpan));
    const ms = sec * 1000;
    const xPx = Math.max(0, Math.min(rect.width, ratio * rect.width));
    return { ratio, sec, ms, xPx, flipBelow: rect.top < 72 };
  };

  const applyHover = (clientX: number) => {
    const info = computePointerState(clientX);
    if (!info) return;
    if (hoverLineRef.current) {
      hoverLineRef.current.style.transform = `translate3d(${info.xPx.toFixed(1)}px, 0, 0)`;
    }
    const para = findParaAt(info.ms, paras);
    setHoverInfo({
      xPct: info.ratio * 100,
      label: tsLabel(info.ms, segmap),
      snippet: para?.text ? para.text.slice(0, 40) : "",
      flipBelow: info.flipBelow,
    });
  };

  const applyScrub = (clientX: number, commitAudio: boolean) => {
    const info = computePointerState(clientX);
    if (!info) return;
    rangePlayEndRef.current = null;
    curSecRef.current = info.sec;
    positionHead(info.sec);
    drawWave(info.sec);
    setCurSec(info.sec);
    setPlaybackState(info.ms, !audioRef.current?.paused);
    if (commitAudio && audioRef.current) {
      const maxD = Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : durSecRef.current;
      audioRef.current.currentTime = Math.max(0, Math.min(maxD || info.sec, info.sec));
    }
  };

  const previewSelection = useCallback(() => {
    if (!selection) return;
    const audio = audioRef.current;
    if (!audio) return;
    const startSec = Math.max(0, selection.start);
    const endSec = Math.max(startSec + 0.05, selection.end);
    rangePlayEndRef.current = endSec;
    audio.currentTime = startSec;
    curSecRef.current = startSec;
    panAutoFollowRef.current = true;
    ensureViewContains(startSec);
    setCurSec(startSec);
    positionHead(startSec);
    setPlaybackState(startSec * 1000, true);
    void audio.play().catch(() => {
      rangePlayEndRef.current = null;
      pushToast("当前无法播放音频，请确认音频文件完整", { tone: "error", durationMs: 3500 });
    });
  }, [selection, ensureViewContains, positionHead, pushToast, setPlaybackState]);

  const exportSelection = useCallback(() => {
    if (!selection) return;
    const url = `/api/meetings/${encodeURIComponent(mid)}/audio/clip?start=${selection.start.toFixed(3)}&end=${selection.end.toFixed(3)}&fmt=wav`;
    const link = document.createElement("a");
    link.href = url;
    const safeTitle = (meeting?.meta.title || mid).replace(/[\\/:*?"<>|]/g, "_").trim() || mid;
    link.download = `${safeTitle}_${Math.round(selection.start)}s-${Math.round(selection.end)}s.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [mid, meeting?.meta.title, selection]);

  const clearSelection = useCallback(() => {
    rangePlayEndRef.current = null;
    setSelection(null);
    setSelectMode(false);
  }, []);

  const hasValidSelection = Boolean(selection && selection.end - selection.start >= 0.05);
  const selStart = selection?.start ?? 0;
  const selEnd = selection?.end ?? 0;
  const selVisStart = Math.max(clampedViewStart, Math.min(viewEnd, selStart));
  const selVisEnd = Math.max(clampedViewStart, Math.min(viewEnd, selEnd));
  const selOverlayLeftPct = ((selVisStart - clampedViewStart) / viewSpan) * 100;
  const selOverlayWidthPct = Math.max(0, ((selVisEnd - selVisStart) / viewSpan) * 100);
  const startHandleLeftPct = ((selStart - clampedViewStart) / viewSpan) * 100;
  const endHandleLeftPct = ((selEnd - clampedViewStart) / viewSpan) * 100;
  const showStartHandle =
    selection !== null && selStart >= clampedViewStart - 0.001 && selStart <= viewEnd + 0.001;
  const showEndHandle = selection !== null && selEnd >= clampedViewStart - 0.001 && selEnd <= viewEnd + 0.001;

  return (
    <div className="sticky top-0 z-10 -mx-2 px-2 py-1 bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md">
      <div className="@container rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-3 py-2">
        <audio
          ref={audioRef}
          id="audio"
          src={audioSrc}
          muted={muted}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDurSec(d);
            e.currentTarget.playbackRate = speedRef.current;
            syncBuffered();
          }}
          onProgress={syncBuffered}
          onPlay={() => {
            setPlaying(true);
            setPlaybackState((audioRef.current?.currentTime || 0) * 1000, true);
          }}
          onPause={() => {
            setPlaying(false);
            stopFastSilence();
            const s = audioRef.current?.currentTime || 0;
            curSecRef.current = s;
            setCurSec(s);
            positionHead(s);
            setPlaybackState(s * 1000, false);
          }}
          onEnded={() => {
            setPlaying(false);
            stopFastSilence();
            rangePlayEndRef.current = null;
            const s = audioRef.current?.currentTime || 0;
            curSecRef.current = s;
            setCurSec(s);
            positionHead(s);
            setPlaybackState(s * 1000, false);
          }}
          onError={() => {
            setPlaying(false);
            stopFastSilence();
            rangePlayEndRef.current = null;
            pushToast("音频加载失败，请确认录音文件存在", { tone: "error", durationMs: 4000 });
          }}
          onTimeUpdate={handleTimeUpdate}
        />

        <div className="flex flex-wrap @[680px]:flex-nowrap items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "暂停播放" : "播放录音"}
            className="relative w-8 h-8 rounded-full bg-[var(--ink)] hover:opacity-90 active:scale-[0.94] text-[var(--ink-fg)] flex items-center justify-center shrink-0 cursor-pointer mr-0.5 transition-[opacity,transform] duration-150"
          >
            <Play
              className={`w-3.5 h-3.5 ml-0.5 absolute transition-[opacity,transform] duration-150 ${
                playing ? "opacity-0 scale-75" : "opacity-100 scale-100"
              }`}
            />
            <Pause
              className={`w-3.5 h-3.5 absolute transition-[opacity,transform] duration-150 ${
                playing ? "opacity-100 scale-100" : "opacity-0 scale-75"
              }`}
            />
          </button>

          <button
            type="button"
            onClick={() => seekByDelta(-15)}
            aria-label="后退 15 秒"
            title="后退 15 秒 (← -5s · J -10s · , -1s)"
            className="btn-ghost h-8 px-2 rounded-[8px] text-xs leading-[18px] font-medium num inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw
              className={`w-3.5 h-3.5 shrink-0 transition-transform duration-150 ${
                kickDir === "back" ? "-rotate-45 scale-95" : ""
              }`}
              aria-hidden="true"
            />
            <span>15s</span>
          </button>

          <button
            type="button"
            onClick={() => seekByDelta(15)}
            aria-label="前进 15 秒"
            title="前进 15 秒 (→ +5s · L +10s · . +1s)"
            className="btn-ghost h-8 px-2 rounded-[8px] text-xs leading-[18px] font-medium num inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>15s</span>
            <RotateCw
              className={`w-3.5 h-3.5 shrink-0 transition-transform duration-150 ${
                kickDir === "fwd" ? "rotate-45 scale-95" : ""
              }`}
              aria-hidden="true"
            />
          </button>

          <div className="relative num-mono text-xs leading-[18px] whitespace-nowrap shrink-0 min-w-[98px] text-center px-1">
            <span className="font-medium text-[var(--text)]">{fmtTs(curSec * 1000)}</span>
            <span className="text-[var(--muted)]"> / {fmtTs(durSec * 1000)}</span>
            {fastRateBadge !== null && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-1.5 py-0.2 text-[11px] font-sans font-medium">
                静音 ×{fastRateBadge}
              </span>
            )}
            {skipBadge && (
              <span className="mn-popover pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1.5 rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-2.5 py-0.5 text-xs leading-[18px] font-medium font-sans whitespace-nowrap shadow-[var(--shadow-2)]">
                {skipBadge}
              </span>
            )}
          </div>

          <div className="relative order-last @[680px]:order-none basis-full @[680px]:basis-auto @[680px]:flex-1 min-w-[160px] @[680px]:mx-1.5 h-9 select-none touch-none flex flex-col justify-center">
            <div
              ref={trackRef}
              className={`group relative w-full h-9 flex flex-col justify-center ${
                selectMode ? "cursor-crosshair" : "cursor-pointer"
              }`}
              role="slider"
              aria-label="音频播放进度"
              aria-valuemin={0}
              aria-valuemax={Math.round(durSec)}
              aria-valuenow={Math.round(curSec)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  e.stopPropagation();
                  seekByDelta(-5);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  seekByDelta(5);
                }
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                draggingRef.current = true;
                setDragging(true);
                applyHover(e.clientX);
                if (e.shiftKey || selectMode) {
                  dragModeRef.current = "select";
                  const info = computePointerState(e.clientX);
                  if (info) {
                    selAnchorRef.current = info.sec;
                    setSelection({ start: info.sec, end: info.sec });
                  }
                } else {
                  dragModeRef.current = "scrub";
                  applyScrub(e.clientX, false);
                }
              }}
              onPointerMove={(e) => {
                applyHover(e.clientX);
                if (!draggingRef.current) return;
                if (dragModeRef.current === "select") {
                  const info = computePointerState(e.clientX);
                  if (info) {
                    const a = selAnchorRef.current;
                    setSelection({ start: Math.min(a, info.sec), end: Math.max(a, info.sec) });
                  }
                } else {
                  applyScrub(e.clientX, false);
                }
              }}
              onPointerUp={(e) => {
                const mode = dragModeRef.current;
                dragModeRef.current = null;
                if (draggingRef.current) {
                  draggingRef.current = false;
                  setDragging(false);
                  if (mode === "select") {
                    const info = computePointerState(e.clientX);
                    const a = selAnchorRef.current;
                    const endSec = info ? info.sec : a;
                    const s = Math.min(a, endSec);
                    const en = Math.max(a, endSec);
                    if (en - s < 0.05) {
                      setSelection(null);
                    } else {
                      setSelection({ start: s, end: en });
                    }
                    return;
                  }
                  applyScrub(e.clientX, true);
                  return;
                }
                if (e.shiftKey || selectMode) return;
                applyScrub(e.clientX, true);
              }}
              onPointerCancel={() => {
                const mode = dragModeRef.current;
                dragModeRef.current = null;
                draggingRef.current = false;
                setDragging(false);
                if (mode === "select") return;
                const restoreSec = audioRef.current?.currentTime ?? curSecRef.current;
                curSecRef.current = restoreSec;
                setCurSec(restoreSec);
                positionHead(restoreSec);
                drawWave(restoreSec);
              }}
              onPointerLeave={() => {
                if (!draggingRef.current) setHoverInfo(null);
              }}
            >
              <div className="relative w-full h-[26px]">
                <canvas ref={canvasRef} className="w-full h-full block" />
                {bufferedSegments.length > 0 && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] rounded-full bg-[var(--fill)] overflow-hidden"
                  >
                    {bufferedSegments.map((seg, i) => (
                      <i
                        key={i}
                        className="absolute top-0 bottom-0 bg-[var(--muted)]/55"
                        style={{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%` }}
                      />
                    ))}
                  </div>
                )}
                <div
                  ref={hoverLineRef}
                  aria-hidden="true"
                  className={`pointer-events-none absolute top-0 bottom-0 left-0 w-px bg-[var(--muted)] transition-opacity duration-150 ${
                    hoverInfo ? "opacity-55" : "opacity-0"
                  }`}
                />
                <div
                  ref={headRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 bottom-0 left-0 w-[2px] -ml-px bg-[var(--ink)] will-change-transform"
                >
                  <span
                    className={`block w-2.5 h-2.5 -ml-1 -mt-1 rounded-full bg-[var(--ink)] shadow-xs transition-transform duration-150 ${
                      dragging ? "scale-125" : "scale-0 group-hover:scale-100"
                    }`}
                  />
                </div>
              </div>

              {spkSegments.length > 0 && (
                <div className="relative h-[3px] w-full rounded-full overflow-hidden mt-1 bg-[var(--fill)]">
                  {spkSegments.map((seg, i) => (
                    <i
                      key={i}
                      className="absolute top-0 bottom-0 opacity-75"
                      style={{
                        left: `${seg.leftPct}%`,
                        width: `${seg.widthPct}%`,
                        backgroundColor: seg.color,
                      }}
                    />
                  ))}
                </div>
              )}

              {hoverInfo && (
                <div
                  className={`mn-popover pointer-events-none absolute -translate-x-1/2 rounded-[8px] bg-[var(--ink)] text-[var(--ink-fg)] px-2.5 py-1 text-xs leading-[18px] whitespace-nowrap max-w-[260px] truncate shadow-[var(--shadow-3)] ${
                    hoverInfo.flipBelow ? "top-10 origin-top" : "-top-8 origin-bottom"
                  }`}
                  style={{ left: `${Math.max(8, Math.min(92, hoverInfo.xPct))}%` }}
                >
                  <span className="num-mono">{hoverInfo.label}</span>
                  {hoverInfo.snippet ? ` · ${hoverInfo.snippet}` : ""}
                </div>
              )}
            </div>

            {selection && (
              <div className="pointer-events-none absolute inset-x-0 top-0 h-[26px]">
                {selOverlayWidthPct > 0 && (
                  <div
                    className="absolute top-0 bottom-0 bg-[var(--brand-soft)] border-x border-[var(--brand)]/65"
                    style={{
                      left: `${selOverlayLeftPct}%`,
                      width: `${selOverlayWidthPct}%`,
                    }}
                  />
                )}
                {showStartHandle && (
                  <div
                    data-region-handle="start"
                    role="slider"
                    aria-label="选区起点"
                    aria-valuemin={0}
                    aria-valuemax={Number(selEnd.toFixed(2))}
                    aria-valuenow={Number(selStart.toFixed(2))}
                    tabIndex={0}
                    className="pointer-events-auto absolute top-0 bottom-0 w-2.5 -ml-1.25 cursor-ew-resize flex items-center justify-center focus:outline-none group/h"
                    style={{ left: `${startHandleLeftPct}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      draggingHandleRef.current = "start";
                    }}
                    onPointerMove={(e) => {
                      if (draggingHandleRef.current !== "start") return;
                      const info = computePointerState(e.clientX);
                      if (!info) return;
                      setSelection((prev) =>
                        prev
                          ? { start: Math.max(0, Math.min(prev.end - 0.05, info.sec)), end: prev.end }
                          : null,
                      );
                    }}
                    onPointerUp={() => {
                      draggingHandleRef.current = null;
                    }}
                    onPointerCancel={() => {
                      draggingHandleRef.current = null;
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                      e.preventDefault();
                      e.stopPropagation();
                      const step = e.shiftKey ? 2 : 0.5;
                      const delta = e.key === "ArrowLeft" ? -step : step;
                      setSelection((prev) =>
                        prev
                          ? {
                              start: Math.max(0, Math.min(prev.end - 0.05, prev.start + delta)),
                              end: prev.end,
                            }
                          : null,
                      );
                    }}
                  >
                    <span className="w-1 h-4 rounded-full bg-[var(--brand)] shadow-xs group-focus/h:ring-2 group-focus/h:ring-[var(--brand-ring)]" />
                  </div>
                )}
                {showEndHandle && (
                  <div
                    data-region-handle="end"
                    role="slider"
                    aria-label="选区终点"
                    aria-valuemin={Number(selStart.toFixed(2))}
                    aria-valuemax={Number(totalDur.toFixed(2))}
                    aria-valuenow={Number(selEnd.toFixed(2))}
                    tabIndex={0}
                    className="pointer-events-auto absolute top-0 bottom-0 w-2.5 -ml-1.25 cursor-ew-resize flex items-center justify-center focus:outline-none group/h"
                    style={{ left: `${endHandleLeftPct}%` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      draggingHandleRef.current = "end";
                    }}
                    onPointerMove={(e) => {
                      if (draggingHandleRef.current !== "end") return;
                      const info = computePointerState(e.clientX);
                      if (!info) return;
                      setSelection((prev) =>
                        prev
                          ? {
                              start: prev.start,
                              end: Math.min(totalDur, Math.max(prev.start + 0.05, info.sec)),
                            }
                          : null,
                      );
                    }}
                    onPointerUp={() => {
                      draggingHandleRef.current = null;
                    }}
                    onPointerCancel={() => {
                      draggingHandleRef.current = null;
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                      e.preventDefault();
                      e.stopPropagation();
                      const step = e.shiftKey ? 2 : 0.5;
                      const delta = e.key === "ArrowLeft" ? -step : step;
                      setSelection((prev) =>
                        prev
                          ? {
                              start: prev.start,
                              end: Math.min(totalDur, Math.max(prev.start + 0.05, prev.end + delta)),
                            }
                          : null,
                      );
                    }}
                  >
                    <span className="w-1 h-4 rounded-full bg-[var(--brand)] shadow-xs group-focus/h:ring-2 group-focus/h:ring-[var(--brand-ring)]" />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 ml-auto @[680px]:ml-0 shrink-0">
            <select
              aria-label="静音处理"
              value={silenceMode}
              onChange={(e) => {
                handleSilenceChange(e.target.value as SilenceMode);
                e.currentTarget.blur();
              }}
              title={
                quietSecTotal >= 1
                  ? `静音处理（共约 ${Math.round(quietSecTotal)} 秒停顿）`
                  : "静音处理：安静片段加速带过或直接跳过"
              }
              className="rounded-[8px] h-8 px-2 text-xs leading-[18px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text-2)] hover:text-[var(--text)] cursor-pointer transition-colors"
            >
              {SIL_OPTS.map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={cycleSpeed}
              title="切换播放倍速 ([ / ])"
              className="rounded-[8px] h-8 min-w-[46px] px-2.5 text-xs leading-[18px] font-medium num-mono bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text-2)] hover:text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <span className="sr-only">播放倍速 </span>
              {speed}×
            </button>

            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              aria-label={muted ? "取消静音" : "静音"}
              title={muted ? "取消静音" : "静音"}
              className={`w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
                muted
                  ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                  : "btn-ghost text-[var(--text-2)] hover:text-[var(--text)]"
              }`}
            >
              {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>

            <button
              type="button"
              onClick={() => setSelectMode((v) => !v)}
              aria-pressed={selectMode}
              title="选区模式：拖动波形截取片段（或按住 Shift 拖动）"
              className={`rounded-[8px] h-8 px-2 text-xs leading-[18px] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                selectMode
                  ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                  : "bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text-2)] hover:text-[var(--text)]"
              }`}
            >
              <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
              <span>选区</span>
            </button>

            <button
              type="button"
              onClick={() => onMarkCurrent(Math.round(curSec * 1000))}
              title="在当前播放时刻打个点"
              aria-label="在当前时刻打点"
              className="btn-ghost w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <Flag className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-1.5 pt-1.5 border-t border-[var(--line-2)] flex flex-wrap items-center justify-between gap-2 text-xs leading-[18px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[var(--muted)]">缩放</span>
            <div className="inline-flex items-center rounded-[7px] bg-[var(--fill)] p-0.5 gap-0.5">
              {ZOOM_LEVELS.map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => applyZoom(z)}
                  aria-pressed={zoom === z}
                  className={`h-6 px-1.5 rounded-[5px] text-[11px] font-medium num-mono cursor-pointer transition-colors ${
                    zoom === z
                      ? "bg-[var(--surface)] text-[var(--text)] shadow-xs"
                      : "text-[var(--text-2)] hover:text-[var(--text)]"
                  }`}
                >
                  {z}×
                </button>
              ))}
            </div>

            {zoom > 1 && (
              <div className="flex items-center gap-2 ml-1">
                <input
                  type="range"
                  aria-label="波形平移"
                  min={0}
                  max={maxViewStart}
                  step={Math.max(0.01, viewSpan / 200)}
                  value={clampedViewStart}
                  onChange={(e) => {
                    const nextStart = Number(e.currentTarget.value);
                    panAutoFollowRef.current =
                      curSecRef.current >= nextStart && curSecRef.current <= nextStart + viewSpan;
                    viewStartRef.current = nextStart;
                    setViewStart(nextStart);
                  }}
                  className="w-28 sm:w-36 accent-[var(--ink)] cursor-pointer"
                />
                <span className="num-mono text-[11px] text-[var(--muted)] whitespace-nowrap">
                  {fmtTs(clampedViewStart * 1000)} – {fmtTs(viewEnd * 1000)}
                </span>
              </div>
            )}
          </div>

          {hasValidSelection && (
            <div className="flex flex-wrap items-center gap-1.5 ml-auto">
              <span className="num-mono text-[11px] text-[var(--text-2)] px-1">
                {fmtTs(selStart * 1000)} – {fmtTs(selEnd * 1000)}
              </span>
              <button
                type="button"
                onClick={previewSelection}
                className="rounded-[7px] h-6 px-2 text-xs font-medium bg-[var(--brand-soft)] text-[var(--brand)] hover:opacity-90 cursor-pointer transition-opacity"
              >
                试听选区
              </button>
              <button
                type="button"
                onClick={exportSelection}
                className="rounded-[7px] h-6 px-2 text-xs font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] cursor-pointer transition-colors"
              >
                导出片段
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="btn-ghost rounded-[7px] h-6 px-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
              >
                清除
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
