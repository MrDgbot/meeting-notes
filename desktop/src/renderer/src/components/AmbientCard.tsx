import { fmtDur, hm } from "@shared/format";
import type { DiscardedItem } from "@shared/types";
import { History, Pause, Play, Scissors, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Disclosure, InlineConfirm } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

export function AmbientCard() {
  const ambient = useAppStore((s) => s.ambient);
  const runAmbientAction = useAppStore((s) => s.runAmbientAction);
  const restoreDiscarded = useAppStore((s) => s.restoreDiscarded);
  const setAmbientIntroOpen = useAppStore((s) => s.setAmbientIntroOpen);
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);

  const [showDiscarded, setShowDiscarded] = useState(false);
  const [discardedItems, setDiscardedItems] = useState<DiscardedItem[]>([]);
  const [loadingDiscarded, setLoadingDiscarded] = useState(false);

  const state = ambient?.state ?? "off";
  const enabled = Boolean(ambient?.enabled);
  const hasDiscardedNotice = Boolean(ambient?.discarded);

  useEffect(() => {
    if (!showDiscarded) return;
    setLoadingDiscarded(true);
    void api<{ items?: DiscardedItem[] }>("/api/discarded")
      .then((res) => setDiscardedItems(Array.isArray(res?.items) ? res.items : []))
      .catch(() => setDiscardedItems([]))
      .finally(() => setLoadingDiscarded(false));
  }, [showDiscarded]);

  const toggleAmbient = () => {
    if (!enabled) {
      let seen = false;
      try {
        seen = localStorage.getItem("ambSeen") === "1";
      } catch {}
      if (!seen) {
        setAmbientIntroOpen(true);
        return;
      }
      void runAmbientAction({ action: "start" });
    } else {
      void runAmbientAction({ action: "stop" });
    }
  };

  const statusText = (() => {
    if (!ambient) return "自动记录身边的对话，有人说话才录音";
    if (state === "error") return ambient.error || "麦克风不可用";
    if (state === "held") return "正在开会录音，已自动挂起";
    if (state === "paused") {
      if (ambient.paused_until < 0) return "已手动暂停";
      const leftMin = Math.max(1, Math.ceil((ambient.paused_until - Date.now() / 1000) / 60));
      return `已暂停 · 约 ${leftMin} 分钟后恢复`;
    }
    if (state === "speech" && ambient.conv) {
      return `说话中 · 已说 ${fmtDur(ambient.conv.speech_s)}`;
    }
    if (ambient.conv) {
      return `等待续说 · 已说 ${fmtDur(ambient.conv.speech_s)}`;
    }
    if (state === "listening") return "监听中 · 有人说话自动记";
    if (state === "starting") return "正在打开麦克风…";
    return "自动记录身边的对话，有人说话才录音";
  })();

  const dotClass =
    state === "speech"
      ? "bg-[var(--red)] rec-dot"
      : state === "listening" || state === "starting"
        ? "bg-[var(--green)]"
        : state === "paused" || state === "held"
          ? "bg-[var(--amber)]"
          : state === "error"
            ? "bg-[var(--red)]"
            : "bg-[var(--line)]";

  const meterPct = enabled
    ? Math.max(0, Math.min(100, Math.round(((ambient?.level_db ?? -60) + 60) * 1.8)))
    : 0;

  const minS = ambient?.cfg?.min_speech_s ?? 15;
  const shortSplit = Boolean(ambient?.conv && ambient.conv.voiced_s < minS);

  return (
    <div
      className={`rounded-[12px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-3 transition-[padding,background-color] duration-200 ${
        enabled ? "py-2.5" : "py-2"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
          <span className="text-[13.5px] font-semibold text-[var(--text)] truncate">全天模式</span>
        </div>

        <label className="ios-switch" title={enabled ? "关闭全天模式" : "开启全天模式"}>
          <input type="checkbox" checked={enabled} onChange={toggleAmbient} aria-label="切换全天模式" />
          <i />
        </label>
      </div>

      <div
        className={`mt-1 text-[11.5px] leading-snug num overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_85%,transparent)] ${
          state === "error" ? "text-[var(--red)]" : "text-[var(--muted)]"
        }`}
        title={ambient?.partial || statusText}
      >
        {ambient?.partial ? ambient.partial : statusText}
      </div>

      {enabled && (
        <div className="mt-2 h-[3px] rounded-full bg-[var(--fill-2)] overflow-hidden" aria-hidden="true">
          <div
            className="h-full w-full origin-left bg-[var(--green)] transition-transform duration-150"
            style={{ transform: `scaleX(${(meterPct / 100).toFixed(3)})` }}
          />
        </div>
      )}

      {ambient?.fallback && (
        <div className="mt-1.5 text-[11px] text-[var(--amber)] leading-tight">{ambient.fallback}</div>
      )}

      {ambient?.conv && (
        <div className="mt-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate(`#/m/${ambient.conv?.id}`)}
            className="flex-1 text-left rounded-lg bg-[var(--fill)] hover:bg-[var(--fill-2)] px-2 py-1 text-[11.5px] text-[var(--red)] font-medium truncate num cursor-pointer transition-colors"
          >
            正在记录 · {fmtDur(ambient.conv.dur_s)}
          </button>
          {shortSplit ? (
            <InlineConfirm
              triggerAriaLabel="立即切分当前对话"
              triggerTitle="立即切分保存这段对话"
              triggerIcon={<Scissors className="w-3.5 h-3.5" />}
              triggerClassName="btn-ghost rounded-lg p-1"
              message={`这段只说了 ${Math.round(ambient.conv.voiced_s)} 秒（不足 ${minS} 秒），现在切分不会保留在主列表。确定切分吗？`}
              confirmLabel="切分"
              align="right"
              onConfirm={() => runAmbientAction({ action: "split" })}
            />
          ) : (
            <button
              type="button"
              onClick={() => void runAmbientAction({ action: "split" })}
              title="立即切分保存这段对话"
              aria-label="立即切分当前对话"
              className="btn-ghost rounded-lg p-1 cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {enabled && (
        <div className="mt-1.5 flex items-center justify-between gap-1 text-[11px] text-[var(--muted)]">
          <span className="num">
            今日 {ambient?.today.count ?? 0} 段 · {fmtDur(ambient?.today.speech_s ?? 0)}
          </span>
          {state === "paused" ? (
            <button
              type="button"
              onClick={() => void runAmbientAction({ action: "resume" })}
              className="hover:text-[var(--text)] inline-flex items-center gap-0.5 cursor-pointer"
            >
              <Play className="w-3 h-3" /> 恢复
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runAmbientAction({ action: "pause", minutes: 30 })}
              className="hover:text-[var(--text)] inline-flex items-center gap-0.5 cursor-pointer"
            >
              <Pause className="w-3 h-3" /> 暂停30分
            </button>
          )}
        </div>
      )}

      {(hasDiscardedNotice || showDiscarded) && (
        <div className="mt-1.5 pt-1.5 border-t border-[var(--line-2)]">
          <button
            type="button"
            onClick={() => setShowDiscarded((v) => !v)}
            className="text-[11px] text-[var(--link)] hover:underline inline-flex items-center gap-1 cursor-pointer"
          >
            <History className="w-3 h-3" />
            {showDiscarded ? "收起待恢复片段" : "有短片段被跳过，点击查看"}
          </button>
        </div>
      )}

      <Disclosure open={showDiscarded} contentClassName="pt-2">
        <div className="rounded-lg bg-[var(--fill)] p-2 space-y-1.5 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between text-[11px] font-medium">
            <span>最近跳过的短对话</span>
            <button
              type="button"
              onClick={() => setShowDiscarded(false)}
              aria-label="关闭跳过列表"
              className="btn-ghost rounded-md w-[26px] h-[26px] inline-flex items-center justify-center cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {loadingDiscarded ? (
            <div className="text-[11px] text-[var(--muted)]">加载中…</div>
          ) : !discardedItems.length ? (
            <div className="text-[11px] text-[var(--muted)]">暂无可恢复的短片段</div>
          ) : (
            discardedItems.map((it) => (
              <div
                key={it.id}
                className="rounded-lg bg-[var(--surface)] shadow-[var(--shadow-1)] p-2 flex items-start justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-[var(--muted)] num">
                    {hm(it.time)} · {Math.round(it.voiced_s)}秒
                  </div>
                  <div className="text-[11px] text-[var(--text-body)] line-clamp-2">
                    {it.text || "（无文字预览）"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void restoreDiscarded(it.id).catch((err) =>
                      pushToast(err instanceof Error ? err.message : "恢复失败", 4000),
                    );
                    setShowDiscarded(false);
                  }}
                  className="btn-secondary rounded px-2 py-0.5 text-[11px] shrink-0 cursor-pointer"
                >
                  恢复
                </button>
              </div>
            ))
          )}
        </div>
      </Disclosure>
    </div>
  );
}
