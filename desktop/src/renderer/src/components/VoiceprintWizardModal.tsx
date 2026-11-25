import { fmtDur, fmtTs } from "@shared/format";
import type { PersonSummary, VoiceprintBatchNameResponse, VoiceprintCluster } from "@shared/types";
import { Check, Play, RefreshCw, Sparkles, Square, Users, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModalShell, SkeletonLines } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

export function VoiceprintWizardModal() {
  const open = useAppStore((s) => s.vpWizardOpen);
  const setOpen = useAppStore((s) => s.setVpWizardOpen);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const pushToast = useAppStore((s) => s.pushToast);

  const [clusters, setClusters] = useState<VoiceprintCluster[]>([]);
  const [candidateNodes, setCandidateNodes] = useState(0);
  const [peopleNames, setPeopleNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [sampleIdxMap, setSampleIdxMap] = useState<Record<string, number>>({});
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [completedIds, setCompletedIds] = useState<Record<string, boolean>>({});
  const [collapsingIds, setCollapsingIds] = useState<Record<string, boolean>>({});
  const [confirmedCount, setConfirmedCount] = useState(0);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playProgress, setPlayProgress] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopAudio = useCallback(() => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
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
    setPlayProgress(0);
  }, []);

  const loadClusters = useCallback(async () => {
    setLoading(true);
    try {
      const [clRes, pplRes] = await Promise.all([
        api<{ clusters?: VoiceprintCluster[]; candidate_nodes?: number }>(
          "/api/rsi/voiceprints/clusters?days=14&limit=8",
        ),
        api<{ people?: PersonSummary[] }>("/api/people").catch(() => ({ people: [] })),
      ]);
      setClusters(Array.isArray(clRes?.clusters) ? clRes.clusters : []);
      setCandidateNodes(Number(clRes?.candidate_nodes || 0));
      setCompletedIds({});
      setCollapsingIds({});
      const names = (pplRes?.people || []).map((p) => p.name).filter(Boolean);
      setPeopleNames(names);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "加载常见声音列表失败", 4000);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (open) {
      setConfirmedCount(0);
      void loadClusters();
    } else {
      stopAudio();
    }
  }, [open, loadClusters, stopAudio]);

  useEffect(() => stopAudio, [stopAudio]);

  const handleClose = useCallback(() => {
    stopAudio();
    setOpen(false);
  }, [stopAudio, setOpen]);

  const togglePlaySample = (clusterId: string, mid: string, startMs: number, endMs: number) => {
    const key = `${clusterId}:${mid}:${startMs}`;
    if (playingKey === key) {
      stopAudio();
      return;
    }
    stopAudio();

    const startSec = Math.max(0, startMs / 1000);
    const clipEndSec = Math.min(Math.max(startSec + 2.5, endMs / 1000 + 0.3), startSec + 6.5);
    const clipSpan = Math.max(0.5, clipEndSec - startSec);
    const audio = new Audio(`/api/meetings/${encodeURIComponent(mid)}/audio`);
    audioRef.current = audio;
    setPlayingKey(key);
    setPlayProgress(0);

    let seekApplied = false;
    const armStop = () => {
      stopTimerRef.current = setTimeout(() => {
        stopAudio();
      }, 7000);
    };

    const tick = () => {
      if (audioRef.current !== audio || audio.paused) return;
      const ratio = Math.max(0, Math.min(1, (audio.currentTime - startSec) / clipSpan));
      setPlayProgress(ratio);
      if (audio.currentTime >= clipEndSec) {
        stopAudio();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    audio.ontimeupdate = () => {
      if (audio.currentTime >= clipEndSec) {
        stopAudio();
      }
    };
    audio.onended = () => stopAudio();
    audio.onerror = () => {
      stopAudio();
      pushToast("音频加载失败，请确认录音文件存在", 3000);
    };

    const startPlayback = () => {
      if (!seekApplied && startSec > 0 && Number.isFinite(audio.duration)) {
        try {
          audio.currentTime = Math.min(startSec, Math.max(0, audio.duration - 0.5));
          seekApplied = true;
        } catch {}
      }
      armStop();
      void audio
        .play()
        .then(() => {
          rafRef.current = requestAnimationFrame(tick);
        })
        .catch(() => {
          stopAudio();
          pushToast("无法自动播放音频", 3000);
        });
    };

    if (audio.readyState >= 1) {
      startPlayback();
    } else {
      audio.onloadedmetadata = startPlayback;
    }
  };

  const handleBatchName = async (cluster: VoiceprintCluster) => {
    const name = (nameMap[cluster.cluster_id] || "").trim();
    if (!name) {
      pushToast("请先输入说话人姓名", 2500);
      return;
    }
    stopAudio();
    setSavingId(cluster.cluster_id);
    try {
      const res = await api<VoiceprintBatchNameResponse>("/api/rsi/voiceprints/batch-name", {
        method: "POST",
        body: {
          name,
          members: cluster.members.map(({ mid, spk }) => ({ mid, spk })),
        },
      });
      setConfirmedCount((c) => c + 1);
      setCompletedIds((m) => ({ ...m, [cluster.cluster_id]: true }));
      pushToast(`已将「${res.name}」应用到 ${res.updated_meetings} 场会议`, {
        tone: "success",
        durationMs: 3600,
      });
      await loadMeetings();
      setTimeout(() => {
        setCollapsingIds((m) => ({ ...m, [cluster.cluster_id]: true }));
        setTimeout(() => {
          setClusters((prev) => prev.filter((x) => x.cluster_id !== cluster.cluster_id));
        }, 220);
      }, 380);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "批量认人失败", 4000);
    } finally {
      setSavingId(null);
    }
  };

  const totalSessionCount = clusters.length + confirmedCount;

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      label="批量认人向导"
      maxWidthClass="max-w-2xl"
      backdropClassName="bg-[var(--backdrop)] backdrop-blur-[4px]"
      panelClassName="max-h-[85vh] rounded-[16px] bg-[var(--surface-elev)] shadow-[var(--shadow-3)] flex flex-col"
    >
      <div className="px-6 py-4 border-b border-[var(--line-2)] flex items-start justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] m-0 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--text-2)] shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">批量认人</span>
            {confirmedCount > 0 && (
              <span className="rounded-full bg-[var(--ok-soft)] text-[var(--ok)] px-2.5 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 num">
                已确认 {confirmedCount} / {totalSessionCount}
              </span>
            )}
          </h2>
          <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0 mt-1 num">
            {candidateNodes > 0
              ? `近 14 天识别出 ${clusters.length} 位跨会议常出现的声音，试听一句即可一次命名`
              : "将多场会议里重复出现的未命名声音聚成一组，试听一句即可批量认出"}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void loadClusters()}
            aria-label="重新扫描常见声音"
            title="重新扫描"
            className="btn-ghost rounded-[8px] w-8 h-8 flex items-center justify-center shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭向导"
            className="btn-ghost rounded-[8px] w-8 h-8 flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <datalist id="vp-wizard-people-list">
        {peopleNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {loading && !clusters.length ? (
          <div className="py-8 space-y-3">
            <div className="text-center text-sm leading-[22px] text-[var(--muted)]">
              正在聚合跨会议未命名声音…
            </div>
            <SkeletonLines lines={4} />
          </div>
        ) : !clusters.length ? (
          <div className="rounded-[12px] bg-[var(--surface-2)] py-12 px-6 text-center space-y-2">
            <Users className="w-8 h-8 mx-auto text-[var(--muted)]" aria-hidden="true" />
            <div className="text-sm leading-[22px] font-medium text-[var(--text)]">
              近 14 天暂无待确认的常见声音
            </div>
            <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0">
              已有记录中的说话人都已命名或发言较短；积累几场新会议后会自动汇总到这里。
            </p>
          </div>
        ) : (
          clusters.map((cl, idx) => {
            const sampleIdx = sampleIdxMap[cl.cluster_id] ?? 0;
            const activeSample = cl.samples[sampleIdx] ?? cl.samples[0];
            const sampleKey = activeSample
              ? `${cl.cluster_id}:${activeSample.mid}:${activeSample.start_ms}`
              : "";
            const isPlaying = Boolean(sampleKey && playingKey === sampleKey);
            const saving = savingId === cl.cluster_id;
            const isDone = Boolean(completedIds[cl.cluster_id]);
            const isCollapsing = Boolean(collapsingIds[cl.cluster_id]);

            return (
              <div
                key={cl.cluster_id}
                className="mn-row-collapse"
                data-collapsing={isCollapsing ? "true" : undefined}
              >
                <div>
                  <article className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`w-6 h-6 rounded-full text-xs leading-[18px] font-semibold inline-flex items-center justify-center shrink-0 num transition-colors ${
                            isDone ? "bg-[var(--ok)] text-white" : "bg-[var(--fill)] text-[var(--text)]"
                          }`}
                        >
                          {isDone ? <Check className="w-3.5 h-3.5" /> : idx + 1}
                        </span>
                        <span className="text-sm leading-[22px] font-semibold text-[var(--text)] num">
                          出现 {cl.meeting_count} 场 · 累计 {fmtDur(cl.total_voiced_s)}
                        </span>
                      </div>
                      <span className="rounded-full bg-[var(--ok-soft)] text-[var(--ok)] px-2.5 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0">
                        {cl.avg_cos >= 0.82 ? "高把握同一人" : "疑似同一人"}
                      </span>
                    </div>

                    {activeSample && (
                      <div className="rounded-[10px] bg-[var(--surface-2)] px-3.5 py-3 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <button
                              type="button"
                              onClick={() =>
                                togglePlaySample(
                                  cl.cluster_id,
                                  activeSample.mid,
                                  activeSample.start_ms,
                                  activeSample.end_ms,
                                )
                              }
                              title={isPlaying ? "停止播放样本" : "试听约 5 秒原声片段"}
                              className={`rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                                isPlaying ? "bg-[var(--fill)] text-[var(--text)]" : "btn-secondary"
                              }`}
                            >
                              {isPlaying ? (
                                <>
                                  <Square className="w-3 h-3" aria-hidden="true" />
                                  <span>停止</span>
                                </>
                              ) : (
                                <>
                                  <Play className="w-3 h-3" aria-hidden="true" />
                                  <span>试听原声</span>
                                </>
                              )}
                            </button>
                            <span className="text-xs leading-[18px] text-[var(--muted)] truncate num">
                              {activeSample.title} · {activeSample.created.slice(0, 10)}{" "}
                              <span className="font-mono">[{fmtTs(activeSample.start_ms)}]</span>
                            </span>
                          </div>

                          {cl.samples.length > 1 && (
                            <div className="inline-flex items-center gap-0.5 rounded-[8px] bg-[var(--fill)] p-[2px] shrink-0">
                              {cl.samples.map((s, si) => (
                                <button
                                  key={`${s.mid}-${s.start_ms}`}
                                  type="button"
                                  onClick={() => {
                                    stopAudio();
                                    setSampleIdxMap((m) => ({ ...m, [cl.cluster_id]: si }));
                                  }}
                                  className={`h-7 px-2.5 rounded-[6px] text-xs leading-[18px] whitespace-nowrap shrink-0 num cursor-pointer transition-colors ${
                                    si === sampleIdx
                                      ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-[var(--shadow-1)]"
                                      : "text-[var(--muted)] hover:text-[var(--text)]"
                                  }`}
                                >
                                  片段{si + 1}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {isPlaying && (
                          <div className="h-[3px] w-full rounded-full bg-[var(--fill-hover)] overflow-hidden">
                            <div
                              className="h-full w-full origin-left bg-[var(--ink)]"
                              style={{ transform: `scaleX(${playProgress.toFixed(3)})` }}
                            />
                          </div>
                        )}

                        <p className="text-sm leading-[22px] text-[var(--text-body)] m-0 flex items-start gap-2">
                          <Volume2
                            className="w-4 h-4 text-[var(--muted)] shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                          <span>“{activeSample.text}”</span>
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 text-xs leading-[18px] text-[var(--muted)]">
                      <span className="whitespace-nowrap shrink-0">涉及场次：</span>
                      {cl.members.slice(0, 4).map((m) => (
                        <span
                          key={`${m.mid}:${m.spk}`}
                          className="rounded-[6px] bg-[var(--fill)] px-2 py-0.5 text-[var(--text-2)] truncate max-w-[220px]"
                        >
                          {m.title}（说话人{Number(m.spk) + 1}）
                        </span>
                      ))}
                      {cl.members.length > 4 && (
                        <span className="whitespace-nowrap shrink-0 num">+{cl.members.length - 4} 场</span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
                      <input
                        type="text"
                        list="vp-wizard-people-list"
                        value={nameMap[cl.cluster_id] ?? ""}
                        onChange={(e) => setNameMap((m) => ({ ...m, [cl.cluster_id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void handleBatchName(cl);
                          }
                        }}
                        placeholder="输入 TA 的名字，如 张三"
                        aria-label={`为声音组 ${idx + 1} 输入姓名`}
                        className="flex-1 min-w-[180px] h-9 rounded-[10px] px-3 text-sm leading-[22px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] focus:ring-2 focus:ring-[var(--ink-ring)] transition-colors"
                      />
                      <button
                        type="button"
                        disabled={saving || isDone}
                        onClick={() => void handleBatchName(cl)}
                        className="h-9 px-4 rounded-[10px] text-sm leading-[22px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 active:scale-[0.98] disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" aria-hidden="true" />
                        <span>
                          {isDone ? "已认人" : saving ? "保存中…" : `一键认人（${cl.members.length} 处）`}
                        </span>
                      </button>
                    </div>
                  </article>
                </div>
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
}
