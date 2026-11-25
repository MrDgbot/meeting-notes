import fs from "node:fs";
import path from "node:path";
import type { AmbientStatus, DetectedMeetingApp, SidecarStatus } from "@shared/types";
import { Menu, type MenuItemConstructorOptions, Notification, nativeImage, Tray } from "electron";
import type { SidecarManager } from "./sidecar";

export interface RecorderSyncState {
  active: boolean;
  paused: boolean;
  mid: string | null;
  elapsedMs: number;
  updatedAt: number;
}

export interface TrayControllerDeps {
  isPackaged: boolean;
  resourcesPath: string;
  sidecar: SidecarManager;
  getRecorderState: () => RecorderSyncState;
  getDetectedMeetingApp?: () => DetectedMeetingApp | null;
  onShowMain: (hash?: string) => void;
  onToggleQuickAsk?: () => void;
  onQuickMark: () => Promise<void>;
  onOpenDataDir: () => void;
  onOpenDiagnostics: () => void;
  onQuit: () => void;
}

export class TrayController {
  private readonly deps: TrayControllerDeps;
  private tray: Tray | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ambient: AmbientStatus | null = null;
  private lastMenuSig = "";

  constructor(deps: TrayControllerDeps) {
    this.deps = deps;
  }

  private resolveIconPath(): string {
    const file = process.platform === "darwin" ? "trayTemplate.png" : "icon.png";
    return this.deps.isPackaged
      ? path.join(this.deps.resourcesPath, file)
      : path.join(import.meta.dirname, `../../build/${file}`);
  }

  start(): void {
    if (this.tray) return;
    const iconPath = this.resolveIconPath();
    let img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    if (!img.isEmpty()) {
      if (process.platform === "darwin") {
        img.setTemplateImage(true);
      } else {
        const size = process.platform === "win32" ? 16 : 22;
        img = img.resize({ width: size, height: size });
      }
    }
    this.tray = new Tray(img);
    this.tray.setToolTip("会议记录 · 本机转写 & AI 纪要");
    this.tray.on("click", () => {
      if (process.platform !== "darwin") {
        this.deps.onShowMain();
      }
    });
    this.tray.on("double-click", () => this.deps.onShowMain());

    this.deps.sidecar.on("status", () => {
      void this.refresh();
    });

    this.updateUI();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, 3000);
    void this.refresh();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  async refresh(): Promise<void> {
    const sc = this.deps.sidecar.getStatus();
    if (sc.phase === "running") {
      try {
        this.ambient = await this.deps.sidecar.fetchApi<AmbientStatus>("/api/ambient");
      } catch {
        this.ambient = null;
      }
    } else {
      this.ambient = null;
    }
    this.updateUI();
  }

  private computeTitle(sc: SidecarStatus, rec: RecorderSyncState): string {
    if (process.platform !== "darwin") return "";
    if (sc.phase === "bootstrapping") return " 初始化中";
    if (sc.phase === "starting") return " 启动中";
    if (sc.phase === "error") return " 异常";
    if (rec.active) return rec.paused ? " 已暂停" : " ● 录音中";
    if (this.ambient?.enabled && this.ambient.state === "speech") return " ● 记录中";
    return "";
  }

