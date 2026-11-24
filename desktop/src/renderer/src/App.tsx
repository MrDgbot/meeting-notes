import { AlertTriangle, Loader2, Menu, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AmbientIntroModal } from "@/components/AmbientIntroModal";
import { CommandPalette } from "@/components/CommandPalette";
import { DragUploadOverlay } from "@/components/DragUploadOverlay";
import { ModalShell } from "@/components/MotionPrimitives";
import { SettingsModal } from "@/components/SettingsModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { Sidebar } from "@/components/Sidebar";
import { SidecarPanel } from "@/components/SidecarPanel";
import { ToastStack } from "@/components/ToastStack";
import { TrashModal } from "@/components/TrashModal";
import { VoiceprintWizardModal } from "@/components/VoiceprintWizardModal";
import { DayPage } from "@/pages/DayPage";
import { HomePage } from "@/pages/HomePage";
import { MeetingPage } from "@/pages/MeetingPage";
import { PeoplePage } from "@/pages/PeoplePage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { QuickAskPage } from "@/pages/QuickAskPage";
import { TodosPage } from "@/pages/TodosPage";
import { WeeklyPage } from "@/pages/WeeklyPage";
import { useAppStore } from "@/stores/appStore";
import { useMeetingStore } from "@/stores/meetingStore";
import { useRecorderStore } from "@/stores/recorderStore";

type ParsedRoute =
  | { page: "home" }
  | { page: "meeting"; mid: string; tSec?: number }
  | { page: "day"; date: string }
  | { page: "todos" }
  | { page: "people"; name?: string }
  | { page: "projects" }
  | { page: "weekly" }
  | { page: "quick-ask" };

