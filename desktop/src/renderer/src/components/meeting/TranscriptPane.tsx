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
      <mark key={idx} className="bg-[var(--warn-soft)] text-[var(--text)] font-medium rounded-[4px] px-0.5">
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
    <div className="space-y-3.5">
      <div
        className={`flex flex-wrap gap-2 ${
          isSplit ? "items-end min-h-[40px] border-b border-[var(--line-2)]" : "items-center"
        }`}
      >
        {isSplit && (
          <span className="relative inline-flex items-center h-9 -mb-px px-0.5 text-sm leading-[22px] font-medium text-[var(--text)] whitespace-nowrap shrink-0 after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-0 after:h-[2px] after:rounded-full after:bg-[var(--ink)]">
            转写稿
          </span>
        )}

        <div className={`relative flex-1 min-w-[148px] max-w-[260px] ${isSplit ? "mb-1" : ""}`}>
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
            className={`w-full h-8 pl-8 ${
              query ? "pr-7" : "pr-2.5"
            } rounded-[8px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] text-[13px] leading-[20px] text-[var(--text)] placeholder:text-[var(--muted)] transition-colors`}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setMatchCursor(0);
              }}
              aria-label="清空转写搜索"
              className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 inline-flex items-center justify-center rounded-[6px] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--fill-hover)] cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {trimmedQ && (
          <div
            className={`flex items-center gap-0.5 h-8 text-xs leading-[18px] text-[var(--muted)] shrink-0 ${
              isSplit ? "mb-1" : ""
            }`}
          >
            <span className="num px-1 whitespace-nowrap">
              {matchingIndices.length ? `${matchCursor + 1} / ${matchingIndices.length}` : "0 处"}
            </span>
            <button
              type="button"
              onClick={() => jumpMatch(-1)}
              aria-label="上一处匹配"
              className="btn-ghost rounded-[6px] w-7 h-7 inline-flex items-center justify-center cursor-pointer"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => jumpMatch(1)}
              aria-label="下一处匹配"
              className="btn-ghost rounded-[6px] w-7 h-7 inline-flex items-center justify-center cursor-pointer"
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
              className={`h-8 rounded-[8px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] pl-2 pr-[22px]! bg-[length:12px] bg-[position:right_6px_center] max-w-[124px] text-xs leading-[18px] text-[var(--text)] shrink-0 transition-colors ${
                isSplit ? "mb-1" : ""
              }`}
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

        <label
          className={`ml-auto inline-flex items-center gap-1.5 h-8 text-xs leading-[18px] text-[var(--text-2)] hover:text-[var(--text)] cursor-pointer select-none whitespace-nowrap shrink-0 transition-colors ${
            isSplit ? "mb-1" : ""
          }`}
        >
          <input type="checkbox" checked={followPlay} onChange={(e) => setFollowPlay(e.target.checked)} />
          <span>跟随播放</span>
        </label>
      </div>

      {spkMap.ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {spkMap.ids.map((id) => {
            const share = spkSharePct.get(id);
            const isFiltered = spkFilter === String(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => setRenameSpk(id)}
                title="点击修改发言人姓名"
                className={`h-7 px-3 rounded-full text-xs leading-[18px] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  isFiltered
                    ? "bg-[var(--ink)] text-[var(--ink-fg)]"
                    : "bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] text-[var(--text)]"
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: spkMap.spkColor(id) }}
                />
                <span className="font-medium">{spkMap.spkName(id)}</span>
                {share !== undefined && (
                  <span className={`num ${isFiltered ? "text-[var(--ink-fg)]/75" : "text-[var(--muted)]"}`}>
                    {share}%
                  </span>
                )}
                <Pencil
                  className={`w-3 h-3 shrink-0 ${isFiltered ? "text-[var(--ink-fg)]/75" : "text-[var(--muted)]"}`}
                  aria-hidden="true"
                />
              </button>
            );
          })}

          {ps.length > 0 && meeting.transcript && (
            <button
              type="button"
              onClick={() => setGuessOpen(true)}
              className="h-7 rounded-full px-3 text-xs leading-[18px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-[var(--text-2)] shrink-0" aria-hidden="true" />
              <span>推测姓名</span>
            </button>
          )}
        </div>
      )}

      {autoEntries.length > 0 && (
        <div className="rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-3.5 py-2.5 text-xs leading-[18px] flex flex-wrap items-center gap-2">
          <span className="font-medium text-[var(--text-2)] whitespace-nowrap shrink-0">声纹自动认出</span>
          {autoEntries.map(([spk, info]) => (
            <span
              key={spk}
              className="inline-flex items-center gap-1.5 h-7 rounded-full bg-[var(--fill)] px-2.5 text-xs leading-[18px] text-[var(--text)] whitespace-nowrap shrink-0"
            >
              <span className="font-medium">{info.name || spkMap.spkName(Number(spk))}</span>
              <button
                type="button"
                onClick={() => void undoVoiceprint(Number(spk))}
                className="text-[var(--danger)] hover:underline font-medium inline-flex items-center gap-0.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Undo2 className="w-3 h-3 shrink-0" /> 撤销
              </button>
            </span>
          ))}
        </div>
      )}

      {(sugEntries.length > 0 || mergeHints.length > 0) && (
        <div className="rounded-[12px] bg-[var(--surface-2)] border border-[var(--line)] px-3.5 py-2.5 text-xs leading-[18px] flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[var(--text)] whitespace-nowrap shrink-0">声纹建议</span>
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
              className="h-7 rounded-full bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] px-3 text-xs leading-[18px] font-medium text-[var(--text)] inline-flex items-center whitespace-nowrap shrink-0 cursor-pointer transition-colors"
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
              className="h-7 rounded-full bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] px-3 text-xs leading-[18px] font-medium text-[var(--text)] inline-flex items-center whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              合并说话人为「{h.name}」
            </button>
          ))}
        </div>
      )}

      {meeting.suspects.length > 0 && (
        <div className="rounded-[12px] bg-[var(--warn-soft)] px-3.5 py-2.5 text-xs leading-[18px] flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[var(--warn)] whitespace-nowrap shrink-0">疑似听错的热词</span>
          {meeting.suspects.map((s) => (
            <span
              key={`${s.hotword}-${s.text}`}
              className="inline-flex items-center gap-2 h-7 rounded-full bg-[var(--surface)] shadow-[var(--shadow-1)] px-3 text-xs leading-[18px] text-[var(--text)] whitespace-nowrap shrink-0"
            >
              <span>
                {s.text} → <span className="font-semibold text-[var(--text)]">{s.hotword}</span>{" "}
                <span className="text-[var(--muted)] num">({s.count}处)</span>
              </span>
              <button
                type="button"
                onClick={() => void acceptSuspectFix(s.text, s.hotword)}
                className="text-[var(--text)] underline underline-offset-2 hover:opacity-75 font-medium whitespace-nowrap shrink-0 cursor-pointer transition-opacity"
              >
                全部改正
              </button>
              <button
                type="button"
                onClick={() => void dismissSuspect(s.hotword, s.text)}
                className="text-[var(--muted)] hover:text-[var(--danger)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                忽略
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="space-y-1">
        {!visibleRows.length ? (
          <div className="py-14 text-center text-sm leading-[22px] text-[var(--muted)]">
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
            const showSpeakerHeader = showSpkCol && Boolean(who) && !sameSpkAsPrev;

            return (
              <div
                key={`${p.start}-${idx}`}
                ref={(el) => {
                  if (el) paraRefs.current.set(idx, el);
                  else paraRefs.current.delete(idx);
                }}
                className={`tr-row group rounded-[12px] px-3.5 flex flex-col transition-colors ${
                  sameSpkAsPrev ? "py-2 gap-1 mt-0.5" : `py-3 gap-2 ${visPos > 0 ? "mt-2" : ""}`
                } ${
                  isActive
                    ? "bg-[var(--fill)] ring-1 ring-inset ring-[var(--line-focus)]"
                    : isSearchFocused
                      ? "bg-[var(--warn-soft)]"
                      : "hover:bg-[var(--fill)]"
                } ${isMarked ? "border-l-[3px] border-l-[var(--warn)] pl-3" : ""}`}
              >
                <div className="flex items-center justify-between gap-2 min-h-[26px]">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    {showSpeakerHeader && (
                      <button
                        type="button"
                        onClick={() => {
                          if (p.spk >= 0) setRenameSpk(p.spk);
                        }}
                        title="点击修改发言人姓名"
                        className="text-[13px] leading-[20px] font-semibold text-[var(--text)] hover:text-[var(--text)] hover:underline underline-offset-2 inline-flex items-center gap-1.5 min-w-0 max-w-full cursor-pointer text-left transition-colors"
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: spkMap.spkColor(p.spk) }}
                        />
                        <span className="truncate">{who}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => requestSeek(p.start, true)}
                      title="跳到此处播放"
                      className={`text-left text-xs leading-[18px] hover:text-[var(--text)] hover:underline num-mono cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                        isActive ? "text-[var(--text)] font-medium" : "text-[var(--muted)]"
                      }`}
                    >
                      {ts}
                    </button>

                    {isMarked && <Flag className="w-3 h-3 text-[var(--warn)] shrink-0" aria-hidden="true" />}
                  </div>

                  {!isEditingHere && (
                    <div className="flex items-center gap-0.5 shrink-0 rounded-[8px] bg-[var(--surface-elev)] shadow-[var(--shadow-1)] px-1 py-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity duration-150">
                      <button
                        type="button"
                        onClick={() => quoteToNotes(quoteLine)}
                        title="引用到我的笔记"
                        aria-label="引用到我的笔记"
                        className="btn-ghost rounded-[6px] w-6 h-6 inline-flex items-center justify-center cursor-pointer"
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
                        className="btn-ghost rounded-[6px] w-6 h-6 inline-flex items-center justify-center cursor-pointer"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void addMarkAt(p.start, p.text.slice(0, 60))}
                        title="在此处打点"
                        aria-label="在此处打点"
                        className="btn-ghost rounded-[6px] w-6 h-6 inline-flex items-center justify-center cursor-pointer"
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
                        className="btn-ghost rounded-[6px] w-6 h-6 inline-flex items-center justify-center cursor-pointer relative"
                      >
                        <Copy
                          className={`w-3.5 h-3.5 absolute transition-[opacity,transform] duration-150 ${
                            copiedIdx === idx ? "opacity-0 scale-75" : "opacity-100 scale-100"
                          }`}
                        />
                        <Check
                          className={`w-3.5 h-3.5 absolute text-[var(--ok)] transition-[opacity,transform] duration-150 ${
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
                          className="btn-ghost rounded-[6px] w-6 h-6 inline-flex items-center justify-center cursor-pointer"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  {isEditingHere ? (
                    <div className="space-y-2.5 pt-0.5">
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
                        className="w-full p-3 rounded-[10px] bg-[var(--surface-elev)] border border-[var(--line)] focus:border-[var(--line-focus)] text-[15px] leading-[26px] text-[var(--text-body)] transition-colors"
                      />
                      {confirmDeleteIdx === idx ? (
                        <div className="rounded-[10px] bg-[var(--danger-soft)] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs leading-[18px]">
                          <span className="text-[var(--danger)] font-medium">确定删除这段转写吗？</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={savingEdit}
                              onClick={() => {
                                setConfirmDeleteIdx(null);
                                setEditText(p.text);
                              }}
                              className="h-7 rounded-[8px] bg-[var(--surface)] hover:bg-[var(--fill-hover)] shadow-[var(--shadow-1)] px-2.5 text-xs leading-[18px] font-medium text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                            >
                              恢复原文
                            </button>
                            <button
                              type="button"
                              disabled={savingEdit}
                              onClick={() => void commitInlineEdit(idx, p, true)}
                              className="h-7 rounded-[8px] px-2.5 text-xs leading-[18px] font-medium bg-[var(--danger)] hover:opacity-90 text-white whitespace-nowrap shrink-0 cursor-pointer transition-opacity"
                            >
                              确认删除
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs leading-[18px] text-[var(--muted)]">
                          清空文字再保存可删除这段 · ⌘↩ 保存 · Esc 取消
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {Boolean(meeting.transcript) && (
                          <select
                            value={editSpk}
                            onChange={(e) => setEditSpk(Number(e.target.value))}
                            aria-label="发言人"
                            className="h-8 rounded-[8px] bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] pl-2.5 text-[13px] leading-[20px] text-[var(--text)] shrink-0 transition-colors"
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
                          className="h-8 rounded-[8px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] px-3 text-[13px] leading-[20px] font-medium text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={savingEdit}
                          onClick={() => void commitInlineEdit(idx, p)}
                          className="h-8 rounded-[8px] bg-[var(--ink)] hover:bg-[var(--ink-hover)] px-3.5 text-[13px] leading-[20px] font-medium text-[var(--ink-fg)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onDoubleClick={() => startInlineEdit(idx, p)}
                      className={`text-[15px] leading-[26px] text-[var(--text-body)] whitespace-pre-wrap break-words ${
                        p.edited ? "border-l-2 border-l-[var(--ink)] pl-3" : ""
                      }`}
                    >
                      {renderHighlightedText(p.text, trimmedQ)}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {meeting.ambient_active && ambient?.conv?.id === meeting.meta.id && ambient.partial && (
          <div className="px-3.5 py-2.5 text-[15px] leading-[26px] text-[var(--muted)] italic">
            正在识别：{ambient.partial}…
          </div>
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
