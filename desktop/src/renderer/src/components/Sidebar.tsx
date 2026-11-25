import { effDuration, fmtDur, hm, isShortClip, STATUS_LABELS } from "@shared/format";
import type { MeetingMeta } from "@shared/types";
import {
  AudioLines,
  BookOpenText,
  CheckSquare,
  CircleHelp,
  FolderKanban,
  Mic,
  Monitor,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { type SideKindFilter, useAppStore } from "@/stores/appStore";
import { useRecorderStore } from "@/stores/recorderStore";
import { AmbientCard } from "./AmbientCard";
import { SegmentedControl, type SegmentOption, usePresence } from "./MotionPrimitives";

function dayLabel(dateStr: string): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const yest = new Date(now.getTime() - 86400000);
  const yesterday = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  if (dateStr === today) return "今天";
  if (dateStr === yesterday) return "昨天";
  const m = Number(dateStr.slice(5, 7));
  const d = Number(dateStr.slice(8, 10));
  if (m > 0 && d > 0) return `${m}月${d}日`;
  return dateStr;
}

export function Sidebar() {
  const hash = useAppStore((s) => s.hash);
  const sideCollapsed = useAppStore((s) => s.sideCollapsed);
  const setSideCollapsed = useAppStore((s) => s.setSideCollapsed);
  const narrowNavOpen = useAppStore((s) => s.narrowNavOpen);
  const setNarrowNavOpen = useAppStore((s) => s.setNarrowNavOpen);
  const meetings = useAppStore((s) => s.meetings);
  const meetingsLoaded = useAppStore((s) => s.meetingsLoaded);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const clearSearch = useAppStore((s) => s.clearSearch);
  const searchRemote = useAppStore((s) => s.searchRemote);
  const searchHits = useAppStore((s) => s.searchHits);
  const sideKind = useAppStore((s) => s.sideKind);
  const setSideKind = useAppStore((s) => s.setSideKind);
  const hideShort = useAppStore((s) => s.hideShort);
  const toggleHideShort = useAppStore((s) => s.toggleHideShort);
  const navigate = useAppStore((s) => s.navigate);

  const health = useAppStore((s) => s.health);
  const sidecarStatus = useAppStore((s) => s.sidecarStatus);
  const desktopInfo = useAppStore((s) => s.desktopInfo);
  const themeMode = useAppStore((s) => s.themeMode);
  const cycleTheme = useAppStore((s) => s.cycleTheme);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setShortcutsOpen = useAppStore((s) => s.setShortcutsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSidecarOpen = useAppStore((s) => s.setSidecarOpen);
  const trashCount = useAppStore((s) => s.trashCount);
  const setTrashOpen = useAppStore((s) => s.setTrashOpen);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const pushToast = useAppStore((s) => s.pushToast);

  const recActive = useRecorderStore((s) => s.active);
  const recMid = useRecorderStore((s) => s.mid);

  const isMacElectron = useMemo(() => {
    if (desktopInfo) return desktopInfo.platform === "darwin";
    return (
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron") &&
      /Mac/i.test(navigator.platform)
    );
  }, [desktopInfo]);

  const [isMd, setIsMd] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsMd(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const asideHidden = isMd ? sideCollapsed : !narrowNavOpen;
  const narrowBackdrop = usePresence(narrowNavOpen, 150);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = filter.trim();
    if (!trimmed) return;
    timerRef.current = setTimeout(() => {
      void searchRemote(trimmed);
    }, 260);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [filter, searchRemote]);

  const activeMid = useMemo(() => {
    const m = hash.match(/^#\/m\/([^/?]+)/);
    return m ? decodeURIComponent(m[1] ?? "") : null;
  }, [hash]);

  const { grouped, hiddenShortCount } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let shortHidden = 0;

    const filtered = meetings.filter((m) => {
      if (sideKind === "meeting" && (m.source === "ambient" || m.source === "upload")) return false;
      if (sideKind === "ambient" && m.source !== "ambient") return false;
      if (sideKind === "upload" && m.source !== "upload") return false;

      if (!q && hideShort && isShortClip(m)) {
        shortHidden += 1;
        return false;
      }

      if (!q) return true;
      const inMeta =
        (m.title || "").toLowerCase().includes(q) ||
        Object.values(m.speakers || {}).some((s) => s.toLowerCase().includes(q));
      const inRemote = Boolean(searchHits?.[m.id]);
      return inMeta || inRemote;
    });

    const groups: Array<{ date: string; items: MeetingMeta[] }> = [];
    const byDate = new Map<string, MeetingMeta[]>();
    for (const m of filtered) {
      const date = (m.created || "").slice(0, 10) || "未知日期";
      let arr = byDate.get(date);
      if (!arr) {
        arr = [];
        byDate.set(date, arr);
        groups.push({ date, items: arr });
      }
      arr.push(m);
    }

    return { grouped: groups, hiddenShortCount: shortHidden };
  }, [meetings, sideKind, hideShort, filter, searchHits]);

  const hasAmbient = useMemo(() => meetings.some((m) => m.source === "ambient"), [meetings]);
  const hasUpload = useMemo(() => meetings.some((m) => m.source === "upload"), [meetings]);
  const hasShortClips = useMemo(() => meetings.some((m) => isShortClip(m)), [meetings]);

  const kindTabs = useMemo<Array<SegmentOption<SideKindFilter>>>(() => {
    const opts: Array<SegmentOption<SideKindFilter>> = [
      { value: "all", label: "全部" },
      { value: "meeting", label: "会议" },
    ];
    if (hasAmbient || sideKind === "ambient") opts.push({ value: "ambient", label: "全天" });
    if (hasUpload || sideKind === "upload") opts.push({ value: "upload", label: "导入" });
    return opts;
  }, [hasAmbient, hasUpload, sideKind]);

  const statusMeta = (() => {
    if (sidecarStatus && sidecarStatus.phase !== "running") {
      if (sidecarStatus.phase === "bootstrapping") {
        return {
          dot: "bg-[var(--amber)] animate-pulse",
          text: "初始化环境中…",
          title: sidecarStatus.bootstrap?.message || "正在准备本机语音运行环境（点击查看日志）",
        };
      }
      if (sidecarStatus.phase === "starting") {
        return {
          dot: "bg-[var(--amber)] animate-pulse",
          text: "服务启动中…",
          title: "正在启动本机语音服务（点击查看运行日志）",
        };
      }
      if (sidecarStatus.phase === "error") {
        return {
          dot: "bg-[var(--red)]",
          text: "服务需要检查",
          title: sidecarStatus.error || "点击查看运行状态并重启",
        };
      }
      return { dot: "bg-[var(--muted)]", text: "服务未连接", title: "点击查看本机语音服务状态" };
    }
    if (!health)
      return { dot: "bg-[var(--amber)] animate-pulse", text: "连接服务中…", title: "检查本机服务与模型状态" };
    if (health.asr_error)
      return { dot: "bg-[var(--red)]", text: "语音模型需要检查", title: health.asr_error };
    if (health.asr_loading)
      return { dot: "bg-[var(--amber)] animate-pulse", text: "加载语音模型…", title: "首次加载需要几秒钟" };
    if (health.asr_ready) {
      return {
        dot: "bg-[var(--green)]",
        text: "语音识别就绪",
        title: "本机语音识别已就绪（点击查看服务状态）",
      };
    }
    return { dot: "bg-[var(--amber)]", text: "点击加载模型", title: "点击重新加载语音模型" };
  })();

  const handleStatusClick = async () => {
    if (health && !health.asr_ready && !health.asr_loading && sidecarStatus?.phase === "running") {
      try {
        await api("/api/asr/reload", { method: "POST" });
        pushToast("正在后台重新加载语音模型");
        void refreshHealth();
      } catch {
        setSidecarOpen(true);
      }
      return;
    }
    setSidecarOpen(true);
  };

  const ThemeIcon = themeMode === "auto" ? Monitor : themeMode === "light" ? Sun : Moon;
  const themeLabel =
    themeMode === "auto" ? "主题：跟随系统" : themeMode === "light" ? "主题：浅色" : "主题：深色";

  return (
    <>
      {narrowBackdrop.mounted && (
        <div
          data-state={narrowBackdrop.state}
          className="mn-backdrop fixed inset-0 z-30 bg-black/35 md:hidden"
          onClick={() => setNarrowNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="侧边导航栏"
        aria-hidden={asideHidden || undefined}
        inert={asideHidden}
        className={`mn-side shrink-0 border-r border-[var(--line-2)] bg-[var(--bg)] flex flex-col overflow-hidden transition-[width,opacity,transform] duration-[220ms] [transition-timing-function:var(--ease-out)] z-40 ${
          sideCollapsed ? "md:w-0 md:border-r-0 md:opacity-0 md:pointer-events-none" : "md:w-[264px]"
        } fixed md:static inset-y-0 left-0 w-[264px] ${
          narrowNavOpen ? "translate-x-0 shadow-[var(--shadow-pop)]" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="w-[264px] h-full flex flex-col shrink-0">
          {isMacElectron && <div className="h-[38px] shrink-0 app-drag" aria-hidden="true" />}

          <div className="px-3 pt-2.5 pb-2 space-y-2.5">
            <div className="flex items-center gap-1 app-drag">
              <button
                type="button"
                onClick={() => navigate("#/")}
                className="app-no-drag flex-1 min-w-0 flex items-center gap-2.5 p-1.5 -m-1 rounded-[8px] hover:bg-[var(--fill)] text-left cursor-pointer transition-colors"
              >
                <span className="w-[30px] h-[30px] rounded-[9px] bg-[var(--ink)] text-[var(--ink-inv)] flex items-center justify-center shrink-0">
                  <AudioLines className="w-[17px] h-[17px]" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-semibold leading-tight text-[var(--text)]">
                    会议记录
                  </span>
                  <span className="block text-[11.5px] leading-tight text-[var(--muted)] truncate">
                    本机转写 · AI 纪要
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => setSideCollapsed(true)}
                aria-label="收起左侧边栏"
                title="收起侧栏 (⌘\)"
                className="app-no-drag hidden md:inline-flex btn-ghost rounded-[7px] w-7 h-7 items-center justify-center opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => navigate("#/")}
              className="btn-primary w-full h-9 rounded-[8px] px-3 text-[13.5px] flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>新建会议</span>
            </button>

            <AmbientCard />

            {recActive && recMid && (
              <button
                type="button"
                onClick={() => navigate(`#/m/${recMid}`)}
                className="w-full rounded-[8px] bg-[var(--red-weak)] text-[var(--red)] px-3 py-2 text-xs font-medium flex items-center gap-2 cursor-pointer"
              >
                <span className="w-2 h-2 rounded-full bg-[var(--red)] rec-dot shrink-0" aria-hidden="true" />
                <span className="truncate">正在录音，点击回到界面</span>
              </button>
            )}

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => navigate("#/todos")}
                className={`rounded-[8px] px-2.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-150 ${
                  hash.startsWith("#/todos")
                    ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-[var(--shadow-1)]"
                    : "text-[var(--text-2)] hover:bg-[var(--fill)]"
                }`}
              >
                <CheckSquare className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>待办中心</span>
              </button>

              <button
                type="button"
                onClick={() => navigate("#/people")}
                className={`rounded-[8px] px-2.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-150 ${
                  hash.startsWith("#/people")
                    ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-[var(--shadow-1)]"
                    : "text-[var(--text-2)] hover:bg-[var(--fill)]"
                }`}
              >
                <Users className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>人物</span>
              </button>

              <button
                type="button"
                onClick={() => navigate("#/projects")}
                className={`rounded-[8px] px-2.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-150 ${
                  hash.startsWith("#/projects")
                    ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-[var(--shadow-1)]"
                    : "text-[var(--text-2)] hover:bg-[var(--fill)]"
                }`}
              >
                <FolderKanban className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>项目脉络</span>
              </button>

              <button
                type="button"
                onClick={() => navigate("#/weekly")}
                className={`rounded-[8px] px-2.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer transition-colors duration-150 ${
                  hash.startsWith("#/weekly")
                    ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-[var(--shadow-1)]"
                    : "text-[var(--text-2)] hover:bg-[var(--fill)]"
                }`}
              >
                <BookOpenText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>周报</span>
              </button>
            </div>

            <div className="flex items-center gap-1 rounded-[8px] bg-[var(--fill)] hover:bg-[var(--fill-2)] focus-within:bg-[var(--surface)] focus-within:shadow-[0_0_0_1px_var(--line)] pl-2.5 pr-1 h-[34px] transition-colors">
              <Search className="w-3.5 h-3.5 text-[var(--muted)] shrink-0" aria-hidden="true" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜索标题和内容"
                aria-label="搜索会议列表"
                className="flex-1 min-w-0 h-full px-1 py-0 text-[13px] bg-transparent border-0 shadow-none hover:bg-transparent focus:bg-transparent focus:border-0 focus:shadow-none"
              />
              {filter ? (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="清空搜索"
                  className="w-6 h-6 shrink-0 rounded-full hover:bg-[var(--fill-2)] text-[var(--muted)] flex items-center justify-center cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  title="命令面板 (⌘K)"
                  className="h-6 min-w-[28px] px-1.5 shrink-0 rounded-[5px] bg-[var(--surface)] shadow-[var(--shadow-1)] text-[11px] font-mono text-[var(--muted)] hover:text-[var(--text)] flex items-center justify-center cursor-pointer"
                >
                  <span className="sr-only">打开命令面板 </span>⌘K
                </button>
              )}
            </div>

            <div className="flex items-center gap-1">
              <SegmentedControl
                value={sideKind}
                onChange={setSideKind}
                options={kindTabs}
                ariaLabel="筛选记录来源"
                size="xs"
                fullWidth
                className="flex-1 min-w-0"
              />
              {(hasShortClips || hideShort) && (
                <button
                  type="button"
                  onClick={toggleHideShort}
                  aria-pressed={hideShort}
                  title={hideShort ? "已隐藏不到 1 分钟的短片段" : "隐藏不到 1 分钟的短片段"}
                  className={`h-[30px] shrink-0 rounded-[7px] px-2 text-[11.5px] cursor-pointer transition-colors duration-150 ${
                    hideShort
                      ? "bg-[var(--surface)] text-[var(--text)] font-medium shadow-[var(--shadow-1)]"
                      : "text-[var(--muted)] hover:bg-[var(--fill)] hover:text-[var(--text)]"
                  }`}
                >
                  滤短
                </button>
              )}
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-2.5" aria-label="会议记录列表">
            {!meetingsLoaded ? (
              <div className="px-2 py-8 text-center text-xs text-[var(--muted)]">正在加载记录…</div>
            ) : !grouped.length ? (
              <div className="px-2 py-8 text-center text-xs text-[var(--muted)]">
                {filter.trim() ? "没有匹配的会议记录" : "还没有会议记录"}
              </div>
            ) : (
              grouped.map((g) => (
                <div key={g.date} className="space-y-0.5">
                  {g.date !== "未知日期" && (
                    <div className="group flex items-center justify-between px-2.5 pt-2 pb-1 text-xs text-[var(--muted)]">
                      <span>{dayLabel(g.date)}</span>
                      <button
                        type="button"
                        onClick={() => navigate(`#/day/${g.date}`)}
                        className="text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] opacity-80 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
                      >
                        当日汇总 →
                      </button>
                    </div>
                  )}

                  {g.items.map((m) => {
                    const isActive = activeMid === m.id;
                    const isRecHere = recActive && recMid === m.id;
                    const dur = effDuration(m);
                    const hit = searchHits?.[m.id];
                    const statusLabel = isRecHere ? "录音中" : STATUS_LABELS[m.status];

                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => navigate(`#/m/${m.id}`)}
                        className={`w-full text-left rounded-[8px] px-2.5 py-1.5 transition-colors duration-150 cursor-pointer ${
                          isActive
                            ? "bg-[var(--surface)] shadow-[var(--shadow-1)] text-[var(--text)]"
                            : "hover:bg-[var(--fill)] text-[var(--text-body)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5 min-w-0">
                          <span
                            className={`text-[13.5px] truncate flex-1 ${
                              dur >= 60 ? "font-medium" : "text-[var(--text-2)]"
                            }`}
                          >
                            {m.title || "未命名会议"}
                          </span>
                          {m.source === "upload" ? (
                            <Upload className="w-3 h-3 text-[var(--muted)] shrink-0" aria-hidden="true" />
                          ) : m.source === "mic" ? (
                            <Mic className="w-3 h-3 text-[var(--muted)] shrink-0" aria-hidden="true" />
                          ) : null}
                        </div>

                        <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--muted)] num">
                          <span>{hm(m.created)}</span>
                          {dur > 0 && <span>· {fmtDur(dur)}</span>}
                          {statusLabel && (
                            <span
                              className={`px-1.5 py-0 rounded text-[10.5px] font-medium ${
                                m.status === "error" || m.status === "recording" || isRecHere
                                  ? "bg-[var(--red-weak)] text-[var(--red)]"
                                  : "bg-[var(--amber-weak)] text-[var(--amber)]"
                              }`}
                            >
                              {statusLabel}
                            </span>
                          )}
                        </div>

                        {(hit?.snippet || m.brief) && (
                          <div className="mt-0.5 text-[11.5px] text-[var(--text-2)] truncate">
                            {hit?.snippet || m.brief}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}

            {hiddenShortCount > 0 && (
              <button
                type="button"
                onClick={toggleHideShort}
                className="w-full py-2 text-center text-[11.5px] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
              >
                已隐藏 {hiddenShortCount} 条短片段（点击显示）
              </button>
            )}
          </nav>

          {trashCount > 0 && (
            <div className="px-3 pb-1.5">
              <button
                type="button"
                onClick={() => setTrashOpen(true)}
                className="w-full min-h-[30px] rounded-[8px] px-2.5 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--fill)] flex items-center justify-between gap-2 cursor-pointer transition-colors"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>废纸篓</span>
                </span>
                <span className="num text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-2)]">
                  {trashCount}
                </span>
              </button>
            </div>
          )}

          <footer className="px-3 py-2.5 border-t border-[var(--line-2)] flex items-center justify-between gap-1.5">
            <button
              type="button"
              id="asrBadge"
              onClick={() => void handleStatusClick()}
              title={statusMeta.title}
              className="flex-1 min-w-0 flex items-center gap-2 text-left text-xs text-[var(--muted)] hover:text-[var(--text)] cursor-pointer py-1"
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusMeta.dot}`} aria-hidden="true" />
              <span className="truncate">{statusMeta.text}</span>
            </button>

            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                id="themeBtn"
                onClick={cycleTheme}
                aria-label={themeLabel}
                title={themeLabel}
                className="btn-ghost rounded-[7px] w-7 h-7 flex items-center justify-center cursor-pointer"
              >
                <ThemeIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                id="kbdBtn"
                onClick={() => setShortcutsOpen(true)}
                aria-label="键盘快捷键"
                title="快捷键说明 (?)"
                className="btn-ghost rounded-[7px] w-7 h-7 flex items-center justify-center cursor-pointer"
              >
                <CircleHelp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                id="cfgBtn"
                onClick={() => setSettingsOpen(true)}
                aria-label="设置"
                title="设置 (⌘,)"
                className="btn-ghost rounded-[7px] w-7 h-7 flex items-center justify-center cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>
          </footer>
        </div>
      </aside>
    </>
  );
}
