import { effDuration, fmtDur, hm, STATUS_LABELS, ymd } from "@shared/format";
import type { DayData, DaySummaryData } from "@shared/types";
import { Calendar, ChevronLeft, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { CopyButton, SkeletonLines } from "@/components/MotionPrimitives";
import { api, streamNd } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

function shiftDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y || 2025, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export function DayPage({ date }: { date: string }) {
  const settings = useAppStore((s) => s.settings);
  const ensureSettings = useAppStore((s) => s.ensureSettings);
  const provId = useAppStore((s) => s.provId);
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);

  const [data, setData] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedProv, setSelectedProv] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState("");
  const [genText, setGenText] = useState("");

  const todayStr = ymd(new Date());
  const isTodayOrFuture = date >= todayStr;

  const loadDay = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<DayData>(`/api/days/${encodeURIComponent(date)}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载日报失败");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void ensureSettings();
    void loadDay();
  }, [ensureSettings, loadDay]);

  const providers = settings?.providers || [];
  const activeProv = selectedProv || provId || settings?.active || providers[0]?.id || "";

  const handleGenerateSummary = async () => {
    if (generating) return;
    setGenerating(true);
    setGenStatus("正在整理当日会议记录…");
    setGenText("");
    let acc = "";
    try {
      await streamNd(`/api/days/${encodeURIComponent(date)}/summary`, { provider: activeProv }, (ev) => {
        if (ev.type === "status") {
          setGenStatus(ev.msg || "生成中…");
        } else if (ev.type === "delta") {
          acc += ev.text || "";
          setGenText(acc);
          setGenStatus(`生成中… ${acc.length} 字`);
        } else if (ev.type === "done" && ev.summary) {
          setData((prev) => (prev ? { ...prev, summary: ev.summary as DaySummaryData } : prev));
        } else if (ev.type === "error") {
          throw new Error(ev.msg || "生成失败");
        }
      });
      await loadDay();
    } catch (err) {
      pushToast(`生成失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      setGenerating(false);
      setGenText("");
      setGenStatus("");
    }
  };

  const totalSec = (data?.meetings || []).reduce((acc, m) => acc + effDuration(m), 0);
  const activeSummaryMd = genText || data?.summary?.markdown || "";

  return (
    <div className="max-w-[960px] mx-auto px-7 sm:px-9 py-7 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(`#/day/${shiftDate(date, -1)}`)}
            aria-label="前一天"
            className="btn-secondary rounded-[8px] w-8 h-8 inline-flex items-center justify-center cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          </button>
          <h1 className="text-[24px] leading-[34px] font-semibold tracking-[-0.02em] text-[var(--text)] m-0 inline-flex items-center gap-2 whitespace-nowrap shrink-0">
            <Calendar className="w-5 h-5 text-[var(--muted)] shrink-0" aria-hidden="true" />
            <span className="num">{date}</span>
          </h1>
          <button
            type="button"
            disabled={isTodayOrFuture}
            onClick={() => navigate(`#/day/${shiftDate(date, 1)}`)}
            aria-label="后一天"
            className="btn-secondary rounded-[8px] w-8 h-8 inline-flex items-center justify-center cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </button>
          {date !== todayStr && (
            <button
              type="button"
              onClick={() => navigate(`#/day/${todayStr}`)}
              className="btn-ghost rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
            >
              回到今天
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {providers.length > 1 && (
            <>
              <label htmlFor="dayProvSel" className="sr-only">
                大模型提供方
              </label>
              <select
                id="dayProvSel"
                value={activeProv}
                onChange={(e) => setSelectedProv(e.target.value)}
                disabled={generating}
                className="h-9 rounded-[10px] text-sm leading-[22px] px-3 bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)]"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}

          <button
            type="button"
            disabled={generating || !data?.meetings.length}
            onClick={() => void handleGenerateSummary()}
            className="h-9 px-4 rounded-[10px] text-sm leading-[22px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 active:scale-[0.98]"
          >
            {generating ? (
              <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            )}
            <span>
              {generating ? genStatus || "生成中…" : data?.summary ? "重新生成日报" : "生成每日总结"}
            </span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-6 space-y-3">
          <SkeletonLines lines={5} />
        </div>
      ) : error ? (
        <div className="rounded-[12px] bg-[var(--danger-soft)] text-[var(--danger)] px-4 py-3.5 text-sm leading-[22px]">
          {error}
        </div>
      ) : (
        <>
          {data?.summary_stale && (
            <div className="rounded-[12px] bg-[var(--warn-soft)] text-[var(--warn)] px-4 py-3 text-[13px] leading-[20px] flex items-center justify-between gap-3">
              <span className="num">
                当日新增或更新了 {data.summary_stale.new} 条记录，建议更新今日日报。
              </span>
              <button
                type="button"
                disabled={generating}
                onClick={() => void handleGenerateSummary()}
                className="btn-secondary rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
              >
                立即更新
              </button>
            </div>
          )}

          {data?.auto_error && (
            <div className="rounded-[12px] bg-[var(--danger-soft)] px-4 py-3 text-[13px] leading-[20px] text-[var(--danger)]">
              自动生成日报遇到问题：{data.auto_error.error}
            </div>
          )}

          <section className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-6">
            <div className="flex items-center justify-between gap-3 pb-3.5 mb-4 border-b border-[var(--line-2)]">
              <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                AI 每日总结
              </h2>
              {activeSummaryMd && !generating && (
                <CopyButton text={activeSummaryMd} label="复制日报" successToast="已复制每日总结" size="sm" />
              )}
            </div>
            {activeSummaryMd ? (
              <>
                <MarkdownView markdown={activeSummaryMd} />
                {!genText && data?.summary && (
                  <div className="mt-5 pt-3.5 border-t border-[var(--line-2)] text-xs leading-[18px] text-[var(--muted)] num">
                    {data.summary.model || data.summary.provider} · 涵盖 {data.summary.meetings.length} 场 ·{" "}
                    {data.summary.cost}s
                  </div>
                )}
              </>
            ) : (
              <div className="py-8 text-sm leading-[22px] text-[var(--muted)]">
                {data?.meetings.length
                  ? "点击右上角「生成每日总结」，把这一天的会议与对话整理成结构化日报。"
                  : "这一天还没有会议记录。"}
              </div>
            )}
          </section>

          <section className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                当日记录
              </h2>
              <span className="text-xs leading-[18px] font-medium text-[var(--muted)] whitespace-nowrap shrink-0 num">
                {data?.meetings.length || 0} 场 · 累计 {fmtDur(totalSec)}
              </span>
            </div>
            {(data?.meetings || []).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`#/m/${m.id}`)}
                className="w-full rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] card-interactive px-4 py-3.5 text-left hover:shadow-[var(--shadow-2)] flex items-center justify-between gap-3 cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-[22px] font-medium text-[var(--text)] truncate">
                    {m.title || "未命名会议"}
                  </div>
                  <div className="text-xs leading-[18px] text-[var(--muted)] mt-0.5 num">
                    {hm(m.created)} · {fmtDur(effDuration(m))}
                  </div>
                </div>
                {STATUS_LABELS[m.status] && (
                  <span className="text-xs leading-[18px] font-medium px-2.5 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-2)] whitespace-nowrap shrink-0">
                    {STATUS_LABELS[m.status]}
                  </span>
                )}
              </button>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
