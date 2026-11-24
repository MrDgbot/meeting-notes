import { buildSpeakerMap, fmtTs, tsLabel } from "@shared/format";
import type { AudioPeaks, MarkItem, MeetingDetail, SegMapEntry, TranscriptParagraph } from "@shared/types";
import { Flag, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
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
  const lastUiSyncRef = useRef(0);
  const lastDrawSecRef = useRef(0);
  const curSecRef = useRef(0);
  const durSecRef = useRef(durationHint || 0);

  const resolvedTheme = useAppStore((s) => s.resolvedTheme);
  const pushToast = useAppStore((s) => s.pushToast);

  const seekRequest = useMeetingStore((s) => s.seekRequest);
  const setPlaybackState = useMeetingStore((s) => s.setPlaybackState);

  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [curSec, setCurSec] = useState(0);
  const [durSec, setDurSec] = useState(durationHint || 0);
  const [kickDir, setKickDir] = useState<"back" | "fwd" | null>(null);
  const [skipBadge, setSkipBadge] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("playSpeed"));
      return SPEEDS.includes(saved as (typeof SPEEDS)[number]) ? saved : 1;
    } catch {
      return 1;
    }
  });
  const [skipSilence, setSkipSilence] = useState<boolean>(() => {
    try {
      return localStorage.getItem("skipSilence") === "1";
    } catch {
      return false;
    }
  });
  const [hoverInfo, setHoverInfo] = useState<{
    xPct: number;
    label: string;
    snippet: string;
    flipBelow: boolean;
  } | null>(null);

  durSecRef.current = durSec;
  curSecRef.current = curSec;

  const audioSrc = `/api/meetings/${encodeURIComponent(mid)}/audio`;
  const spkMap = useMemo(() => buildSpeakerMap(meeting), [meeting]);

  const quietSecTotal = useMemo(() => {
    const quiet = peaks?.quiet || [];
    return quiet.reduce((acc, [s, e]) => acc + Math.max(0, e - s), 0);
  }, [peaks]);

  const spkSegments = useMemo(() => {
    const total = Math.max(durSec, 0.1);
    if (!paras.length) return [];
    const out: Array<{ leftPct: number; widthPct: number; color: string }> = [];
    for (const p of paras) {
      const sSec = Math.max(0, p.start / 1000);
      const eSec = Math.max(sSec + 0.05, p.end / 1000);
      const leftPct = (sSec / total) * 100;
      const widthPct = Math.min(100 - leftPct, Math.max(0.35, ((eSec - sSec) / total) * 100));
      out.push({
        leftPct,
        widthPct,
        color: spkMap.spkColor(p.spk),
      });
    }
    return out;
  }, [paras, durSec, spkMap]);

  const positionHead = useCallback((sec: number) => {
    const head = headRef.current;
    const canvas = canvasRef.current;
    if (!head || !canvas) return;
    const w = canvas.getBoundingClientRect().width;
    if (w <= 0) return;
    const total = Math.max(durSecRef.current, 0.1);
    const ratio = Math.max(0, Math.min(1, sec / total));
    const headX = Math.max(1, Math.min(w - 1, ratio * w));
    head.style.transform = `translate3d(${headX.toFixed(2)}px, 0, 0)`;
  }, []);

  const drawWave = useCallback(
    (overrideSec?: number, overrideDur?: number) => {
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
      const playedColor = style.getPropertyValue("--ink").trim() || (dark ? "#ededed" : "#171717");
      const idleColor =
        style.getPropertyValue("--line").trim() || (dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.16)");
      const markColor = style.getPropertyValue("--amber").trim() || (dark ? "#fbbf24" : "#92400e");

      const total = Math.max(overrideDur ?? durSecRef.current, 0.1);
      const secVal = overrideSec ?? curSecRef.current;
      const curRatio = Math.max(0, Math.min(1, secVal / total));

      const levels = peaks?.levels;
      if (levels?.length) {
        const bars = Math.min(levels.length, Math.max(48, Math.floor(rect.width / 2.6)));
        const step = rect.width / bars;
        const barW = Math.max(1.2, step - 1);
        const midY = rect.height / 2;

        for (let i = 0; i < bars; i++) {
          const srcIdx = Math.min(levels.length - 1, Math.floor((i / bars) * levels.length));
          const amp = Math.max(0.08, Math.min(1, levels[srcIdx] ?? 0.1));
          const barH = Math.max(3, amp * (rect.height - 4));
          const x = i * step;
          const ratio = (i + 0.5) / bars;
          ctx.fillStyle = ratio <= curRatio ? playedColor : idleColor;
          ctx.fillRect(x, midY - barH / 2, barW, barH);
        }
      } else {
        ctx.fillStyle = idleColor;
        ctx.fillRect(0, rect.height / 2 - 2, rect.width, 4);
        ctx.fillStyle = playedColor;
        ctx.fillRect(0, rect.height / 2 - 2, rect.width * curRatio, 4);
      }

      if (peaks?.quiet?.length && skipSilence) {
        ctx.fillStyle = dark ? "rgba(251, 191, 36, 0.45)" : "rgba(180, 83, 9, 0.45)";
        for (const [qs] of peaks.quiet) {
          const x = Math.max(0, Math.min(rect.width - 1.5, (qs / total) * rect.width));
          ctx.fillRect(x, 0, 1.5, rect.height);
        }
      }

      if (marks.length) {
        ctx.fillStyle = markColor;
        for (const m of marks) {
          const x = Math.max(2, Math.min(rect.width - 2, (m.t_ms / 1000 / total) * rect.width));
          ctx.fillRect(x - 0.75, 0, 1.5, rect.height);
        }
      }

      ctx.restore();
      positionHead(secVal);
    },
    [peaks, marks, skipSilence, resolvedTheme, positionHead],
  );

  useEffect(() => {
    drawWave(curSec, durSec);
  }, [drawWave, curSec, durSec]);

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

  // 60fps playhead loop while playing, keeping React state throttled to ~5Hz
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      if (draggingRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }
      let sec = audio.currentTime;
      if (skipSilence && peaks?.quiet?.length) {
        for (const [qs, qe] of peaks.quiet) {
          if (sec >= qs + 0.15 && sec < qe - 0.15 && qe - qs >= 0.8) {
            const jumped = qe - sec;
            audio.currentTime = qe;
            sec = qe;
            if (jumped >= 0.8) {
              setSkipBadge(`已跳过 ${jumped.toFixed(1)}s 停顿`);
            }
            break;
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
  }, [playing, skipSilence, peaks, drawWave, positionHead, setPlaybackState]);

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
    setDurSec(durationHint || 0);
    setCurSec(0);
    setPlaying(false);
    setPlaybackState(0, false);
  }, [mid, durationHint, setPlaybackState]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    if (!seekRequest) return;
    const audio = audioRef.current;
    if (!audio) return;
    const targetSec = Math.max(0, seekRequest.ms / 1000);
    const applySeek = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Math.min(targetSec, audio.duration);
      } else {
        audio.currentTime = targetSec;
      }
      curSecRef.current = targetSec;
      setCurSec(targetSec);
      positionHead(targetSec);
      setPlaybackState(targetSec * 1000, !audio.paused);
      if (seekRequest.autoplay !== false) {
        void audio.play().catch(() => {});
      }
    };
    if (audio.readyState >= 1) {
      applySeek();
    } else {
      audio.addEventListener("loadedmetadata", applySeek, { once: true });
    }
  }, [seekRequest, positionHead, setPlaybackState]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
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
      const maxD = Number.isFinite(audio.duration) ? audio.duration : durSec;
      const next = Math.max(0, Math.min(maxD || 999999, audio.currentTime + deltaSec));
      audio.currentTime = next;
      curSecRef.current = next;
      setCurSec(next);
      positionHead(next);
      setPlaybackState(next * 1000, !audio.paused);
      setKickDir(deltaSec < 0 ? "back" : "fwd");
    },
    [durSec, positionHead, setPlaybackState],
  );

  const cycleSpeed = useCallback(() => {
    const idx = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
    const nextSpeed = SPEEDS[(idx + 1) % SPEEDS.length] ?? 1;
    setSpeed(nextSpeed);
    try {
      localStorage.setItem("playSpeed", String(nextSpeed));
    } catch {}
  }, [speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const app = useAppStore.getState();
      if (
        app.paletteOpen ||
        app.shortcutsOpen ||
        app.settingsOpen ||
        app.sidecarOpen ||
        app.ambientIntroOpen ||
        app.vpWizardOpen
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
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
    if (!audio || playing || draggingRef.current) return;
    const sec = audio.currentTime;
    curSecRef.current = sec;
    setCurSec(sec);
    positionHead(sec);
    setPlaybackState(sec * 1000, false);
  };

  const computePointerState = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const total = Math.max(durSecRef.current, 0.1);
    const sec = ratio * total;
    const ms = sec * 1000;
    const xPx = Math.max(0, Math.min(rect.width, ratio * rect.width));
    return { ratio, sec, ms, xPx, flipBelow: rect.top < 46 };
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

  return (
    <div className="@container sticky top-0 z-10 -mx-3.5 px-3.5 py-2 mb-2 bg-[var(--glass)] backdrop-blur-md">
      {/* biome-ignore lint/a11y/useMediaCaption: local meeting recording audio has interactive transcript */}
      <audio
        ref={audioRef}
        id="audio"
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDurSec(d);
        }}
        onPlay={() => {
          setPlaying(true);
          setPlaybackState((audioRef.current?.currentTime || 0) * 1000, true);
        }}
        onPause={() => {
          setPlaying(false);
          const s = audioRef.current?.currentTime || 0;
          curSecRef.current = s;
          setCurSec(s);
          positionHead(s);
          setPlaybackState(s * 1000, false);
        }}
        onEnded={() => {
          setPlaying(false);
          const s = audioRef.current?.currentTime || 0;
          curSecRef.current = s;
          setCurSec(s);
          positionHead(s);
          setPlaybackState(s * 1000, false);
        }}
        onError={() => {
          setPlaying(false);
          pushToast("音频加载失败，请确认录音文件存在", { tone: "error", durationMs: 4000 });
        }}
        onTimeUpdate={handleTimeUpdate}
      />

      <div className="flex flex-wrap @[540px]:flex-nowrap items-center gap-1.5">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "暂停播放" : "播放录音"}
          className="relative w-9 h-9 rounded-full bg-[var(--ink)] hover:bg-[var(--ink-hover)] active:scale-[0.94] text-[var(--ink-inv)] flex items-center justify-center shrink-0 cursor-pointer mr-0.5 transition-[background-color,transform] duration-150"
        >
          <Play
            className={`w-4 h-4 ml-0.5 absolute transition-[opacity,transform] duration-150 ${
              playing ? "opacity-0 scale-75" : "opacity-100 scale-100"
            }`}
          />
          <Pause
            className={`w-4 h-4 absolute transition-[opacity,transform] duration-150 ${
              playing ? "opacity-100 scale-100" : "opacity-0 scale-75"
            }`}
          />
        </button>

        <button
          type="button"
          onClick={() => seekByDelta(-15)}
          aria-label="后退 15 秒"
          title="后退 15 秒 (←)"
          className="relative btn-ghost w-8 h-8 rounded-full flex items-center justify-center shrink-0 cursor-pointer"
        >
          <RotateCcw
            className={`w-[18px] h-[18px] transition-transform duration-150 ${
              kickDir === "back" ? "-rotate-45 scale-95" : ""
            }`}
            aria-hidden="true"
          />
          <span className="absolute text-[8px] font-bold leading-none mt-0.5">15</span>
        </button>

        <button
          type="button"
          onClick={() => seekByDelta(15)}
          aria-label="前进 15 秒"
          title="前进 15 秒 (→)"
          className="relative btn-ghost w-8 h-8 rounded-full flex items-center justify-center shrink-0 cursor-pointer"
        >
          <RotateCw
            className={`w-[18px] h-[18px] transition-transform duration-150 ${
              kickDir === "fwd" ? "rotate-45 scale-95" : ""
            }`}
            aria-hidden="true"
          />
          <span className="absolute text-[8px] font-bold leading-none mt-0.5">15</span>
        </button>

        <div className="relative font-mono text-xs num whitespace-nowrap min-w-[96px] text-center px-1">
          <span className="font-medium text-[var(--text)]">{fmtTs(curSec * 1000)}</span>
          <span className="text-[var(--muted)]"> / {fmtTs(durSec * 1000)}</span>
          {skipBadge && (
            <span className="mn-popover pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1 rounded-full bg-[var(--amber-weak)] text-[var(--amber)] px-2 py-0.5 text-[10.5px] font-sans whitespace-nowrap shadow-[var(--shadow-1)]">
              {skipBadge}
            </span>
          )}
        </div>

        <div
          ref={trackRef}
          className="group relative order-last @[540px]:order-none basis-full @[540px]:basis-auto @[540px]:flex-1 min-w-[160px] @[540px]:mx-1.5 h-9 cursor-pointer select-none touch-none flex flex-col justify-center"
          role="slider"
          aria-label="音频播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(durSec)}
          aria-valuenow={Math.round(curSec)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              seekByDelta(-5);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
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
            applyScrub(e.clientX, false);
          }}
          onPointerMove={(e) => {
            applyHover(e.clientX);
            if (draggingRef.current) {
              applyScrub(e.clientX, false);
            }
          }}
          onPointerUp={(e) => {
            if (draggingRef.current) {
              draggingRef.current = false;
              setDragging(false);
              applyScrub(e.clientX, true);
              return;
            }
            applyScrub(e.clientX, true);
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
            setDragging(false);
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
          <div className="relative w-full h-[28px]">
            <canvas ref={canvasRef} className="w-full h-full block" />
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
            <div className="relative h-[3px] w-full rounded-full overflow-hidden mt-0.5 bg-[var(--fill)]">
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
              className={`mn-popover pointer-events-none absolute -translate-x-1/2 rounded-[6px] bg-[var(--ink)] text-[var(--ink-inv)] px-2 py-0.5 text-[11px] font-mono num whitespace-nowrap max-w-[240px] truncate shadow-[var(--shadow-pop)] ${
                hoverInfo.flipBelow ? "top-10 origin-top" : "-top-7 origin-bottom"
              }`}
              style={{ left: `${Math.max(8, Math.min(92, hoverInfo.xPct))}%` }}
            >
              {hoverInfo.label}
              {hoverInfo.snippet ? ` · ${hoverInfo.snippet}` : ""}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 ml-auto @[540px]:ml-0 shrink-0">
          {quietSecTotal >= 5 && (
            <button
              type="button"
              onClick={() => {
                const next = !skipSilence;
                setSkipSilence(next);
                try {
                  localStorage.setItem("skipSilence", next ? "1" : "0");
                } catch {}
              }}
              aria-pressed={skipSilence}
              title={`跳过空白停顿（可省约 ${Math.round(quietSecTotal)} 秒）`}
              className={`rounded-full h-7 min-w-[82px] px-2.5 text-xs shrink-0 cursor-pointer transition-colors duration-150 ${
                skipSilence
                  ? "bg-[var(--ink)] text-[var(--ink-inv)] font-medium"
                  : "bg-[var(--surface)] shadow-[var(--shadow-1)] text-[var(--text-2)] hover:text-[var(--text)]"
              }`}
            >
              {skipSilence ? "已跳过停顿" : "跳过停顿"}
            </button>
          )}

          <button
            type="button"
            onClick={cycleSpeed}
            title="切换播放倍速 ([ / ])"
            className="rounded-full h-7 min-w-[40px] px-2 text-xs font-mono num bg-[var(--surface)] shadow-[var(--shadow-1)] text-[var(--text-2)] hover:text-[var(--text)] shrink-0 cursor-pointer transition-colors"
          >
            <span className="sr-only">播放倍速 </span>
            {speed}×
          </button>

          <button
            type="button"
            onClick={() => onMarkCurrent(Math.round(curSec * 1000))}
            title="在当前播放时刻打个点"
            aria-label="在当前时刻打点"
            className="btn-ghost w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer"
          >
            <Flag className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
