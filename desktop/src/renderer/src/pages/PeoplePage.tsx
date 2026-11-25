import { fmtDur } from "@shared/format";
import type { PersonMeetingItem, PersonSummary, PersonTimeline, TodoItem } from "@shared/types";
import { ArrowLeft, Pencil, Search, Sparkles, UserCheck, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InlineConfirm, ModalShell, SkeletonLines } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

export function PeoplePage({ personName }: { personName?: string }) {
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);
  const setVpWizardOpen = useAppStore((s) => s.setVpWizardOpen);
  const loadMeetings = useAppStore((s) => s.loadMeetings);

  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [timeline, setTimeline] = useState<PersonTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameMinutes, setRenameMinutes] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);

  const [reassignTarget, setReassignTarget] = useState<PersonMeetingItem | null>(null);
  const [reassignInput, setReassignInput] = useState("");
  const [reassignMinutes, setReassignMinutes] = useState(false);
  const [reassignBusy, setReassignBusy] = useState(false);

  const loadDirectory = useCallback(
    async (withLoading = false) => {
      if (withLoading) setLoading(true);
      try {
        const res = await api<{ people?: PersonSummary[] }>("/api/people");
        setPeople(Array.isArray(res?.people) ? res.people : []);
      } catch (err) {
        if (withLoading) pushToast(err instanceof Error ? err.message : "加载人物列表失败", 4000);
      } finally {
        if (withLoading) setLoading(false);
      }
    },
    [pushToast],
  );

  const loadTimeline = useCallback(
    async (name: string) => {
      setLoading(true);
      try {
        const res = await api<PersonTimeline>(`/api/people/${encodeURIComponent(name)}`);
        setTimeline(res);
        return res;
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "加载人物时间线失败", 4000);
        setTimeline(null);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [pushToast],
  );

  useEffect(() => {
    setReassignTarget(null);
    if (personName) {
      void loadDirectory(false);
      void loadTimeline(personName);
    } else {
      setTimeline(null);
      void loadDirectory(true);
    }
  }, [personName, loadDirectory, loadTimeline]);

  const openRenameModal = (target: string) => {
    setRenameTarget(target);
    setRenameInput(target);
    setRenameMinutes(target.trim().length >= 2);
  };

  const openReassignModal = (m: PersonMeetingItem) => {
    setReassignTarget(m);
    setReassignInput("");
    setReassignMinutes(Boolean(m.has_minutes && (personName || "").trim().length >= 2));
  };

  const submitRename = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!renameTarget || renameBusy) return;
    const nextName = renameInput.trim();
    if (!nextName || nextName === renameTarget) {
      pushToast(nextName === renameTarget ? "新旧姓名相同" : "请输入新的姓名");
      return;
    }
    setRenameBusy(true);
    try {
      const res = await api<{
        ok: boolean;
        new_name: string;
        merged: boolean;
        meetings_updated: number;
      }>("/api/people/rename", {
        method: "POST",
        body: {
          old_name: renameTarget,
          new_name: nextName,
          update_minutes: renameMinutes,
        },
      });
      const prevTarget = renameTarget;
      setRenameTarget(null);
      void loadMeetings();
      await loadDirectory(false);
      pushToast(
        res.merged
          ? `已将「${prevTarget}」合并到「${nextName}」（更新 ${res.meetings_updated} 场）`
          : `已将「${prevTarget}」改为「${nextName}」`,
        { tone: "success", durationMs: 3600 },
      );
      if (personName === prevTarget) {
        navigate(`#/people/${encodeURIComponent(nextName)}`);
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "修改失败", { tone: "error", durationMs: 4000 });
    } finally {
      setRenameBusy(false);
    }
  };

  const submitReassign = async (targetNewName: string) => {
    if (!personName || !reassignTarget || reassignBusy) return;
    const cleanNew = targetNewName.trim();
    if (cleanNew && cleanNew === personName) {
      pushToast("新姓名与当前相同");
      return;
    }
    setReassignBusy(true);
    try {
      await api("/api/people/reassign", {
        method: "POST",
        body: {
          mid: reassignTarget.id,
          old_name: personName,
          new_name: cleanNew,
          spks: reassignTarget.spks,
          update_minutes: Boolean(cleanNew && reassignMinutes),
        },
      });
      const mTitle = reassignTarget.title || "该场会议";
      setReassignTarget(null);
      void loadMeetings();
      void loadDirectory(false);
      pushToast(
        cleanNew ? `已把「${mTitle}」中的发言人改为「${cleanNew}」` : `已取消「${mTitle}」的人物命名`,
        { tone: "success", durationMs: 3600 },
      );
      const updated = await loadTimeline(personName);
      if (!updated || updated.total_meetings === 0) {
        navigate("#/people");
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "修改失败", { tone: "error", durationMs: 4000 });
    } finally {
      setReassignBusy(false);
    }
  };

  const handleDeleteVoiceprint = async () => {
    if (!personName) return;
    try {
      await api(`/api/rsi/voiceprints/${encodeURIComponent(personName)}`, { method: "DELETE" });
      pushToast(`已清除「${personName}」的声纹档案`, { tone: "success" });
      await loadDirectory(false);
      await loadTimeline(personName);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "清除声纹失败", { tone: "error" });
    }
  };

  const handleClearPerson = async () => {
    if (!personName) return;
    try {
      await api("/api/people/clear", {
        method: "POST",
        body: { name: personName },
      });
      void loadMeetings();
      pushToast(`已清除「${personName}」在所有会议中的命名并移除声纹`, { tone: "success" });
      navigate("#/people");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "清除失败", { tone: "error" });
    }
  };

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name.toLowerCase().includes(q));
  }, [people, search]);

  const otherPeople = useMemo(
    () => people.filter((p) => p.name !== (renameTarget || personName)),
    [people, renameTarget, personName],
  );

  const togglePersonTodo = async (it: TodoItem, done: boolean) => {
    setTimeline((prev) =>
      prev
        ? {
            ...prev,
            todos: prev.todos.map((t) => (t.mid === it.mid && t.idx === it.idx ? { ...t, done } : t)),
          }
        : prev,
    );
    try {
      await api("/api/todos/toggle", {
        method: "POST",
        body: { mid: it.mid, idx: it.idx, done },
      });
      if (done) {
        pushToast("已完成待办", {
          tone: "success",
          durationMs: 4500,
          action: {
            label: "撤销",
            onClick: () => void togglePersonTodo(it, false),
          },
        });
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "更新待办失败", 4000);
      if (personName) void loadTimeline(personName);
    }
  };

  const trimmedRename = renameInput.trim();
  const isMergeTarget = Boolean(
    trimmedRename &&
      renameTarget &&
      trimmedRename !== renameTarget &&
      people.some((p) => p.name === trimmedRename),
  );

  const renameModal = (
    <ModalShell
      open={Boolean(renameTarget)}
      onClose={() => {
        if (!renameBusy) setRenameTarget(null);
      }}
      label="修改人物姓名"
      maxWidthClass="max-w-md"
    >
      <form onSubmit={(e) => void submitRename(e)} className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] m-0">修改或合并人物</h2>
            <p className="text-[13px] leading-[20px] text-[var(--text-2)] mt-1 m-0">
              当前人物：<span className="font-semibold text-[var(--text)]">{renameTarget}</span>
            </p>
          </div>
          <button
            type="button"
            disabled={renameBusy}
            onClick={() => setRenameTarget(null)}
            aria-label="关闭修改人物弹窗"
            className="btn-ghost rounded-[6px] w-7 h-7 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="personRenameInput"
            className="block text-[13px] leading-[20px] font-medium text-[var(--text-2)]"
          >
            改为新姓名（输入已有人物名会自动合并两人的会议与声纹）
          </label>
          <input
            id="personRenameInput"
            type="text"
            maxLength={32}
            value={renameInput}
            onChange={(e) => setRenameInput(e.target.value)}
            placeholder="输入正确姓名…"
            className="w-full h-9 px-3 rounded-[10px] text-sm leading-[22px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)]"
          />
          {isMergeTarget && (
            <div className="rounded-[10px] bg-[var(--warn-soft)] text-[var(--warn)] px-3.5 py-2 text-[13px] leading-[20px]">
              将把「{renameTarget}」的全部会议记录与声纹合并到「{trimmedRename}」
            </div>
          )}
        </div>

        {otherPeople.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs leading-[18px] text-[var(--muted)]">快速合并到已有人物：</div>
            <div className="flex flex-wrap gap-1.5">
              {otherPeople.slice(0, 8).map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setRenameInput(p.name)}
                  className={`rounded-full px-3 h-7 text-xs leading-[18px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    trimmedRename === p.name
                      ? "bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)]"
                      : "btn-secondary"
                  }`}
                >
                  <span>{p.name}</span>
                  <span className="opacity-75 num">{p.meetings}场</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-start gap-2.5 text-[13px] leading-[20px] text-[var(--text-2)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={renameMinutes}
            onChange={(e) => setRenameMinutes(e.target.checked)}
            className="mt-0.5 shrink-0"
          />
          <span>同时把已生成纪要正文里的「{renameTarget}」替换为新姓名</span>
        </label>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            disabled={renameBusy}
            onClick={() => setRenameTarget(null)}
            className="btn-ghost rounded-[8px] h-8 px-3.5 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={renameBusy || !trimmedRename || trimmedRename === renameTarget}
            className="rounded-[8px] h-8 px-4 text-[13px] leading-[20px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 disabled:opacity-45"
          >
            {renameBusy ? "处理中…" : isMergeTarget ? "确认合并" : "保存改名"}
          </button>
        </div>
      </form>
    </ModalShell>
  );

  const reassignModal = (
    <ModalShell
      open={Boolean(reassignTarget)}
      onClose={() => {
        if (!reassignBusy) setReassignTarget(null);
      }}
      label="修改单场发言人"
      maxWidthClass="max-w-md"
    >
      <div className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] m-0">
              修改本场认错的发言人
            </h2>
            <p className="text-[13px] leading-[20px] text-[var(--text-2)] mt-1 m-0 truncate">
              {reassignTarget?.title || "未命名会议"}
            </p>
          </div>
          <button
            type="button"
            disabled={reassignBusy}
            onClick={() => setReassignTarget(null)}
            aria-label="关闭单场改人弹窗"
            className="btn-ghost rounded-[6px] w-7 h-7 flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="reassignInput"
            className="block text-[13px] leading-[20px] font-medium text-[var(--text-2)]"
          >
            在这场会议里，「{personName}」实际上是谁？
          </label>
          <input
            id="reassignInput"
            type="text"
            maxLength={32}
            value={reassignInput}
            onChange={(e) => setReassignInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && reassignInput.trim()) {
                e.preventDefault();
                void submitReassign(reassignInput);
              }
            }}
            placeholder="输入正确姓名，或点下方「恢复为未命名」…"
            className="w-full h-9 px-3 rounded-[10px] text-sm leading-[22px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)]"
          />
        </div>

        {otherPeople.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs leading-[18px] text-[var(--muted)]">改为其他已有人物：</div>
            <div className="flex flex-wrap gap-1.5">
              {otherPeople.slice(0, 8).map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setReassignInput(p.name)}
                  className={`rounded-full px-3 h-7 text-xs leading-[18px] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                    reassignInput.trim() === p.name
                      ? "bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)]"
                      : "btn-secondary"
                  }`}
                >
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {reassignTarget?.has_minutes && reassignInput.trim() && (
          <label className="flex items-start gap-2.5 text-[13px] leading-[20px] text-[var(--text-2)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={reassignMinutes}
              onChange={(e) => setReassignMinutes(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span>同时把本场纪要里的「{personName}」替换为新姓名</span>
          </label>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <button
            type="button"
            disabled={reassignBusy}
            onClick={() => void submitReassign("")}
            className="btn-ghost btn-danger rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            恢复为未命名
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={reassignBusy}
              onClick={() => setReassignTarget(null)}
              className="btn-ghost rounded-[8px] h-8 px-3.5 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              disabled={reassignBusy || !reassignInput.trim() || reassignInput.trim() === personName}
              onClick={() => void submitReassign(reassignInput)}
              className="rounded-[8px] h-8 px-4 text-[13px] leading-[20px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 disabled:opacity-45"
            >
              {reassignBusy ? "保存中…" : "确认修改"}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );

  if (personName) {
    const vpSessions = timeline?.voiceprint_sessions ?? 0;
    return (
      <div className="max-w-[960px] mx-auto px-7 sm:px-9 py-7 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => navigate("#/people")}
              className="btn-ghost rounded-[8px] px-2.5 h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              <span>人物管理</span>
            </button>
            <span className="w-10 h-10 rounded-full bg-[var(--ink)] text-[var(--ink-fg)] inline-flex items-center justify-center font-semibold text-base shrink-0">
              {personName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-[24px] leading-[34px] font-semibold tracking-[-0.02em] text-[var(--text)] m-0 truncate">
                  {personName}
                </h1>
                {vpSessions > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ok-soft)] text-[var(--ok)] px-2.5 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 num">
                    <UserCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    已建声纹（{vpSessions} 场）
                  </span>
                )}
              </div>
            </div>
          </div>

          {timeline && timeline.total_meetings > 0 && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => openRenameModal(personName)}
                className="btn-secondary rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                <span>改名 / 合并</span>
              </button>
              {vpSessions > 0 && (
                <InlineConfirm
                  triggerLabel="清除声纹"
                  triggerAriaLabel={`清除声纹：${personName}`}
                  triggerClassName="btn-ghost rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0"
                  message={`清除「${personName}」的声纹记忆档案？会保留所有历史会议里的名字，后续需要重新学习声纹。`}
                  confirmLabel="确认清除"
                  danger
                  onConfirm={handleDeleteVoiceprint}
                />
              )}
              <InlineConfirm
                triggerLabel="清除命名"
                triggerAriaLabel={`清除命名：${personName}`}
                triggerClassName="btn-ghost btn-danger rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0"
                message={`确定把所有会议里的「${personName}」恢复为未命名说话人并删除其声纹档案吗？会议内容与转写文字不会丢失。`}
                confirmLabel="确认清除"
                danger
                onConfirm={handleClearPerson}
              />
            </div>
          )}
        </div>

        {loading ? (
          <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-6">
            <SkeletonLines lines={5} />
          </div>
        ) : !timeline ? (
          <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] py-14 text-center text-sm leading-[22px] text-[var(--muted)]">
            未找到「{personName}」的会议记录
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4">
                <div className="text-xs leading-[18px] text-[var(--muted)]">参与会议</div>
                <div className="text-[20px] leading-[28px] font-semibold tracking-[-0.01em] text-[var(--text)] mt-1 num">
                  {timeline.total_meetings} 场
                </div>
              </div>
              <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4">
                <div className="text-xs leading-[18px] text-[var(--muted)]">累计发言</div>
                <div className="text-[20px] leading-[28px] font-semibold tracking-[-0.01em] text-[var(--text)] mt-1 num">
                  {fmtDur(timeline.total_s)}
                </div>
              </div>
              <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4">
                <div className="text-xs leading-[18px] text-[var(--muted)]">未完待办</div>
                <div className="text-[20px] leading-[28px] font-semibold tracking-[-0.01em] text-[var(--text)] mt-1 num">
                  {timeline.todos.filter((t) => !t.done).length} 项
                </div>
              </div>
            </div>

            {timeline.co_speakers.length > 0 && (
              <section className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 space-y-3">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0">
                  常一起开会
                </h2>
                <div className="flex flex-wrap gap-2">
                  {timeline.co_speakers.map((co) => (
                    <button
                      key={co.name}
                      type="button"
                      onClick={() => navigate(`#/people/${encodeURIComponent(co.name)}`)}
                      className="btn-secondary rounded-full px-3 h-7 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 num cursor-pointer"
                    >
                      {co.name} · {co.count} 场
                    </button>
                  ))}
                </div>
              </section>
            )}

            {timeline.top_terms.length > 0 && (
              <section className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 space-y-3">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0">高频话题</h2>
                <div className="flex flex-wrap gap-2">
                  {timeline.top_terms.map((term) => (
                    <span
                      key={term}
                      className="rounded-full bg-[var(--fill)] px-3 py-0.5 text-xs leading-[18px] text-[var(--text-2)] whitespace-nowrap"
                    >
                      {term}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {timeline.todos.length > 0 && (
              <section className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 space-y-3">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0">相关待办</h2>
                <div className="space-y-1.5">
                  {timeline.todos.map((t) => (
                    <label
                      key={`${t.mid}-${t.idx}`}
                      className="flex items-start gap-2.5 text-sm leading-[22px] py-1 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={t.done}
                        onChange={(e) => void togglePersonTodo(t, e.target.checked)}
                        className="mt-[3px] shrink-0"
                      />
                      <span
                        className={`transition-colors duration-150 ${
                          t.done ? "line-through text-[var(--muted)]" : "text-[var(--text)]"
                        }`}
                      >
                        {t.text}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                  参会时间线
                </h2>
                <span className="text-xs leading-[18px] text-[var(--muted)]">
                  某场认错了人？点右侧「改人」可单独修正
                </span>
              </div>
              {timeline.meetings.map((m) => (
                <div
                  key={m.id}
                  className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-4 py-3.5 flex items-center justify-between gap-3"
                >
                  <button
                    type="button"
                    onClick={() => navigate(`#/m/${m.id}`)}
                    className="flex-1 min-w-0 text-left hover:opacity-80 cursor-pointer transition-opacity"
                  >
                    <div className="text-sm leading-[22px] font-medium text-[var(--text)] truncate">
                      {m.title || "未命名会议"}
                    </div>
                    <div className="text-xs leading-[18px] text-[var(--muted)] mt-0.5 num">
                      {(m.created || "").slice(0, 10)} · 总长 {fmtDur(m.duration)} · 发言 {fmtDur(m.spoken_s)}
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {m.has_minutes && (
                      <span className="text-xs leading-[18px] font-medium px-2 py-0.5 rounded-[6px] bg-[var(--fill)] text-[var(--text-2)] whitespace-nowrap shrink-0">
                        有纪要
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => openReassignModal(m)}
                      aria-label={`改人：${m.title || "未命名会议"}`}
                      title="修改本场发言人"
                      className="btn-secondary rounded-[8px] h-8 px-3 text-xs leading-[18px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Users className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>改人</span>
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </>
        )}

        {renameModal}
        {reassignModal}
      </div>
    );
  }

  return (
    <div className="max-w-[960px] mx-auto px-7 sm:px-9 py-7 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] leading-[34px] font-semibold tracking-[-0.02em] text-[var(--text)] m-0 whitespace-nowrap">
            人物管理
          </h1>
          <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0 mt-1">
            点击人物查看参会记录，可直接改名、合并重复人物或纠正单场认错
          </p>
        </div>
        <button
          type="button"
          onClick={() => setVpWizardOpen(true)}
          className="h-9 px-4 rounded-[10px] text-sm leading-[22px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 active:scale-[0.98]"
        >
          <Sparkles className="w-4 h-4" aria-hidden="true" />
          <span>批量认人</span>
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search
          className="w-4 h-4 text-[var(--muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索发言人姓名…"
          aria-label="搜索发言人"
          className="w-full h-9 pl-9 pr-9 rounded-[10px] text-sm leading-[22px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)]"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label="清空搜索"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded-[6px] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--fill)] cursor-pointer transition-colors"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-6">
          <SkeletonLines lines={5} />
        </div>
      ) : !filteredPeople.length ? (
        <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] py-14 text-center text-sm leading-[22px] text-[var(--muted)]">
          暂无已命名的发言人，可在转写稿中为说话人命名后汇总于此
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {filteredPeople.map((p) => (
            <div
              key={p.name}
              className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-4 flex flex-col justify-between gap-3 hover:shadow-[var(--shadow-2)] transition-shadow"
            >
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => navigate(`#/people/${encodeURIComponent(p.name)}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer"
                >
                  <span className="w-9 h-9 rounded-full bg-[var(--ink)] text-[var(--ink-fg)] inline-flex items-center justify-center font-semibold text-sm shrink-0">
                    {p.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] leading-[22px] font-semibold truncate text-[var(--text)]">
                      {p.name}
                    </div>
                    <div className="text-xs leading-[18px] text-[var(--muted)] truncate whitespace-nowrap num">
                      最近：{(p.last_seen || "").slice(0, 10) || "-"}
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => openRenameModal(p.name)}
                  aria-label={`修改 ${p.name}`}
                  title="改名或合并"
                  className="btn-ghost rounded-[6px] w-7 h-7 inline-flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>

              <div className="pt-2.5 border-t border-[var(--line-2)] flex items-center justify-between gap-2 text-xs leading-[22px] text-[var(--muted)] num">
                <span className="whitespace-nowrap truncate min-w-0">
                  {p.meetings} 场 · {fmtDur(p.total_s)}
                </span>
                {(p.has_voiceprint || p.open_todos > 0) && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {p.has_voiceprint && (
                      <span className="rounded-full bg-[var(--ok-soft)] text-[var(--ok)] px-2 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0">
                        声纹
                      </span>
                    )}
                    {p.open_todos > 0 && (
                      <span className="rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-2 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0">
                        {p.open_todos} 待办
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {renameModal}
    </div>
  );
}
