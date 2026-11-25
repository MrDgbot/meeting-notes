import { getParas, isGenericSpeakerName } from "@shared/format";
import type { MeetingDetail, SpeakerNamesResponse } from "@shared/types";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { ModalShell, SkeletonLines } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";
import { useRecorderStore } from "@/stores/recorderStore";

const DIALOG_BACKDROP = "bg-[var(--backdrop)] backdrop-blur-[4px]";
const DIALOG_PANEL = "rounded-[16px] bg-[var(--surface-elev)] shadow-[var(--shadow-3)] p-6 space-y-4";
const DIALOG_TITLE = "text-base leading-[24px] font-semibold text-[var(--text)] m-0";
const DIALOG_DESC = "text-sm leading-[22px] text-[var(--text-2)] m-0";
const DIALOG_CLOSE_BTN =
  "w-8 h-8 rounded-[8px] inline-flex items-center justify-center shrink-0 text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--fill-hover)] cursor-pointer transition-colors";
const DIALOG_INPUT =
  "h-9 rounded-[10px] px-3 bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] text-sm leading-[22px] text-[var(--text)] placeholder:text-[var(--muted)] transition-colors";
const DIALOG_BTN_SECONDARY =
  "h-9 rounded-[10px] px-4 text-sm leading-[22px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] inline-flex items-center justify-center whitespace-nowrap shrink-0 cursor-pointer transition-colors";
const DIALOG_BTN_PRIMARY =
  "h-9 rounded-[10px] px-4 text-sm leading-[22px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] active:scale-[0.98] text-[var(--ink-fg)] inline-flex items-center justify-center whitespace-nowrap shrink-0 cursor-pointer transition-[background-color,transform] duration-150";
const DIALOG_BTN_DANGER =
  "h-9 rounded-[10px] px-4 text-sm leading-[22px] font-medium bg-[var(--danger)] hover:opacity-90 active:scale-[0.98] text-white inline-flex items-center justify-center whitespace-nowrap shrink-0 cursor-pointer transition-[opacity,transform] duration-150";

