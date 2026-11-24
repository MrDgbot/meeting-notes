import { fmtTs } from "@shared/format";
import type { AmbientStatus, QuickMarkPayload } from "@shared/types";
import { globalShortcut, Notification } from "electron";
import type { SidecarManager } from "./sidecar";
import type { RecorderSyncState } from "./tray";

export interface ShortcutDeps {
  sidecar: SidecarManager;
  getRecorderState: () => RecorderSyncState;
  isMainFocused?: () => boolean;
  onShowMain: (hash?: string) => void;
  onQuickMarkCreated: (payload: QuickMarkPayload) => void;
  onToggleQuickAsk?: () => void;
}

const MARK_KEY_LABEL = process.platform === "darwin" ? "⌘⇧M" : "Ctrl+Shift+M";

export class ShortcutController {
  private readonly deps: ShortcutDeps;

  constructor(deps: ShortcutDeps) {
    this.deps = deps;
  }

  async triggerQuickMark(): Promise<void> {
    if (this.deps.sidecar.getStatus().phase !== "running") return;
    const rec = this.deps.getRecorderState();
    let mid: string | null = null;
    let tMs = 0;

    if (rec.active && rec.mid) {
      mid = rec.mid;
      const delta = rec.paused ? 0 : Math.max(0, Date.now() - rec.updatedAt);
      tMs = Math.max(0, Math.round(rec.elapsedMs + delta));
    } else {
      try {
        const amb = await this.deps.sidecar.fetchApi<AmbientStatus>("/api/ambient");
        if (amb.conv?.id) {
          mid = amb.conv.id;
          tMs = Math.max(0, Math.round((amb.conv.dur_s || 0) * 1000));
        }
      } catch {
        return;
      }
    }

    if (!mid) {
      if (Notification.isSupported()) {
        new Notification({
          title: "当前没有进行中的录音",
          body: `开始会议录音或开启全天模式后，按 ${MARK_KEY_LABEL} 可随时标记重点。`,
          silent: true,
        }).show();
      }
      return;
    }

    try {
      const res = await this.deps.sidecar.fetchApi<{
        mark?: { id: string; t_ms?: number };
        created?: boolean;
      }>(`/api/meetings/${encodeURIComponent(mid)}/marks`, {
        method: "POST",
        body: JSON.stringify({ t_ms: tMs, label: "全局快捷标记" }),
      });
      const shownMs = typeof res.mark?.t_ms === "number" ? res.mark.t_ms : tMs;
      this.deps.onQuickMarkCreated({ mid, tMs: shownMs, markId: res.mark?.id });
      const focused = this.deps.isMainFocused?.() ?? false;
      if (!focused && Notification.isSupported()) {
        new Notification({
          title: res.created === false ? `附近已有标记 ${fmtTs(shownMs)}` : `已标记 ${fmtTs(shownMs)}`,
          body: "已标注到当前会议时间线",
          silent: true,
        }).show();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "请检查服务连接后再试";
      if (Notification.isSupported()) {
        new Notification({ title: "快捷标记失败", body: msg, silent: true }).show();
      }
    }
  }

  register(): void {
    const shortcuts: Array<[string, () => void]> = [
      [
        "CommandOrControl+Shift+M",
        () => {
          void this.triggerQuickMark();
        },
      ],
      [
        "CommandOrControl+Alt+Shift+N",
        () => {
          this.deps.onShowMain("#/");
        },
      ],
    ];
    if (this.deps.onToggleQuickAsk) {
      shortcuts.push([
        "CommandOrControl+Shift+Space",
        () => {
          this.deps.onToggleQuickAsk?.();
        },
      ]);
    }
    for (const [accel, handler] of shortcuts) {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) {
        console.warn(`[shortcuts] failed to register global shortcut: ${accel}`);
      }
    }
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
  }
}
