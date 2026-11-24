import type { MeetingDetail } from "@shared/types";
import { Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { InlineConfirm, SkeletonLines } from "@/components/MotionPrimitives";
import { api, streamNd } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";

const SUGGESTED_QUESTIONS = [
  "这次会议的主要结论是什么？",
  "有哪些待办？分别是谁负责？",
  "讨论中有哪些分歧或风险？",
  "帮我写一封会后跟进邮件",
];

export function QaPane({ meeting }: { meeting: MeetingDetail }) {
  const settings = useAppStore((s) => s.settings);
  const ensureSettings = useAppStore((s) => s.ensureSettings);
  const provId = useAppStore((s) => s.provId);
  const setProvId = useAppStore((s) => s.setProvId);
  const pushToast = useAppStore((s) => s.pushToast);

  const qaDraft = useMeetingStore((s) => s.qaDraft);
  const clearQaDraft = useMeetingStore((s) => s.clearQaDraft);
  const showMeeting = useMeetingStore((s) => s.showMeeting);
  const requestSeek = useMeetingStore((s) => s.requestSeek);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingQ, setPendingQ] = useState("");
  const [streamAnswer, setStreamAnswer] = useState("");
  const [streamError, setStreamError] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const listBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void ensureSettings();
  }, [ensureSettings]);

  useEffect(() => {
    if (qaDraft && qaDraft.mid === meeting.meta.id) {
      setInput(qaDraft.text);
      clearQaDraft();
      setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
    }
  }, [qaDraft, meeting.meta.id, clearQaDraft]);

  const providers = settings?.providers || [];
  const activeProv = provId || settings?.active || providers[0]?.id || "";
  const hasTranscript = Boolean(meeting.transcript?.paragraphs?.length || meeting.live?.length);

  const handleSend = async (rawQ?: string) => {
    const q = (rawQ ?? input).trim();
    if (!q || sending) return;

    setSending(true);
    if (!rawQ) setInput("");
    setPendingQ(q);
    setStreamAnswer("");
    setStreamError("");

    let acc = "";
    try {
      await streamNd(
        `/api/meetings/${encodeURIComponent(meeting.meta.id)}/ask`,
        {
          question: q,
          provider: activeProv,
        },
        (ev) => {
          if (ev.type === "delta") {
            acc += ev.text || "";
            setStreamAnswer(acc);
          } else if (ev.type === "error") {
            throw new Error(ev.msg || "问答失败");
          }
        },
      );
      await showMeeting(meeting.meta.id, { keepTab: true });
      setPendingQ("");
      setStreamAnswer("");
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "问答失败");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (meeting.qa.length >= 0 || pendingQ || streamAnswer) {
      listBottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [meeting.qa.length, pendingQ, streamAnswer]);

  const handleClear = async () => {
    try {
      const res = await api<{ cleared?: unknown[] }>(
        `/api/meetings/${encodeURIComponent(meeting.meta.id)}/qa`,
        { method: "DELETE" },
      );
      await showMeeting(meeting.meta.id, { keepTab: true });
      const snapshot = Array.isArray(res?.cleared) ? res.cleared : [];
      if (snapshot.length > 0) {
        pushToast(`已清空 ${snapshot.length} 条问答记录`, {
          durationMs: 5600,
          action: {
            label: "撤销",
            onClick: async () => {
              await api(`/api/meetings/${encodeURIComponent(meeting.meta.id)}/qa/restore`, {
                method: "POST",
                body: { items: snapshot },
              });
              await showMeeting(meeting.meta.id, { keepTab: true });
            },
          },
        });
      }
    } catch (err) {
      pushToast(`清空失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {(meeting.qa || []).map((item, idx) => (
          <div key={`${item.t}-${idx}`} className="space-y-1.5">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[var(--ink)] text-[var(--ink-inv)] px-3.5 py-2 text-sm">
                {item.q}
              </div>
            </div>
            <div className="card-surface p-3.5">
              <MarkdownView markdown={item.a} onSeekSec={(sec) => requestSeek(sec * 1000, true)} />
            </div>
          </div>
        ))}

        {pendingQ && (
          <div className="space-y-1.5">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[var(--ink)] text-[var(--ink-inv)] px-3.5 py-2 text-sm">
                {pendingQ}
              </div>
            </div>
            <div className="card-surface p-3.5">
              {streamError ? (
                <div className="text-sm text-[var(--red)]">{streamError}</div>
              ) : streamAnswer ? (
                <MarkdownView markdown={streamAnswer} onSeekSec={(sec) => requestSeek(sec * 1000, true)} />
              ) : (
                <div className="space-y-2 py-0.5">
                  <div className="text-xs text-[var(--muted)]">正在检索相关讨论…</div>
                  <SkeletonLines lines={2} />
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={listBottomRef} />
      </div>

      {!hasTranscript && !meeting.qa.length ? (
        <div className="rounded-xl bg-[var(--fill)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          完成录音或转写后，即可针对这场会议向 AI 提问。
        </div>
      ) : !meeting.qa.length && !pendingQ ? (
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void handleSend(q)}
              className="btn-secondary rounded-full px-3 py-1.5 text-xs cursor-pointer"
            >
              {q}
            </button>
          ))}
        </div>
      ) : null}

      <div className="card-surface p-2.5 flex flex-wrap items-center gap-2">
        {providers.length > 1 && (
          <>
            <label htmlFor="qaProvSel" className="sr-only">
              问答使用的模型
            </label>
            <select
              id="qaProvSel"
              value={activeProv}
              onChange={(e) => setProvId(e.target.value)}
              className="text-xs px-2.5 py-1.5 max-w-[170px]"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        )}

        <input
          ref={inputRef}
          id="qIn"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!hasTranscript}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={
            !hasTranscript
              ? "等待转写完成后即可提问"
              : sending
                ? "正在回答，请稍候…"
                : "就这场会议提问，例如：张伟负责哪些事？"
          }
          aria-label="向 AI 提问"
          className="flex-1 min-w-[200px] px-3 py-1.5 text-sm"
        />

        <button
          type="button"
          disabled={sending || !input.trim() || !hasTranscript}
          onClick={() => void handleSend()}
          className="btn-primary rounded-lg px-3.5 py-1.5 text-xs inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>发送</span>
        </button>

        {meeting.qa.length > 0 && (
          <InlineConfirm
            triggerLabel="清空"
            triggerTitle="清空问答记录"
            triggerIcon={<Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
            triggerClassName="btn-ghost btn-danger rounded-lg px-2.5 py-1.5 text-xs"
            message={`清空这场会议的 ${meeting.qa.length} 条问答记录？`}
            confirmLabel="清空"
            onConfirm={handleClear}
          />
        )}
      </div>
    </div>
  );
}