export function ContinueRecordDialog({
  open,
  meeting,
  hasEditedParagraphs,
  onClose,
}: {
  open: boolean;
  meeting: MeetingDetail;
  hasEditedParagraphs: boolean;
  onClose: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const showMeeting = useMeetingStore((s) => s.showMeeting);
  const prime = useRecorderStore((s) => s.prime);
  const startRec = useRecorderStore((s) => s.start);

  const isDualChannel = meeting.meta.audio_channels === 2 || getParas(meeting).some((p) => p.ch === 1);
  const [src, setSrc] = useState<"mic" | "mix">(isDualChannel ? "mix" : "mic");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSrc(isDualChannel ? "mix" : "mic");
    }
  }, [open, isDualChannel]);

  const handleStart = async () => {
    if (busy) return;
    const useSrc = isDualChannel ? "mix" : src;
    setBusy(true);
    prime();
    onClose();
    try {
      await startRec(meeting.meta.id, useSrc);
      await loadMeetings();
      await showMeeting(meeting.meta.id, { keepTab: true });
    } catch (err) {
      pushToast(`无法开始录音：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      label={meeting.meta.duration ? "继续录音" : "开始录音"}
      maxWidthClass="max-w-[460px]"
      backdropClassName={DIALOG_BACKDROP}
      panelClassName={DIALOG_PANEL}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className={DIALOG_TITLE}>{meeting.meta.duration ? "继续录音" : "开始录音"}</h2>
        <button type="button" onClick={onClose} aria-label="关闭窗口" className={DIALOG_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className={DIALOG_DESC}>
        新录音会接在已有录音后面，结束后重新整理全文。
        {meeting.transcript ? "已改的说话人姓名会保留。" : ""}
      </p>

      {hasEditedParagraphs && meeting.transcript && (
        <div className="rounded-[12px] bg-[var(--danger-soft)] text-[var(--danger)] px-3.5 py-2.5 text-[13px] leading-[20px]">
          这场有手动修改过的段落，继续录音结束后的重新转写会覆盖这些修改（词库纠错规则不受影响）。
        </div>
      )}

      {isDualChannel ? (
        <div className="rounded-[12px] bg-[var(--fill)] px-3.5 py-2.5 text-[13px] leading-[20px] text-[var(--text-2)]">
          已自动保持「麦克风 + 系统声音」双声道，与先前音轨保持一致。
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <label
            className={`rounded-[12px] border px-3.5 py-3 text-sm leading-[22px] text-[var(--text)] cursor-pointer flex items-center gap-2.5 transition-colors ${
              src === "mic"
                ? "border-[var(--ink)] bg-[var(--fill)]"
                : "border-[var(--line)] hover:border-[var(--line-focus)] bg-[var(--surface)]"
            }`}
          >
            <input
              type="radio"
              name="contSrc"
              checked={src === "mic"}
              onChange={() => setSrc("mic")}
              className="accent-[var(--ink)] shrink-0"
            />
            <span className="font-medium whitespace-nowrap">仅麦克风</span>
          </label>
          <label
            className={`rounded-[12px] border px-3.5 py-3 text-sm leading-[22px] text-[var(--text)] cursor-pointer flex items-center gap-2.5 transition-colors ${
              src === "mix"
                ? "border-[var(--ink)] bg-[var(--fill)]"
                : "border-[var(--line)] hover:border-[var(--line-focus)] bg-[var(--surface)]"
            }`}
          >
            <input
              type="radio"
              name="contSrc"
              checked={src === "mix"}
              onChange={() => setSrc("mix")}
              className="accent-[var(--ink)] shrink-0"
            />
            <span className="font-medium whitespace-nowrap">麦克风 + 系统声音</span>
          </label>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className={DIALOG_BTN_SECONDARY}>
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleStart()}
          className={DIALOG_BTN_DANGER}
        >
          开始录音
        </button>
      </div>
    </ModalShell>
  );
}

export function RetranscribeDialog({
  open,
  meeting,
  hasEditedParagraphs,
  onClose,
}: {
  open: boolean;
  meeting: MeetingDetail;
  hasEditedParagraphs: boolean;
  onClose: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const showMeeting = useMeetingStore((s) => s.showMeeting);

  const [numSpk, setNumSpk] = useState(meeting.meta.num_spk || 0);
  const [hotword, setHotword] = useState(meeting.meta.hotword || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setNumSpk(meeting.meta.num_spk || 0);
      setHotword(meeting.meta.hotword || "");
    }
  }, [open, meeting.meta.num_spk, meeting.meta.hotword]);

  const first = meeting.meta.source === "ambient" && meeting.meta.status === "recording";

  const handleGo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/meetings/${encodeURIComponent(meeting.meta.id)}/transcribe`, {
        method: "POST",
        body: { num_spk: numSpk, hotword },
      });
      onClose();
      await showMeeting(meeting.meta.id, { keepTab: true });
      await loadMeetings();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "提交失败", 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      label={first ? "精准转写" : "重新转写"}
      maxWidthClass="max-w-[460px]"
      backdropClassName={DIALOG_BACKDROP}
      panelClassName={DIALOG_PANEL}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className={DIALOG_TITLE}>{first ? "精准转写" : "重新转写"}</h2>
        <button type="button" onClick={onClose} aria-label="关闭窗口" className={DIALOG_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className={DIALOG_DESC}>
        {first
          ? "用整段录音再识别一遍，并区分说话人。实时稿会换成这份结果。"
          : "调整参会人数或热词后重新识别。已改的说话人姓名会保留。"}
      </p>

      {hasEditedParagraphs && (
        <div className="rounded-[12px] bg-[var(--danger-soft)] text-[var(--danger)] px-3.5 py-2.5 text-[13px] leading-[20px]">
          这场有手动修改过的段落，重新转写会覆盖这些修改（词库纠错规则会自动重新套用）。
        </div>
      )}

      <div className="space-y-3.5">
        <div>
          <label
            htmlFor="retransSpk"
            className="block text-[13px] leading-[20px] font-medium text-[var(--text-2)] mb-1.5"
          >
            参会人数
          </label>
          <select
            id="retransSpk"
            value={numSpk}
            onChange={(e) => setNumSpk(Number(e.target.value))}
            className={`w-full ${DIALOG_INPUT}`}
          >
            <option value={0}>自动判断</option>
            {[2, 3, 4, 5, 6, 7, 8, 10, 12].map((n) => (
              <option key={n} value={n}>
                {n} 人
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="retransHot"
            className="block text-[13px] leading-[20px] font-medium text-[var(--text-2)] mb-1.5"
          >
            本场额外热词（空格或逗号分隔，最多 30 个）
          </label>
          <input
            id="retransHot"
            type="text"
            value={hotword}
            onChange={(e) => setHotword(e.target.value)}
            className={`w-full ${DIALOG_INPUT}`}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className={DIALOG_BTN_SECONDARY}>
          取消
        </button>
        <button type="button" disabled={busy} onClick={() => void handleGo()} className={DIALOG_BTN_PRIMARY}>
          {busy ? "提交中…" : "开始"}
        </button>
      </div>
    </ModalShell>
  );
}

export function RenameSpeakerDialog({
  spk,
  currentName,
  existingNames,
  meeting,
  onClose,
}: {
  spk: number | null;
  currentName: string;
  existingNames: string[];
  meeting: MeetingDetail;
  onClose: () => void;
}) {
  const patchMeeting = useMeetingStore((s) => s.patchMeeting);
  const pushToast = useAppStore((s) => s.pushToast);

  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (spk !== null) setName(currentName);
  }, [spk, currentName]);

  const handleSave = async (overrideName?: string) => {
    if (busy || spk === null) return;
    const trimmed = (overrideName ?? name).trim();
    const sp = { ...(meeting.meta.speakers || {}) };
    if (trimmed && trimmed !== `说话人${spk + 1}` && !isGenericSpeakerName(trimmed)) {
      sp[String(spk)] = trimmed;
    } else if (trimmed && trimmed !== `说话人${spk + 1}`) {
      sp[String(spk)] = trimmed;
    } else {
      delete sp[String(spk)];
    }

    setBusy(true);
    try {
      await patchMeeting(meeting.meta.id, { speakers: sp });
      onClose();
    } catch (err) {
      pushToast(`改名没保存上：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      setBusy(false);
    }
  };

  const quickChoices = existingNames.filter((n) => n && n !== currentName).slice(0, 8);

  return (
    <ModalShell
      open={spk !== null}
      onClose={onClose}
      label="修改发言人姓名"
      maxWidthClass="max-w-[420px]"
      backdropClassName={DIALOG_BACKDROP}
      panelClassName={DIALOG_PANEL}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className={DIALOG_TITLE}>修改发言人姓名</h2>
        <button type="button" onClick={onClose} aria-label="关闭窗口" className={DIALOG_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className={DIALOG_DESC}>“{currentName}”的所有发言都会同步改名。填成已有的名字可合并同一人。</p>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleSave();
        }}
        list="spkNameList"
        aria-label="发言人姓名"
        autoFocus
        className={`w-full ${DIALOG_INPUT}`}
      />
      <datalist id="spkNameList">
        {existingNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      {quickChoices.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs leading-[18px] text-[var(--muted)] whitespace-nowrap shrink-0">
            快速选择：
          </span>
          {quickChoices.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => void handleSave(n)}
              className="h-7 rounded-full bg-[var(--fill)] hover:bg-[var(--fill-hover)] px-3 text-xs leading-[18px] font-medium text-[var(--text-2)] hover:text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              {n}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className={DIALOG_BTN_SECONDARY}>
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSave()}
          className={DIALOG_BTN_PRIMARY}
        >
          保存
        </button>
      </div>
    </ModalShell>
  );
}

export function GuessNamesDialog({
  open,
  meeting,
  spkName,
  onClose,
}: {
  open: boolean;
  meeting: MeetingDetail;
  spkName: (spk: number) => string;
  onClose: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const patchMeeting = useMeetingStore((s) => s.patchMeeting);
  const requestSeek = useMeetingStore((s) => s.requestSeek);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resp, setResp] = useState<SpeakerNamesResponse | null>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [editedNames, setEditedNames] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setResp(null);
    setChecked({});
    setEditedNames({});
    void api<SpeakerNamesResponse>(`/api/meetings/${encodeURIComponent(meeting.meta.id)}/speaker-names`, {
      method: "POST",
      body: {},
      timeout: 90000,
    })
      .then((r) => {
        setResp(r);
        const initNames: Record<number, string> = {};
        r.candidates.forEach((c, idx) => {
          initNames[idx] = c.name;
        });
        setEditedNames(initNames);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "推测失败");
      })
      .finally(() => setLoading(false));
  }, [open, meeting.meta.id]);

  const handleApply = async () => {
    if (!resp || saving) return;
    const sp = { ...(meeting.meta.speakers || {}) };
    let count = 0;
    resp.candidates.forEach((c, idx) => {
      if (!checked[idx]) return;
      const val = (editedNames[idx] ?? "").trim();
      if (val) {
        sp[String(c.spk)] = val;
        count += 1;
      }
    });
    if (!count) {
      pushToast("没有勾选要改名的说话人");
      return;
    }
    setSaving(true);
    try {
      await patchMeeting(meeting.meta.id, { speakers: sp });
      pushToast(`已改名 ${count} 位说话人`);
      onClose();
    } catch (err) {
      pushToast(`改名没保存上：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      label="推测说话人姓名"
      maxWidthClass="max-w-[540px]"
      backdropClassName={DIALOG_BACKDROP}
      panelClassName={DIALOG_PANEL}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className={DIALOG_TITLE}>推测说话人姓名</h2>
        <button type="button" onClick={onClose} aria-label="关闭窗口" className={DIALOG_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className={DIALOG_DESC}>
        {loading
          ? "AI 正在从对话中查找自我介绍和称呼线索…"
          : error
            ? `没推测出来：${error}`
            : resp?.candidates.length
              ? `以下是有原话依据的推测（${resp.cost}s）。点击时间可先试听确认。`
              : "对话中没有找到明确称呼，暂无可推荐的姓名。"}
      </p>

      {loading && <SkeletonLines lines={3} />}

      {resp && resp.candidates.length > 0 && (
        <div className="max-h-[48vh] overflow-y-auto space-y-2.5 pr-1">
          {resp.candidates.map((c, idx) => (
            <div
              key={`${c.spk}-${idx}`}
              className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3.5 space-y-2"
            >
              <label className="flex flex-wrap items-center gap-2 text-sm leading-[22px] font-medium text-[var(--text)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(checked[idx])}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [idx]: e.target.checked }))}
                />
                <span className="whitespace-nowrap shrink-0">{spkName(c.spk)} →</span>
                <input
                  type="text"
                  value={editedNames[idx] ?? c.name}
                  onChange={(e) => setEditedNames((prev) => ({ ...prev, [idx]: e.target.value }))}
                  aria-label="候选说话人姓名"
                  className="h-8 rounded-[8px] px-2.5 bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] text-[13px] leading-[20px] text-[var(--text)] w-32 transition-colors"
                />
                <span className="text-xs leading-[18px] text-[var(--muted)] font-normal whitespace-nowrap shrink-0">
                  把握：{c.confidence}
                </span>
              </label>
              <div className="text-[13px] leading-[20px] text-[var(--text-2)]">{c.reason}</div>
              {c.evidence.map((ev, ei) => (
                <div key={`${ev.ts}-${ei}`} className="text-[13px] leading-[20px] text-[var(--text-body)]">
                  <button
                    type="button"
                    onClick={() => {
                      const sec = ev.ts
                        .split(":")
                        .map(Number)
                        .reduce((a, b) => a * 60 + (Number.isFinite(b) ? b : 0), 0);
                      requestSeek(sec * 1000, true);
                    }}
                    className="text-xs leading-[18px] text-[var(--text-2)] hover:text-[var(--text)] num-mono mr-1.5 hover:underline whitespace-nowrap cursor-pointer transition-colors"
                  >
                    [{ev.ts}]
                  </button>
                  {spkName(ev.spk)}：{ev.quote}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className={DIALOG_BTN_SECONDARY}>
          {resp?.candidates.length ? "取消" : "关闭"}
        </button>
        {resp && resp.candidates.length > 0 && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleApply()}
            className={DIALOG_BTN_PRIMARY}
          >
            按勾选的改名
          </button>
        )}
      </div>
    </ModalShell>
  );
}

export function QuickVocabFixModal({
  candidate,
  meetingId,
  allParagraphTexts,
  onClose,
}: {
  candidate: { from: string; to: string } | null;
  meetingId: string;
  allParagraphTexts: string[];
  onClose: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const showMeeting = useMeetingStore((s) => s.showMeeting);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [addHot, setAddHot] = useState(false);
  const [confirmShort, setConfirmShort] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (candidate) {
      setFrom(candidate.from);
      setTo(candidate.to);
      setAddHot(/[\u4e00-\u9fff]/.test(candidate.to) && candidate.to.length >= 2);
      setConfirmShort(false);
    }
  }, [candidate]);

  const matchCount = from.trim()
    ? allParagraphTexts.reduce((n, t) => n + (t.toLowerCase().split(from.trim().toLowerCase()).length - 1), 0)
    : 0;

  const handleConfirm = async () => {
    const f = from.trim();
    const t = to.trim();
    if (!f || f === t) {
      pushToast("请填写不同的错误写法和正确写法");
      return;
    }
    if (f.length < 2 && !confirmShort) {
      setConfirmShort(true);
      return;
    }
    setBusy(true);
    try {
      await api("/api/vocab/fix", { method: "POST", body: { from: f, to: t, hotword: addHot } });
      onClose();
      await showMeeting(meetingId, { keepTab: true });
      pushToast(`已加入词库纠错：${f} → ${t}`, { tone: "success" });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open={Boolean(candidate)}
      onClose={onClose}
      label="加入词库纠错"
      maxWidthClass="max-w-[460px]"
      backdropClassName={DIALOG_BACKDROP}
      panelClassName={DIALOG_PANEL}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className={DIALOG_TITLE}>以后自动纠正这个错词吗？</h2>
        <button type="button" onClick={onClose} aria-label="关闭窗口" className={DIALOG_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className={DIALOG_DESC}>加入词库后，所有记录里相同的写法都会自动改正；删掉规则即可恢复原文。</p>

      <div className="flex items-center gap-2.5">
        <input
          type="text"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setConfirmShort(false);
          }}
          aria-label="错误写法"
          className={`flex-1 min-w-0 ${DIALOG_INPUT}`}
        />
        <span className="text-[var(--muted)] shrink-0">→</span>
        <input
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="正确写法"
          className={`flex-1 min-w-0 ${DIALOG_INPUT}`}
        />
      </div>

      {from.trim() && (
        <div className="text-[13px] leading-[20px] text-[var(--text-2)]">
          本场还有 <span className="num font-medium text-[var(--text)]">{matchCount}</span> 处「
          {from.trim()}」会被改正
        </div>
      )}

      {confirmShort && (
        <div className="rounded-[12px] bg-[var(--warn-soft)] text-[var(--warn)] px-3.5 py-2.5 text-[13px] leading-[20px]">
          「{from.trim()}」只有 1 个字，可能把其他正常词也一并替换；确定要加入请再点一次确认。
        </div>
      )}

      <label className="flex items-center gap-2 text-sm leading-[22px] text-[var(--text)] cursor-pointer">
        <input type="checkbox" checked={addHot} onChange={(e) => setAddHot(e.target.checked)} />
        <span>同时把「{to.trim() || "..."}」加入常用热词</span>
      </label>

      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onClose} className={DIALOG_BTN_SECONDARY}>
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleConfirm()}
          className={DIALOG_BTN_PRIMARY}
        >
          {confirmShort ? "确认加入" : "加入词库"}
        </button>
      </div>
    </ModalShell>
  );
}
