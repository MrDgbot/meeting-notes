import { fmtTs } from "@shared/format";
import type { MeetingDetail } from "@shared/types";
import { Clock } from "lucide-react";
import { useRef } from "react";
import { useMeetingStore } from "@/stores/meetingStore";

export function NotesPane({ meeting }: { meeting: MeetingDetail }) {
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
    <div className="card-surface p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--muted)]">笔记会作为生成 AI 纪要的重点参考，自动保存</span>
        <button
          type="button"
          onClick={insertPlayTs}
          className="btn-secondary rounded-lg px-2.5 py-1 text-xs inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Clock className="w-3.5 h-3.5" />
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
        className="w-full h-[55vh] p-3 text-sm leading-relaxed resize-y"
      />

      <div
        aria-live="polite"
        className={`text-xs min-h-[18px] transition-colors duration-200 ${
          pending?.error ? "text-[var(--red)]" : "text-[var(--muted)]"
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
