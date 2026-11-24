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
      <form onSubmit={(e) => void submitRename(e)} className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text)] m-0">修改或合并人物</h2>
            <p className="text-xs text-[var(--muted)] mt-0.5 m-0">
              当前人物：<b className="text-[var(--text)]">{renameTarget}</b>
            </p>
          </div>
          <button
            type="button"
            disabled={renameBusy}
            onClick={() => setRenameTarget(null)}
            aria-label="关闭修改人物弹窗"
            className="btn-ghost rounded-[7px] w-[28px] h-[28px] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2">
          <label htmlFor="personRenameInput" className="block text-xs font-medium text-[var(--text-2)]">
            改为新姓名（输入已有人物名会自动合并两人的会议与声纹）
          </label>
          <input
            id="personRenameInput"
            type="text"
            maxLength={32}
            value={renameInput}
            onChange={(e) => setRenameInput(e.target.value)}
            placeholder="输入正确姓名…"
            className="w-full h-9 px-3 text-[13px]"
          />
          {isMergeTarget && (
            <div className="rounded-[8px] bg-[var(--amber-weak)] text-[var(--amber)] px-3 py-1.5 text-xs">
              将把「{renameTarget}」的全部会议记录与声纹合并到「{trimmedRename}」
            </div>
          )}
        </div>

        {otherPeople.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11.5px] text-[var(--muted)]">快速合并到已有人物：</div>
            <div className="flex flex-wrap gap-1.5">
              {otherPeople.slice(0, 8).map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setRenameInput(p.name)}
                  className={`rounded-full px-2.5 h-[28px] text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                    trimmedRename === p.name ? "btn-primary" : "btn-secondary"
                  }`}
                >
                  <span>{p.name}</span>
                  <span className="opacity-70 num">{p.meetings}场</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="flex items-start gap-2 text-xs text-[var(--text-2)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={renameMinutes}
            onChange={(e) => setRenameMinutes(e.target.checked)}
            className="mt-0.5"
          />
          <span>同时把已生成纪要正文里的「{renameTarget}」替换为新姓名</span>
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={renameBusy}
            onClick={() => setRenameTarget(null)}
            className="btn-ghost rounded-[8px] h-8 px-3 text-xs cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={renameBusy || !trimmedRename || trimmedRename === renameTarget}
            className="btn-primary rounded-[8px] h-8 px-3.5 text-xs font-medium cursor-pointer disabled:opacity-50"
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
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--text)] m-0">修改本场认错的发言人</h2>
            <p className="text-xs text-[var(--muted)] mt-0.5 m-0 truncate">
              {reassignTarget?.title || "未命名会议"}
            </p>
          </div>
          <button
            type="button"
            disabled={reassignBusy}
            onClick={() => setReassignTarget(null)}
            aria-label="关闭单场改人弹窗"
            className="btn-ghost rounded-[7px] w-[28px] h-[28px] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2">
          <label htmlFor="reassignInput" className="block text-xs font-medium text-[var(--text-2)]">
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
            className="w-full h-9 px-3 text-[13px]"
          />
        </div>

        {otherPeople.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11.5px] text-[var(--muted)]">改为其他已有人物：</div>
            <div className="flex flex-wrap gap-1.5">
              {otherPeople.slice(0, 8).map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setReassignInput(p.name)}
                  className={`rounded-full px-2.5 h-[28px] text-xs inline-flex items-center gap-1 cursor-pointer transition-colors ${
                    reassignInput.trim() === p.name ? "btn-primary" : "btn-secondary"
                  }`}
                >
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {reassignTarget?.has_minutes && reassignInput.trim() && (
          <label className="flex items-start gap-2 text-xs text-[var(--text-2)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={reassignMinutes}
              onChange={(e) => setReassignMinutes(e.target.checked)}
              className="mt-0.5"
            />
            <span>同时把本场纪要里的「{personName}」替换为新姓名</span>
          </label>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={reassignBusy}
            onClick={() => void submitReassign("")}
            className="btn-ghost btn-danger rounded-[8px] h-8 px-2.5 text-xs cursor-pointer"
          >
            恢复为未命名
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={reassignBusy}
              onClick={() => setReassignTarget(null)}
              className="btn-ghost rounded-[8px] h-8 px-3 text-xs cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              disabled={reassignBusy || !reassignInput.trim() || reassignInput.trim() === personName}
              onClick={() => void submitReassign(reassignInput)}
              className="btn-primary rounded-[8px] h-8 px-3.5 text-xs font-medium cursor-pointer disabled:opacity-50"
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
      <div className="max-w-[960px] mx-auto px-5 sm:px-8 py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => navigate("#/people")}
              className="btn-ghost rounded-[8px] px-2.5 h-[28px] text-xs inline-flex items-center gap-1 cursor-pointer shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> 人物管理
            </button>
            <span className="w-10 h-10 rounded-full bg-[var(--ink)] text-[var(--ink-inv)] inline-flex items-center justify-center font-semibold text-base shrink-0">
              {personName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[22px] font-semibold m-0 truncate">{personName}</h1>
                {vpSessions > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--green-weak)] text-[var(--green)] px-2 py-0.5 text-[11px] font-medium num">
                    <UserCheck className="w-3 h-3" aria-hidden="true" />
                    已建声纹（{vpSessions} 场）
                  </span>
                )}
              </div>
            </div>
          </div>

          {timeline && timeline.total_meetings > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => openRenameModal(personName)}
                className="btn-secondary rounded-[8px] h-[28px] px-3 text-xs inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Pencil className="w-3 h-3" aria-hidden="true" />
                <span>改名 / 合并</span>
              </button>
              {vpSessions > 0 && (
                <InlineConfirm
                  triggerLabel="清除声纹"
                  triggerAriaLabel={`清除声纹：${personName}`}
                  triggerClassName="btn-ghost rounded-[8px] h-[28px] px-2.5 text-xs"
                  message={`清除「${personName}」的声纹记忆档案？会保留所有历史会议里的名字，后续需要重新学习声纹。`}
                  confirmLabel="确认清除"
                  danger
                  onConfirm={handleDeleteVoiceprint}
                />
              )}
              <InlineConfirm
                triggerLabel="清除命名"
                triggerAriaLabel={`清除命名：${personName}`}
                triggerClassName="btn-ghost btn-danger rounded-[8px] h-[28px] px-2.5 text-xs"
                message={`确定把所有会议里的「${personName}」恢复为未命名说话人并删除其声纹档案吗？会议内容与转写文字不会丢失。`}
                confirmLabel="确认清除"
                danger
                onConfirm={handleClearPerson}
              />
            </div>
          )}
        </div>

        {loading ? (
          <div className="card-surface p-5">
            <SkeletonLines lines={5} />
          </div>
        ) : !timeline ? (
          <div className="card-surface py-12 text-center text-sm text-[var(--muted)]">
            未找到「{personName}」的会议记录
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="card-surface p-4">
                <div className="text-xs text-[var(--muted)]">参与会议</div>
                <div className="text-lg font-semibold mt-1 num">{timeline.total_meetings} 场</div>
              </div>
              <div className="card-surface p-4">
                <div className="text-xs text-[var(--muted)]">累计发言</div>
                <div className="text-lg font-semibold mt-1 num">{fmtDur(timeline.total_s)}</div>
              </div>
              <div className="card-surface p-4">
                <div className="text-xs text-[var(--muted)]">未完待办</div>
                <div className="text-lg font-semibold mt-1 num">
                  {timeline.todos.filter((t) => !t.done).length} 项
                </div>
              </div>
            </div>

            {timeline.co_speakers.length > 0 && (
              <section className="card-surface p-4 space-y-2">
                <h2 className="text-sm font-semibold m-0">常一起开会</h2>
                <div className="flex flex-wrap gap-1.5">
                  {timeline.co_speakers.map((co) => (
                    <button
                      key={co.name}
                      type="button"
                      onClick={() => navigate(`#/people/${encodeURIComponent(co.name)}`)}
                      className="btn-secondary rounded-full px-3 h-[28px] text-xs num cursor-pointer"
                    >
                      {co.name} · {co.count} 场
                    </button>
                  ))}
                </div>
              </section>
            )}

            {timeline.top_terms.length > 0 && (
              <section className="card-surface p-4 space-y-2">
                <h2 className="text-sm font-semibold m-0">高频话题</h2>
                <div className="flex flex-wrap gap-1.5">
                  {timeline.top_terms.map((term) => (
                    <span
                      key={term}
                      className="rounded-full bg-[var(--fill)] px-2.5 py-0.5 text-xs text-[var(--text-2)]"
                    >
                      {term}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {timeline.todos.length > 0 && (
              <section className="card-surface p-4 space-y-2">
                <h2 className="text-sm font-semibold m-0">相关待办</h2>
                <div className="space-y-1.5">
                  {timeline.todos.map((t) => (
                    <label
                      key={`${t.mid}-${t.idx}`}
                      className="flex items-start gap-2.5 text-sm py-1 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={t.done}
                        onChange={(e) => void togglePersonTodo(t, e.target.checked)}
                        className="mt-1"
                      />
                      <span
                        className={`transition-colors duration-150 ${
                          t.done ? "line-through text-[var(--muted)]" : ""
                        }`}
                      >
                        {t.text}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold m-0">参会时间线</h2>
                <span className="text-xs text-[var(--muted)]">某场认错了人？点右侧「改人」可单独修正</span>
              </div>
              {timeline.meetings.map((m) => (
                <div key={m.id} className="card-surface p-3.5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => navigate(`#/m/${m.id}`)}
                    className="flex-1 min-w-0 text-left hover:opacity-80 cursor-pointer transition-opacity"
                  >
                    <div className="text-sm font-medium truncate">{m.title || "未命名会议"}</div>
                    <div className="text-xs text-[var(--muted)] mt-0.5 num">
                      {(m.created || "").slice(0, 10)} · 总长 {fmtDur(m.duration)} · 发言 {fmtDur(m.spoken_s)}
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {m.has_minutes && (
                      <span className="text-xs px-2 py-0.5 rounded bg-[var(--fill)] text-[var(--text-2)]">
                        有纪要
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => openReassignModal(m)}
                      aria-label={`改人：${m.title || "未命名会议"}`}
                      title="修改本场发言人"
                      className="btn-secondary rounded-[7px] h-[28px] px-2.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Users className="w-3 h-3" aria-hidden="true" />
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
    <div className="max-w-[960px] mx-auto px-5 sm:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] m-0">人物管理</h1>
          <p className="text-[13.5px] text-[var(--muted)] m-0 mt-1">
            点击人物查看参会记录，可直接改名、合并重复人物或纠正单场认错
          </p>
        </div>
        <button
          type="button"
          onClick={() => setVpWizardOpen(true)}
          className="btn-secondary h-9 px-3.5 rounded-lg text-xs inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          <span>批量认人</span>
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search
          className="w-3.5 h-3.5 text-[var(--muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索发言人姓名…"
          aria-label="搜索发言人"
          className="w-full pl-8 pr-8 py-1.5 text-[13px]"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            aria-label="清空搜索"
            className="absolute right-1 top-1/2 -translate-y-1/2 w-[26px] h-[26px] inline-flex items-center justify-center rounded-md text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {loading ? (
        <div className="card-surface p-5">
          <SkeletonLines lines={5} />
        </div>
      ) : !filteredPeople.length ? (
        <div className="card-surface py-12 text-center text-sm text-[var(--muted)]">
          暂无已命名的发言人，可在转写稿中为说话人命名后汇总于此
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredPeople.map((p) => (
            <div
              key={p.name}
              className="card-surface p-4 space-y-3 hover:shadow-[var(--shadow-2)] transition-shadow"
            >
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => navigate(`#/people/${encodeURIComponent(p.name)}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer"
                >
                  <span className="w-[34px] h-[34px] rounded-full bg-[var(--ink)] text-[var(--ink-inv)] inline-flex items-center justify-center font-semibold text-sm shrink-0">
                    {p.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold truncate text-[var(--text)]">{p.name}</div>
                    <div className="text-[11.5px] text-[var(--muted)] num">
                      最近：{(p.last_seen || "").slice(0, 10) || "-"}
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => openRenameModal(p.name)}
                  aria-label={`修改 ${p.name}`}
                  title="改名或合并"
                  className="btn-ghost rounded-[7px] w-[28px] h-[28px] inline-flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>

              <div className="pt-2 border-t border-[var(--line-2)] flex items-center justify-between gap-2 text-xs text-[var(--muted)] num">
                <span>
                  参会 {p.meetings} 场 · 累计发言 {fmtDur(p.total_s)}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {p.has_voiceprint && (
                    <span className="rounded-full bg-[var(--green-weak)] text-[var(--green)] px-1.5 py-0 text-[10.5px] font-medium">
                      声纹
                    </span>
                  )}
                  {p.open_todos > 0 && (
                    <span className="rounded-full bg-[var(--amber-weak)] text-[var(--amber)] px-2 py-0 text-[11px] font-medium">
                      {p.open_todos} 待办
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {renameModal}
    </div>
  );
}
