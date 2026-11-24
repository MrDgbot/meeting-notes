import type { GlobalAskCitation, GlobalAskResponse } from "@shared/types";
import { ExternalLink, Play, Search, Sparkles, Square, X } from "lucide-react";
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

  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const queryRef = useRef(query);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const targetH = loading || result ? 460 : 210;
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

  return (
    <div className="h-screen w-screen flex items-center justify-center p-2 bg-transparent">
      <main
        ref={cardRef}
        id="main"
        className="w-full h-full max-w-[660px] max-h-[520px] rounded-2xl border border-[var(--line)] bg-[var(--surface-elev)] shadow-[var(--shadow-pop)] flex flex-col overflow-hidden"
      >
        <header className="px-4 py-2.5 border-b border-[var(--line-2)] flex items-center gap-2 app-drag">
          <Sparkles className="w-4 h-4 text-[var(--muted)] shrink-0" aria-hidden="true" />
          <h1 className="text-sm font-semibold m-0 shrink-0">全局闪问</h1>

          <div className="flex-1 flex items-center gap-1.5 app-no-drag min-w-0 ml-1">
            <div className="relative flex-1 min-w-0">
              <Search
                className="w-3.5 h-3.5 text-[var(--muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleAsk();
                  }
                }}
                placeholder="问所有历史会议：如 上周谁负责跟进方案？"
                aria-label="跨会议提问"
                className="w-full h-8 pl-8 pr-8 text-[13px]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                  aria-label="清空输入"
                  className="absolute right-1 top-1/2 -translate-y-1/2 w-[26px] h-[26px] inline-flex items-center justify-center rounded-md text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              disabled={loading || !query.trim()}
              onClick={() => void handleAsk()}
              className="btn-primary h-8 px-3 rounded-lg text-xs shrink-0 cursor-pointer"
            >
              {loading ? "检索中…" : "提问"}
            </button>
          </div>

          <kbd className="hidden sm:inline-block font-mono text-[10.5px] text-[var(--muted)] px-1.5 py-0.5 rounded bg-[var(--fill)] shrink-0">
            ⌘⇧Space
          </kbd>
          <button
            type="button"
            onClick={closeWindow}
            aria-label="关闭闪问浮窗"
            className="app-no-drag btn-ghost rounded-lg w-7 h-7 flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!result && !loading && (
            <div className="py-5 px-4 text-center space-y-3">
              <p className="text-sm text-[var(--text-2)] m-0">
                一句话穿透所有会议与全天记录，直接返回结论、原声片段和来源时间戳
              </p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {PRESET_QUERIES.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setQuery(preset);
                      void handleAsk(preset);
                    }}
                    className="btn-secondary rounded-full px-3 py-1 text-xs cursor-pointer"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="rounded-xl bg-[var(--surface)] border border-[var(--line-2)] p-4 space-y-2.5">
              <div className="text-xs text-[var(--muted)]">正在检索全部会议记忆…</div>
              <SkeletonLines lines={3} />
            </div>
          )}

          {result && !loading && (
            <>
              <section className="rounded-xl bg-[var(--surface)] border border-[var(--line-2)] px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[var(--text-2)]">回答结论</span>
                    <span className="rounded-full bg-[var(--fill)] px-2 py-0.5 text-[11px] text-[var(--text-2)]">
                      {result.mode === "llm" ? "AI 归纳" : "本机检索"}
                    </span>
                  </div>
                  <CopyButton text={result.answer} label="复制" successToast="已复制回答结论" />
                </div>
                <MarkdownView markdown={result.answer} className="text-[13.5px]" />
              </section>

              {result.citations.length > 0 && (
                <section className="space-y-2">
                  <div className="text-xs font-medium text-[var(--muted)] num">
                    原声依据（{result.citations.length} 条）
                  </div>
                  {result.citations.map((c, idx) => {
                    const key = `${c.mid}:${c.start_ms}:${idx}`;
                    const playing = playingKey === key;
                    return (
                      <div
                        key={key}
                        className="rounded-xl border border-[var(--line-2)] bg-[var(--surface)] px-3.5 py-2.5 space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--fill)] text-[var(--text-2)] num shrink-0">
                              [{idx + 1}]
                            </span>
                            <span className="font-medium text-[var(--text)] truncate">{c.title}</span>
                            <span className="text-[var(--muted)] num shrink-0">
                              {c.created.slice(0, 10)} [{c.ts}]
                            </span>
                            {c.speaker && (
                              <span className="text-[var(--text-2)] shrink-0">· {c.speaker}</span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => togglePlayCitation(c, idx)}
                              title={playing ? "停止试听" : "试听约 5 秒原声片段"}
                              className="btn-ghost rounded-md px-2 h-6 text-[11.5px] inline-flex items-center gap-1 cursor-pointer"
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
                              className="btn-secondary rounded-md px-2 h-6 text-[11.5px] inline-flex items-center gap-1 cursor-pointer"
                            >
                              <span>跳到原处</span>
                              <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-[var(--text-body)] m-0 leading-relaxed">{c.quote}</p>
                      </div>
                    );
                  })}
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
