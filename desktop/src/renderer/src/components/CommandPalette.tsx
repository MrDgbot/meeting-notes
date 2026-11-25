import { fmtDur, hm } from "@shared/format";
import {
  BookOpenText,
  Calendar,
  CheckSquare,
  Cpu,
  FileText,
  FolderKanban,
  Mic,
  Moon,
  Search,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "@/components/MotionPrimitives";
import { useAppStore } from "@/stores/appStore";

interface PaletteCommand {
  id: string;
  label: string;
  hint: string;
  kind: "action" | "meeting";
  keywords?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const meetings = useAppStore((s) => s.meetings);
  const desktopInfo = useAppStore((s) => s.desktopInfo);
  const navigate = useAppStore((s) => s.navigate);
  const cycleTheme = useAppStore((s) => s.cycleTheme);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSidecarOpen = useAppStore((s) => s.setSidecarOpen);
  const setVpWizardOpen = useAppStore((s) => s.setVpWizardOpen);
  const trashCount = useAppStore((s) => s.trashCount);
  const setTrashOpen = useAppStore((s) => s.setTrashOpen);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isMac = desktopInfo ? desktopInfo.platform === "darwin" : /Mac/i.test(navigator.platform);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo<PaletteCommand[]>(() => {
    const mod = isMac ? "⌘" : "Ctrl+";
    const alt = isMac ? "⌥" : "Alt+";
    const shift = isMac ? "⇧" : "Shift+";

    const actions: PaletteCommand[] = [
      {
        id: "quick-ask",
        label: "全局闪问：一句话查所有历史会议",
        hint: `${mod}${shift}Space`,
        kind: "action",
        run: () => {
          if (window.desktopAPI) {
            void window.desktopAPI.toggleQuickAsk();
          } else {
            navigate("#/quick-ask");
          }
        },
      },
      {
        id: "new",
        label: "开始新会议 / 导入录音",
        hint: `${mod}${alt}${shift}N`,
        kind: "action",
        run: () => navigate("#/"),
      },
      {
        id: "todos",
        label: "待办中心与承诺雷达",
        hint: "待办",
        kind: "action",
        run: () => navigate("#/todos"),
      },
      {
        id: "people",
        label: "人物目录与发言统计",
        hint: "人物",
        kind: "action",
        run: () => navigate("#/people"),
      },
      {
        id: "vp-wizard",
        label: "批量认人向导",
        hint: "声纹",
        kind: "action",
        run: () => setVpWizardOpen(true),
      },
      {
        id: "projects",
        label: "项目脉络：跨场次专题汇总",
        hint: "项目",
        kind: "action",
        run: () => navigate("#/projects"),
      },
      {
        id: "weekly",
        label: "周报：汇总本周工作进展",
        hint: "周报",
        kind: "action",
        run: () => navigate("#/weekly"),
      },
      {
        id: "today",
        label: "查看今日会议日报",
        hint: "日报",
        kind: "action",
        run: () => {
          const d = new Date();
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          navigate(`#/day/${day}`);
        },
      },
      {
        id: "sidecar",
        label: "查看本机语音服务状态与日志",
        hint: "诊断",
        kind: "action",
        run: () => setSidecarOpen(true),
      },
      {
        id: "settings",
        label: "打开设置",
        hint: `${mod},`,
        kind: "action",
        run: () => setSettingsOpen(true),
      },
      {
        id: "trash",
        label: "打开废纸篓（恢复已删除的会议）",
        hint: trashCount > 0 ? `${trashCount} 条` : "恢复",
        kind: "action",
        run: () => setTrashOpen(true),
      },
      {
        id: "theme",
        label: "切换外观主题（自动 / 浅色 / 深色）",
        hint: "外观",
        kind: "action",
        run: () => cycleTheme(),
      },
    ];

    const meetingCmds: PaletteCommand[] = meetings.map((m) => ({
      id: `m-${m.id}`,
      label: m.title || "未命名会议",
      hint: `${(m.created || "").slice(0, 10)} ${hm(m.created)} · ${fmtDur(m.duration)}`,
      kind: "meeting",
      keywords: [m.brief || "", ...(m.tags || []), ...Object.values(m.speakers || {})]
        .join(" ")
        .toLowerCase(),
      run: () => navigate(`#/m/${m.id}`),
    }));

    const q = query.trim().toLowerCase();
    if (!q) {
      return [...actions, ...meetingCmds.slice(0, 8)];
    }
    const matchedActions = actions.filter(
      (it) => it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q),
    );
    const matchedMeetings = meetingCmds
      .filter(
        (it) =>
          it.label.toLowerCase().includes(q) ||
          it.hint.toLowerCase().includes(q) ||
          Boolean(it.keywords?.includes(q)),
      )
      .slice(0, 40);
    return [...matchedActions, ...matchedMeetings];
  }, [
    meetings,
    query,
    isMac,
    navigate,
    cycleTheme,
    setSettingsOpen,
    setSidecarOpen,
    setVpWizardOpen,
    trashCount,
    setTrashOpen,
  ]);

  useEffect(() => {
    itemRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (items.length ? (i + 1) % items.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
      } else if (e.key === "Enter" && !e.isComposing) {
        const picked = items[activeIdx];
        if (picked) {
          e.preventDefault();
          setOpen(false);
          picked.run();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, activeIdx, setOpen]);

  const iconFor = (it: PaletteCommand, active: boolean) => {
    const cls = `w-4 h-4 shrink-0 transition-colors ${active ? "text-[var(--text)]" : "text-[var(--muted)]"}`;
    if (it.id === "quick-ask" || it.id === "vp-wizard") return <Sparkles className={cls} />;
    if (it.id === "new") return <Mic className={cls} />;
    if (it.id === "todos") return <CheckSquare className={cls} />;
    if (it.id === "people") return <Users className={cls} />;
    if (it.id === "projects") return <FolderKanban className={cls} />;
    if (it.id === "weekly") return <BookOpenText className={cls} />;
    if (it.id === "today") return <Calendar className={cls} />;
    if (it.id === "sidecar") return <Cpu className={cls} />;
    if (it.id === "settings") return <Settings className={cls} />;
    if (it.id === "theme") return <Moon className={cls} />;
    return <FileText className={cls} />;
  };

  const firstMeetingIdx = items.findIndex((it) => it.kind === "meeting");
  const hasActions = items.some((it) => it.kind === "action");

  return (
    <ModalShell
      open={open}
      onClose={() => setOpen(false)}
      label="命令面板"
      variant="palette"
      maxWidthClass="max-w-xl"
      backdropClassName="bg-[var(--backdrop)] backdrop-blur-[4px]"
      panelClassName="rounded-[16px] bg-[var(--surface-elev)] shadow-[var(--shadow-3)]"
    >
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--line-2)]">
        <Search className="w-4 h-4 text-[var(--muted)] shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          placeholder="搜索全部会议、人物或执行命令…"
          aria-label="搜索命令或会议"
          className="flex-1 min-w-0 bg-transparent border-0 shadow-none hover:bg-transparent focus:bg-transparent focus:shadow-none focus:border-0 text-[15px] leading-[22px] text-[var(--text)] placeholder:text-[var(--muted)] px-0 py-0.5"
        />
        <kbd className="font-mono text-[11px] leading-[14px] text-[var(--muted)] px-1.5 py-0.5 rounded-[6px] bg-[var(--fill)] border border-[var(--line-2)] whitespace-nowrap shrink-0">
          Esc
        </kbd>
      </div>

      <div className="max-h-[56vh] overflow-y-auto p-2 space-y-0.5">
        {!items.length ? (
          <div className="py-10 text-center text-[13px] leading-[20px] text-[var(--muted)]">
            没有匹配的命令或会议
          </div>
        ) : (
          items.map((it, idx) => {
            const active = idx === activeIdx;
            return (
              <div key={it.id}>
                {idx === 0 && hasActions && (
                  <div className="px-3 pt-1.5 pb-1 text-xs leading-[18px] font-medium text-[var(--muted)]">
                    常用操作
                  </div>
                )}
                {idx === firstMeetingIdx && (
                  <div className="px-3 pt-2.5 pb-1 text-xs leading-[18px] font-medium text-[var(--muted)]">
                    会议记录
                  </div>
                )}
                <button
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => {
                    setOpen(false);
                    it.run();
                  }}
                  className={`w-full text-left rounded-[10px] px-3 py-2 flex items-center gap-2.5 text-sm leading-[22px] cursor-pointer transition-colors duration-150 ${
                    active
                      ? "bg-[var(--fill-hover)] text-[var(--text)]"
                      : "text-[var(--text-body)] hover:bg-[var(--fill)]"
                  }`}
                >
                  {iconFor(it, active)}
                  <span className="flex-1 truncate font-medium">{it.label}</span>
                  <span className="text-xs leading-[18px] text-[var(--muted)] whitespace-nowrap shrink-0 num">
                    {it.hint}
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
}