  private async runAmbientAction(body: Record<string, unknown>): Promise<void> {
    try {
      this.ambient = await this.deps.sidecar.fetchApi<AmbientStatus>("/api/ambient", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (Notification.isSupported()) {
        new Notification({
          title: "全天模式操作未完成",
          body: err instanceof Error ? err.message : "请稍后再试",
          silent: true,
        }).show();
      }
    }
    this.updateUI();
  }

  updateUI(): void {
    if (!this.tray) return;
    const sc = this.deps.sidecar.getStatus();
    const rec = this.deps.getRecorderState();
    const amb = this.ambient;

    if (process.platform === "darwin") {
      this.tray.setTitle(this.computeTitle(sc, rec));
    }

    const statusLine =
      sc.phase === "bootstrapping"
        ? "正在初始化本机语音环境…"
        : sc.phase === "starting"
          ? "语音服务启动中…"
          : sc.phase === "error"
            ? "语音服务异常"
            : rec.active
              ? rec.paused
                ? "手动录音已暂停"
                : "正在会议录音"
              : amb?.enabled
                ? amb.state === "speech"
                  ? "全天模式 · 正在记录对话"
                  : amb.state === "paused"
                    ? "全天模式 · 已暂停"
                    : amb.state === "held"
                      ? "全天模式 · 开会录音中已暂避"
                      : "全天模式 · 正在监听"
                : "会议记录 · 待机中";

    const detected = this.deps.getDetectedMeetingApp?.() ?? null;
    const sig = JSON.stringify([
      statusLine,
      sc.phase,
      rec.active,
      rec.mid,
      amb?.enabled ?? null,
      amb?.state ?? null,
      Boolean(amb?.conv),
      detected?.id ?? null,
    ]);
    if (sig === this.lastMenuSig) return;
    this.lastMenuSig = sig;

    const template: MenuItemConstructorOptions[] = [
      { label: statusLine, enabled: false },
      ...(detected && !rec.active
        ? [
            {
              label: `检测到${detected.name} · 准备双声道录音`,
              click: () => this.deps.onShowMain("#/?autostart=mix"),
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      { type: "separator" },
      {
        label: rec.active && rec.mid ? "回到当前录音" : "打开主窗口",
        click: () => this.deps.onShowMain(rec.active && rec.mid ? `#/m/${rec.mid}` : undefined),
      },
      ...(this.deps.onToggleQuickAsk
        ? [
            {
              label: "全局闪问",
              accelerator: "CommandOrControl+Shift+Space",
              click: () => this.deps.onToggleQuickAsk?.(),
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      {
        label: "新建会议录音",
        accelerator: "CommandOrControl+Alt+Shift+N",
        enabled: !rec.active,
        click: () => this.deps.onShowMain("#/"),
      },
      {
        label: "立刻标记重点",
        accelerator: "CommandOrControl+Shift+M",
        enabled: sc.phase === "running" && (rec.active || Boolean(amb?.conv)),
        click: () => {
          void this.deps.onQuickMark();
        },
      },
      { type: "separator" },
    ];

    if (sc.phase === "running" && amb) {
      template.push({
        label: amb.enabled ? "关闭全天模式" : "开启全天模式",
        click: () => {
          void this.runAmbientAction({ action: amb.enabled ? "stop" : "start" });
        },
      });
      if (amb.enabled) {
        if (amb.state === "paused") {
          template.push({
            label: "恢复全天模式",
            click: () => {
              void this.runAmbientAction({ action: "resume" });
            },
          });
        } else if (amb.state !== "held") {
          template.push({
            label: "暂停全天模式",
            submenu: [
              {
                label: "暂停 15 分钟",
                click: () => void this.runAmbientAction({ action: "pause", minutes: 15 }),
              },
              {
                label: "暂停 30 分钟",
                click: () => void this.runAmbientAction({ action: "pause", minutes: 30 }),
              },
              {
                label: "暂停 1 小时",
                click: () => void this.runAmbientAction({ action: "pause", minutes: 60 }),
              },
              {
                label: "暂停直到恢复",
                click: () => void this.runAmbientAction({ action: "pause", minutes: 0 }),
              },
            ],
          });
        }
        if (amb.conv) {
          template.push({
            label: "结束并保存当前全天对话",
            click: () => {
              void this.runAmbientAction({ action: "split" });
            },
          });
        }
      }
      template.push({ type: "separator" });
    }

    template.push(
      { label: "打开数据目录", click: () => this.deps.onOpenDataDir() },
      { label: "服务诊断与日志", click: () => this.deps.onOpenDiagnostics() },
      {
        label: "重启语音服务",
        click: () => {
          void this.deps.sidecar.restart();
        },
      },
      { type: "separator" },
      { label: "退出会议记录", accelerator: "CommandOrControl+Q", click: () => this.deps.onQuit() },
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
