import type { BootstrapMirror, BootstrapProgress } from "@shared/types";
import { AlertTriangle, AudioLines, Check, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/MotionPrimitives";
import { useAppStore } from "@/stores/appStore";

const STEPS: Array<{ key: BootstrapProgress["stage"]; label: string; desc: string }> = [
  { key: "python", label: "准备 Python 3.11", desc: "自动拉取独立运行时，不影响系统环境" },
  { key: "deps", label: "安装语音与 AI 组件", desc: "首次安装所需依赖，之后启动无需重复下载" },
  { key: "verify", label: "校验并启动语音服务", desc: "检查转写引擎组件并拉起本机服务" },
];

function stepIndex(stage: BootstrapProgress["stage"] | undefined): number {
  if (stage === "python") return 0;
  if (stage === "deps") return 1;
  if (stage === "verify" || stage === "starting") return 2;
  return 0;
}

export function BootstrapOverlay() {
  const sidecarStatus = useAppStore((s) => s.sidecarStatus);
  const sidecarLogs = useAppStore((s) => s.sidecarLogs);
  const pushToast = useAppStore((s) => s.pushToast);

  const [logsExpanded, setLogsExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const visible =
    sidecarStatus?.phase === "bootstrapping" ||
    (sidecarStatus?.phase === "error" && Boolean(sidecarStatus.bootstrap));

  const isError = sidecarStatus?.phase === "error";
  const boot = sidecarStatus?.bootstrap;
  const activeIdx = stepIndex(boot?.stage);
  const pct = Math.max(4, Math.min(100, boot?.percent ?? 8));
  const currentMirror: BootstrapMirror = boot?.mirror ?? "cn";

  const latestTs = sidecarLogs[sidecarLogs.length - 1]?.ts ?? 0;

  useEffect(() => {
    if (!visible || !logsExpanded || !logRef.current || latestTs === 0) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible, logsExpanded, latestTs]);

  if (!visible || !boot) return null;

  const title = isError
    ? "环境初始化遇到网络问题"
    : boot.isUpgrade
      ? "版本升级：正在更新本机语音组件"
      : "首次启动：正在准备本机语音环境";

  const subtitle = isError
    ? "请检查网络连接，或切换下载源后重试"
    : "只需首次准备一次，音频与转写数据均保留在你的电脑上";

  const logsText =
    sidecarLogs
      .map((l) => `${new Date(l.ts).toTimeString().slice(0, 8)} [${l.stream}] ${l.line}`)
      .join("\n") || "(暂无日志)";
  const latestLog = sidecarLogs[sidecarLogs.length - 1]?.line;

  const triggerRetry = async (mirror: BootstrapMirror) => {
    if (!window.desktopAPI?.retryBootstrap || retrying) return;
    setRetrying(true);
    try {
      await window.desktopAPI.retryBootstrap(mirror);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "重试失败", 4000);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      aria-label="运行环境初始化"
      className="fixed inset-0 z-[45] bg-[var(--bg)] flex flex-col overflow-y-auto"
    >
      <div className="h-[38px] shrink-0 app-drag" aria-hidden="true" />

      <div className="flex-1 flex items-center justify-center px-5 pb-10 pt-2">
        <div className="w-full max-w-[560px] rounded-[20px] bg-[var(--surface)] border border-[var(--line-2)] shadow-[var(--shadow-1)] p-6 sm:p-7 space-y-5">
          <div className="flex items-start gap-3.5">
            <span
              className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${
                isError ? "bg-[var(--red-weak)] text-[var(--red)]" : "bg-[var(--ink)] text-[var(--ink-inv)]"
              }`}
            >
              {isError ? (
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              ) : (
                <AudioLines className="w-5 h-5" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h1 className="text-[17px] font-semibold tracking-[-0.015em] text-[var(--text)] m-0">
                {title}
              </h1>
              <p className="text-[12.5px] text-[var(--muted)] mt-1 m-0">{subtitle}</p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs gap-2">
              <span className="text-[var(--text-2)] truncate">{boot.message}</span>
              <span className="num text-[var(--muted)] shrink-0">{pct}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-[var(--fill)] overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${
                  isError ? "bg-[var(--red)]" : "bg-[var(--ink)]"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {latestLog && !logsExpanded && (
              <div className="text-[11.5px] font-mono text-[var(--muted)] truncate pt-0.5">{latestLog}</div>
            )}
          </div>

          <div className="space-y-2 rounded-[14px] bg-[var(--fill)] p-3.5">
            {STEPS.map((st, idx) => {
              const done = !isError && idx < activeIdx;
              const current = idx === activeIdx;
              return (
                <div key={st.key} className="flex items-start gap-2.5 py-1">
                  <span
                    className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] shrink-0 ${
                      done
                        ? "bg-[var(--green)] text-white"
                        : current
                          ? isError
                            ? "bg-[var(--red)] text-white"
                            : "bg-[var(--ink)] text-[var(--ink-inv)]"
                          : "bg-[var(--surface)] text-[var(--muted)] border border-[var(--line-2)]"
                    }`}
                  >
                    {done ? (
                      <Check className="w-3 h-3" aria-hidden="true" />
                    ) : current && !isError ? (
                      <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    ) : (
                      idx + 1
                    )}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={`text-[13px] font-medium leading-snug ${
                        done || current ? "text-[var(--text)]" : "text-[var(--muted)]"
                      }`}
                    >
                      {st.label}
                    </div>
                    <div className="text-[11.5px] text-[var(--muted)]">{st.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {isError && sidecarStatus?.error && (
            <div className="rounded-[12px] bg-[var(--red-weak)] text-[var(--red)] px-3.5 py-2.5 text-xs leading-relaxed break-words">
              {sidecarStatus.error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
            <fieldset
              className="flex flex-wrap items-center gap-1.5 border-0 p-0 m-0"
              aria-label="下载源切换"
            >
              <button
                type="button"
                disabled={retrying}
                aria-pressed={currentMirror === "cn"}
                onClick={() => void triggerRetry("cn")}
                className={`rounded-[8px] px-3 h-8 text-xs cursor-pointer transition-colors ${
                  currentMirror === "cn"
                    ? "bg-[var(--ink)] text-[var(--ink-inv)] font-medium"
                    : "btn-secondary"
                }`}
              >
                国内加速源（清华 PyPI）
              </button>
              <button
                type="button"
                disabled={retrying}
                aria-pressed={currentMirror === "official"}
                onClick={() => void triggerRetry("official")}
                className={`rounded-[8px] px-3 h-8 text-xs cursor-pointer transition-colors ${
                  currentMirror === "official"
                    ? "bg-[var(--ink)] text-[var(--ink-inv)] font-medium"
                    : "btn-secondary"
                }`}
              >
                官方默认源（PyPI）
              </button>
            </fieldset>

            {isError && (
              <button
                type="button"
                disabled={retrying}
                onClick={() => void triggerRetry(currentMirror)}
                className="btn-primary rounded-[9px] px-4 h-9 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${retrying ? "animate-spin" : ""}`} aria-hidden="true" />
                <span>{retrying ? "重试中…" : "重试初始化"}</span>
              </button>
            )}
          </div>

          <div className="pt-1 border-t border-[var(--line-2)] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                aria-expanded={logsExpanded}
                onClick={() => setLogsExpanded((v) => !v)}
                className="btn-ghost rounded-[8px] px-2.5 h-8 text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-150 ${logsExpanded ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                <span>{logsExpanded ? "收起日志" : "展开日志"}</span>
              </button>
              <CopyButton text={logsText} label="复制日志" successToast="已复制初始化日志" />
            </div>

            {logsExpanded && (
              <div
                ref={logRef}
                className="max-h-44 overflow-y-auto rounded-[10px] bg-[var(--bg)] border border-[var(--line-2)] p-2.5 font-mono text-[11px] leading-relaxed space-y-0.5"
              >
                {sidecarLogs.length === 0 ? (
                  <div className="text-[var(--muted)]">等待日志输出…</div>
                ) : (
                  sidecarLogs.slice(-120).map((entry, idx) => (
                    <div
                      key={`${entry.ts}-${idx}`}
                      className={`whitespace-pre-wrap break-all ${
                        entry.stream === "stderr"
                          ? "text-[var(--red)]"
                          : entry.stream === "system"
                            ? "text-[var(--link)]"
                            : "text-[var(--text-body)]"
                      }`}
                    >
                      <span className="text-[var(--muted)] mr-2 num">
                        {new Date(entry.ts).toTimeString().slice(0, 8)}
                      </span>
                      {entry.line}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
