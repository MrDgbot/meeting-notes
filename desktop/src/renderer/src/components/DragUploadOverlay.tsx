import type { MeetingMeta } from "@shared/types";
import { Check, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { usePresence } from "@/components/MotionPrimitives";
import { uploadWithProgress } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

export function DragUploadOverlay() {
  const navigate = useAppStore((s) => s.navigate);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const pushToast = useAppStore((s) => s.pushToast);

  const [dragging, setDragging] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [doneMark, setDoneMark] = useState(false);

  const visible = dragging || uploadPct !== null || doneMark;
  const { mounted, state } = usePresence(visible, 150);

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

      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", file.name.replace(/\.[^.]+$/, ""));
      fd.append("num_spk", "0");
      fd.append("hotword", "");
      fd.append("template", "general");

      setUploadPct(0);
      try {
        const meta = await uploadWithProgress<MeetingMeta>("/api/meetings/upload", fd, (pct) =>
          setUploadPct(pct),
        );
        setDoneMark(true);
        setUploadPct(null);
        await loadMeetings();
        pushToast(`已导入「${meta.title}」，正在排队转写`, { tone: "success" });
        setTimeout(() => {
          setDoneMark(false);
          navigate(`#/m/${meta.id}`);
        }, 280);
      } catch (err) {
        setUploadPct(null);
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
            <div className="mt-2 text-xs leading-[18px] text-[var(--muted)] num">{pct}%</div>
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
