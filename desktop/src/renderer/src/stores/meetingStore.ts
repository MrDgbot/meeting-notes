import { fmtTs, getParas } from "@shared/format";
import { toggleMarkdownTodo } from "@shared/markdown";
import type {
  AudioPeaks,
  LocalLlmStatus,
  MarkItem,
  MeetingDetail,
  MeetingMeta,
  MinutesData,
  RelatedMeeting,
  TranscriptParagraph,
} from "@shared/types";
import { create } from "zustand";
import { api, streamNd } from "@/lib/api";
import { useAppStore } from "./appStore";
import { useRecorderStore } from "./recorderStore";

export type MeetingTab = "minutes" | "transcript" | "notes" | "qa";

export interface GenMinutesState {
  text: string;
  status: string;
  startedAt: number;
  provider: string;
}

export interface PendingNoteEntry {
  value: string;
  saving: boolean;
  dirty: boolean;
  error?: string;
}

export interface SeekRequest {
  ms: number;
  autoplay?: boolean;
  nonce: number;
}

function markSnippet(tMs: number, ps: TranscriptParagraph[]): string {
  if (!ps.length) return "";
  let hit = ps.find((p) => p.start <= tMs && tMs <= p.end);
  if (!hit) {
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of ps) {
      const dist = Math.min(Math.abs(p.start - tMs), Math.abs(p.end - tMs));
      if (dist < bestD) {
        bestD = dist;
        hit = p;
      }
    }
  }
  return hit?.text ? hit.text.trim().slice(0, 40) : "";
}

function enrichMarks(marks: MarkItem[], ps: TranscriptParagraph[]): MarkItem[] {
  return marks.map((m) => ({
    ...m,
    snippet: m.snippet || markSnippet(m.t_ms, ps) || m.label || "",
  }));
}

interface PendingMarkState {
  cancelled: boolean;
}

const pendingMarks = new Map<string, PendingMarkState>();
const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const todoQueues = new Map<string, Promise<void>>();
const todoBaseMd = new Map<string, string>();
let seekNonce = 0;

interface MeetingStoreState {
  meeting: MeetingDetail | null;
  loading: boolean;
  loadError: string;
  tab: MeetingTab;
  peaks: AudioPeaks | null;
  related: RelatedMeeting[];
  pendingNotes: Record<string, PendingNoteEntry>;
  genByMid: Record<string, GenMinutesState>;
  genErr: { id: string; msg: string } | null;
  qaDraft: { mid: string; text: string } | null;
  playMs: number;
  playing: boolean;
  seekRequest: SeekRequest | null;
  localLlmBusy: boolean;

  setTab: (tab: MeetingTab) => void;
  setPlaybackState: (playMs: number, playing: boolean) => void;
  requestSeek: (ms: number, autoplay?: boolean) => void;
  clearQaDraft: () => void;
  clearMeeting: () => void;

  showMeeting: (mid: string, opts?: { keepTab?: boolean; initialSeekSec?: number }) => Promise<void>;
  refreshMeeting: (mid: string) => Promise<void>;
  patchMeeting: (mid: string, body: Record<string, unknown>) => Promise<MeetingMeta>;
  deleteMeeting: (mid: string) => Promise<void>;

  setNotesDraft: (mid: string, value: string) => void;
  flushNotes: (mid?: string) => Promise<boolean>;
  quoteToNotes: (line: string) => void;
  askWithQuote: (prompt: string) => void;

  addMarkAt: (tMs: number, label?: string) => Promise<boolean>;
  addLiveMark: () => Promise<void>;
  deleteMark: (markId: string) => Promise<void>;
  dismissSuspect: (hotword: string, text: string) => Promise<void>;
  acceptSuspectFix: (from: string, to: string) => Promise<void>;
  undoVoiceprint: (spk: number) => Promise<void>;
  editParagraph: (origIdx: number, body: { text?: string; spk?: number }) => Promise<MeetingDetail | null>;

