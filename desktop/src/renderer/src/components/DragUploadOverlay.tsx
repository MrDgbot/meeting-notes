import type { MeetingMeta } from "@shared/types";
import { Check, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePresence } from "@/components/MotionPrimitives";
import { OFFLINE_MSG } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";
import { useRecorderStore } from "@/stores/recorderStore";

function uploadWithAbort<T = unknown>(
  url: string,
  formData: FormData,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("已取消导入", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      xhr.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    xhr.open("POST", url);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const data = JSON.parse(xhr.responseText || "null");
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve(data as T);
        } else {
          reject(new Error(data?.detail || `上传失败 (${xhr.status})`));
        }
      } catch {
        reject(new Error(`上传失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(OFFLINE_MSG));
    };
    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("已取消导入", "AbortError"));
    };
    xhr.send(formData);
  });
}

function canAutoNavigate(startHash: string): boolean {
  const curHash = window.location.hash || "#/";
  if (curHash !== startHash) return false;

  const rec = useRecorderStore.getState();
  if (rec.active || rec.stopping) return false;

  const meetingState = useMeetingStore.getState();
  if (meetingState.meeting?.live_active || meetingState.meeting?.meta.status === "recording") {
    return false;
  }

  const app = useAppStore.getState();
  if (
    app.paletteOpen ||
    app.shortcutsOpen ||
    app.settingsOpen ||
    app.sidecarOpen ||
    app.ambientIntroOpen ||
    app.vpWizardOpen ||
    app.trashOpen
  ) {
    return false;
  }

  if (document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]')) {
    return false;
  }

  const activeEl = document.activeElement as HTMLElement | null;
  if (
    activeEl &&
    (activeEl.matches("input, textarea, select, [contenteditable]") ||
      activeEl.isContentEditable ||
      Boolean(activeEl.closest("[contenteditable]")))
  ) {
    return false;
  }

  return true;
}

export function DragUploadOverlay() {
  const navigate = useAppStore((s) => s.navigate);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const pushToast = useAppStore((s) => s.pushToast);

  const activeUploadsRef = useRef(0);
  const abortControllersRef = useRef<Set<AbortController>>(new Set());
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dragging, setDragging] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [doneMark, setDoneMark] = useState(false);

  const visible = dragging || uploadPct !== null || doneMark;
  const { mounted, state } = usePresence(visible, 150);

  const cancelActiveUploads = useCallback(() => {
    for (const ac of abortControllersRef.current) {
      ac.abort();
    }
    abortControllersRef.current.clear();
  }, []);

  useEffect(() => {
    let depth = 0;

    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        depth = 0;
        setDragging(false);
      }
    };

    const onWindowBlur = () => {
      depth = 0;
      setDragging(false);
    };

    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      const startHash = window.location.hash || "#/";
      if (doneTimerRef.current) {
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }

      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", file.name.replace(/\.[^.]+$/, ""));
      fd.append("num_spk", "0");
      fd.append("hotword", "");
      fd.append("template", "general");

      const ac = new AbortController();
      abortControllersRef.current.add(ac);
      activeUploadsRef.current += 1;
      setDoneMark(false);
      setUploadPct(0);

      try {
        const meta = await uploadWithAbort<MeetingMeta>(
          "/api/meetings/upload",
          fd,
          (pct) => {
            if (activeUploadsRef.current > 0) setUploadPct(pct);
          },
          ac.signal,
        );
        abortControllersRef.current.delete(ac);
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);

        await loadMeetings();
        pushToast(`已导入「${meta.title}」，正在排队转写`, { tone: "success" });

        if (activeUploadsRef.current === 0) {
          setUploadPct(null);
          setDoneMark(true);
          doneTimerRef.current = setTimeout(() => {
            doneTimerRef.current = null;
            setDoneMark(false);
            if (activeUploadsRef.current === 0 && canAutoNavigate(startHash)) {
              navigate(`#/m/${meta.id}`);
            }
          }, 280);
        }
      } catch (err) {
        abortControllersRef.current.delete(ac);
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
        if (activeUploadsRef.current === 0) {
          setUploadPct(null);
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          if (activeUploadsRef.current === 0) {
            pushToast("已取消导入");
          }
          return;
        }
        pushToast(err instanceof Error ? err.message : "导入失败", { tone: "error", durationMs: 5000 });
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
      if (doneTimerRef.current) {
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      for (const ac of abortControllersRef.current) {
        ac.abort();
      }
      abortControllersRef.current.clear();
    };
  }, [loadMeetings, navigate, pushToast]);

  if (!mounted) return null;

  const pct = Math.max(0, Math.min(100, Math.round(uploadPct ?? 0)));

  return (
    <div
      data-state={state}
      className="mn-backdrop fixed inset-0 z-[70] bg-[var(--backdrop)] backdrop-blur-[4px] flex items-center justify-center p-6 pointer-events-auto"
      onClick={() => {
        if (dragging) setDragging(false);
      }}
    >
      <div
        data-state={state}
        className="mn-dialog rounded-[16px] border-2 border-dashed border-[var(--ink)]/35 bg-[var(--surface-elev)] px-10 py-8 text-center max-w-md w-full shadow-[var(--shadow-3)]"
      >
        {doneMark ? (
          <Check className="w-10 h-10 mx-auto text-[var(--ok)] mb-3" />
        ) : (
          <Upload className="w-10 h-10 mx-auto text-[var(--ink)] mb-3" />
        )}
        {doneMark ? (
          <div className="text-base leading-[24px] font-semibold text-[var(--text)]">导入完成</div>
        ) : uploadPct !== null ? (
          <>
            <div className="text-base leading-[24px] font-semibold text-[var(--text)]">正在导入音视频…</div>
            <div className="mt-3 h-2 rounded-full bg-[var(--fill)] overflow-hidden">
              <div
                className="h-full w-full origin-left bg-[var(--ink)] transition-transform duration-150"
                style={{ transform: `scaleX(${(pct / 100).toFixed(3)})` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-center gap-3">
              <span className="text-xs leading-[18px] text-[var(--muted)] num">{pct}%</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelActiveUploads();
                }}
                className="btn-ghost rounded-[7px] h-7 px-2.5 text-xs leading-[18px] font-medium text-[var(--text-2)] hover:text-[var(--text)] cursor-pointer"
              >
                取消上传
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-base leading-[24px] font-semibold text-[var(--text)]">
              松开即可导入并转写
            </div>
            <p className="mt-1.5 text-[13px] leading-[20px] text-[var(--text-2)]">
              支持 MP3 / WAV / M4A / MP4 / MOV 等常见音视频文件（按 Esc 取消）
            </p>
          </>
        )}
      </div>
    </div>
  );
}
