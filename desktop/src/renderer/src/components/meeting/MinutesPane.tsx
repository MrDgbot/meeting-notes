import { fmtDur, fmtTs } from "@shared/format";
import { countMarkdownTodos } from "@shared/markdown";
import type { LocalLlmStatus, MeetingDetail } from "@shared/types";
import { AlertTriangle, Edit3, Flag, Link2, RefreshCw, Save, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { CopyButton } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";

function formatCheckEntry(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const obj = c as Record<string, unknown>;
    if (typeof obj.msg === "string") return obj.msg;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.text === "string") return obj.text;
    return JSON.stringify(c);
  }
  return String(c ?? "");
}

export function MinutesPane({ meeting, isSplit = false }: { meeting: MeetingDetail; isSplit?: boolean }) {
  const health = useAppStore((s) => s.health);
  const settings = useAppStore((s) => s.settings);
  const ensureSettings = useAppStore((s) => s.ensureSettings);
  const provId = useAppStore((s) => s.provId);
  const pushToast = useAppStore((s) => s.pushToast);
  const navigate = useAppStore((s) => s.navigate);

  const related = useMeetingStore((s) => s.related);
  const gen = useMeetingStore((s) => s.genByMid[meeting.meta.id]);
  const genErr = useMeetingStore((s) => s.genErr);
  const localLlmBusy = useMeetingStore((s) => s.localLlmBusy);
  const generateMinutes = useMeetingStore((s) => s.generateMinutes);
  const startLocalLlm = useMeetingStore((s) => s.startLocalLlm);
  const patchMeeting = useMeetingStore((s) => s.patchMeeting);
  const enqueueTodoToggle = useMeetingStore((s) => s.enqueueTodoToggle);
  const deleteMark = useMeetingStore((s) => s.deleteMark);
  const requestSeek = useMeetingStore((s) => s.requestSeek);

  const templates = useMemo(() => {
    const entries = Object.entries(health?.templates || {});
    return entries.length
      ? entries
      : ([
          ["general", "通用纪要"],
          ["weekly", "周会 / 例会"],
          ["client", "客户访谈"],
          ["interview", "招聘面试"],
        ] as Array<[string, string]>);
  }, [health?.templates]);

  const providers = settings?.providers || [];
  const defaultProv = provId || settings?.active || providers[0]?.id || "";
  const [selectedTpl, setSelectedTpl] = useState(
    meeting.minutes?.template || meeting.meta.template || "general",
  );
  const [selectedProv, setSelectedProv] = useState(defaultProv);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    void ensureSettings();
  }, [ensureSettings]);

  useEffect(() => {
    if (!selectedProv && defaultProv) setSelectedProv(defaultProv);
  }, [defaultProv, selectedProv]);

  useEffect(() => {
    setSelectedTpl(meeting.minutes?.template || meeting.meta.template || "general");
    setEditing(false);
  }, [meeting.minutes?.template, meeting.meta.template]);

  const activeProviderObj = useMemo(
    () => providers.find((p) => p.id === (selectedProv || defaultProv)),
    [providers, selectedProv, defaultProv],
  );
  const isLocalProvider = Boolean(
    activeProviderObj?.base_url && /127\.0\.0\.1|localhost/.test(activeProviderObj.base_url),
  );

  const mn = meeting.minutes;
  const markdownText = gen ? gen.text : mn?.markdown || "";
  const todoStats = useMemo(() => countMarkdownTodos(markdownText), [markdownText]);
  const hasTranscript = Boolean(meeting.transcript?.paragraphs?.length || meeting.live?.length);
  const busy = ["queued", "transcribing", "recording"].includes(meeting.meta.status);
  const canDelMark = !busy && !meeting.live_active && !meeting.ambient_active;

  const checks = Array.isArray(mn?.checks) ? mn.checks : [];
  const highlights = Array.isArray(mn?.highlights) ? mn.highlights : null;
  const hasMarkedHighlight = Boolean(highlights?.some((h) => h.marked));
  const marks = meeting.marks || [];

  const handleGenerate = async () => {
    const prov = selectedProv || defaultProv;
    if (isLocalProvider) {
      try {
        const st = await api<LocalLlmStatus>("/api/llm/local");
        if (st.script && !st.running) {
          pushToast("正在启动本机离线模型，完成后自动开始生成…", 3500);
          const started = await startLocalLlm();
          if (!started?.running) return;
        }
      } catch {}
    }
    await generateMinutes(meeting.meta.id, selectedTpl, prov);
  };

  const handleSaveEdit = async () => {
    setSavingEdit(true);
    try {
      await patchMeeting(meeting.meta.id, { minutes_markdown: editDraft });
      setEditing(false);
      pushToast("纪要正文已保存");
    } catch (err) {
      pushToast(`保存失败：${err instanceof Error ? err.message : "未知错误"}`, 4000);
    } finally {
      setSavingEdit(false);
    }
  };

  const generateControls = (
    <>
      <label htmlFor="tplSel" className="sr-only">
        纪要模板
      </label>
      <select
        id="tplSel"
        value={selectedTpl}
        onChange={(e) => setSelectedTpl(e.target.value)}
        disabled={Boolean(gen) || localLlmBusy}
        className={`h-8 rounded-[8px] text-[13px] leading-[20px] shrink-0 ${isSplit ? "px-2" : "px-2.5"}`}
      >
        {templates.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>

      {providers.length > 1 && (
        <>
          <label htmlFor="minProvSel" className="sr-only">
            大模型提供方
          </label>
          <select
            id="minProvSel"
            value={selectedProv || defaultProv}
            onChange={(e) => setSelectedProv(e.target.value)}
            disabled={Boolean(gen) || localLlmBusy}
            className={`h-8 rounded-[8px] text-[13px] leading-[20px] min-w-0 shrink ${
              isSplit ? "px-2 max-w-[136px]" : "px-2.5 max-w-[210px]"
            }`}
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
        disabled={Boolean(gen) || localLlmBusy || !hasTranscript}
        onClick={() => void handleGenerate()}
        className={`bg-[var(--ink)] hover:bg-[var(--ink-hover)] active:scale-[0.97] text-[var(--ink-fg)] rounded-[8px] h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-[background-color,transform,opacity] duration-150 ${
          isSplit ? "px-3" : "px-3.5"
        }`}
      >
        <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>{localLlmBusy ? "启动本地模型…" : gen ? "生成中…" : mn ? "重新生成" : "生成纪要"}</span>
      </button>
    </>
  );

  const todoPill =
    todoStats.total > 0 ? (
      <span
        aria-live="polite"
        className={`inline-flex items-center gap-2 rounded-full bg-[var(--surface)] shadow-[var(--shadow-1)] text-xs leading-[18px] whitespace-nowrap shrink-0 ${
          isSplit ? "h-7 px-2.5" : "h-8 px-3"
        } ${todoStats.done === todoStats.total ? "text-[var(--ok)] font-medium" : "text-[var(--text-2)]"}`}
      >
        <span className="num">
          待办 {todoStats.done} / {todoStats.total}
        </span>
        <span
          className={`${isSplit ? "w-9" : "w-10"} h-1 rounded-full bg-[var(--fill-hover)] overflow-hidden`}
        >
          <span
            className="block h-full w-full origin-left bg-current transition-transform duration-300 [transition-timing-function:var(--ease-spring)]"
            style={{
              transform: `scaleX(${(todoStats.done / todoStats.total).toFixed(4)})`,
            }}
          />
        </span>
      </span>
    ) : null;

  const editCopyActions =
    mn && !gen ? (
      <>
        <button
          type="button"
          onClick={() => {
            if (editing) {
              setEditing(false);
            } else {
              setEditDraft(mn.markdown || "");
              setEditing(true);
            }
          }}
          className={`btn-ghost rounded-[8px] px-2.5 font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
            isSplit ? "h-7 text-xs leading-[18px]" : "h-8 text-[13px] leading-[20px]"
          }`}
        >
          <Edit3 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{editing ? "取消编辑" : "编辑"}</span>
        </button>

        <CopyButton
          text={markdownText}
          label="复制"
          copiedLabel="已复制"
          successToast="已复制纪要 Markdown"
          size={isSplit ? "xs" : "sm"}
          className="btn-ghost border-0 shadow-none font-medium"
        />
      </>
    ) : null;

  return (
    <div className="space-y-4">
      {isSplit ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 min-w-0">{generateControls}</div>
          {(todoPill || editCopyActions) && (
            <div className="flex items-center justify-between gap-2 min-w-0">
              {todoPill}
              {editCopyActions && (
                <div className="flex items-center gap-1 ml-auto shrink-0">{editCopyActions}</div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {generateControls}
          <div className="flex-1" />
          {todoPill}
          {editCopyActions}
        </div>
      )}

      {gen && (
        <div className="rounded-[12px] bg-[var(--fill)] px-4 py-2.5 text-[13px] leading-[20px] text-[var(--text)] flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="font-medium num">{gen.status}</span>
        </div>
      )}

      {genErr?.id === meeting.meta.id && !gen && (
        <div className="rounded-[12px] bg-[var(--danger-soft)] px-4 py-2.5 text-[13px] leading-[20px] text-[var(--danger)] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>上次生成失败：{genErr.msg}</span>
        </div>
      )}

      {!gen && meeting.minutes_stale.length > 0 && mn && (
        <div className="rounded-[12px] bg-[var(--warn-soft)] px-4 py-2.5 text-[13px] leading-[20px] text-[var(--warn)] flex items-center justify-between gap-3">
          <span>
            {meeting.minutes_stale.includes("transcript")
              ? "转写稿或说话人在生成纪要后有改动，建议重新生成以同步最新内容。"
              : "我的笔记在生成纪要后有新增内容，重新生成可把笔记融入纪要。"}
          </span>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            className="btn-secondary rounded-[8px] h-7 px-2.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            立即更新
          </button>
        </div>
      )}

      {checks.length > 0 && !gen && (
        <div className="rounded-[12px] bg-[var(--warn-soft)] px-4 py-3 text-[13px] leading-[20px] text-[var(--warn)] space-y-1.5">
          <div className="font-medium">AI 自检提示：</div>
          <ul className="m-0 pl-4 list-disc space-y-1">
            {checks.map((c, idx) => (
              <li key={idx}>{formatCheckEntry(c)}</li>
            ))}
          </ul>
        </div>
      )}

      {!editing && !gen && highlights && highlights.length > 0 && (
        <section className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4 sm:p-5 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
              要点
            </h2>
            <span className="text-xs leading-[18px] text-[var(--muted)] text-right">
              点时间跳到转写并播放
              {hasMarkedHighlight ? " · 带旗的是打点处" : ""}
            </span>
          </div>
          <ul className="m-0 p-0 list-none divide-y divide-[var(--line-2)] text-sm leading-[22px] text-[var(--text-body)]">
            {highlights.map((h, idx) => (
              <li key={`${h.text}-${idx}`} className="flex items-start gap-2.5 py-2 first:pt-1 last:pb-0.5">
                {hasMarkedHighlight &&
                  (h.marked ? (
                    <Flag className="w-3.5 h-3.5 text-[var(--warn)] mt-[4px] shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="w-3.5 shrink-0" aria-hidden="true" />
                  ))}
                <span className="flex-1 min-w-0">{h.text}</span>
                {h.start_ms == null ? (
                  <span className="mt-[2px] text-xs leading-[18px] text-[var(--muted)] whitespace-nowrap shrink-0">
                    无出处
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => requestSeek(h.start_ms ?? 0, true)}
                    className="mt-[1px] text-xs leading-[18px] num-mono text-[var(--text-2)] hover:text-[var(--text)] bg-[var(--fill)] hover:bg-[var(--fill-hover)] rounded-full px-2.5 py-0.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    {fmtTs(h.start_ms)}
                    {h.end_ms && Math.floor(h.end_ms / 1000) !== Math.floor(h.start_ms / 1000)
                      ? `–${fmtTs(h.end_ms)}`
                      : ""}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!editing && !gen && marks.length > 0 && (
        <section className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4 sm:p-5 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 num whitespace-nowrap shrink-0">
              打点 · {marks.length}
            </h2>
            <span className="text-xs leading-[18px] text-[var(--muted)] text-right">
              点时间从打点前 5 秒开始回放
            </span>
          </div>
          <ul className="m-0 p-0 list-none divide-y divide-[var(--line-2)] text-sm leading-[22px] text-[var(--text-body)]">
            {marks.map((m) => (
              <li key={m.id} className="flex items-center gap-2.5 py-2 first:pt-1 last:pb-0.5">
                <Flag className="w-3.5 h-3.5 text-[var(--warn)] shrink-0" />
                <span className="flex-1 min-w-0 truncate">
                  {m.snippet || <span className="text-[var(--muted)]">（这里没有转写）</span>}
                </span>
                <button
                  type="button"
                  onClick={() => requestSeek(Math.max(0, m.t_ms - 5000), true)}
                  className="text-xs leading-[18px] num-mono text-[var(--text-2)] hover:text-[var(--text)] bg-[var(--fill)] hover:bg-[var(--fill-hover)] rounded-full px-2.5 py-0.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  {fmtTs(m.t_ms)}
                </button>
                {canDelMark && (
                  <button
                    type="button"
                    onClick={() => void deleteMark(m.id)}
                    aria-label="删除这个打点"
                    className="btn-ghost rounded-full w-7 h-7 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-soft)] shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className={`rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] ${
          isSplit ? "p-5" : "px-7 sm:px-9 py-7"
        }`}
      >
        {editing ? (
          <div className="space-y-3">
            <textarea
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              aria-label="编辑纪要 Markdown"
              className="w-full h-[55vh] p-3.5 rounded-[10px] bg-[var(--surface-2)] border border-[var(--line)] focus:bg-[var(--surface-elev)] focus:border-[var(--line-focus)] font-mono text-[13px] leading-[22px] text-[var(--text-body)]"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="btn-secondary rounded-[8px] h-8 px-3.5 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={savingEdit}
                onClick={() => void handleSaveEdit()}
                className="bg-[var(--ink)] hover:bg-[var(--ink-hover)] active:scale-[0.97] text-[var(--ink-fg)] rounded-[8px] h-8 px-3.5 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-[background-color,transform,opacity] duration-150"
              >
                <Save className="w-3.5 h-3.5 shrink-0" />
                {savingEdit ? "保存中…" : "保存修改"}
              </button>
            </div>
          </div>
        ) : markdownText ? (
          <div className={isSplit ? "" : "max-w-[780px] mx-auto"}>
            <MarkdownView
              markdown={markdownText}
              interactiveTodo={!gen}
              onSeekSec={(sec) => requestSeek(sec * 1000, true)}
              onToggleTodo={(todoIdx, checked) => enqueueTodoToggle(meeting.meta.id, todoIdx, checked)}
            />
            {mn && !gen && (
              <div className="mt-6 pt-3.5 border-t border-[var(--line-2)] text-xs leading-[18px] text-[var(--muted)] flex flex-wrap gap-x-4 gap-y-1 num">
                <span>
                  模型：{mn.provider} / {mn.model}
                </span>
                {mn.cost !== undefined && <span>耗时：{mn.cost}s</span>}
                {mn.edited && <span>已手动修改</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="py-14 text-center text-sm leading-[22px] text-[var(--muted)] max-w-md mx-auto">
            {hasTranscript
              ? "选择模板后点击“生成纪要”，AI 会整理出会议概要、议题、决议、待办和发言人观点"
              : "完成录音或转写后，可在这里生成结构化会议纪要与待办清单"}
          </div>
        )}
      </section>

      {related.length > 0 && (
        <section className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-1.5 text-[15px] leading-[22px] font-semibold text-[var(--text)] whitespace-nowrap">
            <Link2 className="w-4 h-4 text-[var(--muted)] shrink-0" />
            <span>相关会议</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {related.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => navigate(`#/m/${r.id}`)}
                className="text-left rounded-[10px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] p-3.5 transition-colors cursor-pointer"
              >
                <div className="text-sm leading-[22px] font-medium text-[var(--text)] truncate">
                  {r.title || "未命名会议"}
                </div>
                <div className="mt-1 text-xs leading-[18px] text-[var(--muted)] num">
                  {(r.created || "").slice(0, 10)} · {fmtDur(r.duration)}
                </div>
                {(r.shared_speakers.length > 0 || r.shared_terms.length > 0) && (
                  <div className="mt-1 text-xs leading-[18px] text-[var(--text-2)] truncate">
                    {[
                      r.shared_speakers.length ? `共同发言人：${r.shared_speakers.join("、")}` : "",
                      r.shared_terms.length ? `共有话题：${r.shared_terms.join("、")}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
