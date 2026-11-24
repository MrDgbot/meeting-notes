import { tsToSec } from "@shared/format";
import type {
  CommitmentItem,
  CommitmentsResponse,
  PersonSummary,
  TodoItem,
  TodosResponse,
} from "@shared/types";
import { CheckSquare, ExternalLink, Radar, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SegmentedControl, SkeletonLines } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

export function TodosPage() {
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);

  const [viewMode, setViewMode] = useState<"todos" | "commitments">("todos");
  const [statusFilter, setStatusFilter] = useState<"open" | "done" | "all">("open");
  const [dirFilter, setDirFilter] = useState<"all" | "mine" | "theirs">("all");
  const [personFilter, setPersonFilter] = useState("");
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [resp, setResp] = useState<TodosResponse | null>(null);
  const [commResp, setCommResp] = useState<CommitmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsingTodos, setCollapsingTodos] = useState<Record<string, boolean>>({});
  const [collapsingCommits, setCollapsingCommits] = useState<Record<string, boolean>>({});
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const loadSeqRef = useRef(0);
  const filterKey = `${statusFilter}|${personFilter}`;
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      if (mountedRef.current) fn();
    }, ms);
    timersRef.current.add(id);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
    };
  }, []);

  const lastLoadedFilterRef = useRef(filterKey);

  const loadTodos = useCallback(async () => {
    const curFilter = `${statusFilter}|${personFilter}`;
    if (lastLoadedFilterRef.current !== curFilter) {
      lastLoadedFilterRef.current = curFilter;
      setCollapsingTodos({});
      setCollapsingCommits({});
    }
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: statusFilter });
      if (personFilter) qs.set("person", personFilter);
      const [todoData, commData] = await Promise.all([
        api<TodosResponse>(`/api/todos?${qs.toString()}`),
        api<CommitmentsResponse>(`/api/commitments?status=${statusFilter}&days=30`),
      ]);
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setResp(todoData);
      setCommResp(commData);
    } catch (err) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      pushToast(err instanceof Error ? err.message : "加载待办失败", 4000);
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [statusFilter, personFilter, pushToast]);
  const loadTodosRef = useRef(loadTodos);
  loadTodosRef.current = loadTodos;

  useEffect(() => {
    void api<{ people?: PersonSummary[] }>("/api/people")
      .then((res) => setPeople(Array.isArray(res?.people) ? res.people : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const filteredItems = useMemo(() => {
    const items = resp?.items || [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.text.toLowerCase().includes(q) ||
        it.meeting_title.toLowerCase().includes(q) ||
        (it.speakers || []).some((sp) => sp.toLowerCase().includes(q)),
    );
  }, [resp, search]);

  const filteredCommitments = useMemo(() => {
    let items = commResp?.items || [];
    if (dirFilter !== "all") {
      items = items.filter((it) => it.direction === dirFilter);
    }
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.text.toLowerCase().includes(q) ||
        it.meeting_title.toLowerCase().includes(q) ||
        it.who.toLowerCase().includes(q),
    );
  }, [commResp, dirFilter, search]);

  const scheduleCollapseAndReload = (key: string, setter: typeof setCollapsingTodos) => {
    const originFilter = filterKeyRef.current;
    scheduleTimer(() => {
      if (filterKeyRef.current !== originFilter) return;
      setter((m) => ({ ...m, [key]: true }));
      scheduleTimer(() => {
        setter((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        if (filterKeyRef.current === originFilter) {
          void loadTodosRef.current();
        }
      }, 220);
    }, 350);
  };

  const handleToggle = async (item: TodoItem, checked: boolean) => {
    const key = `${item.mid}-${item.idx}`;
    setResp((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((x) =>
          x.mid === item.mid && x.idx === item.idx ? { ...x, done: checked } : x,
        ),
      };
    });

    try {
      await api("/api/todos/toggle", {
        method: "POST",
        body: { mid: item.mid, idx: item.idx, done: checked },
      });
      const willFilterOut = (statusFilter === "open" && checked) || (statusFilter === "done" && !checked);
      if (willFilterOut) {
        scheduleCollapseAndReload(key, setCollapsingTodos);
      } else {
        void loadTodos();
      }
      if (checked) {
        pushToast("已完成待办", {
          tone: "success",
          durationMs: 5600,
          action: {
            label: "撤销",
            onClick: async () => {
              await api("/api/todos/toggle", {
                method: "POST",
                body: { mid: item.mid, idx: item.idx, done: false },
              });
              await loadTodosRef.current();
            },
          },
        });
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "更新待办失败", 4000);
      void loadTodos();
    }
  };

  const handleToggleCommitment = async (item: CommitmentItem, checked: boolean) => {
    const key = `${item.mid}-${item.id}`;
    setCommResp((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((x) =>
              x.mid === item.mid && x.id === item.id ? { ...x, done: checked } : x,
            ),
          }
        : prev,
    );
    try {
      await api("/api/commitments/toggle", {
        method: "POST",
        body: { mid: item.mid, id: item.id, done: checked },
      });
      const willFilterOut = (statusFilter === "open" && checked) || (statusFilter === "done" && !checked);
      if (willFilterOut) {
        scheduleCollapseAndReload(key, setCollapsingCommits);
      } else {
        void loadTodos();
      }
      if (checked) {
        pushToast("已标记承诺完成", {
          tone: "success",
          durationMs: 5600,
          action: {
            label: "撤销",
            onClick: async () => {
              await api("/api/commitments/toggle", {
                method: "POST",
                body: { mid: item.mid, id: item.id, done: false },
              });
              await loadTodosRef.current();
            },
          },
        });
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "更新承诺失败", 4000);
      void loadTodosRef.current();
    }
  };

  const handleDismissCommitment = async (item: CommitmentItem) => {
    const key = `${item.mid}-${item.id}`;
    const originFilter = filterKeyRef.current;
    try {
      setCollapsingCommits((m) => ({ ...m, [key]: true }));
      await api("/api/commitments/dismiss", {
        method: "POST",
        body: { mid: item.mid, id: item.id },
      });
      scheduleTimer(() => {
        setCollapsingCommits((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        if (filterKeyRef.current === originFilter) {
          void loadTodosRef.current();
        }
      }, 220);
      pushToast("已忽略该承诺提醒", {
        durationMs: 5600,
        action: {
          label: "撤销",
          onClick: async () => {
            await api("/api/commitments/restore", {
              method: "POST",
              body: { mid: item.mid, id: item.id },
            });
            await loadTodosRef.current();
          },
        },
      });
    } catch (err) {
      setCollapsingCommits((m) => {
        const next = { ...m };
        delete next[key];
        return next;
      });
      pushToast(err instanceof Error ? err.message : "操作失败", 4000);
    }
  };

  const hasNarrowFilters =
    Boolean(search.trim()) ||
    (viewMode === "todos" && Boolean(personFilter)) ||
    (viewMode === "commitments" && dirFilter !== "all") ||
    statusFilter !== "open";

  const resetFilters = () => {
    setSearch("");
    setPersonFilter("");
    setDirFilter("all");
    setStatusFilter("open");
  };

  return (
    <div className="max-w-4xl mx-auto px-5 py-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold m-0 flex items-center gap-2">
            {viewMode === "todos" ? (
              <CheckSquare className="w-5 h-5 text-[var(--muted)]" aria-hidden="true" />
            ) : (
              <Radar className="w-5 h-5 text-[var(--muted)]" aria-hidden="true" />
            )}
            <span>待办中心</span>
          </h1>
          <p className="text-xs text-[var(--muted)] m-0 mt-1 num">
            {viewMode === "todos"
              ? resp
                ? `当前显示 ${filteredItems.length} 项 · 未完成 ${resp.counts.open} · 已完成 ${resp.counts.done}`
                : "汇总所有会议纪要中的行动项与负责人"
              : commResp
                ? `当前显示 ${filteredCommitments.length} 项 · 待跟进 ${commResp.counts.open} · 超期 ${commResp.counts.overdue}`
                : "从对话原声中自动捕捉的口头答应与待对方反馈事项"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: "todos", label: "纪要待办", badge: resp?.counts.open ?? 0 },
              { value: "commitments", label: "承诺雷达", badge: commResp?.counts.open ?? 0 },
            ]}
            ariaLabel="切换待办与承诺"
          />

          <SegmentedControl
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "open", label: "未完成" },
              { value: "done", label: "已完成" },
              { value: "all", label: "全部" },
            ]}
            ariaLabel="按状态筛选"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            className="w-3.5 h-3.5 text-[var(--muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={viewMode === "todos" ? "过滤待办关键词或会议名…" : "过滤承诺内容、承诺人或会议名…"}
            aria-label="过滤待办或承诺列表"
            className="w-full pl-8 pr-8 py-1.5 text-xs"
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

        {viewMode === "todos" ? (
          <>
            <label htmlFor="todoPersonSel" className="sr-only">
              按参会人筛选
            </label>
            <select
              id="todoPersonSel"
              value={personFilter}
              onChange={(e) => setPersonFilter(e.target.value)}
              className="text-xs px-2.5 py-1.5"
            >
              <option value="">全部相关人</option>
              {people.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <SegmentedControl
            value={dirFilter}
            onChange={setDirFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "mine", label: "我答应" },
              { value: "theirs", label: "等对方" },
            ]}
            ariaLabel="按归属筛选"
          />
        )}
      </div>

      {viewMode === "todos" ? (
        <div className="space-y-2">
          {loading && !resp ? (
            <div className="card-surface p-4">
              <SkeletonLines lines={4} />
            </div>
          ) : !filteredItems.length ? (
            <div className="card-surface py-12 text-center space-y-2">
              <div className="text-sm text-[var(--muted)]">没有符合条件的待办事项</div>
              {hasNarrowFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="btn-secondary rounded-lg px-3 py-1 text-xs cursor-pointer"
                >
                  重置筛选
                </button>
              )}
            </div>
          ) : (
            filteredItems.map((it) => {
              const rowKey = `${it.mid}-${it.idx}`;
              return (
                <div
                  key={rowKey}
                  className="mn-row-collapse"
                  data-collapsing={collapsingTodos[rowKey] ? "true" : undefined}
                >
                  <div>
                    <div className="card-surface p-3.5 flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={it.done}
                        onChange={(e) => void handleToggle(it, e.target.checked)}
                        aria-label={`标记完成：${it.text}`}
                        className="mt-1 w-4 h-4 shrink-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-sm leading-snug transition-colors duration-150 ${
                            it.done ? "line-through text-[var(--muted)]" : "text-[var(--text)]"
                          }`}
                        >
                          {it.text}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                          <button
                            type="button"
                            onClick={() => navigate(`#/m/${it.mid}`)}
                            className="inline-flex items-center gap-1 hover:text-[var(--link)] hover:underline cursor-pointer"
                          >
                            <span>{it.meeting_title || "未命名会议"}</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                          <span className="num">{(it.meeting_created || "").slice(0, 10)}</span>
                          {it.ts && (
                            <button
                              type="button"
                              onClick={() => navigate(`#/m/${it.mid}?t=${tsToSec(it.ts)}`)}
                              className="font-mono text-[var(--link)] hover:underline num cursor-pointer"
                            >
                              [{it.ts}]
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {loading && !commResp ? (
            <div className="card-surface p-4">
              <SkeletonLines lines={4} />
            </div>
          ) : !filteredCommitments.length ? (
            <div className="card-surface py-12 text-center space-y-2">
              <div className="text-sm text-[var(--muted)]">近 30 天内暂无符合条件的承诺记录</div>
              {hasNarrowFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="btn-secondary rounded-lg px-3 py-1 text-xs cursor-pointer"
                >
                  重置筛选
                </button>
              )}
            </div>
          ) : (
            filteredCommitments.map((c) => {
              const rowKey = `${c.mid}-${c.id}`;
              return (
                <div
                  key={rowKey}
                  className="mn-row-collapse"
                  data-collapsing={collapsingCommits[rowKey] ? "true" : undefined}
                >
                  <div>
                    <div className="card-surface p-3.5 flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={c.done}
                        onChange={(e) => void handleToggleCommitment(c, e.target.checked)}
                        aria-label={`标记承诺完成：${c.text}`}
                        className="mt-1 w-4 h-4 shrink-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              c.direction === "mine"
                                ? "bg-[var(--fill-2)] text-[var(--text)]"
                                : "bg-[var(--amber-weak)] text-[var(--amber)]"
                            }`}
                          >
                            {c.direction === "mine"
                              ? "我答应"
                              : c.direction === "theirs"
                                ? "等对方"
                                : "团队协作"}
                          </span>
                          {c.who && <span className="text-xs font-medium text-[var(--text-2)]">{c.who}</span>}
                          {c.overdue && !c.done && (
                            <span className="rounded-full bg-[var(--amber-weak)] text-[var(--amber)] px-2 py-0.5 text-[11px] font-medium num">
                              超过 3 天未跟进
                            </span>
                          )}
                          {c.due_hint && (
                            <span className="rounded bg-[var(--fill)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
                              {c.due_hint}
                            </span>
                          )}
                        </div>

                        <div
                          className={`text-sm leading-snug transition-colors duration-150 ${
                            c.done ? "line-through text-[var(--muted)]" : "text-[var(--text)]"
                          }`}
                        >
                          {c.text}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                          <button
                            type="button"
                            onClick={() => navigate(`#/m/${c.mid}`)}
                            className="inline-flex items-center gap-1 hover:text-[var(--link)] hover:underline cursor-pointer"
                          >
                            <span>{c.meeting_title || "未命名会议"}</span>
                            <ExternalLink className="w-3 h-3" />
                          </button>
                          <span className="num">{(c.created || "").slice(0, 10)}</span>
                          {c.ts && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate(
                                  `#/m/${c.mid}?t=${Math.max(0, Math.floor((c.start_ms || 0) / 1000))}`,
                                )
                              }
                              className="font-mono text-[var(--link)] hover:underline num cursor-pointer"
                            >
                              [{c.ts}]
                            </button>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDismissCommitment(c)}
                        aria-label="忽略此承诺"
                        title="不再提醒"
                        className="btn-ghost rounded-md w-7 h-7 flex items-center justify-center text-[var(--muted)] hover:text-[var(--text)] shrink-0 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
