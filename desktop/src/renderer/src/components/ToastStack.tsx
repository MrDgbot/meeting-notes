import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/stores/appStore";

export function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const pauseToast = useAppStore((s) => s.pauseToast);
  const resumeToast = useAppStore((s) => s.resumeToast);
  const pushToast = useAppStore((s) => s.pushToast);
  const [busyIds, setBusyIds] = useState<Record<number, boolean>>({});

  if (!toasts.length || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed bottom-4 right-4 z-[90] flex flex-col items-end gap-2 max-w-[min(380px,calc(100vw-2rem))] pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-closing={t.closing ? "true" : undefined}
          onMouseEnter={() => pauseToast(t.id)}
          onMouseLeave={() => resumeToast(t.id)}
          className="mn-toast-slot pointer-events-auto"
        >
          <div>
            <div className="flex items-center gap-2 rounded-[10px] bg-[var(--ink)] text-[var(--ink-inv)] pl-3.5 pr-2 py-2 text-[13px] shadow-[var(--shadow-pop)]">
              {t.tone !== "default" && (
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    t.tone === "success" ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
              )}
              <span className="flex-1 leading-snug">{t.msg}</span>
              {t.action && (
                <button
                  type="button"
                  disabled={Boolean(busyIds[t.id])}
                  onClick={async () => {
                    const act = t.action;
                    if (!act || busyIds[t.id]) return;
                    pauseToast(t.id);
                    setBusyIds((prev) => ({ ...prev, [t.id]: true }));
                    try {
                      await act.onClick();
                      dismissToast(t.id);
                    } catch (err) {
                      resumeToast(t.id);
                      pushToast(err instanceof Error ? err.message : "操作失败，请重试", {
                        tone: "error",
                        durationMs: 4000,
                      });
                    } finally {
                      setBusyIds((prev) => {
                        const next = { ...prev };
                        delete next[t.id];
                        return next;
                      });
                    }
                  }}
                  className="rounded-[6px] px-2 py-0.5 text-xs font-medium bg-[var(--ink-inv)]/15 hover:bg-[var(--ink-inv)]/25 transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-wait"
                >
                  {busyIds[t.id] ? "处理中…" : t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                aria-label="关闭提示"
                className="w-6 h-6 rounded-[6px] inline-flex items-center justify-center opacity-75 hover:opacity-100 hover:bg-[var(--ink-inv)]/15 transition-colors cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
