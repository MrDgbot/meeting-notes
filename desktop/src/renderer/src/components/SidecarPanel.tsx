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

  return (
    <DrawerShell
      open={open}
      onClose={() => setOpen(false)}
      label="本机语音服务状态"
      widthClass="w-full max-w-xl border-l border-[var(--line)]"
    >
      <div className="px-4 py-3 border-b border-[var(--line-2)] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-[var(--muted)]" />
          <h2 className="text-sm font-semibold m-0">本机语音服务状态</h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭诊断面板"
          className="btn-ghost rounded-lg w-7 h-7 flex items-center justify-center cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 border-b border-[var(--line-2)] space-y-2.5 text-xs">
        {sidecarStatus ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-[var(--surface-muted)] p-3">
            <div>
              <span className="text-[var(--muted)]">运行状态：</span>
              <span className="font-medium">{PHASE_LABELS[sidecarStatus.phase] || sidecarStatus.phase}</span>
            </div>
            <div>
              <span className="text-[var(--muted)]">进程 / 端口：</span>
              <span className="font-mono num">
                {sidecarStatus.pid ?? "-"} / {sidecarStatus.port ?? "-"}
              </span>
            </div>
            <div className="col-span-2 truncate" title={sidecarStatus.pythonBin ?? ""}>
              <span className="text-[var(--muted)]">运行环境：</span>
              <span className="font-mono">{sidecarStatus.pythonBin ?? "未检测到"}</span>
            </div>
            <div className="col-span-2 truncate" title={sidecarStatus.dataDir ?? ""}>
              <span className="text-[var(--muted)]">数据目录：</span>
              <span className="font-mono">{sidecarStatus.dataDir ?? "-"}</span>
            </div>
            {sidecarStatus.error && (
              <div className="col-span-2 text-[var(--red)] break-words">提示：{sidecarStatus.error}</div>
            )}
          </div>
        ) : (
          <div className="rounded-xl bg-[var(--surface-muted)] p-3 text-[var(--muted)]">
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
                className="btn-secondary rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${restarting ? "animate-spin" : ""}`} />
                {restarting ? "正在重启…" : "重启服务"}
              </button>
              <button
                type="button"
                onClick={() => void window.desktopAPI?.openDataDir()}
                className="btn-secondary rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
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
            className="rounded-lg px-2 py-1 text-xs"
          >
            <option value="all">全部日志</option>
            <option value="stderr">仅错误日志</option>
            <option value="system">仅启停记录</option>
          </select>

          <CopyButton text={logsText} label="复制" successToast="已复制运行日志" />
        </div>
      </div>

      <div
        ref={logBoxRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed bg-[var(--bg)] space-y-1"
      >
        {!filteredLogs.length ? (
          <div className="text-[var(--muted)] p-4 text-center">暂无日志输出</div>
        ) : (
          filteredLogs.map((entry, idx) => (
            <div
              key={`${entry.ts}-${idx}`}
              className={`whitespace-pre-wrap break-all px-2 py-0.5 rounded ${
                entry.stream === "stderr"
                  ? "text-[var(--red)] bg-[var(--red-weak)]/40"
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
    </DrawerShell>
  );
}
