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
    <div className="max-w-4xl mx-auto px-5 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate(`#/day/${shiftDate(date, -1)}`)}
            aria-label="前一天"
            className="btn-secondary rounded-lg p-1.5 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h1 className="text-xl font-semibold m-0 inline-flex items-center gap-2 num">
            <Calendar className="w-5 h-5 text-[var(--muted)]" />
            <span>{date}</span>
          </h1>
          <button
            type="button"
            disabled={isTodayOrFuture}
            onClick={() => navigate(`#/day/${shiftDate(date, 1)}`)}
            aria-label="后一天"
            className="btn-secondary rounded-lg p-1.5 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {date !== todayStr && (
            <button
              type="button"
              onClick={() => navigate(`#/day/${todayStr}`)}
              className="btn-ghost rounded-lg px-2.5 h-7 text-xs cursor-pointer"
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
                className="text-xs px-2.5 py-1.5"
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
            className="btn-primary rounded-lg px-3.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
          >
            {generating ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span>
              {generating ? genStatus || "生成中…" : data?.summary ? "重新生成日报" : "生成每日总结"}
            </span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card-surface p-5 space-y-3">
          <SkeletonLines lines={5} />
        </div>
      ) : error ? (
        <div className="rounded-xl bg-[var(--red-weak)] text-[var(--red)] p-4 text-sm">{error}</div>
      ) : (
        <>
          {data?.summary_stale && (
            <div className="rounded-xl bg-[var(--amber-weak)] text-[var(--amber)] px-4 py-2.5 text-xs flex items-center justify-between gap-2">
              <span>当日新增或更新了 {data.summary_stale.new} 条记录，建议更新今日日报。</span>
              <button
                type="button"
                disabled={generating}
                onClick={() => void handleGenerateSummary()}
                className="btn-secondary rounded-lg px-2.5 py-1 text-xs cursor-pointer shrink-0"
              >
                立即更新
              </button>
            </div>
          )}

          {data?.auto_error && (
            <div className="rounded-xl bg-[var(--red-weak)] px-4 py-2.5 text-xs text-[var(--red)]">
              自动生成日报遇到问题：{data.auto_error.error}
            </div>
          )}

          <section className="card-surface p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold m-0">AI 每日总结</h2>
              {activeSummaryMd && !generating && (
                <CopyButton text={activeSummaryMd} label="复制日报" successToast="已复制每日总结" />
              )}
            </div>
            {activeSummaryMd ? (
              <>
                <MarkdownView markdown={activeSummaryMd} />
                {!genText && data?.summary && (
                  <div className="mt-4 pt-3 border-t border-[var(--line-2)] text-xs text-[var(--muted)] num">
                    {data.summary.model || data.summary.provider} · 涵盖 {data.summary.meetings.length} 场 ·{" "}
                    {data.summary.cost}s
                  </div>
                )}
              </>
            ) : (
              <div className="py-6 text-xs text-[var(--muted)]">
                {data?.meetings.length
                  ? "点击右上角「生成每日总结」，把这一天的会议与对话整理成结构化日报。"
                  : "这一天还没有会议记录。"}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="text-xs font-medium text-[var(--muted)] num">
              当日记录 · {data?.meetings.length || 0} 场 · 累计 {fmtDur(totalSec)}
            </div>
            {(data?.meetings || []).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`#/m/${m.id}`)}
                className="w-full card-surface card-interactive p-3.5 text-left hover:bg-[var(--btn-hover)] flex items-center justify-between gap-3 cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{m.title || "未命名会议"}</div>
                  <div className="text-xs text-[var(--muted)] mt-0.5 num">
                    {hm(m.created)} · {fmtDur(effDuration(m))}
                  </div>
                </div>
                {STATUS_LABELS[m.status] && (
                  <span className="text-xs px-2 py-0.5 rounded bg-[var(--fill)] text-[var(--text-2)]">
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
