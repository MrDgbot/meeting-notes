import type {
  AmbientStatus,
  AsrConfig,
  DesktopRuntimeInfo,
  DetectedMeetingApp,
  HealthStatus,
  MeetingMeta,
  ResolvedTheme,
  SettingsData,
  SidecarLogEntry,
  SidecarStatus,
  ThemeMode,
  UpdateStatus,
} from "@shared/types";
import { create } from "zustand";
import { api, wsUrl } from "@/lib/api";

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastOptions {
  durationMs?: number;
  tone?: "default" | "success" | "error";
  action?: ToastAction;
}

export interface ToastItem {
  id: number;
  msg: string;
  tone: "default" | "success" | "error";
  action?: ToastAction;
  closing?: boolean;
  durationMs: number;
}

export interface SearchState {
  filter: string;
  searchQ: string;
  searchHits: Record<string, { id: string; hits: number; snippet: string }> | null;
}

export type SideKindFilter = "all" | "meeting" | "ambient" | "upload";

export type SettingsTab = "llm" | "asr" | "vocab" | "ambient" | "rsi" | "lan" | "mcp" | "about";

export function normalizeSettingsTab(
  tab: SettingsTab,
): "llm" | "asr" | "vocab" | "ambient" | "lan" | "about" {
  if (tab === "rsi") return "vocab";
  if (tab === "mcp") return "lan";
  return tab;
}

interface AppStoreState {
  hash: string;
  routeSeq: number;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  sideCollapsed: boolean;
  narrowNavOpen: boolean;

  paletteOpen: boolean;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  sidecarOpen: boolean;
  ambientIntroOpen: boolean;
  vpWizardOpen: boolean;
  trashOpen: boolean;
  trashCount: number;
  detectedMeetingApp: DetectedMeetingApp | null;

  toasts: ToastItem[];
  meetings: MeetingMeta[];
  meetingsLoaded: boolean;
  health: HealthStatus | null;
  settings: SettingsData | null;
  asr: AsrConfig | null;
  ambient: AmbientStatus | null;
  ambientLive: boolean;
  discardSeenAt: number | null;
  filter: string;
  sideKind: SideKindFilter;
  hideShort: boolean;
  searchQ: string;
  searchHits: Record<string, { id: string; hits: number; snippet: string }> | null;
  followPlay: boolean;
  splitView: boolean;
  provId: string | null;

  sidecarStatus: SidecarStatus | null;
  sidecarLogs: SidecarLogEntry[];
  desktopInfo: DesktopRuntimeInfo | null;
  updateStatus: UpdateStatus | null;

  pushToast: (msg: string, msOrOpts?: number | ToastOptions) => number;
  dismissToast: (id: number) => void;
  pauseToast: (id: number) => void;
  resumeToast: (id: number) => void;
  setThemeMode: (mode: ThemeMode, opts?: { skipDesktopSync?: boolean }) => void;
  cycleTheme: () => void;
  setSideCollapsed: (on: boolean) => void;
  setNarrowNavOpen: (on: boolean) => void;
  setPaletteOpen: (on: boolean) => void;
  setShortcutsOpen: (on: boolean) => void;
  setSettingsOpen: (on: boolean) => void;
  openSettingsTab: (tab: SettingsTab) => void;
  setSidecarOpen: (on: boolean) => void;
  setAmbientIntroOpen: (on: boolean) => void;
  setVpWizardOpen: (on: boolean) => void;
  setTrashOpen: (on: boolean) => void;
  loadTrashCount: () => Promise<number>;
  setDetectedMeetingApp: (app: DetectedMeetingApp | null) => void;
  dismissDetectedMeetingApp: () => void;
  setSideKind: (kind: SideKindFilter) => void;
  toggleHideShort: () => void;
  setFilter: (q: string) => void;
  clearSearch: () => void;
  setFollowPlay: (on: boolean) => void;
  setSplitView: (on: boolean) => void;
  setProvId: (id: string | null) => void;

  navigate: (nextHash: string) => void;
  loadMeetings: () => Promise<boolean>;
  refreshHealth: () => Promise<HealthStatus | null>;
  ensureSettings: () => Promise<SettingsData>;
  refreshSettings: () => Promise<SettingsData>;
  runAmbientAction: (body: Record<string, unknown>) => Promise<void>;
  restoreDiscarded: (mid: string) => Promise<void>;
  initDesktopBridge: () => () => void;
  initAmbientStream: () => () => void;
  searchRemote: (q: string) => Promise<void>;
}

const THEME_KEY = "theme";
const SIDE_COLLAPSED_KEY = "sideCollapsed";
const HIDE_SHORT_KEY = "hideShort";
const SPLIT_VIEW_KEY = "splitView";

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function computeResolvedTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "auto") {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function applyDocumentTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = computeResolvedTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#1F1F1F" : "#FCFCFC");
  return resolved;
}

