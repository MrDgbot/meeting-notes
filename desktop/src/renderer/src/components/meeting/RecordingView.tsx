import { fmtDur, fmtTs, GAP_TEXT } from "@shared/format";
import type { LiveSegment, MeetingDetail, RecGap } from "@shared/types";
import { Clock, Flag, Pause, Play, RefreshCw, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { InlineConfirm } from "@/components/MotionPrimitives";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";
import { useRecorderStore } from "@/stores/recorderStore";

interface RecordingViewProps {
  meeting: MeetingDetail;
}

type LiveTimelineEntry =
  | { kind: "gap"; key: string; gap: RecGap }
  | { kind: "seg"; key: string; seg: LiveSegment };

export function RecordingView({ meeting }: RecordingViewProps) {
  const pushToast = useAppStore((s) => s.pushToast);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const showMeeting = useMeetingStore((s) => s.showMeeting);
  const setTab = useMeetingStore((s) => s.setTab);
  const addLiveMark = useMeetingStore((s) => s.addLiveMark);
  const deleteMark = useMeetingStore((s) => s.deleteMark);
  const pendingNote = useMeetingStore((s) => s.pendingNotes[meeting.meta.id]);
  const setNotesDraft = useMeetingStore((s) => s.setNotesDraft);
  const flushNotes = useMeetingStore((s) => s.flushNotes);

  const active = useRecorderStore((s) => s.active);
  const paused = useRecorderStore((s) => s.paused);
  const stopping = useRecorderStore((s) => s.stopping);
  const elapsedMs = useRecorderStore((s) => s.elapsedMs);
  const pendingSec = useRecorderStore((s) => s.pendingSec);
  const level = useRecorderStore((s) => s.level);
  const conn = useRecorderStore((s) => s.conn);
  const channels = useRecorderStore((s) => s.channels);
  const lost = useRecorderStore((s) => s.lost);
  const stall = useRecorderStore((s) => s.stall);
  const finals = useRecorderStore((s) => s.finals);
  const partial = useRecorderStore((s) => s.partial);
  const gaps = useRecorderStore((s) => s.gaps);
  const pause = useRecorderStore((s) => s.pause);
  const resume = useRecorderStore((s) => s.resume);
  const stop = useRecorderStore((s) => s.stop);
  const reconnectDevice = useRecorderStore((s) => s.reconnectDevice);
  const giveUp = useRecorderStore((s) => s.giveUp);

  const liveBoxRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const noteValue = pendingNote ? pendingNote.value : meeting.notes || "";

  // Keyboard shortcut 'M' to mark while actively recording and not typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.shiftKey) return;
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
      if (target?.closest("input, textarea, select, [contenteditable]") && !e.altKey) return;
      e.preventDefault();
      void addLiveMark();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addLiveMark]);

  const timeline = useMemo<LiveTimelineEntry[]>(() => {
    const prev = (meeting.live || []).filter((x) => {
      const firstNew = finals[0];
      return !firstNew || x.start < firstNew.start;
    });
    const mergedSegs = [...prev, ...finals];
    const sortedGaps = [...gaps].sort((a, b) => a.at_ms - b.at_ms);

    const out: LiveTimelineEntry[] = [];
    let gi = 0;
    for (let i = 0; i < mergedSegs.length; i++) {
      const seg = mergedSegs[i];
      if (!seg) continue;
      while (gi < sortedGaps.length) {
        const g = sortedGaps[gi];
        if (!g || g.at_ms > seg.start) break;
        out.push({ kind: "gap", key: `gap-${g.at_ms}-${gi}`, gap: g });
        gi += 1;
      }
      out.push({ kind: "seg", key: `seg-${seg.start}-${i}`, seg });
    }
    while (gi < sortedGaps.length) {
      const g = sortedGaps[gi];
      if (g) out.push({ kind: "gap", key: `gap-tail-${g.at_ms}-${gi}`, gap: g });
      gi += 1;
    }
    return out;
  }, [meeting.live, finals, gaps]);

  useEffect(() => {
    const el = liveBoxRef.current;
    if (!el || (!timeline.length && !partial?.text)) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      el.scrollTop = el.scrollHeight;
    }
  }, [timeline.length, partial?.text]);

  const statusText = stopping
    ? "正在保存录音"
    : lost === "mic"
      ? "麦克风已断开"
      : stall
        ? "录不到声音"
        : paused
          ? "已暂停（暂停期间不录音）"
          : conn === "reconnecting"
            ? "录音中 · 等待重连"
            : lost === "sys"
              ? "只录麦克风"
              : "正在录音并实时转写";

  const isWarnState = Boolean(lost || stall || paused || stopping);
  const meterPct = Math.min(100, Math.round(Math.sqrt(Math.max(0, level)) * 140));

  const handleStop = async () => {
    await flushNotes(meeting.meta.id);
    const r = await stop();
    if (r.gaveUp && r.lost > 0) {
      const bps = channels === 2 ? 64000 : 32000;
      pushToast(`没等传完就结束了：最后 ${fmtDur(r.lost / bps)} 的录音未保存`, 8000);
    }
    await loadMeetings();
    setTab("transcript");
    await showMeeting(meeting.meta.id, { keepTab: true });
  };

  const insertTimestamp = () => {
    const el = notesRef.current;
    const stamp = `[${fmtTs(elapsedMs)}] `;
    if (!el) {
      setNotesDraft(meeting.meta.id, `${noteValue}${stamp}`);
      return;
    }
    const start = el.selectionStart ?? noteValue.length;
    const end = el.selectionEnd ?? noteValue.length;
    const next = noteValue.slice(0, start) + stamp + noteValue.slice(end);
    setNotesDraft(meeting.meta.id, next);
    setTimeout(() => {
      el.focus();
      const caret = start + stamp.length;
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  return (
    <div className="space-y-4">
      {stopping && (
        <div className="rounded-[12px] bg-[var(--surface-2)] shadow-[var(--shadow-1)] px-4 py-3 flex items-center justify-between gap-3 text-[13px] leading-[20px] text-[var(--text)]">
          <span>
            正在把剩下的录音传到后端…
            {conn !== "ok" ? " 连接断开了，正在重连；" : ""}
            已暂存 <span className="num font-medium">{fmtDur(pendingSec)}</span>
          </span>
          <InlineConfirm
            triggerLabel="不等了，直接结束"
            triggerClassName="h-8 rounded-[8px] bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] px-3 text-[13px] leading-[20px] font-medium text-[var(--text)] whitespace-nowrap shrink-0 transition-colors"
            message={`还有 ${fmtDur(pendingSec)} 暂存录音未传完，强行结束会丢失这段尾部音频。`}
            confirmLabel="直接结束"
            onConfirm={giveUp}
          />
        </div>
      )}

      {!stopping && conn === "reconnecting" && (
        <div className="rounded-[12px] bg-[var(--warn-soft)] ring-1 ring-inset ring-[var(--warn)]/25 px-4 py-3 text-[13px] leading-[20px] text-[var(--text)]">
          和后端的连接断开了，正在重连… 录音没有停，已暂存{" "}
          <span className="num font-medium">{fmtDur(pendingSec)}</span>（最多 15 分钟），连上后自动补传
        </div>
      )}

      {!stopping && stall && (
        <div className="rounded-[12px] bg-[var(--danger-soft)] ring-1 ring-inset ring-[var(--danger)]/25 px-4 py-3 flex items-center justify-between gap-3 text-[13px] leading-[20px] text-[var(--text)]">
          <span>现在录不到声音：{GAP_TEXT[stall.reason] || GAP_TEXT.stall}</span>
          <button
            type="button"
            onClick={() => void reconnectDevice()}
            className="h-8 rounded-[8px] bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] px-3 text-[13px] leading-[20px] font-medium text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            继续录音
          </button>
        </div>
      )}

      {!stopping && lost && (
        <div className="rounded-[12px] bg-[var(--danger-soft)] ring-1 ring-inset ring-[var(--danger)]/25 px-4 py-3 flex items-center justify-between gap-3 text-[13px] leading-[20px] text-[var(--text)]">
          <span>
            {lost === "sys" ? "电脑声音已断开，现在只录到麦克风" : "麦克风断开了，现在什么都录不到"}
          </span>
          <button
            type="button"
            onClick={() => void reconnectDevice().catch((e) => pushToast(String(e), 5000))}
            className="h-8 rounded-[8px] bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] px-3 text-[13px] leading-[20px] font-medium text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            重新连接{lost === "sys" ? "电脑声音" : "麦克风"}
          </button>
        </div>
      )}

      <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-4 py-3 flex flex-wrap items-center gap-3">
        <div
          className={`inline-flex items-center gap-2 h-7 px-2.5 rounded-full whitespace-nowrap shrink-0 ${
            isWarnState ? "bg-[var(--warn-soft)]" : "bg-[var(--danger-soft)]"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isWarnState ? "bg-[var(--warn)]" : "bg-[var(--danger)] rec-dot"
            }`}
            aria-hidden="true"
          />
          <span className="text-xs leading-[18px] font-semibold text-[var(--text)] num-mono">
            {fmtTs(elapsedMs)}
          </span>
        </div>

        <div className="w-24 h-1.5 rounded-full bg-[var(--fill)] overflow-hidden shrink-0" aria-hidden="true">
          <div
            className="h-full w-full origin-left bg-[var(--ok)] transition-transform duration-75"
            style={{ transform: `scaleX(${(meterPct / 100).toFixed(3)})` }}
          />
        </div>

        <span className="text-[13px] leading-[20px] text-[var(--text-2)] whitespace-nowrap">
          {statusText}
        </span>

        <div className="flex-1" />

        <button
          type="button"
          disabled={stopping || !active}
          onClick={() => void addLiveMark()}
          title="给当前时刻打个点，生成纪要时优先覆盖这里（快捷键 M）"
          className="h-9 rounded-[10px] px-3.5 text-sm leading-[22px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          <Flag className="w-4 h-4 text-[var(--text-2)] shrink-0" />
          <span>标记</span>
          <kbd className="font-mono text-[11px] leading-[14px] text-[var(--text-2)] bg-[var(--surface)] shadow-[var(--shadow-1)] px-1.5 py-0.5 rounded-[4px] shrink-0">
            M
          </kbd>
        </button>

        <button
          type="button"
          disabled={stopping}
          onClick={() => (paused ? resume() : pause())}
          className="h-9 rounded-[10px] px-3.5 text-sm leading-[22px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          <span
            className="relative w-4 h-4 inline-flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <Play
              className={`w-4 h-4 absolute transition-[opacity,transform] duration-150 ${
                paused ? "opacity-100 scale-100" : "opacity-0 scale-75"
              }`}
            />
            <Pause
              className={`w-4 h-4 absolute transition-[opacity,transform] duration-150 ${
                paused ? "opacity-0 scale-75" : "opacity-100 scale-100"
              }`}
            />
          </span>
          <span>{paused ? "继续" : "暂停"}</span>
        </button>

        <button
          type="button"
          disabled={stopping}
          onClick={() => void handleStop()}
          className="h-9 rounded-[10px] px-4 text-sm leading-[22px] font-medium bg-[var(--danger)] hover:opacity-90 active:scale-[0.98] text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-[opacity,transform] duration-150"
        >
          <Square className="w-3.5 h-3.5 fill-current shrink-0" />
          <span>{stopping ? "保存中…" : "结束录音"}</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs leading-[18px]">
        {meeting.marks.length ? (
          <>
            <span className="text-[var(--muted)] font-medium whitespace-nowrap shrink-0">
              打点 <span className="num">{meeting.marks.length}</span>：
            </span>
            {meeting.marks.map((m) => (
              <span
                key={m.id}
                className="h-7 inline-flex items-center gap-1.5 rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-2.5 text-xs leading-[18px] font-medium num-mono whitespace-nowrap shrink-0"
              >
                <Flag className="w-3 h-3 shrink-0" />
                {fmtTs(m.t_ms)}
                <button
                  type="button"
                  onClick={() => void deleteMark(m.id)}
                  aria-label={`删除 ${fmtTs(m.t_ms)} 打点`}
                  className="hover:opacity-75 rounded-full p-0.5 cursor-pointer transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </>
        ) : (
          <span className="text-xs leading-[18px] text-[var(--muted)]">
            按「标记」或键盘 M / 全局 ⌘⇧M，给重点内容打个点；生成纪要时会优先覆盖这些地方
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 flex flex-col h-[58vh]">
          <div className="flex items-center justify-between gap-2 min-h-[45px] pb-3 border-b border-[var(--line-2)]">
            <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] whitespace-nowrap shrink-0 m-0">
              实时转写
            </h2>
            <span className="text-xs leading-[18px] text-[var(--muted)] truncate min-w-0">
              {channels === 2 ? "麦克风和电脑声音分开识别；会后再精转" : "会后会重新精准转写并区分说话人"}
            </span>
          </div>

          <div ref={liveBoxRef} className="flex-1 overflow-y-auto pt-3.5 space-y-3">
            {!timeline.length && !partial ? (
              <div className="h-full flex items-center justify-center text-sm leading-[22px] text-[var(--muted)]">
                开始说话，文字会实时出现在这里
              </div>
            ) : (
              <>
                {timeline.map((item) => {
                  if (item.kind === "gap") {
                    return (
                      <div
                        key={item.key}
                        className="rounded-[10px] bg-[var(--warn-soft)] text-[var(--warn)] px-3 py-2 text-xs leading-[18px] flex items-center gap-2"
                      >
                        <Clock className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          这里有 <span className="num">{fmtDur(Math.max(1, item.gap.dur_ms / 1000))}</span>{" "}
                          没录到：
                          {GAP_TEXT[item.gap.reason] || GAP_TEXT.stall}
                        </span>
                      </div>
                    );
                  }
                  const tag = item.seg.ch === 0 ? "我" : item.seg.ch === 1 ? "对方" : "";
                  return (
                    <div key={item.key} className="flex items-start gap-3">
                      <span className="text-xs leading-[26px] text-[var(--muted)] num-mono whitespace-nowrap shrink-0">
                        {fmtTs(item.seg.start)}
                      </span>
                      <div className="flex-1 min-w-0 text-[15px] leading-[26px] text-[var(--text-body)]">
                        {tag && (
                          <span className="inline-flex items-center text-xs leading-[18px] font-medium text-[var(--text-2)] bg-[var(--fill)] rounded-[6px] px-1.5 py-0.5 mr-2 align-baseline whitespace-nowrap shrink-0">
                            {tag}
                          </span>
                        )}
                        <span>{item.seg.text}</span>
                      </div>
                    </div>
                  );
                })}

                {partial && (
                  <div className="flex items-start gap-3 text-[var(--muted)] italic">
                    <span className="text-xs leading-[26px] num-mono whitespace-nowrap shrink-0">
                      {fmtTs(elapsedMs)}
                    </span>
                    <div className="flex-1 min-w-0 text-[15px] leading-[26px]">
                      {partial.ch === 0 ? "我 · " : partial.ch === 1 ? "对方 · " : ""}
                      {partial.text}…
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 flex flex-col h-[58vh]">
          <div className="flex items-center justify-between gap-2 min-h-[45px] pb-3 border-b border-[var(--line-2)]">
            <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] whitespace-nowrap shrink-0 m-0">
              我的笔记
            </h2>
            <button
              type="button"
              onClick={insertTimestamp}
              className="h-8 rounded-[8px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] px-2.5 text-[13px] leading-[20px] font-medium text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Clock className="w-3.5 h-3.5 text-[var(--text-2)] shrink-0" />
              插入时间点
            </button>
          </div>
          <textarea
            ref={notesRef}
            value={noteValue}
            onChange={(e) => setNotesDraft(meeting.meta.id, e.target.value)}
            aria-label="我的笔记"
            placeholder={"记录重点、决定、待办……\nAI 生成纪要时会重点参考这里的内容"}
            className="flex-1 mt-3.5 p-3.5 rounded-[12px] bg-[var(--surface-2)] border border-[var(--line)] focus:bg-[var(--surface-elev)] focus:border-[var(--line-focus)] text-[15px] leading-[26px] text-[var(--text-body)] placeholder:text-[var(--muted)] resize-none transition-colors"
          />
          <div className="mt-2.5 text-xs leading-[18px] text-[var(--muted)] min-h-[18px]">
            {pendingNote?.saving
              ? "保存中…"
              : pendingNote?.error
                ? `保存失败（将自动重试）：${pendingNote.error}`
                : pendingNote?.dirty
                  ? "未保存，稍后自动保存…"
                  : "已自动保存"}
          </div>
        </section>
      </div>
    </div>
  );
}
