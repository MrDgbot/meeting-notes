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
      panelClassName="max-h-[85vh] border border-[var(--line)] flex flex-col"
    >
      <div className="px-5 py-4 border-b border-[var(--line-2)] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold m-0 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[var(--muted)] shrink-0" aria-hidden="true" />
            <span>批量认人</span>
            {confirmedCount > 0 && (
              <span className="rounded-full bg-[var(--green-weak)] text-[var(--green)] px-2 py-0.5 text-[11px] font-medium num">
                已确认 {confirmedCount} / {totalSessionCount}
              </span>
            )}
          </h2>
          <p className="text-xs text-[var(--muted)] m-0 mt-0.5 num">
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
            className="btn-ghost rounded-lg w-8 h-8 flex items-center justify-center cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭向导"
            className="btn-ghost rounded-lg w-8 h-8 flex items-center justify-center cursor-pointer"
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

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {loading && !clusters.length ? (
          <div className="py-6 space-y-3">
            <div className="text-center text-sm text-[var(--muted)]">正在聚合跨会议未命名声音…</div>
            <SkeletonLines lines={4} />
          </div>
        ) : !clusters.length ? (
          <div className="rounded-xl bg-[var(--fill)] py-10 px-6 text-center space-y-2">
            <Users className="w-8 h-8 mx-auto text-[var(--muted)]" aria-hidden="true" />
            <div className="text-sm font-medium text-[var(--text)]">近 14 天暂无待确认的常见声音</div>
            <p className="text-xs text-[var(--muted)] m-0">
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
                  <article className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-6 h-6 rounded-full text-xs font-semibold inline-flex items-center justify-center num transition-colors ${
                            isDone ? "bg-[var(--green)] text-white" : "bg-[var(--ink)] text-[var(--ink-inv)]"
                          }`}
                        >
                          {isDone ? <Check className="w-3.5 h-3.5" /> : idx + 1}
                        </span>
                        <span className="text-sm font-semibold text-[var(--text)] num">
                          出现 {cl.meeting_count} 场 · 累计 {fmtDur(cl.total_voiced_s)}
                        </span>
                      </div>
                      <span className="rounded-full bg-[var(--green-weak)] text-[var(--green)] px-2.5 py-0.5 text-[11px] font-medium">
                        {cl.avg_cos >= 0.82 ? "高把握同一人" : "疑似同一人"}
                      </span>
                    </div>

                    {activeSample && (
                      <div className="rounded-lg bg-[var(--fill)] px-3 py-2.5 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
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
                              className="btn-secondary rounded-md px-2.5 h-7 text-xs inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
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
                            <span className="text-xs text-[var(--muted)] truncate num">
                              {activeSample.title} · {activeSample.created.slice(0, 10)} [
                              {fmtTs(activeSample.start_ms)}]
                            </span>
                          </div>

                          {cl.samples.length > 1 && (
                            <div className="flex items-center gap-1 shrink-0">
                              {cl.samples.map((s, si) => (
                                <button
                                  key={`${s.mid}-${s.start_ms}`}
                                  type="button"
                                  onClick={() => {
                                    stopAudio();
                                    setSampleIdxMap((m) => ({ ...m, [cl.cluster_id]: si }));
                                  }}
                                  className={`h-6 px-2 rounded text-[11px] num cursor-pointer ${
                                    si === sampleIdx
                                      ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-xs"
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
                          <div className="h-[2px] w-full rounded-full bg-[var(--fill-2)] overflow-hidden">
                            <div
                              className="h-full w-full origin-left bg-[var(--ink)]"
                              style={{ transform: `scaleX(${playProgress.toFixed(3)})` }}
                            />
                          </div>
                        )}

                        <p className="text-[13px] text-[var(--text-body)] m-0 leading-relaxed flex items-start gap-1.5">
                          <Volume2
                            className="w-3.5 h-3.5 text-[var(--muted)] shrink-0 mt-1"
                            aria-hidden="true"
                          />
                          <span>“{activeSample.text}”</span>
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--muted)]">
                      <span>涉及场次：</span>
                      {cl.members.slice(0, 4).map((m) => (
                        <span
                          key={`${m.mid}:${m.spk}`}
                          className="rounded-md bg-[var(--fill)] px-2 py-0.5 text-[var(--text-2)] truncate max-w-[200px]"
                        >
                          {m.title}（说话人{Number(m.spk) + 1}）
                        </span>
                      ))}
                      {cl.members.length > 4 && <span className="num">+{cl.members.length - 4} 场</span>}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
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
                        className="flex-1 min-w-[180px] h-9 px-3 text-sm"
                      />
                      <button
                        type="button"
                        disabled={saving || isDone}
                        onClick={() => void handleBatchName(cl)}
                        className="btn-primary h-9 px-3.5 rounded-lg text-xs inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
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