  enqueueTodoToggle: (mid: string, todoIdx: number, checked: boolean) => void;
  generateMinutes: (mid: string, template: string, providerId: string) => Promise<void>;
  startLocalLlm: () => Promise<LocalLlmStatus | null>;

  initMeetingBridge: () => () => void;
}

export const useMeetingStore = create<MeetingStoreState>((set, get) => ({
  meeting: null,
  loading: false,
  loadError: "",
  tab: "minutes",
  peaks: null,
  related: [],
  pendingNotes: {},
  genByMid: {},
  genErr: null,
  qaDraft: null,
  playMs: 0,
  playing: false,
  seekRequest: null,
  localLlmBusy: false,

  setTab: (tab) => set({ tab }),

  setPlaybackState: (playMs, playing) => set({ playMs, playing }),

  requestSeek: (ms, autoplay = true) => {
    seekNonce += 1;
    set({ seekRequest: { ms: Math.max(0, ms), autoplay, nonce: seekNonce } });
  },

  clearQaDraft: () => set({ qaDraft: null }),

  clearMeeting: () => set({ meeting: null, loading: false, loadError: "", peaks: null, related: [] }),

  showMeeting: async (mid, opts = {}) => {
    const prevMid = get().meeting?.meta.id;
    if (prevMid && prevMid !== mid) {
      void get().flushNotes(prevMid);
    }

    const isSame = prevMid === mid && get().meeting !== null;
    if (!isSame) {
      set({
        loading: true,
        loadError: "",
        peaks: null,
        related: [],
      });
    }

    try {
      const d = await api<MeetingDetail>(`/api/meetings/${encodeURIComponent(mid)}`);
      const ps = getParas(d);
      const enriched: MeetingDetail = {
        ...d,
        marks: enrichMarks(d.marks || [], ps),
      };
      if (d.minutes?.markdown !== undefined && !todoQueues.has(mid)) {
        todoBaseMd.set(mid, d.minutes.markdown);
      }

      let nextTab = get().tab;
      if (!opts.keepTab && !isSame) {
        if (d.minutes?.markdown || !d.transcript?.paragraphs?.length) {
          nextTab = "minutes";
        } else {
          nextTab = "transcript";
        }
      }

      set({
        meeting: enriched,
        loading: false,
        loadError: "",
        tab: nextTab,
      });

      if (opts.initialSeekSec !== undefined && Number.isFinite(opts.initialSeekSec)) {
        get().requestSeek(Math.max(0, opts.initialSeekSec * 1000), false);
      }

      if (d.has_audio) {
        void api<AudioPeaks>(`/api/meetings/${encodeURIComponent(mid)}/peaks`)
          .then((peaks) => {
            if (get().meeting?.meta.id === mid) {
              set({ peaks });
            }
          })
          .catch(() => {});
      }

      void api<{ mid?: string; items?: RelatedMeeting[] }>(
        `/api/meetings/${encodeURIComponent(mid)}/related?limit=5`,
      )
        .then((res) => {
          if (get().meeting?.meta.id === mid) {
            set({ related: Array.isArray(res?.items) ? res.items : [] });
          }
        })
        .catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载会议失败";
      set({ loading: false, loadError: msg });
    }
  },

  refreshMeeting: async (mid) => {
    if (get().meeting?.meta.id !== mid) return;
    await get().showMeeting(mid, { keepTab: true });
  },

  patchMeeting: async (mid, body) => {
    const meta = await api<MeetingMeta>(`/api/meetings/${encodeURIComponent(mid)}`, {
      method: "PATCH",
      body,
    });
    const cur = get().meeting;
    if (cur && cur.meta.id === mid) {
      let nextMinutes = cur.minutes;
      if (typeof body.minutes_markdown === "string" && cur.minutes) {
        nextMinutes = {
          ...cur.minutes,
          markdown: body.minutes_markdown,
          edited: true,
        };
        todoBaseMd.set(mid, body.minutes_markdown);
      }
      set({ meeting: { ...cur, meta, minutes: nextMinutes } });
    }
    void useAppStore.getState().loadMeetings();
    return meta;
  },

  deleteMeeting: async (mid) => {
    const timer = noteSaveTimers.get(mid);
    if (timer) {
      clearTimeout(timer);
      noteSaveTimers.delete(mid);
    }
    const title = get().meeting?.meta.id === mid ? get().meeting?.meta.title : "";
    await api(`/api/meetings/${encodeURIComponent(mid)}/trash`, { method: "POST", body: {} });
    set((s) => {
      const nextNotes = { ...s.pendingNotes };
      delete nextNotes[mid];
      return {
        meeting: s.meeting?.meta.id === mid ? null : s.meeting,
        pendingNotes: nextNotes,
      };
    });
    await useAppStore.getState().loadMeetings();
    void useAppStore.getState().loadTrashCount();
    useAppStore.getState().navigate("#/");
    useAppStore.getState().pushToast(`已将「${title || "会议记录"}」移入废纸篓`, {
      durationMs: 6000,
      action: {
        label: "撤销",
        onClick: async () => {
          await api(`/api/trash/${encodeURIComponent(mid)}/restore`, { method: "POST", body: {} });
          await useAppStore.getState().loadMeetings();
          void useAppStore.getState().loadTrashCount();
          useAppStore.getState().navigate(`#/m/${mid}`);
          useAppStore.getState().pushToast("已恢复会议记录", { tone: "success" });
        },
      },
    });
  },

  setNotesDraft: (mid, value) => {
    const prevTimer = noteSaveTimers.get(mid);
    if (prevTimer) clearTimeout(prevTimer);

    set((s) => ({
      pendingNotes: {
        ...s.pendingNotes,
        [mid]: { value, saving: false, dirty: true },
      },
      meeting: s.meeting && s.meeting.meta.id === mid ? { ...s.meeting, notes: value } : s.meeting,
    }));

    const timer = setTimeout(() => {
      noteSaveTimers.delete(mid);
      void get().flushNotes(mid);
    }, 1200);
    noteSaveTimers.set(mid, timer);
  },

  flushNotes: async (targetMid) => {
    const ids = targetMid ? [targetMid] : Object.keys(get().pendingNotes);
    let allOk = true;
    for (const mid of ids) {
      const t = noteSaveTimers.get(mid);
      if (t) {
        clearTimeout(t);
        noteSaveTimers.delete(mid);
      }
      const entry = get().pendingNotes[mid];
      if (!entry?.dirty || entry?.saving) continue;

      const savingVal = entry.value;
      set((s) => {
        const curEntry = s.pendingNotes[mid];
        if (!curEntry) return s;
        return {
          pendingNotes: {
            ...s.pendingNotes,
            [mid]: { ...curEntry, saving: true, error: undefined },
          },
        };
      });

      try {
        await api(`/api/meetings/${encodeURIComponent(mid)}`, {
          method: "PATCH",
          body: { notes: savingVal },
        });
        set((s) => {
          const curEntry = s.pendingNotes[mid];
          const next = { ...s.pendingNotes };
          if (curEntry && curEntry.value === savingVal) {
            delete next[mid];
          } else if (curEntry) {
            next[mid] = { ...curEntry, saving: false, dirty: true };
          }
          return {
            pendingNotes: next,
            meeting:
              s.meeting && s.meeting.meta.id === mid && !curEntry?.dirty
                ? { ...s.meeting, notes: savingVal }
                : s.meeting,
          };
        });
        // Re-flush if user typed while saving
        const after = get().pendingNotes[mid];
        if (after?.dirty) {
          const retry = setTimeout(() => {
            noteSaveTimers.delete(mid);
            void get().flushNotes(mid);
          }, 400);
          noteSaveTimers.set(mid, retry);
        }
      } catch (err) {
        allOk = false;
        const msg = err instanceof Error ? err.message : "保存失败";
        set((s) => {
          const curEntry = s.pendingNotes[mid];
          if (!curEntry) return s;
          return {
            pendingNotes: {
              ...s.pendingNotes,
              [mid]: { ...curEntry, saving: false, dirty: true, error: msg },
            },
          };
        });
        const retry = setTimeout(() => {
          noteSaveTimers.delete(mid);
          void get().flushNotes(mid);
        }, 5000);
        noteSaveTimers.set(mid, retry);
      }
    }
    return allOk;
  },

  quoteToNotes: (line) => {
    const cur = get().meeting;
    if (!cur || !line) return;
    const mid = cur.meta.id;
    const existing = get().pendingNotes[mid]?.value ?? cur.notes ?? "";
    const sep = !existing ? "" : existing.endsWith("\n") ? "" : "\n";
    const next = existing + sep + line;
    get().setNotesDraft(mid, next);
    void get().flushNotes(mid);
    useAppStore.getState().pushToast("已引用到我的笔记");
  },

  askWithQuote: (prompt) => {
    const cur = get().meeting;
    if (!cur || !prompt) return;
    set({ tab: "qa", qaDraft: { mid: cur.meta.id, text: prompt } });
  },

  addMarkAt: async (tMs, snippetLabel = "") => {
    const cur = get().meeting;
    if (!cur) return false;
    const mid = cur.meta.id;
    const t = Math.max(0, Math.round(Number(tMs) || 0));
    const label = String(snippetLabel || "")
      .trim()
      .slice(0, 60);
    try {
      const r = await api<{ mark?: MarkItem; marks?: MarkItem[]; created?: boolean }>(
        `/api/meetings/${encodeURIComponent(mid)}/marks`,
        { method: "POST", body: { t_ms: t, label } },
      );
      const latest = get().meeting;
      if (!latest || latest.meta.id !== mid) return false;
      const ps = getParas(latest);
      set({ meeting: { ...latest, marks: enrichMarks(r.marks || [], ps) } });
      const shownMs = r.mark && Number.isFinite(r.mark.t_ms) ? r.mark.t_ms : t;
      useAppStore
        .getState()
        .pushToast(r.created === false ? `附近已有打点 ${fmtTs(shownMs)}` : `已打点 ${fmtTs(t)}`);
      return true;
    } catch (err) {
      useAppStore.getState().pushToast(`打点失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
      return false;
    }
  },

  addLiveMark: async () => {
    const rec = useRecorderStore.getState();
    const cur = get().meeting;
    if (!rec.active || rec.stopping || !cur || rec.mid !== cur.meta.id) return;
    const mid = rec.mid;
    const t = Math.round(rec.elapsedMs);
    const list = [...(cur.marks || [])];
    let tmpId: string | null = null;
    if (!list.some((m) => Math.abs(m.t_ms - t) < 2000)) {
      tmpId = `tmp${t}_${Math.random().toString(36).slice(2, 6)}`;
      pendingMarks.set(tmpId, { cancelled: false });
      list.push({ id: tmpId, t_ms: t, label: "" });
      list.sort((a, b) => a.t_ms - b.t_ms);
      set({ meeting: { ...cur, marks: list } });
    }
    useAppStore.getState().pushToast(`已标记 ${fmtTs(t)}`, 1200);

    const state = tmpId ? pendingMarks.get(tmpId) : null;
    for (let i = 0; i < 8; i++) {
      if (state?.cancelled) {
        if (tmpId) pendingMarks.delete(tmpId);
        return;
      }
      try {
        const r = await api<{ mark?: MarkItem; marks?: MarkItem[] }>(
          `/api/meetings/${encodeURIComponent(mid)}/marks`,
          { method: "POST", body: { t_ms: t } },
        );
        if (state?.cancelled) {
          if (tmpId) pendingMarks.delete(tmpId);
          if (r.mark?.id) {
            void api(`/api/meetings/${encodeURIComponent(mid)}/marks/${encodeURIComponent(r.mark.id)}`, {
              method: "DELETE",
            }).catch(() => {});
          }
          return;
        }
        if (tmpId) pendingMarks.delete(tmpId);
        const latest = get().meeting;
        if (latest && latest.meta.id === mid) {
          const ps = getParas(latest);
          const extras = (latest.marks || []).filter(
            (m) =>
              String(m.id).startsWith("tmp") &&
              m.id !== tmpId &&
              pendingMarks.has(m.id) &&
              !pendingMarks.get(m.id)?.cancelled,
          );
          const merged = [...enrichMarks(r.marks || [], ps), ...extras].sort((a, b) => a.t_ms - b.t_ms);
          set({ meeting: { ...latest, marks: merged } });
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/404|不存在/.test(msg)) {
          if (tmpId) pendingMarks.delete(tmpId);
          return;
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (tmpId) pendingMarks.delete(tmpId);
    useAppStore.getState().pushToast("这个打点没有存上，请检查连接后再标一次", 6000);
  },

  deleteMark: async (markId) => {
    const cur = get().meeting;
    if (!cur) return;
    const mid = cur.meta.id;
    const removed = (cur.marks || []).find((m) => m.id === markId);
    if (markId.startsWith("tmp")) {
      const st = pendingMarks.get(markId);
      if (st) st.cancelled = true;
      set({
        meeting: { ...cur, marks: (cur.marks || []).filter((m) => m.id !== markId) },
      });
      return;
    }
    try {
      const r = await api<{ marks?: MarkItem[] }>(
        `/api/meetings/${encodeURIComponent(mid)}/marks/${encodeURIComponent(markId)}`,
        { method: "DELETE" },
      );
      const latest = get().meeting;
      if (latest && latest.meta.id === mid) {
        const ps = getParas(latest);
        set({ meeting: { ...latest, marks: enrichMarks(r.marks || [], ps) } });
      }
      if (removed) {
        useAppStore.getState().pushToast(`已移除 ${fmtTs(removed.t_ms)} 打点`, {
          durationMs: 5600,
          action: {
            label: "撤销",
            onClick: async () => {
              await api(`/api/meetings/${encodeURIComponent(mid)}/marks`, {
                method: "POST",
                body: { t_ms: removed.t_ms, label: removed.label || "" },
              });
              if (get().meeting?.meta.id === mid) {
                await get().refreshMeeting(mid);
              }
            },
          },
        });
      }
    } catch (err) {
      useAppStore.getState().pushToast(`没删掉：${err instanceof Error ? err.message : "未知错误"}`, 4000);
    }
  },

  dismissSuspect: async (hotword, text) => {
    const cur = get().meeting;
    if (!cur || !hotword || !text) return;
    const mid = cur.meta.id;
    await api("/api/rsi/vocab/suspect/dismiss", { method: "POST", body: { hotword, text } });
    const latest = get().meeting;
    if (latest && latest.meta.id === mid) {
      set({
        meeting: {
          ...latest,
          suspects: (latest.suspects || []).filter((x) => !(x.hotword === hotword && x.text === text)),
        },
      });
    }
    useAppStore.getState().pushToast("后续将不再提示该误报");
  },

  acceptSuspectFix: async (from, to) => {
    const cur = get().meeting;
    if (!cur) return;
    await api("/api/vocab/fix", { method: "POST", body: { from, to } });
    useAppStore.getState().pushToast(`已加纠错规则：${from} → ${to}`);
    await get().showMeeting(cur.meta.id, { keepTab: true });
  },

  undoVoiceprint: async (spk) => {
    const cur = get().meeting;
    if (!cur) return;
    const updatedMeta = await api<MeetingMeta>("/api/rsi/voiceprints/undo", {
      method: "POST",
      body: { mid: cur.meta.id, spk },
    });
    const latest = get().meeting;
    if (latest && latest.meta.id === cur.meta.id) {
      set({ meeting: { ...latest, meta: updatedMeta } });
    }
    useAppStore.getState().pushToast("已撤销自动认人，声纹模型已记录反馈");
    await get().showMeeting(cur.meta.id, { keepTab: true });
  },

  editParagraph: async (origIdx, body) => {
    const cur = get().meeting;
    if (!cur) return null;
    const mid = cur.meta.id;
    const r = await api<MeetingDetail>(`/api/meetings/${encodeURIComponent(mid)}/paragraphs/${origIdx}`, {
      method: "PUT",
      body,
    });
    const latest = get().meeting;
    if (!latest || latest.meta.id !== mid) return null;
    const updated: MeetingDetail = {
      ...latest,
      meta: r.meta,
      transcript: r.transcript,
      live: r.live,
      minutes_stale: r.minutes_stale,
      suspects: r.suspects,
    };
    set({ meeting: updated });
    return updated;
  },

  enqueueTodoToggle: (mid, todoIdx, checked) => {
    const cur = get().meeting;
    if (cur && cur.meta.id === mid && cur.minutes) {
      const currentMd = todoBaseMd.get(mid) ?? cur.minutes.markdown ?? "";
      const optimisticMd = toggleMarkdownTodo(currentMd, todoIdx, checked);
      todoBaseMd.set(mid, optimisticMd);
      set({
        meeting: {
          ...cur,
          minutes: { ...cur.minutes, markdown: optimisticMd, edited: true },
        },
      });
    }

    const prev = todoQueues.get(mid) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const base = todoBaseMd.get(mid) ?? get().meeting?.minutes?.markdown ?? "";
        const updatedMd = toggleMarkdownTodo(base, todoIdx, checked);
        try {
          await api(`/api/meetings/${encodeURIComponent(mid)}`, {
            method: "PATCH",
            body: { minutes_markdown: updatedMd },
          });
          todoBaseMd.set(mid, updatedMd);
          const latest = get().meeting;
          if (latest && latest.meta.id === mid && latest.minutes) {
            set({
              meeting: {
                ...latest,
                minutes: { ...latest.minutes, markdown: updatedMd, edited: true },
              },
            });
          }
        } catch (err) {
          const rollbackMd = toggleMarkdownTodo(base, todoIdx, !checked);
          todoBaseMd.set(mid, rollbackMd);
          const latest = get().meeting;
          if (latest && latest.meta.id === mid && latest.minutes) {
            set({
              meeting: {
                ...latest,
                minutes: { ...latest.minutes, markdown: rollbackMd },
              },
            });
          }
          useAppStore
            .getState()
            .pushToast(`待办状态保存失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
        }
      });

    todoQueues.set(mid, next);
    void next.finally(() => {
      if (todoQueues.get(mid) === next) todoQueues.delete(mid);
    });
  },

  generateMinutes: async (mid, template, providerId) => {
    const cur = get().meeting;
    const title = cur?.meta.id === mid ? cur.meta.title : "会议";
    useAppStore.getState().setProvId(providerId);
    const t0 = Date.now();

    set((s) => ({
      genErr: s.genErr?.id === mid ? null : s.genErr,
      genByMid: {
        ...s.genByMid,
        [mid]: { text: "", status: "准备中…", startedAt: t0, provider: providerId },
      },
    }));

    const clock = setInterval(() => {
      const g = get().genByMid[mid];
      if (!g || g.text) return;
      if (/已 \d+ 秒/.test(g.status)) return;
      const secs = Math.round((Date.now() - g.startedAt) / 1000);
      const base = g.status.replace(/ · \d+s$/, "");
      set((s) => ({
        genByMid: {
          ...s.genByMid,
          [mid]: { ...g, status: `${base} · ${secs}s` },
        },
      }));
    }, 1000);

    try {
      await streamNd(
        `/api/meetings/${encodeURIComponent(mid)}/minutes`,
        {
          template,
          provider: providerId,
        },
        (ev) => {
          const prev = get().genByMid[mid];
          if (!prev) return;
          if (ev.type === "status") {
            set((s) => ({
              genByMid: {
                ...s.genByMid,
                [mid]: { ...prev, status: ev.msg || prev.status },
              },
            }));
          } else if (ev.type === "delta") {
            const nextText = prev.text + (ev.text || "");
            const secs = Math.round((Date.now() - prev.startedAt) / 1000);
            set((s) => ({
              genByMid: {
                ...s.genByMid,
                [mid]: {
                  ...prev,
                  text: nextText,
                  status: `生成中… ${nextText.length} 字 · ${secs}s`,
                },
              },
            }));
          } else if (ev.type === "done") {
            todoBaseMd.delete(mid);
            const latest = get().meeting;
            if (latest && latest.meta.id === mid && ev.minutes) {
              set({
                meeting: { ...latest, minutes: ev.minutes as MinutesData },
              });
            }
          } else if (ev.type === "error") {
            throw new Error(ev.msg || "生成失败");
          }
        },
      );

      clearInterval(clock);
      set((s) => {
        const next = { ...s.genByMid };
        delete next[mid];
        return { genByMid: next };
      });
      if (get().meeting?.meta.id === mid) {
        await get().showMeeting(mid, { keepTab: true });
      } else {
        useAppStore.getState().pushToast(`「${title}」的纪要已生成`);
      }
      void useAppStore.getState().loadMeetings();
    } catch (err) {
      clearInterval(clock);
      const msg = err instanceof Error ? err.message : "生成失败";
      set((s) => {
        const next = { ...s.genByMid };
        delete next[mid];
        return { genByMid: next, genErr: { id: mid, msg } };
      });
      useAppStore.getState().pushToast(`生成失败：${msg}`, 6000);
    }
  },

  startLocalLlm: async () => {
    set({ localLlmBusy: true });
    try {
      await api("/api/llm/local", { method: "POST", body: { action: "start" } });
      for (let i = 0; i < 90; i++) {
        const st = await api<LocalLlmStatus>("/api/llm/local");
        if (st.running) {
          useAppStore.getState().pushToast("本地模型已启动");
          return st;
        }
        if (!st.ours) {
          useAppStore
            .getState()
            .pushToast(`本地模型启动失败：${st.log || `退出码 ${st.exit_code ?? "?"}`}`, 8000);
          return st;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      useAppStore.getState().pushToast("本地模型启动超时，请检查日志", 6000);
      return null;
    } catch (err) {
      useAppStore.getState().pushToast(err instanceof Error ? err.message : "启动失败", 6000);
      return null;
    } finally {
      set({ localLlmBusy: false });
    }
  },

  initMeetingBridge: () => {
    const unsubs: Array<() => void> = [];

    useRecorderStore.getState().setBeforeRemoteEnd(async () => {
      await get().flushNotes();
    });

    const onRecorderClosed = () => {
      const curMid = get().meeting?.meta.id;
      if (curMid) {
        void get().showMeeting(curMid, { keepTab: true });
      }
    };
    window.addEventListener("mn:recorder-closed", onRecorderClosed);
    unsubs.push(() => window.removeEventListener("mn:recorder-closed", onRecorderClosed));

    const desk = window.desktopAPI;
    if (desk) {
      unsubs.push(
        desk.onQuickMark((payload) => {
          useAppStore.getState().pushToast(`全局打点 ${fmtTs(payload.tMs)}`, 1800);
          const cur = get().meeting;
          if (cur && cur.meta.id === payload.mid) {
            void get().showMeeting(payload.mid, { keepTab: true });
          }
        }),
      );
    }

    return () => {
      for (const fn of unsubs) fn();
    };
  },
}));
