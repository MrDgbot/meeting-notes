import { fmtDur, hm, ymd } from "@shared/format";
import type { WeeklyData, WeeklyReport } from "@shared/types";
import { BookOpenText, ChevronLeft, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { CopyButton, prefersReducedMotion, SkeletonLines } from "@/components/MotionPrimitives";
import { api, streamNd } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

function shiftDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y || 2026, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return ymd(dt);
}

export function WeeklyPage() {
  const settings = useAppStore((s) => s.settings);
  const ensureSettings = useAppStore((s) => s.ensureSettings);
  const provId = useAppStore((s) => s.provId);
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);

  const todayStr = ymd(new Date());
  const [endDate, setEndDate] = useState<string>(todayStr);
  const [data, setData] = useState<WeeklyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState("");
  const [genText, setGenText] = useState("");

  const autoDraftedWeeksRef = useRef<Set<string>>(new Set());
  const meetingsSectionRef = useRef<HTMLElement | null>(null);

  const loadWeek = useCallback(
    async (targetEnd: string) => {
      setLoading(true);
      try {
        const res = await api<WeeklyData>(`/api/weekly?end=${encodeURIComponent(targetEnd)}`);
        setData(res);

        // Auto-assemble an offline draft automatically when a week has meetings but no saved report yet.
        if (res.meeting_count > 0 && !res.report?.markdown && !autoDraftedWeeksRef.current.has(targetEnd)) {
          autoDraftedWeeksRef.current.add(targetEnd);
          void api<{ report?: WeeklyReport }>("/api/weekly/draft", {
            method: "POST",
            body: { end: targetEnd },
          })
            .then((draftRes) => {
              if (draftRes?.report) {
                setData((prev) =>
                  prev && prev.end_date === res.end_date
                    ? { ...prev, report: draftRes.report ?? null }
                    : prev,
                );
              }
            })
            .catch(() => {});
        }
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "加载周报数据失败", 4000);
      } finally {
        setLoading(false);
      }
    },
    [pushToast],
  );

  useEffect(() => {
    void ensureSettings();
    void loadWeek(endDate);
  }, [endDate, ensureSettings, loadWeek]);

  const providers = settings?.providers || [];
  const activeProv = provId || settings?.active || providers[0]?.id || "";
  const activeMarkdown = genText || data?.report?.markdown || "";
  const isCurrentOrFutureWeek = endDate >= todayStr;

  const handleLocalDraft = async () => {
    if (drafting || generating) return;
    setDrafting(true);
    try {
      const res = await api<{ report?: WeeklyReport }>("/api/weekly/draft", {
        method: "POST",
        body: { end: endDate },
      });
      if (res?.report) {
        setData((prev) => (prev ? { ...prev, report: res.report ?? null } : prev));
        pushToast("已根据最新记录更新本地周报草稿", { tone: "success" });
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "整理周报草稿失败", 4000);
    } finally {
      setDrafting(false);
    }
  };

  const handleAiGenerate = async () => {
    if (generating || drafting) return;
    setGenerating(true);
    setGenStatus("正在汇总本周日报与对话记录…");
    setGenText("");
    let acc = "";
    try {
      await streamNd("/api/weekly/generate", { end: endDate, provider: activeProv }, (ev) => {
        if (ev.type === "status") {
          setGenStatus(ev.msg || "润色中…");
        } else if (ev.type === "delta") {
          acc += ev.text || "";
          setGenText(acc);
          setGenStatus(`AI 润色中… ${acc.length} 字`);
        } else if (ev.type === "done" && ev.report) {
          setData((prev) => (prev ? { ...prev, report: ev.report as WeeklyReport } : prev));
        } else if (ev.type === "error") {
          throw new Error(ev.msg || "生成失败");
        }
      });
      await loadWeek(endDate);
    } catch (err) {
      pushToast(`润色失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      setGenerating(false);
      setGenText("");
      setGenStatus("");
    }
  };

  return (
    <div className="max-w-[960px] mx-auto px-5 sm:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEndDate((d) => shiftDate(d, -7))}
              aria-label="上一周"
              className="btn-secondary rounded-lg p-1.5 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            </button>
            <h1 className="text-[24px] font-semibold tracking-[-0.01em] m-0 inline-flex items-center gap-2">
              <BookOpenText className="w-5 h-5 text-[var(--muted)]" aria-hidden="true" />
              <span>周报</span>
            </h1>
            <button
              type="button"
              disabled={isCurrentOrFutureWeek}
              onClick={() => setEndDate((d) => shiftDate(d, 7))}
              aria-label="下一周"
              className="btn-secondary rounded-lg p-1.5 cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
            {!isCurrentOrFutureWeek && (
              <button
                type="button"
                onClick={() => setEndDate(todayStr)}
                className="btn-ghost rounded-lg px-2.5 h-7 text-xs cursor-pointer"
              >
                回到本周
              </button>
            )}
          </div>
          <p className="text-[13px] text-[var(--muted)] m-0 mt-1 num">
            {data
              ? `${data.week_id} · ${data.start_date} ~ ${data.end_date}`
              : "汇总本周会议纪要、重点与待办承诺"}
          </p>
        </div>

        <button
          type="button"
          disabled={generating || drafting || !data || data.meeting_count === 0}
          onClick={() => void handleAiGenerate()}
          className="btn-primary h-9 px-4 rounded-lg text-xs inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{generating ? "AI 润色中…" : "AI 润色"}</span>
        </button>
      </div>

      {data && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-label="本周统计">
          <div className="card-surface p-3.5">
            <div className="text-xs text-[var(--muted)]">活跃天数</div>
            <div className="text-lg font-semibold mt-0.5 num">{data.active_days} 天</div>
          </div>
          <button
            type="button"
            onClick={() =>
              meetingsSectionRef.current?.scrollIntoView({
                behavior: prefersReducedMotion() ? "auto" : "smooth",
                block: "start",
              })
            }
            className="card-surface card-interactive p-3.5 text-left hover:shadow-[var(--shadow-2)] cursor-pointer"
          >
            <div className="text-xs text-[var(--muted)]">沟通记录</div>
            <div className="text-lg font-semibold mt-0.5 num">{data.meeting_count} 段</div>
          </button>
          <div className="card-surface p-3.5">
            <div className="text-xs text-[var(--muted)]">累计时长</div>
            <div className="text-lg font-semibold mt-0.5 num">{fmtDur(data.total_s)}</div>
          </div>
          <button
            type="button"
            onClick={() => navigate("#/todos")}
            className="card-surface card-interactive p-3.5 text-left hover:shadow-[var(--shadow-2)] cursor-pointer"
          >
            <div className="text-xs text-[var(--muted)]">待办与承诺</div>
            <div className="text-lg font-semibold mt-0.5 num">
              {data.todos.length + data.commitments.length} 项
            </div>
          </button>
        </section>
      )}

      <section className="card-surface p-5 space-y-3" aria-label="周报正文">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[var(--line-2)]">
          <div className="text-xs text-[var(--muted)] num flex items-center gap-2">
            {generating && genStatus ? (
              <span className="text-[var(--text-2)] font-medium">{genStatus}</span>
            ) : data?.report?.created ? (
              <span>
                {data.report.provider === "local" ? "自动整理草稿" : data.report.provider || "周报"} ·{" "}
                {hm(data.report.created)} 更新
              </span>
            ) : (
              <span>自动汇总本周记录并生成周报草稿</span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {data && data.meeting_count > 0 && !generating && (
              <button
                type="button"
                disabled={drafting}
                onClick={() => void handleLocalDraft()}
                className="btn-ghost rounded-md px-2 h-7 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${drafting ? "animate-spin" : ""}`} aria-hidden="true" />
                <span>重新汇总</span>
              </button>
            )}
            {activeMarkdown && (
              <CopyButton text={activeMarkdown} label="复制周报" successToast="周报 Markdown 已复制" />
            )}
          </div>
        </div>

        {loading && !data ? (
          <SkeletonLines lines={5} />
        ) : activeMarkdown ? (
          <MarkdownView markdown={activeMarkdown} />
        ) : (
          <div className="py-10 text-center text-sm text-[var(--muted)]">
            本周还没有可用于生成周报的会议或对话记录。
          </div>
        )}
      </section>

      {data && data.meetings.length > 0 && (
        <section
          ref={meetingsSectionRef}
          className="card-surface p-5 space-y-2.5"
          aria-label="本周纳入的记录"
        >
          <h2 className="text-sm font-semibold m-0">本周纳入记录（{data.meetings.length} 段）</h2>
          <div className="space-y-1">
            {data.meetings.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`#/m/${m.id}`)}
                className="w-full card-interactive rounded-[8px] px-2.5 py-2 text-left hover:bg-[var(--fill)] flex items-center justify-between gap-3 cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-[var(--text)] truncate">{m.title}</div>
                  {m.brief && <div className="text-xs text-[var(--text-2)] truncate">{m.brief}</div>}
                </div>
                <span className="text-xs text-[var(--muted)] num shrink-0">
                  {m.created.slice(0, 10)} · {fmtDur(m.duration)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