let toastSeq = 0;
let settingsPromise: Promise<SettingsData> | null = null;
const toastTimers = new Map<
  number,
  { timer: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }
>();

function prefersReducedMotionNow(): boolean {
  return (
    typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

const initialThemeRaw = readLS(THEME_KEY, "auto");
const initialThemeMode: ThemeMode =
  initialThemeRaw === "light" || initialThemeRaw === "dark" ? initialThemeRaw : "auto";

export const useAppStore = create<AppStoreState>((set, get) => ({
  hash: location.hash || "#/",
  routeSeq: 1,
  themeMode: initialThemeMode,
  resolvedTheme: applyDocumentTheme(initialThemeMode),
  sideCollapsed: readLS(SIDE_COLLAPSED_KEY, "0") === "1",
  narrowNavOpen: false,

  paletteOpen: false,
  shortcutsOpen: false,
  settingsOpen: false,
  settingsTab: "llm",
  sidecarOpen: false,
  ambientIntroOpen: false,
  vpWizardOpen: false,
  trashOpen: false,
  trashCount: 0,
  detectedMeetingApp: null,

  toasts: [],
  meetings: [],
  meetingsLoaded: false,
  health: null,
  settings: null,
  asr: null,
  ambient: null,
  ambientLive: false,
  discardSeenAt: null,
  filter: "",
  sideKind: "all",
  hideShort: readLS(HIDE_SHORT_KEY, "0") === "1",
  searchQ: "",
  searchHits: null,
  followPlay: true,
  splitView: readLS(SPLIT_VIEW_KEY, "1") !== "0",
  provId: null,

  sidecarStatus: null,
  sidecarLogs: [],
  desktopInfo: null,
  updateStatus: null,

  pushToast: (msg, msOrOpts = 2800) => {
    const id = ++toastSeq;
    const opts: ToastOptions = typeof msOrOpts === "number" ? { durationMs: msOrOpts } : msOrOpts;
    const durationMs = opts.durationMs ?? (opts.action ? 5600 : 2800);
    const tone = opts.tone ?? "default";
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id, msg, tone, action: opts.action, durationMs }],
    }));
    if (durationMs > 0) {
      const timer = setTimeout(() => get().dismissToast(id), durationMs);
      toastTimers.set(id, { timer, remaining: durationMs, startedAt: Date.now() });
    }
    return id;
  },

  dismissToast: (id) => {
    const entry = toastTimers.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    toastTimers.delete(id);

    const existing = get().toasts.find((t) => t.id === id);
    if (!existing) return;

    if (prefersReducedMotionNow()) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      return;
    }

    if (!existing.closing) {
      set((s) => ({
        toasts: s.toasts.map((t) => (t.id === id ? { ...t, closing: true } : t)),
      }));
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 170);
    }
  },

  pauseToast: (id) => {
    const entry = toastTimers.get(id);
    if (!entry?.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(400, entry.remaining - (Date.now() - entry.startedAt));
  },

  resumeToast: (id) => {
    const entry = toastTimers.get(id);
    if (!entry || entry.timer) return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => get().dismissToast(id), entry.remaining);
  },

  setThemeMode: (mode, opts) => {
    writeLS(THEME_KEY, mode);
    const resolved = applyDocumentTheme(mode);
    set({ themeMode: mode, resolvedTheme: resolved });
    if (!opts?.skipDesktopSync) {
      window.desktopAPI?.setThemeMode?.(mode);
    }
  },

  cycleTheme: () => {
    const order: ThemeMode[] = ["auto", "light", "dark"];
    const next = order[(order.indexOf(get().themeMode) + 1) % order.length] ?? "auto";
    const labels: Record<ThemeMode, string> = {
      auto: "已切换为跟随系统",
      light: "已切换为浅色主题",
      dark: "已切换为深色主题",
    };
    get().setThemeMode(next);
    get().pushToast(labels[next], 2000);
  },

  setSideCollapsed: (on) => {
    writeLS(SIDE_COLLAPSED_KEY, on ? "1" : "0");
    set({ sideCollapsed: on });
    setTimeout(() => window.dispatchEvent(new Event("resize")), 20);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 220);
  },

  setNarrowNavOpen: (on) => set({ narrowNavOpen: on }),
  setPaletteOpen: (on) => set({ paletteOpen: on }),
  setShortcutsOpen: (on) => set({ shortcutsOpen: on }),
  setSettingsOpen: (on) => set({ settingsOpen: on }),
  openSettingsTab: (tab) => set({ settingsOpen: true, settingsTab: normalizeSettingsTab(tab) }),
  setSidecarOpen: (on) => set({ sidecarOpen: on }),
  setAmbientIntroOpen: (on) => set({ ambientIntroOpen: on }),
  setVpWizardOpen: (on) => set({ vpWizardOpen: on }),
  setTrashOpen: (on) => set({ trashOpen: on }),
  loadTrashCount: async () => {
    try {
      const res = await api<{ items?: Array<{ id: string }> }>("/api/trash");
      const n = Array.isArray(res?.items) ? res.items.length : 0;
      set({ trashCount: n });
      return n;
    } catch {
      return get().trashCount;
    }
  },
  setDetectedMeetingApp: (app) => set({ detectedMeetingApp: app }),
  dismissDetectedMeetingApp: () => {
    const cur = get().detectedMeetingApp;
    if (cur) {
      window.desktopAPI?.dismissMeetingApp(cur.id);
    }
    set({ detectedMeetingApp: null });
  },
  setSideKind: (sideKind) => set({ sideKind }),

  toggleHideShort: () => {
    const next = !get().hideShort;
    writeLS(HIDE_SHORT_KEY, next ? "1" : "0");
    set({ hideShort: next });
  },

  setFilter: (q) => {
    set({ filter: q });
    if (!q.trim()) {
      set({ searchQ: "", searchHits: null });
    }
  },

  clearSearch: () => set({ filter: "", searchQ: "", searchHits: null }),
  setFollowPlay: (followPlay) => set({ followPlay }),
  setSplitView: (splitView) => {
    writeLS(SPLIT_VIEW_KEY, splitView ? "1" : "0");
    set({ splitView });
  },
  setProvId: (provId) => set({ provId }),

  navigate: (nextHash) => {
    const normalized = nextHash.startsWith("#") ? nextHash : `#${nextHash}`;
    if (location.hash !== normalized) {
      location.hash = normalized;
    } else {
      set((s) => ({ hash: normalized, routeSeq: s.routeSeq + 1, narrowNavOpen: false }));
    }
  },

  loadMeetings: async () => {
    try {
      const list = await api<MeetingMeta[]>("/api/meetings");
      set({ meetings: Array.isArray(list) ? list : [], meetingsLoaded: true });
      void get().loadTrashCount();
      return true;
    } catch {
      return false;
    }
  },

  refreshHealth: async () => {
    try {
      const h = await api<HealthStatus>("/api/health", { timeout: 5000 });
      set({ health: h });
      if (!get().meetingsLoaded) {
        void get().loadMeetings();
      }
      return h;
    } catch {
      return null;
    }
  },

  ensureSettings: async () => {
    const existing = get().settings;
    if (existing) return existing;
    return get().refreshSettings();
  },

  refreshSettings: async () => {
    if (!settingsPromise) {
      settingsPromise = api<SettingsData>("/api/settings")
        .then((s) => {
          set({ settings: s });
          return s;
        })
        .finally(() => {
          settingsPromise = null;
        });
    }
    return settingsPromise;
  },

  runAmbientAction: async (body) => {
    try {
      const next = await api<AmbientStatus>("/api/ambient", { method: "POST", body });
      set({ ambient: next });
      if (body.action === "split") {
        setTimeout(() => void get().loadMeetings(), 800);
      }
    } catch (err) {
      get().pushToast(err instanceof Error ? err.message : "全天模式操作失败", 4000);
    }
  },

  restoreDiscarded: async (mid) => {
    await api(`/api/discarded/${encodeURIComponent(mid)}/restore`, { method: "POST", body: {} });
    get().pushToast("已恢复，正在精准转写");
    await get().loadMeetings();
    get().navigate(`#/m/${mid}`);
  },

  searchRemote: async (rawQ) => {
    const q = rawQ.trim();
    if (!q) {
      set({ searchQ: "", searchHits: null });
      return;
    }
    try {
      const rows = await api<{ id: string; hits: number; snippet: string }[]>(
        `/api/search?q=${encodeURIComponent(q)}`,
      );
      if (get().filter.trim().toLowerCase() !== q.toLowerCase()) return;
      const hitMap = Object.fromEntries((Array.isArray(rows) ? rows : []).map((x) => [x.id, x]));
      set({ searchQ: q.toLowerCase(), searchHits: hitMap });
    } catch {}
  },

  initDesktopBridge: () => {
    const desk = window.desktopAPI;
    const unsubs: Array<() => void> = [];

    const onHash = () => {
      set((s) => ({
        hash: location.hash || "#/",
        routeSeq: s.routeSeq + 1,
        narrowNavOpen: false,
        paletteOpen: false,
      }));
    };
    window.addEventListener("hashchange", onHash);
    unsubs.push(() => window.removeEventListener("hashchange", onHash));

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (mq) {
      const onThemeMedia = () => {
        if (get().themeMode === "auto") {
          set({ resolvedTheme: applyDocumentTheme("auto") });
        }
      };
      mq.addEventListener("change", onThemeMedia);
      unsubs.push(() => mq.removeEventListener("change", onThemeMedia));
    }

    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== THEME_KEY) return;
      const raw = ev.newValue;
      const mode: ThemeMode = raw === "light" || raw === "dark" ? raw : "auto";
      if (mode !== get().themeMode) {
        get().setThemeMode(mode, { skipDesktopSync: true });
      }
    };
    window.addEventListener("storage", onStorage);
    unsubs.push(() => window.removeEventListener("storage", onStorage));

    if (desk) {
      unsubs.push(
        desk.onThemeChanged((mode) => {
          if (mode !== get().themeMode) {
            get().setThemeMode(mode, { skipDesktopSync: true });
          }
        }),
      );
      void desk
        .getInfo()
        .then((desktopInfo) => set({ desktopInfo }))
        .catch(() => {});
      void desk
        .getSidecarStatus()
        .then((sidecarStatus) => set({ sidecarStatus }))
        .catch(() => {});
      void desk
        .getSidecarLogs()
        .then((sidecarLogs) => set({ sidecarLogs }))
        .catch(() => {});
      void desk
        .getUpdateStatus()
        .then((updateStatus) => set({ updateStatus }))
        .catch(() => {});

      unsubs.push(
        desk.onUpdateStatus((updateStatus) => {
          set({ updateStatus });
        }),
      );

      unsubs.push(
        desk.onSidecarStatus((sidecarStatus) => {
          set({ sidecarStatus });
          if (sidecarStatus.phase === "running") {
            void get().refreshHealth();
            void get().loadMeetings();
          }
        }),
      );
      unsubs.push(
        desk.onSidecarLog((entry) => {
          set((s) => ({ sidecarLogs: [...s.sidecarLogs.slice(-499), entry] }));
        }),
      );
      unsubs.push(desk.onOpenDiagnostics(() => set({ sidecarOpen: true })));
      unsubs.push(desk.onNavigate((hash) => get().navigate(hash)));
      unsubs.push(desk.onMeetingAppDetected((detectedMeetingApp) => set({ detectedMeetingApp })));
    }

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const delays = [600, 1200, 2000, 2500, 3000];
    let attempt = 0;

    const tickInitialLoad = async () => {
      if (disposed || get().meetingsLoaded) return;
      const ok = await get().loadMeetings();
      void get().refreshHealth();
      if (ok || disposed) return;
      const waitMs = delays[Math.min(attempt, delays.length - 1)] ?? 3000;
      attempt += 1;
      retryTimer = setTimeout(() => void tickInitialLoad(), waitMs);
    };

    void tickInitialLoad();
    unsubs.push(() => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
    });

    return () => {
      for (const fn of unsubs) fn();
    };
  },

  initAmbientStream: () => {
    let ws: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSig = "";
    let disposed = false;

    const handleAmbient = (a: AmbientStatus) => {
      const sig = `${a.conv?.id ?? ""}|${a.today.count}`;
      const prevSig = lastSig;
      lastSig = sig;
      set({ ambient: a });
      if (prevSig && sig !== prevSig) {
        void get().loadMeetings();
      }
    };

    const connectWs = () => {
      if (disposed || ws || document.visibilityState !== "visible") return;
      try {
        const sock = new WebSocket(wsUrl("/ws/ambient"));
        ws = sock;
        sock.onmessage = (ev) => {
          if (ws !== sock) return;
          set({ ambientLive: true });
          try {
            handleAmbient(JSON.parse(String(ev.data)) as AmbientStatus);
          } catch {}
        };
        sock.onclose = () => {
          if (ws !== sock) return;
          ws = null;
          set({ ambientLive: false });
          if (!disposed) {
            reconnectTimer = setTimeout(connectWs, 3000);
          }
        };
      } catch {
        ws = null;
      }
    };

    const poll = async () => {
      if (disposed) return;
      if (!get().ambientLive && !document.hidden) {
        try {
          const a = await api<AmbientStatus>("/api/ambient");
          if (!get().ambientLive) handleAmbient(a);
        } catch {}
      }
      const cur = get().ambient;
      const delay = document.hidden ? 15000 : get().ambientLive ? 5000 : cur?.enabled ? 2000 : 8000;
      if (!disposed) {
        pollTimer = setTimeout(() => void poll(), delay);
      }
    };

    const onVis = () => {
      if (document.visibilityState === "visible") {
        connectWs();
        void get().refreshHealth();
        void get().loadMeetings();
      } else if (ws) {
        const cur = ws;
        ws = null;
        set({ ambientLive: false });
        cur.close();
      }
    };

    document.addEventListener("visibilitychange", onVis);
    connectWs();
    void poll();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      if (pollTimer) clearTimeout(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  },
}));
