import { buildSpeakerMap, fmtTs, getParas, tsLabel } from "@shared/format";
import type { MeetingDetail, PersonSummary, TranscriptParagraph } from "@shared/types";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Edit2,
  Flag,
  HelpCircle,
  Pencil,
  Quote,
  Search,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";
import { GuessNamesDialog, QuickVocabFixModal, RenameSpeakerDialog } from "./MeetingDialogs";

function diffFix(a: string, b: string): { from: string; to: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const cut = (): [string, string] => [a.slice(i, a.length - j), b.slice(i, b.length - j)];
  let [from, to] = cut();
  while (from.length < 2 && (i > 0 || j > 0)) {
    if (i > 0 && !/[，。？！、；：,.?!;:\s]/.test(a[i - 1] ?? "")) i--;
    else if (j > 0) j--;
    else break;
    [from, to] = cut();
  }
  return { from: from.trim(), to: to.trim() };
}

function renderHighlightedText(text: string, query: string) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark key={idx} className="bg-[var(--amber-weak)] text-[var(--text)] rounded px-0.5">
        {part}
      </mark>
    ) : (
      <Fragment key={idx}>{part}</Fragment>
    ),
  );
}

export function TranscriptPane({ meeting, isSplit = false }: { meeting: MeetingDetail; isSplit?: boolean }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const ambient = useAppStore((s) => s.ambient);
  const followPlay = useAppStore((s) => s.followPlay);
  const setFollowPlay = useAppStore((s) => s.setFollowPlay);

  const playMs = useMeetingStore((s) => s.playMs);
  const playing = useMeetingStore((s) => s.playing);
  const requestSeek = useMeetingStore((s) => s.requestSeek);
  const quoteToNotes = useMeetingStore((s) => s.quoteToNotes);
  const askWithQuote = useMeetingStore((s) => s.askWithQuote);
  const addMarkAt = useMeetingStore((s) => s.addMarkAt);
  const patchMeeting = useMeetingStore((s) => s.patchMeeting);
  const editParagraph = useMeetingStore((s) => s.editParagraph);
  const acceptSuspectFix = useMeetingStore((s) => s.acceptSuspectFix);
  const dismissSuspect = useMeetingStore((s) => s.dismissSuspect);
  const undoVoiceprint = useMeetingStore((s) => s.undoVoiceprint);

  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [spkFilter, setSpkFilter] = useState<string>("all");
  const [renameSpk, setRenameSpk] = useState<number | null>(null);
  const [guessOpen, setGuessOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpk, setEditSpk] = useState(0);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [fixCandidate, setFixCandidate] = useState<{ from: string; to: string } | null>(null);
  const [knownPeople, setKnownPeople] = useState<string[]>([]);

  useEffect(() => {
    void api<{ people?: PersonSummary[] }>("/api/people")
      .then((res) => {
        const names = (res?.people || []).map((p) => p.name).filter(Boolean);
        setKnownPeople(names);
      })
      .catch(() => {});
  }, []);

  const paraRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevScrollIdxRef = useRef<number>(-1);

  const ps = useMemo(() => getParas(meeting), [meeting]);
  const spkMap = useMemo(() => buildSpeakerMap(meeting), [meeting]);

  const spkSharePct = useMemo(() => {
    const durBySpk = new Map<number, number>();
    let total = 0;
    for (const p of ps) {
      if (p.spk < 0) continue;
      const d = Math.max(0, p.end - p.start);
      durBySpk.set(p.spk, (durBySpk.get(p.spk) ?? 0) + d);
      total += d;
    }
    const pct = new Map<number, number>();
    if (total > 0) {
      for (const [spk, ms] of durBySpk.entries()) {
        pct.set(spk, Math.round((ms / total) * 100));
      }
    }
    return pct;
  }, [ps]);

  const canEdit = !["queued", "transcribing", "recording"].includes(meeting.meta.status);
  const trimmedQ = query.trim();

  const visibleRows = useMemo(() => {
    return ps
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => {
        if (spkFilter === "all") return true;
        const target = Number(spkFilter);
        return p.spk === target || Boolean(p.spks?.includes(target));
      });
  }, [ps, spkFilter]);

  const matchingIndices = useMemo(() => {
    if (!trimmedQ) return [];
    const q = trimmedQ.toLowerCase();
    return visibleRows.filter(({ p }) => p.text.toLowerCase().includes(q)).map(({ idx }) => idx);
  }, [visibleRows, trimmedQ]);

  const jumpMatch = (dir: 1 | -1) => {
    if (!matchingIndices.length) return;
    const next = (matchCursor + dir + matchingIndices.length) % matchingIndices.length;
    setMatchCursor(next);
    const paraIdx = matchingIndices[next];
    if (paraIdx !== undefined) {
      paraRefs.current.get(paraIdx)?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
      });
    }
  };

  const activeIdx = useMemo(() => {
    if (!ps.length) return -1;
    let lo = 0;
    let hi = ps.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const item = ps[mid];
      if (item && item.start <= playMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return -1;
    for (let i = Math.max(0, found - 8); i <= found; i++) {
      const p = ps[i];
      if (p && playMs >= p.start && playMs < p.end + 300) return i;
    }
    return -1;
  }, [ps, playMs]);

  useEffect(() => {
    if (followPlay && playing && activeIdx >= 0 && prevScrollIdxRef.current !== activeIdx) {
      prevScrollIdxRef.current = activeIdx;
      paraRefs.current.get(activeIdx)?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "nearest",
      });
    }
  }, [activeIdx, followPlay, playing]);

  const markedIndices = useMemo(() => {
    const out = new Set<number>();
    for (const m of meeting.marks || []) {
      const hit = ps.findIndex(
        (p) => Math.abs(p.start - m.t_ms) < 1500 || (m.t_ms >= p.start && m.t_ms <= p.end),
      );
      if (hit >= 0) out.add(hit);
    }
    return out;
  }, [meeting.marks, ps]);

  const startInlineEdit = (idx: number, p: TranscriptParagraph) => {
    if (!canEdit) return;
    setEditIdx(idx);
    setConfirmDeleteIdx(null);
    setEditText(p.text);
    setEditSpk(Math.max(p.spk, 0));
  };

  const commitInlineEdit = async (idx: number, p: TranscriptParagraph, allowDeleteEmpty = false) => {
    if (savingEdit) return;
    const trimmed = editText.trim();
    const hasSpk = Boolean(meeting.transcript);
    const body: { text?: string; spk?: number } = {};
    if (trimmed !== p.text) body.text = trimmed;
    if (hasSpk && editSpk !== p.spk) body.spk = editSpk;

    if (!Object.keys(body).length) {
      setEditIdx(null);
      setConfirmDeleteIdx(null);
      return;
    }
    if (trimmed === "" && !allowDeleteEmpty) {
      setConfirmDeleteIdx(idx);
      return;
    }

    setSavingEdit(true);
    try {
      const origIdx = p._idx ?? idx;
      await editParagraph(origIdx, body);
      setEditIdx(null);
      setConfirmDeleteIdx(null);
      if (trimmed === "") {
        pushToast("已删除该段转写");
      } else if (body.text) {
        const diff = diffFix(p.text, trimmed);
        const strip = (s: string) => s.replace(/[\s，。？！、；：,.?!;:“”"']/g, "");
        if (
          diff.from &&
          diff.to &&
          diff.from.length <= 16 &&
          diff.to.length <= 16 &&
          strip(diff.from) !== strip(diff.to)
        ) {
          pushToast(`已保存修改（可将「${diff.from} → ${diff.to}」加入词库）`, {
            tone: "success",
            durationMs: 5600,
            action: {
              label: "加入词库",
              onClick: () => setFixCandidate(diff),
            },
          });
        } else {
          pushToast("已保存");
        }
      } else {
        pushToast("已保存");
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", 4000);
    } finally {
      setSavingEdit(false);
    }
  };

  const autoVp = meeting.meta.speaker_meta?.auto || {};
  const autoEntries = Object.entries(autoVp);
  const sugEntries = Object.entries(meeting.meta.speaker_meta?.suggest || {});
  const mergeHints = meeting.meta.speaker_meta?.merge_hints || [];
  const nextSpkId = spkMap.ids.length ? Math.max(...spkMap.ids) + 1 : 0;
  const showSpkCol = Boolean(meeting.transcript) || ps.some((p) => p.ch === 0 || p.ch === 1);

  return (
    <div className="space-y-3">
      <div
        className={`flex flex-wrap items-center gap-2.5 ${
          isSplit ? "min-h-[39px] pb-1.5 border-b border-[var(--line)]" : ""
        }`}
      >
        {isSplit && (
          <span className="relative flex items-center h-[32px] px-1 text-[13.5px] font-medium text-[var(--text)] whitespace-nowrap after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-[-7px] after:h-[2px] after:rounded-full after:bg-[var(--ink)]">
            转写稿
          </span>
        )}

        <div className="relative flex-1 min-w-[140px] max-w-[240px]">
          <Search
            className="w-3.5 h-3.5 text-[var(--muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                jumpMatch(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="搜索转写内容"
            aria-label="在转写稿中搜索"
            className="w-full h-[30px] pl-8 pr-8 text-[13px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setMatchCursor(0);
              }}
              aria-label="清空转写搜索"
              className="absolute right-1 top-1/2 -translate-y-1/2 w-[26px] h-[26px] inline-flex items-center justify-center rounded-md text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {trimmedQ && (
          <div className="flex items-center gap-0.5 text-xs text-[var(--muted)] num">
            <span>{matchingIndices.length ? `${matchCursor + 1} / ${matchingIndices.length}` : "0 处"}</span>
            <button
              type="button"
              onClick={() => jumpMatch(-1)}
              aria-label="上一处匹配"
              className="btn-ghost rounded-md w-[26px] h-[26px] inline-flex items-center justify-center cursor-pointer"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => jumpMatch(1)}
              aria-label="下一处匹配"
              className="btn-ghost rounded-md w-[26px] h-[26px] inline-flex items-center justify-center cursor-pointer"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {spkMap.ids.length > 1 && (
          <>
            <label htmlFor="spkFilterSel" className="sr-only">
              按发言人筛选
            </label>
            <select
              id="spkFilterSel"
              value={spkFilter}
              onChange={(e) => {
                setSpkFilter(e.target.value);
                setMatchCursor(0);
              }}
              className="h-[30px] text-xs px-2"
            >
              <option value="all">全部发言人</option>
              {spkMap.ids.map((id) => (
                <option key={id} value={String(id)}>
                  {spkMap.spkName(id)}
                </option>
              ))}
            </select>
          </>
        )}

        <div className="flex-1" />

        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-2)] cursor-pointer select-none whitespace-nowrap">
          <input type="checkbox" checked={followPlay} onChange={(e) => setFollowPlay(e.target.checked)} />
          <span>跟随播放</span>
        </label>
      </div>

      {spkMap.ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {spkMap.ids.map((id) => {
            const share = spkSharePct.get(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => setRenameSpk(id)}
                title="点击修改发言人姓名"
                className="h-[26px] px-2.5 rounded-full bg-[var(--surface)] hover:bg-[var(--btn-hover)] shadow-[var(--shadow-1)] text-xs inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <span
                  className="w-[7px] h-[7px] rounded-full shrink-0"
                  style={{ backgroundColor: spkMap.spkColor(id) }}
                />
                <span>{spkMap.spkName(id)}</span>
                {share !== undefined && <span className="text-[var(--muted)] num">{share}%</span>}
                <Pencil className="w-3 h-3 text-[var(--muted)]" aria-hidden="true" />
              </button>
            );
          })}

          {ps.length > 0 && meeting.transcript && (
            <button
              type="button"
              onClick={() => setGuessOpen(true)}
              className="btn-ghost h-[26px] rounded-full px-2.5 text-xs inline-flex items-center gap-1 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-[var(--muted)]" aria-hidden="true" />
              <span>推测姓名</span>
            </button>
          )}
        </div>
      )}

      {autoEntries.length > 0 && (
        <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-3.5 py-2 text-xs flex flex-wrap items-center gap-2">
          <span className="text-[var(--muted)]">声纹自动认出：</span>
          {autoEntries.map(([spk, info]) => (
            <span
              key={spk}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--fill)] px-2.5 py-0.5"
            >
              <span>{info.name || spkMap.spkName(Number(spk))}</span>
              <button
                type="button"
                onClick={() => void undoVoiceprint(Number(spk))}
                className="text-[var(--red)] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
              >
                <Undo2 className="w-3 h-3" /> 撤销
              </button>
            </span>
          ))}
        </div>
      )}

      {(sugEntries.length > 0 || mergeHints.length > 0) && (
        <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-3.5 py-2 text-xs flex flex-wrap items-center gap-2">
          <span className="text-[var(--muted)]">声纹建议：</span>
          {sugEntries.map(([spk, item]) => (
            <button
              key={`sug-${spk}`}
              type="button"
              onClick={() => {
                const sp = { ...(meeting.meta.speakers || {}), [spk]: item.name };
                void patchMeeting(meeting.meta.id, { speakers: sp }).then(() =>
                  pushToast(`已确认发言人：${item.name}`),
                );
              }}
              className="btn-secondary rounded-full px-2.5 py-0.5 text-xs cursor-pointer"
            >
              {spkMap.spkName(Number(spk))} 是 {item.name}？点此确认
            </button>
          ))}
          {mergeHints.map((h, i) => (
            <button
              key={`mh-${i}`}
              type="button"
              onClick={() => {
                const sp = { ...(meeting.meta.speakers || {}) };
                for (const s of h.spks) sp[String(s)] = h.name;
                void patchMeeting(meeting.meta.id, { speakers: sp }).then(() =>
                  pushToast(`已合并命名为：${h.name}`),
                );
              }}
              className="btn-secondary rounded-full px-2.5 py-0.5 text-xs cursor-pointer"
            >
              合并说话人为「{h.name}」
            </button>
          ))}
        </div>
      )}

      {meeting.suspects.length > 0 && (
        <div className="rounded-[12px] bg-[var(--amber-weak)] px-3.5 py-2 text-xs flex flex-wrap items-center gap-2">
          <span className="font-medium text-[var(--amber)]">疑似听错的热词：</span>
          {meeting.suspects.map((s) => (
            <span
              key={`${s.hotword}-${s.text}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface)] shadow-[var(--shadow-1)] px-2.5 py-0.5"
            >
              <span>
                {s.text} → <b>{s.hotword}</b> ({s.count}处)
              </span>
              <button
                type="button"
                onClick={() => void acceptSuspectFix(s.text, s.hotword)}
                className="text-[var(--link)] hover:underline cursor-pointer"
              >
                全部改正
              </button>
              <button
                type="button"
                onClick={() => void dismissSuspect(s.hotword, s.text)}
                className="text-[var(--muted)] hover:text-[var(--red)] cursor-pointer"
              >
                忽略
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="@container space-y-0.5 -mx-2">
        {!visibleRows.length ? (
          <div className="py-12 text-center text-sm text-[var(--muted)]">
            {ps.length ? "当前筛选条件下没有转写段落" : "暂无转写内容"}
          </div>
        ) : (
          visibleRows.map(({ p, idx }, visPos) => {
            const prevRow = visPos > 0 ? visibleRows[visPos - 1]?.p : undefined;
            const sameSpkAsPrev =
              Boolean(prevRow) &&
              p.spk >= 0 &&
              prevRow?.spk === p.spk &&
              !(p.spks && p.spks.length > 1) &&
              !(prevRow?.spks && prevRow.spks.length > 1);

            const isActive = idx === activeIdx;
            const isMarked = markedIndices.has(idx);
            const isEditingHere = editIdx === idx;
            const who = spkMap.whoLabel(p);
            const ts = tsLabel(p.start, meeting.segmap);
            const quoteLine = `[${fmtTs(p.start)}] ${who ? `${who}：` : ""}${p.text}`;
            const isSearchFocused = trimmedQ && matchingIndices[matchCursor] === idx;

            return (
              <div
                key={`${p.start}-${idx}`}
                ref={(el) => {
                  if (el) paraRefs.current.set(idx, el);
                  else paraRefs.current.delete(idx);
                }}
                className={`tr-row group relative rounded-[8px] px-2.5 py-1.5 grid gap-x-3 gap-y-0.5 @[520px]:gap-y-0 items-baseline ${
                  showSpkCol
                    ? "grid-cols-[64px_minmax(0,1fr)] @[520px]:grid-cols-[64px_84px_minmax(0,1fr)]"
                    : "grid-cols-[64px_minmax(0,1fr)]"
                } ${!sameSpkAsPrev && visPos > 0 ? "mt-1.5" : ""} ${
                  isActive
                    ? "bg-[var(--surface)] shadow-[var(--shadow-1)]"
                    : isSearchFocused
                      ? "bg-[var(--amber-weak)]"
                      : "hover:bg-[var(--fill)]"
                } ${isMarked ? "border-l-[3px] border-l-[var(--amber)] pl-2" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => requestSeek(p.start, true)}
                  title="跳到此处播放"
                  className="text-left font-mono text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] hover:underline num cursor-pointer justify-self-start whitespace-nowrap"
                >
                  {ts}
                </button>

                {showSpkCol && (
                  <div className="min-w-0 empty:hidden @[520px]:block">
                    {(!sameSpkAsPrev || !who) && who && (
                      <button
                        type="button"
                        onClick={() => {
                          if (p.spk >= 0) setRenameSpk(p.spk);
                        }}
                        className="text-[13px] font-semibold text-[var(--text)] hover:text-[var(--link)] inline-flex items-center gap-1.5 max-w-full cursor-pointer text-left"
                      >
                        <span
                          className="w-[7px] h-[7px] rounded-full shrink-0"
                          style={{ backgroundColor: spkMap.spkColor(p.spk) }}
                        />
                        <span className="truncate">{who}</span>
                      </button>
                    )}
                  </div>
                )}

                <div className={`min-w-0 ${showSpkCol ? "col-start-2 @[520px]:col-start-3" : "col-start-2"}`}>
                  {isEditingHere ? (
                    <div className="space-y-2 py-1">
                      <textarea
                        value={editText}
                        onChange={(e) => {
                          setEditText(e.target.value);
                          if (confirmDeleteIdx === idx && e.target.value.trim() !== "") {
                            setConfirmDeleteIdx(null);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void commitInlineEdit(idx, p);
                          } else if (e.key === "Escape" && !savingEdit) {
                            setConfirmDeleteIdx(null);
                            setEditIdx(null);
                          }
                        }}
                        rows={3}
                        aria-label="编辑转写段落"
                        autoFocus
                        className="w-full p-2 text-sm bg-[var(--surface)]"
                      />
                      {confirmDeleteIdx === idx ? (
                        <div className="rounded-[8px] bg-[var(--red-weak)] px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="text-[var(--red)] font-medium">确定删除这段转写吗？</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={savingEdit}
                              onClick={() => {
                                setConfirmDeleteIdx(null);
                                setEditText(p.text);
                              }}
                              className="btn-secondary rounded-[6px] px-2 py-0.5 text-xs cursor-pointer"
                            >
                              恢复原文
                            </button>
                            <button
                              type="button"
                              disabled={savingEdit}
                              onClick={() => void commitInlineEdit(idx, p, true)}
                              className="rounded-[6px] px-2 py-0.5 text-xs font-medium bg-[var(--rec)] hover:bg-[var(--rec-hover)] text-white cursor-pointer"
                            >
                              确认删除
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[11px] text-[var(--muted)]">
                          清空文字再保存可删除这段 · ⌘↩ 保存 · Esc 取消
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {Boolean(meeting.transcript) && (
                          <select
                            value={editSpk}
                            onChange={(e) => setEditSpk(Number(e.target.value))}
                            aria-label="发言人"
                            className="text-xs px-2 py-1"
                          >
                            {spkMap.ids.map((s) => (
                              <option key={s} value={s}>
                                {spkMap.spkName(s)}
                              </option>
                            ))}
                            <option value={nextSpkId}>新说话人（{spkMap.spkName(nextSpkId)}）</option>
                          </select>
                        )}
                        <div className="flex-1" />
                        <button
                          type="button"
                          disabled={savingEdit}
                          onClick={() => {
                            setConfirmDeleteIdx(null);
                            setEditIdx(null);
                          }}
                          className="btn-secondary rounded-[8px] px-2.5 py-1 text-xs cursor-pointer"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={savingEdit}
                          onClick={() => void commitInlineEdit(idx, p)}
                          className="btn-primary rounded-[8px] px-2.5 py-1 text-xs cursor-pointer"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onDoubleClick={() => startInlineEdit(idx, p)}
                      className={`text-[14.5px] leading-[1.7] text-[var(--text-body)] whitespace-pre-wrap break-words pr-2 ${
                        p.edited ? "border-l-2 border-l-[var(--link)] pl-2" : ""
                      }`}
                    >
                      {renderHighlightedText(p.text, trimmedQ)}
                    </div>
                  )}
                </div>

                {!isEditingHere && (
                  <div className="absolute top-1 right-1.5 flex items-center gap-0.5 rounded-[7px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-1 py-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity">
                    <button
                      type="button"
                      onClick={() => quoteToNotes(quoteLine)}
                      title="引用到我的笔记"
                      aria-label="引用到我的笔记"
                      className="btn-ghost rounded p-1 cursor-pointer"
                    >
                      <Quote className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        askWithQuote(`关于 [${fmtTs(p.start)}] ${who ? `${who}说的` : ""}「${p.text}」：`)
                      }
                      title="就此段问 AI"
                      aria-label="就此段问 AI"
                      className="btn-ghost rounded p-1 cursor-pointer"
                    >
                      <HelpCircle className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void addMarkAt(p.start, p.text.slice(0, 60))}
                      title="在此处打点"
                      aria-label="在此处打点"
                      className="btn-ghost rounded p-1 cursor-pointer"
                    >
                      <Flag className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(quoteLine).then(() => {
                          setCopiedIdx(idx);
                          pushToast("已复制该段转写");
                          setTimeout(() => setCopiedIdx(null), 1200);
                        });
                      }}
                      title="复制该段转写"
                      aria-label="复制该段转写"
                      className="btn-ghost rounded p-1 cursor-pointer relative w-6 h-6 inline-flex items-center justify-center"
                    >
                      <Copy
                        className={`w-3.5 h-3.5 absolute transition-[opacity,transform] duration-150 ${
                          copiedIdx === idx ? "opacity-0 scale-75" : "opacity-100 scale-100"
                        }`}
                      />
                      <Check
                        className={`w-3.5 h-3.5 absolute text-[var(--green)] transition-[opacity,transform] duration-150 ${
                          copiedIdx === idx ? "opacity-100 scale-100" : "opacity-0 scale-75"
                        }`}
                      />
                    </button>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => startInlineEdit(idx, p)}
                        title="编辑这段转写"
                        aria-label="编辑这段转写"
                        className="btn-ghost rounded p-1 cursor-pointer"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {meeting.ambient_active && ambient?.conv?.id === meeting.meta.id && ambient.partial && (
          <div className="px-2.5 py-1.5 text-sm text-[var(--muted)] italic">正在识别：{ambient.partial}…</div>
        )}
      </div>

      <RenameSpeakerDialog
        spk={renameSpk}
        currentName={renameSpk !== null ? spkMap.spkName(renameSpk) : ""}
        existingNames={[...new Set([...spkMap.names, ...knownPeople])]}
        meeting={meeting}
        onClose={() => setRenameSpk(null)}
      />

      <GuessNamesDialog
        open={guessOpen}
        meeting={meeting}
        spkName={spkMap.spkName}
        onClose={() => setGuessOpen(false)}
      />

      <QuickVocabFixModal
        candidate={fixCandidate}
        meetingId={meeting.meta.id}
        allParagraphTexts={ps.map((p) => p.text)}
        onClose={() => setFixCandidate(null)}
      />
    </div>
  );
}
