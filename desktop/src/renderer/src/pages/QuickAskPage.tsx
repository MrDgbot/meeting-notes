import type { GlobalAskCitation, GlobalAskResponse } from "@shared/types";
import { ArrowUp, ExternalLink, Loader2, Play, Sparkles, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { CopyButton, SkeletonLines } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

const PRESET_QUERIES = [
  "上周答应给客户的方案",
  "近期反复提到的风险或问题",
  "尚未完成的待办和截止时间",
] as const;

export function QuickAskPage() {
  const navigate = useAppStore((s) => s.navigate);
  const provId = useAppStore((s) => s.provId);
  const pushToast = useAppStore((s) => s.pushToast);

  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GlobalAskResponse | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const queryRef = useRef(query);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFloatingWindow = typeof window !== "undefined" && Boolean(window.desktopAPI);

  queryRef.current = query;

  const stopAudio = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    }
    setPlayingKey(null);
  }, []);

  const closeWindow = useCallback(() => {
    stopAudio();
    if (window.desktopAPI) {
      window.desktopAPI.hideQuickAsk();
    } else {
      navigate("#/");
    }
  }, [navigate, stopAudio]);

  useEffect(() => {
    if (window.desktopAPI) {
      document.documentElement.dataset.window = "quick-ask";
    }
    setTimeout(() => inputRef.current?.focus(), 30);
    const unsubFocus = window.desktopAPI?.onQuickAskFocus(() => {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 20);
    });
    const unsubHidden = window.desktopAPI?.onQuickAskHidden(() => {
      stopAudio();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (queryRef.current.trim()) {
          setQuery("");
          setResult(null);
          stopAudio();
          inputRef.current?.focus();
        } else {
          closeWindow();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      delete document.documentElement.dataset.window;
      window.removeEventListener("keydown", onKey);
      unsubFocus?.();
      unsubHidden?.();
      stopAudio();
    };
  }, [closeWindow, stopAudio]);

  useEffect(() => {
    if (!window.desktopAPI?.resizeQuickAsk) return;
    const targetH = loading || result ? 520 : 250;
    window.desktopAPI.resizeQuickAsk(targetH);
  }, [loading, result]);

  const handleAsk = async (raw?: string) => {
    const q = (raw ?? query).trim();
    if (!q || loading) return;
    stopAudio();
    setLoading(true);
    try {
      const res = await api<GlobalAskResponse>("/api/ask-global", {
        method: "POST",
        body: { q, ...(provId ? { provider: provId } : {}) },
      });
      setResult(res);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "全局闪问失败", 4000);
    } finally {
      setLoading(false);
    }
  };

  const togglePlayCitation = (c: GlobalAskCitation, idx: number) => {
    const key = `${c.mid}:${c.start_ms}:${idx}`;
    if (playingKey === key) {
      stopAudio();
      return;
    }
    stopAudio();

    const startSec = Math.max(0, c.start_ms / 1000);
    const clipEndSec = startSec + 6.0;
    const audio = new Audio(`/api/meetings/${encodeURIComponent(c.mid)}/audio`);
    audioRef.current = audio;
    setPlayingKey(key);

    let seekApplied = false;
    audio.ontimeupdate = () => {
      if (audio.currentTime >= clipEndSec) stopAudio();
    };
    audio.onended = () => stopAudio();
    audio.onerror = () => {
      stopAudio();
      pushToast("音频片段加载失败", 2500);
    };

    const startPlayback = () => {
      if (!seekApplied && startSec > 0 && Number.isFinite(audio.duration)) {
        try {
          audio.currentTime = Math.min(startSec, Math.max(0, audio.duration - 0.5));
          seekApplied = true;
        } catch {}
      }
      stopTimerRef.current = setTimeout(() => stopAudio(), 6500);
      void audio.play().catch(() => {
        stopAudio();
        pushToast("无法播放音频片段", 2500);
      });
    };

    if (audio.readyState >= 1) {
      startPlayback();
    } else {
      audio.onloadedmetadata = startPlayback;
    }
  };

  const openCitation = (c: GlobalAskCitation) => {
    stopAudio();
    const sec = Math.max(0, Math.floor((c.start_ms || 0) / 1000));
    if (window.desktopAPI) {
      void window.desktopAPI.openMeetingFromQuickAsk(c.mid, sec);
    } else {
      navigate(`#/m/${c.mid}?t=${sec}`);
    }
  };

  const composer = (
    <div className="max-w-[800px] mx-auto w-full bg-[var(--surface-elev)] border border-[var(--line)] focus-within:border-[var(--line-focus)] rounded-[20px] shadow-[var(--shadow-2)] px-4 py-3.5 transition-colors app-no-drag">
      <textarea
        ref={inputRef}
        rows={isFloatingWindow ? 2 : 3}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void handleAsk();
          }
        }}
        placeholder="问所有历史会议：如 上周谁负责跟进方案？"
        aria-label="跨会议提问"
        className="w-full !bg-transparent hover:!bg-transparent focus:!bg-transparent !border-0 focus:!border-0 !shadow-none focus:!shadow-none !rounded-none !p-0 outline-none resize-none text-[15px] leading-[24px] text-[var(--text)] placeholder:text-[var(--muted)]"
      />

      <div className="flex items-center justify-between gap-2 pt-2.5">
        <div className="flex items-center gap-2 text-xs leading-[18px] text-[var(--muted)]">
          <span>Enter 发送 · Shift+Enter 换行</span>
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="清空输入"
              className="btn-ghost rounded-[6px] px-2 h-7 text-xs leading-[18px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <X className="w-3 h-3" aria-hidden="true" />
              <span>清空</span>
            </button>
          )}
        </div>

        <button
          type="button"
          disabled={loading || !query.trim()}
          onClick={() => void handleAsk()}
          aria-label={loading ? "检索中" : "发送提问"}
          title={loading ? "检索中…" : "发送提问 (Enter)"}
          className="w-8 h-8 rounded-full bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] inline-flex items-center justify-center shrink-0 cursor-pointer transition-colors duration-150 active:scale-95 disabled:opacity-40"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );

  const resultsContent = (
    <div className="max-w-[800px] mx-auto w-full space-y-4">
      {!result && !loading && (
        <div className="pt-1 text-center space-y-3">
          {!isFloatingWindow && (
            <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0">
              试试直接提问，快速定位结论、原声片段和来源时间戳
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {PRESET_QUERIES.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  setQuery(preset);
                  void handleAsk(preset);
                }}
                className="btn-secondary rounded-full px-3.5 h-8 text-[13px] leading-[20px] text-[var(--text-2)] hover:text-[var(--text)] cursor-pointer"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 space-y-3">
          <div className="text-[13px] leading-[20px] text-[var(--muted)]">正在检索全部会议记忆…</div>
          <SkeletonLines lines={3} />
        </div>
      )}

      {result && !loading && (
        <>
          <section className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 sm:p-6 space-y-3.5">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-[var(--line-2)]">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[15px] leading-[22px] font-semibold text-[var(--text)] whitespace-nowrap shrink-0">
                  回答结论
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 ${
                    result.mode === "llm"
                      ? "bg-[var(--fill)] text-[var(--text)]"
                      : "bg-[var(--fill)] text-[var(--text-2)]"
                  }`}
                >
                  {result.mode === "llm" ? "AI 归纳" : "本机检索"}
                </span>
              </div>
              <CopyButton text={result.answer} label="复制" successToast="已复制回答结论" size="sm" />
            </div>
            <MarkdownView markdown={result.answer} />
          </section>

          {result.citations.length > 0 && (
            <section className="space-y-2.5">
              <div className="text-xs leading-[18px] font-medium text-[var(--muted)] num">
                原声依据（{result.citations.length} 条）
              </div>
              {result.citations.map((c, idx) => {
                const key = `${c.mid}:${c.start_ms}:${idx}`;
                const playing = playingKey === key;
                return (
                  <div
                    key={key}
                    className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-4 py-3.5 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="font-mono tabular-nums text-xs leading-[18px] font-medium px-2 py-0.5 rounded-[6px] bg-[var(--fill)] text-[var(--text)] whitespace-nowrap shrink-0">
                          [{idx + 1}]
                        </span>
                        <span className="text-sm leading-[22px] font-medium text-[var(--text)] truncate">
                          {c.title}
                        </span>
                        <span className="text-xs leading-[18px] text-[var(--muted)] whitespace-nowrap shrink-0 num">
                          {c.created.slice(0, 10)} [{c.ts}]
                        </span>
                        {c.speaker && (
                          <span className="text-xs leading-[18px] text-[var(--text-2)] whitespace-nowrap shrink-0">
                            · {c.speaker}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => togglePlayCitation(c, idx)}
                          title={playing ? "停止试听" : "试听约 5 秒原声片段"}
                          className={`rounded-[8px] px-2.5 h-7 text-xs leading-[18px] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                            playing ? "bg-[var(--fill)] text-[var(--text)]" : "btn-ghost"
                          }`}
                        >
                          {playing ? (
                            <>
                              <Square className="w-3 h-3" aria-hidden="true" />
                              <span>停止</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3" aria-hidden="true" />
                              <span>试听</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => openCitation(c)}
                          className="btn-secondary rounded-[8px] px-2.5 h-7 text-xs leading-[18px] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>跳到原处</span>
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <p className="text-[13px] leading-[20px] text-[var(--text-body)] m-0">{c.quote}</p>
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}
    </div>
  );

  if (isFloatingWindow) {
    return (
      <div className="h-screen w-screen flex items-center justify-center p-2 bg-transparent">
        <main
          ref={cardRef}
          id="main"
          className="w-full h-full max-w-[660px] max-h-[544px] rounded-[20px] border border-[var(--line)] bg-[var(--bg)] shadow-[var(--shadow-3)] flex flex-col overflow-hidden"
        >
          <header className="px-4 py-2.5 border-b border-[var(--line-2)] flex items-center justify-between gap-2 app-drag">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-[var(--text-2)] shrink-0" aria-hidden="true" />
              <h1 className="text-base leading-[24px] font-semibold text-[var(--text)] m-0 truncate">
                全局闪问
              </h1>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <kbd className="hidden sm:inline-block font-mono text-xs leading-[18px] text-[var(--muted)] px-2 py-0.5 rounded-[6px] bg-[var(--fill)] whitespace-nowrap shrink-0">
                ⌘⇧Space
              </kbd>
              <button
                type="button"
                onClick={closeWindow}
                aria-label="关闭闪问浮窗"
                className="app-no-drag btn-ghost rounded-[8px] w-7 h-7 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {composer}
            {resultsContent}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[var(--bg)] text-[var(--text)] overflow-y-auto">
      <main ref={cardRef} id="main" className="max-w-[820px] mx-auto px-7 sm:px-9 py-7 space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[24px] leading-[34px] font-semibold tracking-[-0.02em] text-[var(--text)] m-0 flex items-center gap-2.5 whitespace-nowrap">
              <Sparkles className="w-5 h-5 text-[var(--text-2)] shrink-0" aria-hidden="true" />
              <span>全局闪问</span>
            </h1>
            <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0 mt-1">
              一句话穿透所有会议与全天记录，直接返回结论、原声片段和来源时间戳
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <kbd className="hidden sm:inline-block font-mono text-xs leading-[18px] text-[var(--muted)] px-2 py-0.5 rounded-[6px] bg-[var(--fill)] whitespace-nowrap shrink-0">
              ⌘⇧Space
            </kbd>
            <button
              type="button"
              onClick={closeWindow}
              aria-label="关闭全局闪问"
              className="btn-ghost rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" aria-hidden="true" />
              <span>返回</span>
            </button>
          </div>
        </header>

        {composer}
        {resultsContent}
      </main>
    </div>
  );
}
