import { FolderOpen, RefreshCw, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton, DrawerShell } from "@/components/MotionPrimitives";
import { useAppStore } from "@/stores/appStore";

const PHASE_LABELS: Record<string, string> = {
  running: "运行中",
  bootstrapping: "初始化环境中…",
  starting: "启动中…",
  stopping: "正在停止…",
  stopped: "已停止",
  error: "需要检查",
};

export function SidecarPanel() {
  const open = useAppStore((s) => s.sidecarOpen);
  const setOpen = useAppStore((s) => s.setSidecarOpen);
  const sidecarStatus = useAppStore((s) => s.sidecarStatus);
  const sidecarLogs = useAppStore((s) => s.sidecarLogs);
  const desktopInfo = useAppStore((s) => s.desktopInfo);
  const pushToast = useAppStore((s) => s.pushToast);

  const [restarting, setRestarting] = useState(false);
  const [streamFilter, setStreamFilter] = useState<"all" | "stderr" | "system">("all");
  const logBoxRef = useRef<HTMLDivElement>(null);

  const filteredLogs = sidecarLogs.filter((l) => (streamFilter === "all" ? true : l.stream === streamFilter));

  useEffect(() => {
    const el = logBoxRef.current;
    if (!open || !el || filteredLogs.length === 0) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, filteredLogs.length]);

  useEffect(() => {
    if (!open || !logBoxRef.current) return;
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [open]);

  const handleRestart = async () => {
    if (!window.desktopAPI) return;
    setRestarting(true);
    try {
      await window.desktopAPI.restartSidecar();
      pushToast("正在重启本机语音服务…");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "重启失败", 4000);
    } finally {
      setRestarting(false);
    }
  };

  const logsText =
    filteredLogs.map((l) => `${new Date(l.ts).toISOString()} [${l.stream}] ${l.line}`).join("\n") ||
    "(暂无日志)";

  const phaseDotClass =
    sidecarStatus?.phase === "running"
      ? "bg-[var(--ok)]"
      : sidecarStatus?.phase === "error"
        ? "bg-[var(--danger)]"
        : sidecarStatus?.phase === "starting" || sidecarStatus?.phase === "bootstrapping"
          ? "bg-[var(--warn)]"
          : "bg-[var(--muted)]";

  return (
    <DrawerShell
      open={open}
      onClose={() => setOpen(false)}
      label="本机语音服务状态"
      widthClass="w-full max-w-xl border-l border-[var(--line-2)] bg-[var(--surface-elev)] shadow-[var(--shadow-3)]"
    >
      <div className="px-5 py-4 border-b border-[var(--line-2)] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <Terminal className="w-4 h-4 text-[var(--muted)] shrink-0" />
          <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] whitespace-nowrap truncate m-0">
            本机语音服务状态
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭诊断面板"
          className="btn-ghost rounded-[8px] w-8 h-8 flex items-center justify-center cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 border-b border-[var(--line-2)] space-y-3.5 shrink-0">
        {sidecarStatus ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-[12px] bg-[var(--surface-2)] border border-[var(--line-2)] p-3.5 text-[13px] leading-[20px]">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[var(--muted)] whitespace-nowrap shrink-0">运行状态：</span>
              <span className={`w-2 h-2 rounded-full shrink-0 ${phaseDotClass}`} aria-hidden="true" />
              <span className="font-medium text-[var(--text)] whitespace-nowrap truncate">
                {PHASE_LABELS[sidecarStatus.phase] || sidecarStatus.phase}
              </span>
            </div>
            <div>
              <span className="text-[var(--muted)]">进程 / 端口：</span>
              <span className="font-mono text-xs leading-[18px] text-[var(--text)] num">
                {sidecarStatus.pid ?? "-"} / {sidecarStatus.port ?? "-"}
              </span>
            </div>
            <div className="col-span-2 truncate" title={sidecarStatus.pythonBin ?? ""}>
              <span className="text-[var(--muted)]">运行环境：</span>
              <span className="font-mono text-xs leading-[18px] text-[var(--text-body)]">
                {sidecarStatus.pythonBin ?? "未检测到"}
              </span>
            </div>
            <div className="col-span-2 truncate" title={sidecarStatus.dataDir ?? ""}>
              <span className="text-[var(--muted)]">数据目录：</span>
              <span className="font-mono text-xs leading-[18px] text-[var(--text-body)]">
                {sidecarStatus.dataDir ?? "-"}
              </span>
            </div>
            {sidecarStatus.error && (
              <div className="col-span-2 rounded-[8px] bg-[var(--danger-soft)] text-[var(--danger)] px-3 py-2 text-xs leading-[18px] break-words">
                提示：{sidecarStatus.error}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-[12px] bg-[var(--surface-2)] border border-[var(--line-2)] p-3.5 text-[13px] leading-[20px] text-[var(--text-2)]">
            当前运行在独立网页调试模式。{desktopInfo ? ` 版本 ${desktopInfo.version}` : ""}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {window.desktopAPI && (
            <>
              <button
                type="button"
                onClick={() => void handleRestart()}
                disabled={restarting}
                className="btn-secondary rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${restarting ? "animate-spin" : ""}`} />
                {restarting ? "正在重启…" : "重启服务"}
              </button>
              <button
                type="button"
                onClick={() => void window.desktopAPI?.openDataDir()}
                className="btn-secondary rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                打开数据目录
              </button>
            </>
          )}

          <div className="flex-1" />

          <label className="sr-only" htmlFor="logFilterSel">
            日志级别筛选
          </label>
          <select
            id="logFilterSel"
            value={streamFilter}
            onChange={(e) => setStreamFilter(e.target.value as "all" | "stderr" | "system")}
            className="h-8 rounded-[8px] px-2.5 text-[13px] leading-[20px] bg-[var(--surface)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] shrink-0 transition-colors"
          >
            <option value="all">全部日志</option>
            <option value="stderr">仅错误日志</option>
            <option value="system">仅启停记录</option>
          </select>

          <CopyButton text={logsText} label="复制" successToast="已复制运行日志" size="sm" />
        </div>
      </div>

      <div
        ref={logBoxRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-[20px] bg-[var(--surface-2)] space-y-1"
      >
        {!filteredLogs.length ? (
          <div className="text-[var(--muted)] p-6 text-center font-sans text-[13px] leading-[20px]">
            暂无日志输出
          </div>
        ) : (
          filteredLogs.map((entry, idx) => (
            <div
              key={`${entry.ts}-${idx}`}
              className={`whitespace-pre-wrap break-all px-2.5 py-1 rounded-[6px] ${
                entry.stream === "stderr"
                  ? "text-[var(--danger)] bg-[var(--danger-soft)]"
                  : entry.stream === "system"
                    ? "text-[var(--text)] font-medium"
                    : "text-[var(--text-body)]"
              }`}
            >
              <span className="text-[var(--muted)] mr-2.5 num select-none">
                {new Date(entry.ts).toTimeString().slice(0, 8)}
              </span>
              {entry.line}
            </div>
          ))
        )}
      </div>
    </DrawerShell>
  );
}