function parseHashRoute(hash: string): ParsedRoute {
  const raw = (hash || "#/").replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart || "/";

  if (path.startsWith("/m/")) {
    const mid = decodeURIComponent(path.slice(3).replace(/\/+$/, ""));
    let tSec: number | undefined;
    if (queryPart) {
      const tParam = new URLSearchParams(queryPart).get("t");
      if (tParam !== null && tParam !== "") {
        const parsed = Number(tParam);
        if (Number.isFinite(parsed) && parsed >= 0) tSec = parsed;
      }
    }
    if (mid) return { page: "meeting", mid, tSec };
  }

  const dayM = path.match(/^\/day\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (dayM?.[1]) {
    return { page: "day", date: dayM[1] };
  }

  if (path === "/todos" || path.startsWith("/todos/")) {
    return { page: "todos" };
  }

  if (path === "/people" || path === "/people/") {
    return { page: "people" };
  }

  if (path.startsWith("/people/")) {
    const name = decodeURIComponent(path.slice(8).replace(/\/+$/, ""));
    return { page: "people", name: name || undefined };
  }

  if (path === "/projects" || path.startsWith("/projects/")) {
    return { page: "projects" };
  }

  if (path === "/weekly" || path.startsWith("/weekly/")) {
    return { page: "weekly" };
  }

  if (path === "/quick-ask" || path.startsWith("/quick-ask/")) {
    return { page: "quick-ask" };
  }

  return { page: "home" };
}

export function App() {
  const hash = useAppStore((s) => s.hash);
  const desktopInfo = useAppStore((s) => s.desktopInfo);
  const sideCollapsed = useAppStore((s) => s.sideCollapsed);
  const setSideCollapsed = useAppStore((s) => s.setSideCollapsed);
  const narrowNavOpen = useAppStore((s) => s.narrowNavOpen);
  const setNarrowNavOpen = useAppStore((s) => s.setNarrowNavOpen);
  const initDesktopBridge = useAppStore((s) => s.initDesktopBridge);
  const initAmbientStream = useAppStore((s) => s.initAmbientStream);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const initMeetingBridge = useMeetingStore((s) => s.initMeetingBridge);
  const clearMeeting = useMeetingStore((s) => s.clearMeeting);

  const isMacElectron = useMemo(() => {
    if (desktopInfo) return desktopInfo.platform === "darwin";
    return (
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron") &&
      /Mac/i.test(navigator.platform)
    );
  }, [desktopInfo]);

  useEffect(() => {
    const unsubDesktop = initDesktopBridge();
    const unsubAmbient = initAmbientStream();
    const unsubMeeting = initMeetingBridge();
    void loadMeetings();
    void refreshHealth();

    const healthTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshHealth();
      }
    }, 8000);

    return () => {
      clearInterval(healthTimer);
      unsubDesktop();
      unsubAmbient();
      unsubMeeting();
    };
  }, [initDesktopBridge, initAmbientStream, initMeetingBridge, loadMeetings, refreshHealth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const app = useAppStore.getState();
      const target = e.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable]"));

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        app.setPaletteOpen(!app.paletteOpen);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        app.setSettingsOpen(!app.settingsOpen);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        app.setSideCollapsed(!app.sideCollapsed);
        return;
      }

      if (
        !typing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key === "?" &&
        !app.paletteOpen &&
        !app.settingsOpen &&
        !app.sidecarOpen &&
        !app.ambientIntroOpen &&
        !app.vpWizardOpen &&
        !app.trashOpen
      ) {
        e.preventDefault();
        app.setShortcutsOpen(!app.shortcutsOpen);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [quitPhase, setQuitPhase] = useState<"idle" | "flushing" | "prompt" | "saving">("idle");
  const quitPhaseRef = useRef(quitPhase);
  quitPhaseRef.current = quitPhase;

  const flushAllPendingNotes = useCallback(async () => {
    const ms = useMeetingStore.getState();
    const ids = Object.keys(ms.pendingNotes || {});
    await ms.flushNotes();
    for (const mid of ids) {
      if (useMeetingStore.getState().pendingNotes[mid]?.dirty) {
        await useMeetingStore.getState().flushNotes(mid);
      }
    }
  }, []);

  useEffect(() => {
    const desk = window.desktopAPI;
    if (!desk?.onQuitRequested) return;
    return desk.onQuitRequested(() => {
      if (quitPhaseRef.current !== "idle") return;
      if (useRecorderStore.getState().active) {
        setQuitPhase("prompt");
        return;
      }
      setQuitPhase("flushing");
      void Promise.race([flushAllPendingNotes(), new Promise<void>((resolve) => setTimeout(resolve, 1200))])
        .catch(() => undefined)
        .finally(() => {
          window.desktopAPI?.confirmQuit();
        });
    });
  }, [flushAllPendingNotes]);

  const handleConfirmQuit = useCallback(async () => {
    if (quitPhaseRef.current === "saving") return;
    setQuitPhase("saving");
    try {
      await flushAllPendingNotes();
      if (useRecorderStore.getState().active) {
        await useRecorderStore.getState().stop();
      }
      await flushAllPendingNotes();
    } catch {
      // 确保确认退出时不卡死在弹窗
    }
    window.desktopAPI?.confirmQuit();
  }, [flushAllPendingNotes]);

  const route = useMemo(() => parseHashRoute(hash), [hash]);

  useEffect(() => {
    if (route.page !== "meeting") {
      clearMeeting();
    }
  }, [route.page, clearMeeting]);

  if (route.page === "quick-ask") {
    return (
      <>
        <QuickAskPage />
        <ToastStack />
      </>
    );
  }

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-[var(--bg)] text-[var(--text)] relative">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[var(--bg)]">
        <div
          className={`h-[38px] shrink-0 items-center gap-2 pr-3 app-drag bg-[var(--bg)] ${
            isMacElectron || sideCollapsed ? "flex" : "flex md:hidden"
          } ${isMacElectron ? (sideCollapsed ? "pl-[82px]" : "pl-[82px] md:pl-3") : "pl-3"}`}
        >
          {sideCollapsed && (
            <button
              type="button"
              onClick={() => setSideCollapsed(false)}
              aria-label="展开左侧边栏"
              title="展开侧栏 (⌘\)"
              className="app-no-drag hidden md:inline-flex btn-ghost w-7 h-7 rounded-[7px] items-center justify-center text-[var(--text-2)] hover:text-[var(--text)] cursor-pointer"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}

          {!narrowNavOpen && (
            <button
              type="button"
              onClick={() => setNarrowNavOpen(true)}
              aria-label="打开导航栏"
              className="app-no-drag md:hidden btn-ghost w-7 h-7 rounded-[7px] inline-flex items-center justify-center text-[var(--text-2)] hover:text-[var(--text)] cursor-pointer"
            >
              <Menu className="w-4 h-4" />
            </button>
          )}
        </div>
        <main id="main" className="flex-1 overflow-y-auto min-w-0 bg-[var(--bg)]" tabIndex={-1}>
          <div key={route.page} className="mn-page-enter min-h-full">
            {route.page === "home" && <HomePage />}
            {route.page === "meeting" && <MeetingPage mid={route.mid} initialSeekSec={route.tSec} />}
            {route.page === "day" && <DayPage date={route.date} />}
            {route.page === "todos" && <TodosPage />}
            {route.page === "people" && <PeoplePage personName={route.name} />}
            {route.page === "projects" && <ProjectsPage />}
            {route.page === "weekly" && <WeeklyPage />}
          </div>
        </main>
      </div>

      <SettingsModal />
      <CommandPalette />
      <ShortcutsModal />
      <SidecarPanel />
      <AmbientIntroModal />
      <VoiceprintWizardModal />
      <TrashModal />
      <DragUploadOverlay />
      <ModalShell
        open={quitPhase === "prompt" || quitPhase === "saving"}
        onClose={() => {
          if (quitPhase === "prompt") setQuitPhase("idle");
        }}
        label="退出确认"
        maxWidthClass="max-w-md"
      >
        <div className="p-5 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--amber-weak)] text-[var(--amber)]">
              {quitPhase === "saving" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <AlertTriangle className="w-4 h-4" />
              )}
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[var(--text)]">
                {quitPhase === "saving" ? "正在保存录音与笔记…" : "当前会议仍在录音中"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                {quitPhase === "saving"
                  ? "正在收尾转写片段并写入本地记录，完成后会自动退出。"
                  : "直接退出可能丢失最近数秒的语音缓存。选择「停止并退出」会先完整保存当前录音和笔记。"}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={quitPhase === "saving"}
              onClick={() => setQuitPhase("idle")}
              className="btn-secondary rounded-[8px] px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              继续录音
            </button>
            <button
              type="button"
              disabled={quitPhase === "saving"}
              onClick={() => void handleConfirmQuit()}
              className="rounded-[8px] px-3 py-1.5 text-xs font-medium bg-[#b91c1c] text-white hover:opacity-90 cursor-pointer disabled:opacity-60"
            >
              {quitPhase === "saving" ? "保存中…" : "停止并退出"}
            </button>
          </div>
        </div>
      </ModalShell>
      <ToastStack />
    </div>
  );
}
