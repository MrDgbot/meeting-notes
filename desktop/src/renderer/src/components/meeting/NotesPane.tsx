import { fmtTs } from "@shared/format";
import type { MeetingDetail } from "@shared/types";
import { Clock } from "lucide-react";
import { useRef } from "react";
import { useMeetingStore } from "@/stores/meetingStore";

export function NotesPane({ meeting, isSplit = false }: { meeting: MeetingDetail; isSplit?: boolean }) {
  const pending = useMeetingStore((s) => s.pendingNotes[meeting.meta.id]);
  const setNotesDraft = useMeetingStore((s) => s.setNotesDraft);
  const playMs = useMeetingStore((s) => s.playMs);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const val = pending ? pending.value : meeting.notes || "";

  const insertPlayTs = () => {
    const stamp = `[${fmtTs(playMs)}] `;
    const el = notesRef.current;
    if (!el) {
      setNotesDraft(meeting.meta.id, `${val}${stamp}`);
      return;
    }
    const s = el.selectionStart ?? val.length;
    const e = el.selectionEnd ?? val.length;
    const next = val.slice(0, s) + stamp + val.slice(e);
    setNotesDraft(meeting.meta.id, next);
    setTimeout(() => {
      el.focus();
      const pos = s + stamp.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  return (
    <div
      className={`rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 flex flex-col gap-3.5 ${
        isSplit ? "" : "max-w-[780px] mx-auto"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 text-[13px] leading-[20px] text-[var(--text-2)]">
          笔记会作为生成 AI 纪要的重点参考，自动保存
        </span>
        <button
          type="button"
          onClick={insertPlayTs}
          className="btn-secondary rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          插入当前播放时间
        </button>
      </div>

      <textarea
        ref={notesRef}
        id="notes"
        aria-label="我的笔记"
        value={val}
        onChange={(e) => setNotesDraft(meeting.meta.id, e.target.value)}
        placeholder="记录重点、决定、待办……"
        className="w-full h-[55vh] min-h-[280px] p-4 rounded-[12px] bg-[var(--surface-2)] border border-[var(--line)] focus:bg-[var(--surface-elev)] focus:border-[var(--line-focus)] text-[15px] leading-[26px] text-[var(--text-body)] placeholder:text-[var(--muted)] resize-y"
      />

      <div
        aria-live="polite"
        className={`text-xs leading-[18px] min-h-[18px] transition-colors duration-200 ${
          pending?.error ? "text-[var(--danger)]" : "text-[var(--muted)]"
        }`}
      >
        {pending?.saving
          ? "正在保存…"
          : pending?.error
            ? `保存失败（将自动重试）：${pending.error}`
            : pending?.dirty
              ? "待保存…"
              : "已自动保存"}
      </div>
    </div>
  );
}
