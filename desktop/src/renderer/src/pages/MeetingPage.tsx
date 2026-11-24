import { asrInfo, buildSpeakerMap, computeRecHealth, fmtDur, getParas, hm } from "@shared/format";
import {
  AlertCircle,
  Calendar,
  Clock,
  Columns2,
  Download,
  FolderOpen,
  Lock,
  Mic,
  Radio,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { InlineConfirm, SkeletonLines, SlidingTabBar } from "@/components/MotionPrimitives";
import { ContinueRecordDialog, RetranscribeDialog } from "@/components/meeting/MeetingDialogs";
import { MinutesPane } from "@/components/meeting/MinutesPane";
import { NotesPane } from "@/components/meeting/NotesPane";
import { QaPane } from "@/components/meeting/QaPane";
import { RecordingView } from "@/components/meeting/RecordingView";
import { TranscriptPane } from "@/components/meeting/TranscriptPane";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { type MeetingTab, useMeetingStore } from "@/stores/meetingStore";
import { useRecorderStore } from "@/stores/recorderStore";

export function MeetingPage({ mid, initialSeekSec }: { mid: string; initialSeekSec?: number }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const splitView = useAppStore((s) => s.splitView);
  const setSplitView = useAppStore((s) => s.setSplitView);
  const runAmbientAction = useAppStore((s) => s.runAmbientAction);
  const ambient = useAppStore((s) => s.ambient);
  const ambientLive = useAppStore((s) => s.ambientLive);
  const provId = useAppStore((s) => s.provId);
  const loadMeetings = useAppStore((s) => s.loadMeetings);

  const meeting = useMeetingStore((s) => s.meeting);
  const loading = useMeetingStore((s) => s.loading);
  const loadError = useMeetingStore((s) => s.loadError);
  const tab = useMeetingStore((s) => s.tab);
  const setTab = useMeetingStore((s) => s.setTab);
  const peaks = useMeetingStore((s) => s.peaks);
  const showMeeting = useMeetingStore((s) => s.showMeeting);
  const refreshMeeting = useMeetingStore((s) => s.refreshMeeting);
  const patchMeeting = useMeetingStore((s) => s.patchMeeting);
  const deleteMeeting = useMeetingStore((s) => s.deleteMeeting);
  const flushNotes = useMeetingStore((s) => s.flushNotes);
  const addMarkAt = useMeetingStore((s) => s.addMarkAt);

  const recActive = useRecorderStore((s) => s.active);
  const recMid = useRecorderStore((s) => s.mid);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [continueOpen, setContinueOpen] = useState(false);
  const [retransOpen, setRetransOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [canSplitWidth, setCanSplitWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1100 : true,
  );
  const [splitLeftPct, setSplitLeftPct] = useState(() => {
    try {
      const saved = Number.parseFloat(localStorage.getItem("splitRatio") || "50");
      return Number.isFinite(saved) ? Math.min(68, Math.max(32, saved)) : 50;
    } catch {
      return 50;
    }
  });

  const mainGridRef = useRef<HTMLDivElement>(null);
  const exportWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: PointerEvent) => {
      if (exportWrapRef.current && !exportWrapRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExportOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [exportOpen]);

  useEffect(() => {
    void showMeeting(mid, { initialSeekSec });
  }, [mid, initialSeekSec, showMeeting]);

  useEffect(() => {
    const check = () => setCanSplitWidth(window.innerWidth >= 1100);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (!meeting || meeting.meta.id !== mid) return;
    const isBusy = ["queued", "transcribing"].includes(meeting.meta.status);
    const shouldPoll = isBusy || meeting.ambient_active || meeting.live_active;
    if (!shouldPoll) return;

    const intervalMs = isBusy ? 2500 : meeting.ambient_active ? (ambientLive ? 12000 : 4000) : 3000;
    const id = setInterval(() => {
      void refreshMeeting(mid);
    }, intervalMs);
    return () => clearInterval(id);
  }, [meeting, mid, ambientLive, refreshMeeting]);

  const paras = useMemo(() => getParas(meeting), [meeting]);
  const spkMap = useMemo(() => buildSpeakerMap(meeting), [meeting]);
  const hasEditedParagraphs = useMemo(() => paras.some((p) => Boolean(p.edited)), [paras]);
  const recHealth = useMemo(() => computeRecHealth(meeting?.meta), [meeting?.meta]);

  if (loading && (!meeting || meeting.meta.id !== mid)) {
    return (
      <div className="max-w-[1040px] mx-auto px-7 py-8 space-y-5">
        <SkeletonLines lines={2} className="max-w-md" />
        <div className="card-surface p-5">
          <SkeletonLines lines={6} />
        </div>
      </div>
    );
  }

  if (loadError && (!meeting || meeting.meta.id !== mid)) {
    return (
      <div className="max-w-xl mx-auto px-5 py-12 text-center space-y-3">
        <div className="text-sm text-[var(--red)]">{loadError}</div>
        <button
          type="button"
          onClick={() => void showMeeting(mid)}
          className="btn-secondary rounded-[8px] px-4 py-1.5 text-xs cursor-pointer"
        >
          重试
        </button>
      </div>
    );
  }

  if (!meeting || meeting.meta.id !== mid) return null;

  const m = meeting.meta;
  const isRecHere = recActive && recMid === m.id;
  const useSplit = splitView && canSplitWidth && !isRecHere;
  const effectiveTab: MeetingTab = useSplit && tab === "transcript" ? "minutes" : tab;
  const busy = ["queued", "transcribing"].includes(m.status);

  const commitTitle = async () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === m.title) return;
    try {
      await patchMeeting(m.id, { title: trimmed });
      pushToast("标题已更新");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "修改标题失败", 4000);
    }
  };

  const handleTogglePrivacy = async () => {
    const next = !m.rsi_exclude;
    try {
      await patchMeeting(m.id, { rsi_exclude: next });
      pushToast(next ? "已标记为隐私会议（不参与声纹和词汇自学习）" : "已取消隐私会议标记");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "切换失败", 4000);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMeeting(m.id);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "移入废纸篓失败", 4000);
    }
  };

  const handleGenerateBrief = async () => {
    if (briefBusy) return;
    setBriefBusy(true);
    try {
      await api(`/api/meetings/${encodeURIComponent(m.id)}/brief`, {
        method: "POST",
        body: provId ? { provider: provId } : {},
      });
      await Promise.all([refreshMeeting(m.id), loadMeetings()]);
      pushToast("已更新一句话结论与话题标签");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "生成摘要失败", 4000);
    } finally {
      setBriefBusy(false);
    }
  };

  const handleExport = (fmt: "md" | "txt" | "srt" | "zip") => {
    setExportOpen(false);
    const url = `/api/meetings/${encodeURIComponent(m.id)}/export?fmt=${fmt}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  };

  const updateSplitRatio = (nextPct: number) => {
    const clamped = Math.min(68, Math.max(32, Math.round(nextPct * 10) / 10));
    setSplitLeftPct(clamped);
    try {
      localStorage.setItem("splitRatio", String(clamped));
    } catch {}
  };

  const tabs: Array<{ id: MeetingTab; label: string }> = [
    { id: "minutes", label: "AI 纪要" },
    ...(useSplit ? [] : [{ id: "transcript" as const, label: "转写稿" }]),
    { id: "notes", label: "我的笔记" },
    { id: "qa", label: "AI 问答" },
  ];

  return (
    <div className={`mx-auto px-7 pt-2 pb-10 space-y-2.5 ${useSplit ? "max-w-[1640px]" : "max-w-[1040px]"}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          {editingTitle ? (
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitTitle();
                else if (e.key === "Escape") setEditingTitle(false);
              }}
              aria-label="编辑会议标题"
              autoFocus
              className="text-[22px] font-semibold px-2 py-0.5 -ml-2 w-full max-w-xl bg-[var(--surface)]"
            />
          ) : (
            <h1
              onClick={() => {
                setTitleDraft(m.title || "");
                setEditingTitle(true);
              }}
              title="点击修改会议标题"
              className="text-[22px] font-semibold tracking-[-0.01em] m-0 px-2 py-0.5 -ml-2 rounded-[8px] cursor-text hover:bg-[var(--fill)] inline-block transition-colors"
            >
              {m.title || "未命名会议"}
            </h1>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-[var(--muted)] num">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 opacity-75" aria-hidden="true" />
              {(m.created || "").slice(0, 10)} {hm(m.created)}
            </span>
            {m.duration > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 opacity-75" aria-hidden="true" />
                时长 {fmtDur(m.duration)}
              </span>
            )}
            {m.source === "ambient" && (
              <span className="inline-flex items-center gap-1">
                <Radio className="w-3.5 h-3.5 opacity-75" aria-hidden="true" />
                全天自动记录
              </span>
            )}
            {spkMap.ids.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Users className="w-3.5 h-3.5 opacity-75" aria-hidden="true" />
                {spkMap.ids.length} 位发言人
              </span>
            )}
            {(m.asr?.cloud_failed || m.asr?.nano_failed || (m.asr?.failed ?? 0) > 0) && (
              <span title={asrInfo(m.asr, true)} className="text-[var(--amber)]">
                {asrInfo(m.asr, false)}
              </span>
            )}
            {m.rsi_exclude && (
              <span className="rounded px-1.5 py-0 text-[11px] bg-[var(--amber-weak)] text-[var(--amber)] font-medium">
                不参与学习
              </span>
            )}
            {recHealth && (
              <span
                title={recHealth.tip}
                className={recHealth.hasIssue ? "text-[var(--amber)]" : "text-[var(--green)]"}
              >
                {recHealth.summaryText}
              </span>
            )}
          </div>

          {(m.brief || (m.tags && m.tags.length > 0) || (m.status === "ready" && !isRecHere && !busy)) && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
              {m.brief && <span className="text-[var(--text-2)]">{m.brief}</span>}
              {(m.tags || []).slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-[var(--fill)] px-2 py-0.5 text-[11px] text-[var(--text-2)]"
                >
                  #{tag}
                </span>
              ))}
              {m.status === "ready" && !isRecHere && !busy && (
                <button
                  type="button"
                  disabled={briefBusy}
                  onClick={() => void handleGenerateBrief()}
                  className="btn-ghost rounded-[7px] px-2 h-6 text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-1 cursor-pointer"
                >
                  <Sparkles className="w-3 h-3" aria-hidden="true" />
                  <span>{briefBusy ? "提炼中…" : m.brief ? "更新摘要" : "生成一句话摘要"}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {!isRecHere && (
          <div className="flex flex-wrap items-center gap-0.5 pt-0.5">
            {!busy && !meeting.live_active && !meeting.ambient_active && (
              <button
                type="button"
                onClick={() => setContinueOpen(true)}
                className="btn-ghost rounded-[8px] h-8 px-2.5 text-[13px] inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{m.duration ? "继续录音" : "开始录音"}</span>
              </button>
            )}

            {meeting.has_audio && !busy && !meeting.live_active && (
              <button
                type="button"
                onClick={() => setRetransOpen(true)}
                className="btn-ghost rounded-[8px] h-8 px-2.5 text-[13px] inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{m.source === "ambient" && m.status === "recording" ? "精准转写" : "重新转写"}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleTogglePrivacy()}
              aria-pressed={Boolean(m.rsi_exclude)}
              title="设为隐私会议后，该场不会用于声纹识别和词库自学习"
              className={`rounded-[8px] h-8 px-2.5 text-[13px] inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                m.rsi_exclude ? "bg-[var(--amber-weak)] text-[var(--amber)] font-medium" : "btn-ghost"
              }`}
            >
              <Lock className="w-3.5 h-3.5" aria-hidden="true" />
              <span>隐私会议</span>
            </button>

            {window.desktopAPI && (
              <button
                type="button"
                onClick={() => void window.desktopAPI?.revealMeeting(m.id)}
                title="在访达中显示会议目录"
                className="btn-ghost rounded-[8px] h-8 px-2.5 text-[13px] inline-flex items-center gap-1.5 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden xl:inline">文件目录</span>
              </button>
            )}

            <div ref={exportWrapRef} className="relative">
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                aria-expanded={exportOpen}
                className="btn-ghost rounded-[8px] h-8 px-2.5 text-[13px] inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>导出</span>
              </button>
              {exportOpen && (
                <div className="mn-popover absolute right-0 mt-1.5 w-36 rounded-[12px] bg-[var(--surface-elev)] shadow-[var(--shadow-pop)] border border-[var(--line)] py-1 z-30 text-xs">
                  {(
                    [
                      ["md", "Markdown (.md)"],
                      ["txt", "纯文本 (.txt)"],
                      ["srt", "字幕 (.srt)"],
                      ["zip", "完整打包 (.zip)"],
                    ] as const
                  ).map(([fmt, label]) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => handleExport(fmt)}
                      className="w-full text-left px-3 py-1.5 hover:bg-[var(--fill)] cursor-pointer transition-colors"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!isRecHere && !meeting.live_active && (
              <>
                <span className="h-4 w-px bg-[var(--line-2)] mx-1" aria-hidden="true" />
                <InlineConfirm
                  triggerAriaLabel="删除会议"
                  triggerTitle="移入废纸篓"
                  triggerClassName="btn-ghost btn-danger rounded-[8px] w-8 h-8"
                  triggerIcon={<Trash2 className="w-4 h-4" />}
                  message={`将「${m.title || "未命名会议"}」移入废纸篓？30 天内可找回。`}
                  confirmLabel="移入废纸篓"
                  onConfirm={handleDelete}
                />
              </>
            )}
          </div>
        )}
      </header>

      {isRecHere ? (
        <RecordingView meeting={meeting} />
      ) : (
        <>
          {busy && (
            <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-4 py-2.5 text-xs flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-[var(--link)]" />
              <span>
                {m.status === "queued"
                  ? "正在排队等待语音识别与声纹聚类…"
                  : "正在进行本机高精度语音识别与说话人区分，完成后会自动刷新…"}
              </span>
            </div>
          )}

          {meeting.ambient_active && (
            <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2">
              <span>
                全天模式正在记录这段对话（静音 {ambient?.cfg.split_min ?? 5} 分钟后自动结束并精准转写）
              </span>
              <button
                type="button"
                onClick={() => {
                  void flushNotes(m.id).then(() => runAmbientAction({ action: "split" }));
                  setTimeout(() => void showMeeting(m.id, { keepTab: true }), 800);
                }}
                className="btn-secondary rounded-[8px] px-2.5 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <Scissors className="w-3.5 h-3.5" /> 现在结束这段
              </button>
            </div>
          )}

          {meeting.live_active && (
            <div className="rounded-[12px] bg-[var(--amber-weak)] px-4 py-2.5 text-xs text-[var(--amber)] flex items-center justify-between gap-3">
              <span>
                {meeting.live_state?.state === "reconnecting"
                  ? `录音设备已断开连接，等待重连（剩余 ${fmtDur(meeting.live_state.grace_left || 0)}）`
                  : "该会议正在另一个终端录音中，结束后这里会自动更新"}
              </span>
              <button
                type="button"
                onClick={() => {
                  void api(`/api/meetings/${encodeURIComponent(m.id)}/live/end`, { method: "POST" })
                    .then(() => {
                      pushToast("已通知结束录音，将开始转写");
                      setTimeout(() => void showMeeting(m.id, { keepTab: true }), 1200);
                    })
                    .catch((e) => pushToast(String(e), 4000));
                }}
                className="btn-secondary rounded-[8px] px-2.5 py-1 text-xs cursor-pointer"
              >
                现在结束
              </button>
            </div>
          )}

          {m.status === "error" && (
            <div className="rounded-[12px] bg-[var(--red-weak)] px-4 py-2.5 text-xs text-[var(--red)] flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                转写失败：{m.error}
              </span>
              {meeting.has_audio && (
                <button
                  type="button"
                  onClick={() => setRetransOpen(true)}
                  className="btn-secondary rounded-[8px] px-2.5 py-1 text-xs cursor-pointer"
                >
                  重新转写
                </button>
              )}
            </div>
          )}

          {meeting.has_audio && (
            <AudioPlayer
              key={m.id}
              mid={m.id}
              durationHint={m.duration}
              peaks={peaks}
              marks={meeting.marks}
              segmap={meeting.segmap}
              paras={paras}
              meeting={meeting}
              onMarkCurrent={(tMs) => void addMarkAt(tMs)}
            />
          )}

          {useSplit ? (
            <div
              ref={mainGridRef}
              className={`grid items-start gap-0 ${
                draggingSplit
                  ? ""
                  : "transition-[grid-template-columns] duration-[220ms] [transition-timing-function:var(--ease-spring)]"
              }`}
              style={{
                gridTemplateColumns: `${splitLeftPct}% 16px minmax(0, 1fr)`,
              }}
            >
              <section className="min-w-0 pr-1">
                <div className="flex items-center gap-2 min-h-[39px] mb-3 border-b border-[var(--line-2)]">
                  <SlidingTabBar
                    value={effectiveTab}
                    onChange={(nextTab) => {
                      void flushNotes(m.id);
                      setTab(nextTab);
                    }}
                    tabs={tabs}
                    ariaLabel="会议内容视图"
                    className="border-b-0 flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => setSplitView(false)}
                    title="改回单栏标签页视图"
                    className="btn-ghost rounded-[8px] px-2.5 h-[30px] text-[12.5px] inline-flex items-center gap-1.5 cursor-pointer shrink-0 mb-1"
                  >
                    <Columns2 className="w-3.5 h-3.5" aria-hidden="true" /> 单栏
                  </button>
                </div>

                <div key={effectiveTab} className="mn-page-enter">
                  {effectiveTab === "minutes" && <MinutesPane key={m.id} meeting={meeting} />}
                  {effectiveTab === "notes" && <NotesPane meeting={meeting} />}
                  {effectiveTab === "qa" && <QaPane meeting={meeting} />}
                </div>
              </section>

              <hr
                aria-orientation="vertical"
                aria-valuemin={32}
                aria-valuemax={68}
                aria-valuenow={Math.round(splitLeftPct)}
                aria-label="拖动调整分屏宽度（双击恢复均分）"
                tabIndex={0}
                onDoubleClick={() => updateSplitRatio(50)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    updateSplitRatio(splitLeftPct - 3);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    updateSplitRatio(splitLeftPct + 3);
                  } else if (e.key === "Home" || e.key === "0") {
                    e.preventDefault();
                    updateSplitRatio(50);
                  }
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || !mainGridRef.current) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  el.setPointerCapture(e.pointerId);
                  setDraggingSplit(true);
                  const prevCursor = document.body.style.cursor;
                  document.body.style.cursor = "col-resize";
                  const onMove = (ev: PointerEvent) => {
                    const r = mainGridRef.current?.getBoundingClientRect();
                    if (r && r.width > 0) {
                      updateSplitRatio(((ev.clientX - r.left) / r.width) * 100);
                    }
                  };
                  const onUp = () => {
                    setDraggingSplit(false);
                    document.body.style.cursor = prevCursor;
                    el.removeEventListener("pointermove", onMove);
                    el.removeEventListener("pointerup", onUp);
                    el.removeEventListener("pointercancel", onUp);
                  };
                  el.addEventListener("pointermove", onMove);
                  el.addEventListener("pointerup", onUp);
                  el.addEventListener("pointercancel", onUp);
                }}
                className="border-0 m-0 self-stretch w-4 h-auto cursor-col-resize flex items-center justify-center bg-transparent after:content-[''] after:block after:w-[3px] after:h-12 after:rounded-full after:bg-transparent hover:after:bg-[var(--line)] focus-visible:after:bg-[var(--ink)]"
              />

              <section className="min-w-0 pl-1">
                <TranscriptPane key={m.id} meeting={meeting} isSplit={true} />
              </section>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 min-h-[39px] mb-3 border-b border-[var(--line-2)]">
                <SlidingTabBar
                  value={effectiveTab}
                  onChange={(nextTab) => {
                    void flushNotes(m.id);
                    setTab(nextTab);
                  }}
                  tabs={tabs}
                  ariaLabel="会议内容视图"
                  className="border-b-0 flex-1"
                />
                {canSplitWidth && (
                  <button
                    type="button"
                    onClick={() => setSplitView(true)}
                    title="左看纪要右看转写稿"
                    className="btn-ghost rounded-[8px] px-2.5 h-[30px] text-[12.5px] inline-flex items-center gap-1.5 cursor-pointer shrink-0 mb-1"
                  >
                    <Columns2 className="w-3.5 h-3.5" aria-hidden="true" /> 分屏
                  </button>
                )}
              </div>

              <div key={effectiveTab} className="mn-page-enter">
                {effectiveTab === "minutes" && <MinutesPane key={m.id} meeting={meeting} />}
                {effectiveTab === "transcript" && <TranscriptPane key={m.id} meeting={meeting} />}
                {effectiveTab === "notes" && <NotesPane meeting={meeting} />}
                {effectiveTab === "qa" && <QaPane meeting={meeting} />}
              </div>
            </div>
          )}
        </>
      )}

      <ContinueRecordDialog
        open={continueOpen}
        meeting={meeting}
        hasEditedParagraphs={hasEditedParagraphs}
        onClose={() => setContinueOpen(false)}
      />

      <RetranscribeDialog
        open={retransOpen}
        meeting={meeting}
        hasEditedParagraphs={hasEditedParagraphs}
        onClose={() => setRetransOpen(false)}
      />
    </div>
  );
}
