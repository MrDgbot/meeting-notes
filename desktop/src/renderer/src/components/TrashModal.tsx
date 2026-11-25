import { fmtDur, hm } from "@shared/format";
import { Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ModalShell } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

interface TrashedItem {
  id: string;
  title: string;
  created: string;
  duration: number;
  trashed_at: string;
}

export function TrashModal() {
  const open = useAppStore((s) => s.trashOpen);
  const setOpen = useAppStore((s) => s.setTrashOpen);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);

  const [items, setItems] = useState<TrashedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items?: TrashedItem[] }>("/api/trash");
      const list = Array.isArray(res?.items) ? res.items : [];
      setItems(list);
      useAppStore.setState({ trashCount: list.length });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "加载废纸篓失败", { tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (!open) {
      setConfirmPurgeId(null);
      return;
    }
    void loadList();
  }, [open, loadList]);

  const handleRestore = async (it: TrashedItem) => {
    if (busyId) return;
    setBusyId(it.id);
    try {
      await api(`/api/trash/${encodeURIComponent(it.id)}/restore`, { method: "POST", body: {} });
      setItems((prev) => {
        const next = prev.filter((x) => x.id !== it.id);
        useAppStore.setState({ trashCount: next.length });
        return next;
      });
      void loadMeetings();
      pushToast(`已恢复「${it.title || "未命名会议"}」`, {
        tone: "success",
        durationMs: 5000,
        action: {
          label: "查看",
          onClick: () => {
            setOpen(false);
            navigate(`#/m/${it.id}`);
          },
        },
      });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "恢复失败", { tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const handlePurge = async (it: TrashedItem) => {
    if (busyId) return;
    setBusyId(it.id);
    try {
      await api(`/api/trash/${encodeURIComponent(it.id)}`, { method: "DELETE" });
      setConfirmPurgeId(null);
      setItems((prev) => {
        const next = prev.filter((x) => x.id !== it.id);
        useAppStore.setState({ trashCount: next.length });
        return next;
      });
      pushToast(`已彻底删除「${it.title || "未命名会议"}」`, { durationMs: 2500 });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "删除失败", { tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={() => setOpen(false)}
      label="废纸篓"
      maxWidthClass="max-w-xl"
      backdropClassName="bg-[var(--backdrop)] backdrop-blur-[4px]"
      panelClassName="max-h-[85vh] rounded-[16px] bg-[var(--surface-elev)] shadow-[var(--shadow-3)] flex flex-col"
    >
      <div className="px-6 py-4 border-b border-[var(--line-2)] flex items-start justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] m-0">废纸篓</h2>
          <p className="text-[13px] leading-[20px] text-[var(--text-2)] mt-0.5 m-0">
            已删除的会议记录会在这里保留 30 天，过期后自动清理。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭废纸篓"
          className="btn-ghost rounded-[8px] w-8 h-8 flex items-center justify-center cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2.5">
        {loading && items.length === 0 ? (
          <div className="py-10 flex items-center justify-center gap-2 text-sm leading-[22px] text-[var(--muted)]">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-[13px] leading-[20px] text-[var(--muted)]">
            废纸篓为空，已删除的会议记录会在这里保留 30 天。
          </div>
        ) : (
          items.map((it) => {
            const confirming = confirmPurgeId === it.id;
            const busy = busyId === it.id;
            return (
              <div
                key={it.id}
                className="rounded-[12px] border border-[var(--line-2)] bg-[var(--surface)] px-4 py-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-[22px] font-medium text-[var(--text)] truncate">
                    {it.title || "未命名会议"}
                  </div>
                  <div className="text-xs leading-[18px] text-[var(--muted)] mt-0.5 flex flex-wrap items-center gap-x-2 num">
                    <span>
                      {(it.created || "").slice(0, 10)} {hm(it.created)}
                    </span>
                    {it.duration > 0 && <span>· {fmtDur(it.duration)}</span>}
                    {it.trashed_at && <span>· 删除于 {(it.trashed_at || "").slice(0, 10)}</span>}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmPurgeId(null)}
                        className="btn-ghost rounded-[8px] h-8 px-3 text-[13px] leading-[20px] whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handlePurge(it)}
                        className="rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium bg-[var(--danger)] text-white hover:opacity-90 whitespace-nowrap shrink-0 cursor-pointer transition-opacity disabled:opacity-60"
                      >
                        {busy ? "删除中…" : "确认彻底删除"}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRestore(it)}
                        className="btn-secondary rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> 恢复
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmPurgeId(it.id)}
                        className="btn-ghost btn-danger rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                        title="彻底删除后无法找回"
                      >
                        <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> 彻底删除
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
}
