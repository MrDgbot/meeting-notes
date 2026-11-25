import { effDuration, fmtDur, hm, tsToSec, ymd } from "@shared/format";
import type {
  CommitmentItem,
  CommitmentsResponse,
  DayData,
  DiscardedItem,
  MeetingMeta,
  PersonSummary,
  ProjectStream,
  RsiState,
  TodoItem,
  TodosResponse,
  VoiceprintCluster,
} from "@shared/types";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Radio,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ActivityBucket,
  ActivityTrendChart,
  CompletionRing,
  CompositionBar,
  type CompositionSegment,
} from "@/components/HomeCharts";
import { MarkdownView } from "@/components/MarkdownView";
import { Disclosure, DrawerShell, SegmentedControl } from "@/components/MotionPrimitives";
import { api, uploadWithProgress } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";
import { useRecorderStore } from "@/stores/recorderStore";

interface SavedFormPrefs {
  src?: "mic" | "mix";
  template?: string;
}

const WEEKDAYS_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;
const WEEKDAYS_SHORT = ["日", "一", "二", "三", "四", "五", "六"] as const;
const SPEAKER_BAR_OPACITIES = [0.75, 0.58, 0.45, 0.35, 0.28] as const;

function loadPrefs(): SavedFormPrefs {
  try {
    return JSON.parse(localStorage.getItem("lastForm") || "{}") as SavedFormPrefs;
  } catch {
    return {};
  }
}

function savePrefs(p: SavedFormPrefs): void {
  try {
    localStorage.setItem("lastForm", JSON.stringify({ src: p.src, template: p.template }));
  } catch {}
}

function namedSpeakerCount(m: MeetingMeta): number {
  const vals = Object.values(m.speakers || {}).filter((s) => s.trim() && !/^说话人\s*\d+$/.test(s.trim()));
  return vals.length;
}

function sourceDotColor(source: MeetingMeta["source"]): string {
  if (source === "ambient") return "var(--chart-3)";
  if (source === "upload") return "var(--chart-2)";
  return "var(--chart-1)";
}

export function HomePage() {
  const hash = useAppStore((s) => s.hash);
  const health = useAppStore((s) => s.health);
  const desktopInfo = useAppStore((s) => s.desktopInfo);
  const meetings = useAppStore((s) => s.meetings);
  const ambient = useAppStore((s) => s.ambient);
  const detectedMeetingApp = useAppStore((s) => s.detectedMeetingApp);
  const dismissDetectedMeetingApp = useAppStore((s) => s.dismissDetectedMeetingApp);
  const navigate = useAppStore((s) => s.navigate);
  const loadMeetings = useAppStore((s) => s.loadMeetings);
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const setVpWizardOpen = useAppStore((s) => s.setVpWizardOpen);
  const restoreDiscarded = useAppStore((s) => s.restoreDiscarded);
  const pushToast = useAppStore((s) => s.pushToast);

  const recActive = useRecorderStore((s) => s.active);
  const recMid = useRecorderStore((s) => s.mid);
  const prime = useRecorderStore((s) => s.prime);
  const startRec = useRecorderStore((s) => s.start);

  const init = useMemo(() => loadPrefs(), []);
  const [title, setTitle] = useState("");
  const [src, setSrc] = useState<"mic" | "mix">(init.src === "mix" ? "mix" : "mic");
  const manualSrcRef = useRef(false);
  const [numSpk, setNumSpk] = useState<number>(0);
  const [hotword, setHotword] = useState("");
  const [template, setTemplate] = useState(init.template || "general");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [autostartHint, setAutostartHint] = useState(false);

  const [dayData, setDayData] = useState<DayData | null>(null);
  const [todos, setTodos] = useState<TodosResponse | null>(null);
  const [commitments, setCommitments] = useState<CommitmentsResponse | null>(null);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [projects, setProjects] = useState<ProjectStream[]>([]);
  const [rsi, setRsi] = useState<RsiState | null>(null);
  const [clusters, setClusters] = useState<VoiceprintCluster[]>([]);
  const [discarded, setDiscarded] = useState<DiscardedItem[]>([]);
  const [todoTab, setTodoTab] = useState<"todos" | "commitments">("todos");
  const [trendRange, setTrendRange] = useState<"7d" | "4w">("7d");
  const [hoveredBucket, setHoveredBucket] = useState<string | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [collapsingTodos, setCollapsingTodos] = useState<Record<string, boolean>>({});
  const [collapsingCommits, setCollapsingCommits] = useState<Record<string, boolean>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      if (mountedRef.current) fn();
    }, ms);
    timersRef.current.add(id);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, []);

  const now = new Date();
  const todayStr = ymd(now);
  const todayHeading = `${now.getMonth() + 1}月${now.getDate()}日 · ${WEEKDAYS_ZH[now.getDay()] ?? ""}`;
  const isMac = desktopInfo ? desktopInfo.platform === "darwin" : /Mac/i.test(navigator.platform);
  const markShortcut = isMac ? "⌘⇧M" : "Ctrl+Shift+M";

  useEffect(() => {
    if (hash.includes("autostart=mix")) {
      setSrc("mix");
      setAutostartHint(true);
      scheduleTimer(() => document.getElementById("homeQuickTitle")?.focus(), 40);
    }
  }, [hash, scheduleTimer]);

  useEffect(() => {
    if (detectedMeetingApp && !recActive && !manualSrcRef.current) {
      setSrc("mix");
    }
  }, [detectedMeetingApp, recActive]);

  const fetchDashboard = useCallback(
    async (isCancelled?: () => boolean) => {
      const [dayRes, todoRes, commRes, pplRes, prjRes, rsiRes, clRes, discRes] = await Promise.allSettled([
        api<DayData>(`/api/days/${todayStr}`),
        api<TodosResponse>("/api/todos?status=open"),
        api<CommitmentsResponse>("/api/commitments?status=open&days=14"),
        api<{ people?: PersonSummary[] }>("/api/people"),
        api<{ projects?: ProjectStream[] }>("/api/projects?days=30&limit=4"),
        api<RsiState>("/api/rsi"),
        api<{ clusters?: VoiceprintCluster[] }>("/api/rsi/voiceprints/clusters?days=14&limit=8"),
        api<{ items?: DiscardedItem[] }>("/api/discarded"),
      ]);
      if (isCancelled?.() || !mountedRef.current) return;
      if (dayRes.status === "fulfilled") setDayData(dayRes.value);
      if (todoRes.status === "fulfilled") setTodos(todoRes.value);
      if (commRes.status === "fulfilled") setCommitments(commRes.value);
      if (pplRes.status === "fulfilled") {
        setPeople(Array.isArray(pplRes.value?.people) ? pplRes.value.people : []);
      }
      if (prjRes.status === "fulfilled") {
        setProjects(Array.isArray(prjRes.value?.projects) ? prjRes.value.projects : []);
      }
      if (rsiRes.status === "fulfilled") setRsi(rsiRes.value);
      if (clRes.status === "fulfilled") {
        setClusters(Array.isArray(clRes.value?.clusters) ? clRes.value.clusters : []);
      }
      if (discRes.status === "fulfilled") {
        setDiscarded(Array.isArray(discRes.value?.items) ? discRes.value.items : []);
      }
    },
    [todayStr],
  );

  const meetingCountSig = `${meetings.length}|${meetings[0]?.id ?? ""}|${meetings[0]?.status ?? ""}`;
  useEffect(() => {
    let active = true;
    if (meetingCountSig) {
      void fetchDashboard(() => !active);
    }
    return () => {
      active = false;
    };
  }, [meetingCountSig, fetchDashboard]);

  const templates = useMemo(() => {
    const entries = Object.entries(health?.templates || {});
    return entries.length
      ? entries
      : ([
          ["general", "通用会议"],
          ["weekly", "周会 / 例会"],
          ["client", "客户访谈"],
          ["interview", "招聘面试"],
        ] as Array<[string, string]>);
  }, [health?.templates]);

  const handleStartRecording = async (srcOverride?: "mic" | "mix") => {
    if (starting || recActive) return;
    const useSrc = srcOverride || src;
    setStarting(true);
    setAutostartHint(false);
    savePrefs({ src: useSrc, template });
    prime();

    try {
      const m = await api<MeetingMeta>("/api/meetings", {
        method: "POST",
        body: {
          title: title.trim(),
          num_spk: numSpk,
          hotword: hotword.trim(),
          template,
          source: "mic",
        },
      });
      await startRec(m.id, useSrc);
      await loadMeetings();
      navigate(`#/m/${m.id}`);
    } catch (err) {
      pushToast(`无法开始录音：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      setStarting(false);
    }
  };

  const handleFilePicked = async (file: File | null | undefined) => {
    if (!file) return;
    savePrefs({ src, template });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("title", title.trim() || file.name.replace(/\.[^.]+$/, ""));
    fd.append("num_spk", String(numSpk));
    fd.append("hotword", hotword.trim());
    fd.append("template", template);

    setUploadPct(0);
    try {
      const m = await uploadWithProgress<MeetingMeta>("/api/upload", fd, (pct) => {
        setUploadPct(pct);
      });
      setUploadPct(null);
      await loadMeetings();
      navigate(`#/m/${m.id}`);
    } catch (err) {
      setUploadPct(null);
      pushToast(`上传失败：${err instanceof Error ? err.message : "未知错误"}`, 5000);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const scheduleRowCollapse = (key: string, setter: Dispatch<SetStateAction<Record<string, boolean>>>) => {
    scheduleTimer(() => {
      setter((m) => ({ ...m, [key]: true }));
      scheduleTimer(() => {
        setter((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        void fetchDashboard();
      }, 220);
    }, 350);
  };

  const toggleHomeTodo = async (it: TodoItem, done: boolean) => {
    const key = `${it.mid}-${it.idx}`;
    setTodos((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((t) => (t.mid === it.mid && t.idx === it.idx ? { ...t, done } : t)),
          }
        : prev,
    );
    try {
      await api("/api/todos/toggle", {
        method: "POST",
        body: { mid: it.mid, idx: it.idx, done },
      });
      if (done) {
        scheduleRowCollapse(key, setCollapsingTodos);
        pushToast("已完成待办", {
          tone: "success",
          durationMs: 5600,
          action: {
            label: "撤销",
            onClick: async () => {
              await api("/api/todos/toggle", {
                method: "POST",
                body: { mid: it.mid, idx: it.idx, done: false },
              });
              await fetchDashboard();
            },
          },
        });
      } else {
        void fetchDashboard();
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "更新待办失败", { tone: "error", durationMs: 4000 });
      void fetchDashboard();
    }
  };

  const toggleHomeCommitment = async (c: CommitmentItem, done: boolean) => {
    const key = `${c.mid}-${c.id}`;
    setCommitments((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((x) => (x.mid === c.mid && x.id === c.id ? { ...x, done } : x)),
          }
        : prev,
    );
    try {
      await api("/api/commitments/toggle", {
        method: "POST",
        body: { mid: c.mid, id: c.id, done },
      });
      if (done) {
        scheduleRowCollapse(key, setCollapsingCommits);
        pushToast("已标记承诺完成", {
          tone: "success",
          durationMs: 5600,
          action: {
            label: "撤销",
            onClick: async () => {
              await api("/api/commitments/toggle", {
                method: "POST",
                body: { mid: c.mid, id: c.id, done: false },
              });
              await fetchDashboard();
            },
          },
        });
      } else {
        void fetchDashboard();
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "更新承诺状态失败", { tone: "error", durationMs: 4000 });
      void fetchDashboard();
    }
  };

  const dismissHomeCommitment = async (c: CommitmentItem) => {
    const key = `${c.mid}-${c.id}`;
    try {
      setCollapsingCommits((m) => ({ ...m, [key]: true }));
      await api("/api/commitments/dismiss", {
        method: "POST",
        body: { mid: c.mid, id: c.id },
      });
      scheduleTimer(() => {
        setCollapsingCommits((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        void fetchDashboard();
      }, 220);
      pushToast("已忽略该承诺提醒", {
        durationMs: 5600,
        action: {
          label: "撤销",
          onClick: async () => {
            await api("/api/commitments/restore", {
              method: "POST",
              body: { mid: c.mid, id: c.id },
            });
            await fetchDashboard();
          },
        },
      });
    } catch (err) {
      setCollapsingCommits((m) => {
        const next = { ...m };
        delete next[key];
        return next;
      });
      pushToast(err instanceof Error ? err.message : "忽略失败", { tone: "error", durationMs: 4000 });
    }
  };

  const handleBackfillBriefs = async () => {
    if (backfilling) return;
    setBackfilling(true);
    try {
      const res = await api<{ count?: number }>("/api/insights/backfill", {
        method: "POST",
        body: { limit: 5 },
      });
      await Promise.all([loadMeetings(), fetchDashboard()]);
      const n = Number(res?.count || 0);
      pushToast(n > 0 ? `已为 ${n} 条记录补全标题与一句话摘要` : "近期记录均已有标题与摘要");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "补全摘要失败", 4000);
    } finally {
      setBackfilling(false);
    }
  };

  const handleVocabCandidate = async (frm: string, to: string, accept: boolean) => {
    const key = `${accept ? "acc" : "dis"}:${frm}:${to}`;
    setBusyAction(key);
    try {
      await api(accept ? "/api/rsi/vocab/candidate/accept" : "/api/rsi/vocab/candidate/dismiss", {
        method: "POST",
        body: accept ? { from: frm, to, hotword: true } : { from: frm, to },
      });
      pushToast(accept ? `已采纳「${frm} → ${to}」` : `已忽略候选「${frm}」`);
      void fetchDashboard();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "操作失败", 4000);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestoreDiscarded = async (mid: string) => {
    setBusyAction(`restore:${mid}`);
    try {
      await restoreDiscarded(mid);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "恢复失败", 4000);
      setBusyAction(null);
    }
  };

  const todayMeetings = useMemo(() => {
    const fromDay = dayData?.meetings;
    if (fromDay && dayData.date === todayStr) {
      return [...fromDay].reverse();
    }
    return meetings.filter((m) => (m.created || "").startsWith(todayStr));
  }, [dayData, todayStr, meetings]);

  const todayDurSec = useMemo(
    () => todayMeetings.reduce((acc, m) => acc + effDuration(m), 0),
    [todayMeetings],
  );
  const isTodayRecording = useMemo(
    () => todayMeetings.some((m) => m.status === "recording") || ambient?.state === "speech",
    [todayMeetings, ambient?.state],
  );

  const weekBuckets = useMemo<ActivityBucket[]>(() => {
    const [yy, mm, dd] = todayStr.split("-").map(Number);
    const base = new Date(yy || 2026, (mm || 1) - 1, dd || 1);
    const byDate = new Map<string, { count: number; dur: number }>();
    const days: ActivityBucket[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      const ds = ymd(d);
      const entry = { count: 0, dur: 0 };
      byDate.set(ds, entry);
      days.push({
        key: ds,
        label: i === 0 ? "今" : (WEEKDAYS_SHORT[d.getDay()] ?? ""),
        sublabel: `${d.getMonth() + 1}月${d.getDate()}日`,
        count: 0,
        dur: 0,
        isCurrent: i === 0,
        targetHash: `#/day/${ds}`,
      });
    }
    for (const m of meetings) {
      const ds = (m.created || "").slice(0, 10);
      const b = byDate.get(ds);
      if (b) {
        b.count += 1;
        b.dur += effDuration(m);
      }
    }
    return days.map((item) => {
      const b = byDate.get(item.key);
      return b ? { ...item, count: b.count, dur: b.dur } : item;
    });
  }, [meetings, todayStr]);

  const monthBuckets = useMemo<ActivityBucket[]>(() => {
    const [yy, mm, dd] = todayStr.split("-").map(Number);
    const base = new Date(yy || 2026, (mm || 1) - 1, dd || 1);
    const labels = ["3周前", "2周前", "上周", "近7天"];
    const buckets: Array<ActivityBucket & { minDs: string; maxDs: string }> = [];
    for (let w = 3; w >= 0; w--) {
      const endOffset = w * 7;
      const startOffset = endOffset + 6;
      const startD = new Date(base.getFullYear(), base.getMonth(), base.getDate() - startOffset);
      const endD = new Date(base.getFullYear(), base.getMonth(), base.getDate() - endOffset);
      const minDs = ymd(startD);
      const maxDs = ymd(endD);
      buckets.push({
        key: `w-${w}`,
        label: labels[3 - w] ?? "",
        sublabel: `${startD.getMonth() + 1}/${startD.getDate()}–${endD.getMonth() + 1}/${endD.getDate()}`,
        count: 0,
        dur: 0,
        isCurrent: w === 0,
        targetHash: "#/weekly",
        minDs,
        maxDs,
      });
    }
    for (const m of meetings) {
      const ds = (m.created || "").slice(0, 10);
      if (!ds) continue;
      for (const b of buckets) {
        if (ds >= b.minDs && ds <= b.maxDs) {
          b.count += 1;
          b.dur += effDuration(m);
          break;
        }
      }
    }
    return buckets.map(({ minDs: _a, maxDs: _b, ...rest }) => rest);
  }, [meetings, todayStr]);

  const activeBuckets = trendRange === "7d" ? weekBuckets : monthBuckets;
  const periodStats = useMemo(() => {
    const count = activeBuckets.reduce((a, b) => a + b.count, 0);
    const dur = activeBuckets.reduce((a, b) => a + b.dur, 0);
    return { count, dur };
  }, [activeBuckets]);
  const inspectedBucket = useMemo(
    () => (hoveredBucket ? (activeBuckets.find((b) => b.key === hoveredBucket) ?? null) : null),
    [hoveredBucket, activeBuckets],
  );

  const sourceSegments = useMemo<CompositionSegment[]>(() => {
    let mic = 0;
    let amb = 0;
    let up = 0;
    for (const m of meetings) {
      if (m.source === "ambient") amb += 1;
      else if (m.source === "upload") up += 1;
      else mic += 1;
    }
    return [
      { key: "mic", label: "现场会议", count: mic, color: "var(--chart-1)" },
      { key: "ambient", label: "全天记录", count: amb, color: "var(--chart-3)" },
      { key: "upload", label: "导入音频", count: up, color: "var(--chart-2)" },
    ];
  }, [meetings]);

  const vpCount = rsi?.voiceprints?.persons?.length ?? 0;
  const conflictCount = rsi?.voiceprints?.conflicts?.length ?? 0;
  const vocabCandidates = rsi?.vocab?.candidates ?? [];
  const ctcDemoted = rsi?.vocab?.ctc_demoted ?? [];

  const openTodoList = useMemo(() => (todos?.items || []).filter((t) => !t.done).slice(0, 4), [todos]);
  const openCommitList = useMemo(
    () => (commitments?.items || []).filter((c) => !c.done).slice(0, 4),
    [commitments],
  );
  const highValueDiscarded = useMemo(
    () => discarded.filter((d) => (d.voiced_s ?? 0) >= 5 && Boolean(d.text?.trim())).slice(0, 2),
    [discarded],
  );
  const seedMeeting = useMemo(() => {
    if (vpCount > 0) return null;
    const todayReady = todayMeetings
      .filter((m) => m.status === "ready" && effDuration(m) >= 60 && namedSpeakerCount(m) === 0)
      .sort((a, b) => effDuration(b) - effDuration(a))[0];
    if (todayReady) return todayReady;
    return (
      meetings
        .filter((m) => m.status === "ready" && effDuration(m) >= 60 && namedSpeakerCount(m) === 0)
        .sort((a, b) => effDuration(b) - effDuration(a))[0] ?? null
    );
  }, [vpCount, todayMeetings, meetings]);

  const showTodayTimeline = todayMeetings.length > 0;
  const timelineSource = showTodayTimeline ? todayMeetings : meetings.slice(0, 6);
  const visibleTimeline = timelineExpanded ? timelineSource : timelineSource.slice(0, 6);
  const needsBackfill = useMemo(
    () => timelineSource.some((m) => m.status === "ready" && (Boolean(m.title_auto) || !m.brief)),
    [timelineSource],
  );
  const hasHotwordAdvice = Boolean(rsi?.ambient?.advice?.warning || ctcDemoted.length > 0);
  const insightCount =
    (clusters.length > 0 ? 1 : 0) +
    Math.min(3, vocabCandidates.length) +
    (seedMeeting && clusters.length === 0 ? 1 : 0) +
    (conflictCount > 0 && !seedMeeting ? 1 : 0) +
    highValueDiscarded.length +
    (hasHotwordAdvice ? 1 : 0);

  const summaryParts = useMemo(() => {
    const parts: string[] = [];
    if (todayMeetings.length > 0) {
      parts.push(`今日 ${todayMeetings.length} 场 · ${fmtDur(todayDurSec)}`);
    }
    const openTodos = todos?.counts.open ?? 0;
    if (openTodos > 0) parts.push(`${openTodos} 项待办`);
    const openCommits = commitments?.counts.open ?? 0;
    if (openCommits > 0) parts.push(`${openCommits} 条承诺`);
    return parts;
  }, [todayMeetings.length, todayDurSec, todos?.counts.open, commitments?.counts.open]);

  const hasDaySummaryMd = Boolean(dayData?.summary?.markdown?.trim());
  const dailyButtonLabel = hasDaySummaryMd
    ? dayData?.summary_stale
      ? "更新今日日报"
      : "查看今日日报"
    : "生成今日日报";

  const topPeople = useMemo(() => people.slice(0, 5), [people]);
  const maxPersonSec = useMemo(
    () => Math.max(1, ...topPeople.map((p) => Number(p.total_s || 0))),
    [topPeople],
  );

  return (
    <div className="max-w-[1160px] mx-auto px-5 xl:px-9 py-7 flex flex-col">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] leading-[36px] font-semibold tracking-[-0.02em] text-[var(--text)] m-0 num">
            {todayHeading}
          </h1>
          <p className="text-sm leading-[22px] text-[var(--text-2)] m-0 mt-1 num">
            {summaryParts.length > 0
              ? summaryParts.join(" · ")
              : ambient?.enabled
                ? "全天监听待命中 · 有人说话将自动开始记录"
                : "本机实时转写与 AI 纪要"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {insightCount > 0 && (
            <button
              type="button"
              onClick={() => setInsightsOpen(true)}
              className="btn-secondary rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Bell className="w-4 h-4 text-[var(--warn)] shrink-0" aria-hidden="true" />
              <span>待确认</span>
              <span className="rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-1.5 py-0.5 text-[11px] leading-[14px] font-medium num whitespace-nowrap shrink-0">
                {insightCount}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (window.desktopAPI) {
                void window.desktopAPI.toggleQuickAsk();
              } else {
                navigate("#/quick-ask");
              }
            }}
            className="btn-ghost rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Sparkles className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>全局闪问</span>
          </button>
          <button
            type="button"
            onClick={() => navigate("#/people")}
            className="btn-secondary rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Users className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>人物</span>
            {people.length > 0 && (
              <span className="rounded-full bg-[var(--fill)] px-1.5 py-0.5 text-[11px] leading-[14px] text-[var(--text-2)] num whitespace-nowrap shrink-0">
                {people.length}
              </span>
            )}
          </button>
        </div>
      </header>

      <Disclosure open={Boolean(detectedMeetingApp && !recActive)}>
        {detectedMeetingApp && (
          <div className="pb-5">
            <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-5 py-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full bg-[var(--ok)] animate-pulse shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="text-sm leading-[22px] font-semibold text-[var(--text)]">
                    检测到正在进行 {detectedMeetingApp.name}
                  </div>
                  <div className="text-[13px] leading-[20px] text-[var(--text-2)]">
                    已为你选中「麦+电脑音」双声道，同时录制你的话筒与对方声音
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => dismissDetectedMeetingApp()}
                  className="btn-ghost rounded-[8px] px-3 h-8 text-[13px] leading-[20px] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  本次忽略
                </button>
                <button
                  type="button"
                  disabled={starting}
                  onClick={() => {
                    setSrc("mix");
                    void handleStartRecording("mix");
                  }}
                  className="rounded-[8px] px-3.5 h-8 text-[13px] leading-[20px] font-medium bg-[var(--rec)] hover:bg-[var(--rec-hover)] active:scale-[0.98] text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-[background-color,transform] duration-150 disabled:opacity-55"
                >
                  <Radio className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>开始双声道录音</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </Disclosure>

      <Disclosure open={Boolean(!detectedMeetingApp && autostartHint && !recActive)}>
        <div className="pb-5">
          <div className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] px-5 py-3.5 flex items-center justify-between gap-2 text-[13px] leading-[20px] text-[var(--text-2)]">
            <span>已为你切换到「麦+电脑音」双声道模式，输入标题或直接点击下方「开始录音」即可开始。</span>
            <button
              type="button"
              onClick={() => setAutostartHint(false)}
              aria-label="关闭提示"
              className="btn-ghost rounded-[6px] w-7 h-7 flex items-center justify-center cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </Disclosure>

      <Disclosure open={Boolean(recActive && recMid)}>
        {recMid && (
          <div className="pb-5">
            <div className="rounded-[16px] bg-[var(--danger-soft)] px-5 py-3.5 flex items-center justify-between gap-3 text-[13px] leading-[20px] text-[var(--danger)]">
              <span className="font-medium inline-flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[var(--danger)] rec-dot" aria-hidden="true" />
                当前正在录音中
              </span>
              <button
                type="button"
                onClick={() => navigate(`#/m/${recMid}`)}
                className="rounded-[8px] px-3 h-8 text-[13px] leading-[20px] bg-[var(--rec)] hover:bg-[var(--rec-hover)] text-white font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              >
                回到录音界面
              </button>
            </div>
          </div>
        )}
      </Disclosure>

      <div className="mb-6 grid grid-cols-1 lg:grid-cols-12 gap-5 xl:gap-6 items-stretch">
        <section
          className="lg:col-span-7 rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 xl:p-6 flex flex-col"
          aria-label="快速开始会议"
        >
          <div className="flex-1 flex flex-col justify-between gap-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                  新建会议
                </h2>
                <span className="text-xs leading-[18px] text-[var(--muted)] truncate">
                  支持拖放音视频文件
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOptionsOpen((v) => !v)}
                aria-expanded={optionsOpen}
                className="btn-ghost h-8 px-2.5 rounded-[8px] text-[13px] leading-[20px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>选项</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${optionsOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            <input
              id="homeQuickTitle"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && !starting && !recActive) {
                  e.preventDefault();
                  void handleStartRecording();
                }
              }}
              placeholder="准备记一场什么会？输入标题，或留空按时间自动命名…"
              aria-label="会议标题"
              className="w-full h-11 px-4 text-[15px] leading-[22px] font-medium rounded-[10px]"
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <SegmentedControl
                value={src}
                onChange={(nextSrc) => {
                  manualSrcRef.current = true;
                  setSrc(nextSrc);
                }}
                options={[
                  { value: "mic", label: "现场麦" },
                  { value: "mix", label: "麦+电脑音" },
                ]}
                ariaLabel="声音来源"
              />

              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,video/*,.m4a,.mp3,.wav,.ogg,.webm,.flac,.aac,.mp4,.mov,.mkv"
                  onChange={(e) => void handleFilePicked(e.target.files?.[0])}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-secondary h-10 px-4 rounded-[10px] text-sm leading-[22px] font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{uploadPct !== null ? `上传中 ${Math.round(uploadPct)}%` : "导入音频"}</span>
                </button>

                <button
                  type="button"
                  disabled={starting || recActive}
                  onClick={() => void handleStartRecording()}
                  className="h-10 px-5 rounded-[10px] text-sm leading-[22px] font-medium bg-[var(--rec)] hover:bg-[var(--rec-hover)] active:scale-[0.97] text-white inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer transition-[background-color,transform] duration-150 disabled:opacity-55"
                >
                  <span className="w-2 h-2 rounded-full bg-white shrink-0" aria-hidden="true" />
                  <span>{starting ? "启动中…" : "开始录音"}</span>
                </button>
              </div>
            </div>
          </div>

          <Disclosure open={optionsOpen}>
            <div className="pt-4">
              <div className="pt-4 border-t border-[var(--line-2)] space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="homeNumSpk"
                      className="block text-xs leading-[18px] font-medium text-[var(--text-2)] mb-1.5"
                    >
                      参会人数
                    </label>
                    <select
                      id="homeNumSpk"
                      value={numSpk}
                      onChange={(e) => setNumSpk(Number(e.target.value))}
                      className="w-full h-9 px-3 rounded-[8px] text-[13px] leading-[20px]"
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
                      htmlFor="homeTpl"
                      className="block text-xs leading-[18px] font-medium text-[var(--text-2)] mb-1.5"
                    >
                      默认纪要模板
                    </label>
                    <select
                      id="homeTpl"
                      value={template}
                      onChange={(e) => setTemplate(e.target.value)}
                      className="w-full h-9 px-3 rounded-[8px] text-[13px] leading-[20px]"
                    >
                      {templates.map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      htmlFor="homeHotword"
                      className="block text-xs leading-[18px] font-medium text-[var(--text-2)] mb-1.5"
                    >
                      本场热词 / 人名
                    </label>
                    <input
                      id="homeHotword"
                      type="text"
                      value={hotword}
                      onChange={(e) => setHotword(e.target.value)}
                      placeholder="例如：张伟 季度复盘 OKR"
                      className="w-full h-9 px-3 rounded-[8px] text-[13px] leading-[20px]"
                    />
                  </div>
                </div>

                <div className="text-xs leading-[18px] text-[var(--muted)]">
                  全局快捷键：
                  <kbd className="font-mono text-[11px] leading-[14px] bg-[var(--fill)] text-[var(--text-2)] px-1.5 py-0.5 rounded-[4px]">
                    {markShortcut}
                  </kbd>{" "}
                  随时打点
                </div>
              </div>
            </div>
          </Disclosure>
        </section>

        <section
          className="lg:col-span-5 rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 xl:p-6 flex flex-col justify-between gap-4"
          aria-label="记录节奏图表"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
              记录节奏
            </h2>
            <SegmentedControl
              size="xs"
              value={trendRange}
              onChange={(next) => {
                setTrendRange(next);
                setHoveredBucket(null);
              }}
              options={[
                { value: "7d", label: "7天" },
                { value: "4w", label: "4周" },
              ]}
              ariaLabel="选择统计周期"
            />
          </div>

          <div className="flex items-baseline justify-between gap-2 min-h-[32px]">
            <span className="text-[24px] leading-[32px] font-semibold tracking-[-0.02em] text-[var(--text)] num whitespace-nowrap shrink-0">
              {inspectedBucket ? fmtDur(inspectedBucket.dur) : fmtDur(periodStats.dur)}
            </span>
            <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
              {inspectedBucket
                ? `${inspectedBucket.sublabel} · ${inspectedBucket.count} 场`
                : `${trendRange === "7d" ? "近 7 天" : "近 4 周"} · ${periodStats.count} 场`}
            </span>
          </div>

          <ActivityTrendChart
            buckets={activeBuckets}
            hoveredKey={hoveredBucket}
            onHover={setHoveredBucket}
            onSelect={(b) => {
              if (b.targetHash) navigate(b.targetHash);
            }}
          />
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 xl:gap-6 items-start">
        <div className="lg:col-span-7 space-y-6">
          <section
            className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 xl:p-6 space-y-4"
            aria-label={showTodayTimeline ? "今日脉络" : "最近记录"}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-[15px] leading-[22px] font-semibold tracking-[-0.01em] text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                  {showTodayTimeline ? "今日脉络" : "最近记录"}
                </h2>
                {timelineSource.length > 0 && (
                  <span className="rounded-full bg-[var(--fill)] px-2 py-0.5 text-xs leading-[16px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                    {timelineSource.length} 场
                  </span>
                )}
                {isTodayRecording && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--danger-soft)] text-[var(--danger)] px-2.5 py-0.5 text-xs leading-[16px] font-medium whitespace-nowrap shrink-0">
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] rec-dot shrink-0"
                      aria-hidden="true"
                    />
                    记录中
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {needsBackfill && (
                  <button
                    type="button"
                    disabled={backfilling}
                    onClick={() => void handleBackfillBriefs()}
                    className="btn-ghost rounded-[8px] px-2.5 h-8 text-[13px] leading-[20px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Wand2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{backfilling ? "起名中…" : "智能起名"}</span>
                  </button>
                )}
                {(todayMeetings.length > 0 || hasDaySummaryMd) && (
                  <button
                    type="button"
                    onClick={() => navigate(`#/day/${todayStr}`)}
                    className="btn-secondary rounded-[8px] px-3 h-8 text-[13px] leading-[20px] font-medium inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <span>{dailyButtonLabel}</span>
                    <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            {hasDaySummaryMd && dayData?.summary && (
              <div className="rounded-[12px] bg-[var(--surface-2)] px-4 py-3.5 space-y-2.5">
                <div className="max-h-[184px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_76%,transparent)]">
                  <MarkdownView markdown={dayData.summary.markdown} />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs leading-[18px] text-[var(--muted)] num">
                  <span className="min-w-0 truncate">
                    今日日报 · {dayData.summary.model || dayData.summary.provider || "AI 汇总"}
                    {dayData.summary.created ? (
                      <>
                        {" · "}
                        <span className="num-mono">{hm(dayData.summary.created)}</span>
                      </>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate(`#/day/${todayStr}`)}
                    className="btn-ghost rounded-[6px] px-2 h-7 text-xs leading-[18px] font-medium text-[var(--text-2)] hover:text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    展开全文
                  </button>
                </div>
              </div>
            )}

            {!visibleTimeline.length ? (
              <div className="py-10 text-center text-[13px] leading-[20px] text-[var(--muted)]">
                暂无会议记录，在上方输入标题开始录音，或直接拖放音视频文件进来
              </div>
            ) : (
              <div className={timelineExpanded ? "max-h-[480px] overflow-y-auto pr-1" : undefined}>
                <div className="relative pl-4 space-y-1">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-[4.5px] top-4 bottom-4 w-px bg-[var(--line-2)]"
                  />
                  {visibleTimeline.map((m) => {
                    const spkCnt = namedSpeakerCount(m);
                    const suggestCnt = Object.keys(m.speaker_meta?.suggest || {}).length;
                    const timeLabel = m.clock_start
                      ? `${m.clock_start}${m.clock_end ? `–${m.clock_end}` : ""}`
                      : `${(m.created || "").slice(5, 10)} ${hm(m.created)}`;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => navigate(`#/m/${m.id}`)}
                        className="relative w-full py-3 px-3 rounded-[10px] text-left hover:bg-[var(--fill)] transition-colors flex items-start gap-3 cursor-pointer"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute -left-[15px] top-[19px] w-[7px] h-[7px] rounded-full ring-2 ring-[var(--surface)]"
                          style={{ backgroundColor: sourceDotColor(m.source) }}
                        />
                        <span className="num-mono text-xs leading-[22px] text-[var(--muted)] shrink-0 min-w-[84px]">
                          {timeLabel}
                        </span>
                        <span className="flex-1 min-w-0 block space-y-1">
                          <span className="block text-sm leading-[22px] font-medium text-[var(--text)] truncate">
                            {m.title || "未命名会议"}
                          </span>
                          {(m.brief || (m.tags && m.tags.length > 0)) && (
                            <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[20px] text-[var(--text-2)]">
                              {m.brief && <span className="truncate max-w-[340px]">{m.brief}</span>}
                              {(m.tags || []).slice(0, 2).map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-[6px] bg-[var(--fill)] px-1.5 py-0 text-xs leading-[18px] text-[var(--muted)] shrink-0"
                                >
                                  #{tag}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0 pt-0.5">
                          {m.status === "recording" && (
                            <span className="rounded-full bg-[var(--danger-soft)] text-[var(--danger)] px-2 py-0.5 text-xs leading-[16px] font-medium whitespace-nowrap shrink-0">
                              录音中
                            </span>
                          )}
                          {(m.status === "queued" || m.status === "transcribing") && (
                            <span className="rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-2 py-0.5 text-xs leading-[16px] font-medium whitespace-nowrap shrink-0">
                              {m.status === "queued" ? "排队中" : "转写中"}
                            </span>
                          )}
                          {suggestCnt > 0 && (
                            <span className="rounded-full bg-[var(--fill)] text-[var(--text-2)] px-2 py-0.5 text-xs leading-[16px] font-medium whitespace-nowrap shrink-0">
                              待认人
                            </span>
                          )}
                          {spkCnt > 0 && (
                            <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                              {spkCnt}人
                            </span>
                          )}
                          <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                            {fmtDur(effDuration(m))}
                          </span>
                          <ChevronRight
                            className="w-3.5 h-3.5 text-[var(--muted)] shrink-0"
                            aria-hidden="true"
                          />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {timelineSource.length > 6 && (
              <div className="pt-1 flex justify-center">
                <button
                  type="button"
                  onClick={() => setTimelineExpanded((v) => !v)}
                  className="btn-ghost rounded-[8px] px-3 h-8 text-[13px] leading-[20px] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {timelineExpanded ? "收起时间线" : `展开全部 ${timelineSource.length} 场`}
                </button>
              </div>
            )}
          </section>
        </div>

        <div className="lg:col-span-5 space-y-6">
          <section
            className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 xl:p-6 space-y-4"
            aria-label="待跟进事项"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SegmentedControl
                value={todoTab}
                onChange={setTodoTab}
                options={[
                  { value: "todos", label: "未完待办", badge: todos?.counts.open ?? 0 },
                  { value: "commitments", label: "承诺雷达", badge: commitments?.counts.open ?? 0 },
                ]}
                ariaLabel="切换待办与承诺"
              />

              <button
                type="button"
                onClick={() => navigate("#/todos")}
                className="btn-ghost rounded-[8px] px-2 h-8 text-[13px] leading-[20px] inline-flex items-center gap-0.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>全部</span>
                <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              </button>
            </div>

            {todoTab === "todos" && (todos?.counts.total ?? 0) > 0 && (
              <CompletionRing
                done={todos?.counts.done ?? 0}
                total={todos?.counts.total ?? 0}
                label={`已完成 ${todos?.counts.done ?? 0} / 共 ${todos?.counts.total ?? 0} 项`}
                sublabel={
                  (todos?.counts.open ?? 0) > 0
                    ? `还有 ${todos?.counts.open ?? 0} 项待办等待推进`
                    : "当前待办已全部清零"
                }
              />
            )}

            {todoTab === "commitments" && (commitments?.counts.total ?? 0) > 0 && (
              <CompletionRing
                done={commitments?.counts.done ?? 0}
                total={commitments?.counts.total ?? 0}
                label={`已兑现 ${commitments?.counts.done ?? 0} / 共 ${commitments?.counts.total ?? 0} 条`}
                sublabel={
                  (commitments?.counts.overdue ?? 0) > 0
                    ? `其中 ${commitments?.counts.overdue ?? 0} 条超过 3 天未跟进`
                    : `待跟进 ${commitments?.counts.open ?? 0} 条口头承诺`
                }
              />
            )}

            {todoTab === "todos" ? (
              !openTodoList.length ? (
                <p className="text-[13px] leading-[20px] text-[var(--muted)] m-0 py-2">
                  暂无未完待办，会议行动项会自动汇总于此
                </p>
              ) : (
                <div className="space-y-2.5">
                  {openTodoList.map((it) => {
                    const rowKey = `${it.mid}-${it.idx}`;
                    return (
                      <div
                        key={rowKey}
                        className="mn-row-collapse"
                        data-collapsing={collapsingTodos[rowKey] ? "true" : undefined}
                      >
                        <div>
                          <div className="rounded-[12px] bg-[var(--fill)] px-3.5 py-3 space-y-1.5">
                            <label className="flex items-start gap-2.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={it.done}
                                onChange={(e) => void toggleHomeTodo(it, e.target.checked)}
                                className="mt-[3px] shrink-0"
                              />
                              <span
                                className={`text-sm leading-[22px] transition-colors duration-150 ${
                                  it.done ? "line-through text-[var(--muted)]" : "text-[var(--text)]"
                                }`}
                              >
                                {it.text}
                              </span>
                            </label>
                            <div className="pl-6 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  navigate(`#/m/${it.mid}${it.ts ? `?t=${Math.max(0, tsToSec(it.ts))}` : ""}`)
                                }
                                className="btn-ghost rounded-[6px] px-1.5 h-7 text-xs leading-[18px] text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-1 min-w-0 cursor-pointer"
                              >
                                <span className="truncate">{it.meeting_title || "来源会议"}</span>
                                {it.ts && <span className="num-mono shrink-0">[{it.ts}]</span>}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : !openCommitList.length ? (
              <p className="text-[13px] leading-[20px] text-[var(--muted)] m-0 py-2">
                近 14 天暂无待跟进的口头承诺
              </p>
            ) : (
              <div className="space-y-2.5">
                {openCommitList.map((c) => {
                  const rowKey = `${c.mid}-${c.id}`;
                  return (
                    <div
                      key={rowKey}
                      className="mn-row-collapse"
                      data-collapsing={collapsingCommits[rowKey] ? "true" : undefined}
                    >
                      <div>
                        <div className="rounded-[12px] bg-[var(--fill)] px-3.5 py-3 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <label className="flex items-start gap-2.5 cursor-pointer flex-1 min-w-0">
                              <input
                                type="checkbox"
                                checked={c.done}
                                onChange={(e) => void toggleHomeCommitment(c, e.target.checked)}
                                className="mt-[3px] shrink-0"
                              />
                              <span
                                className={`text-sm leading-[22px] transition-colors duration-150 ${
                                  c.done ? "line-through text-[var(--muted)]" : "text-[var(--text)]"
                                }`}
                              >
                                {c.text}
                              </span>
                            </label>
                            <button
                              type="button"
                              onClick={() => void dismissHomeCommitment(c)}
                              aria-label="忽略承诺"
                              className="btn-ghost rounded-[6px] w-7 h-7 flex items-center justify-center text-[var(--muted)] shrink-0 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          </div>
                          <div className="pl-6 flex flex-wrap items-center gap-1.5 text-xs leading-[18px]">
                            <span
                              className={`rounded-full px-2 py-0.5 font-medium whitespace-nowrap shrink-0 ${
                                c.direction === "mine"
                                  ? "bg-[var(--surface)] text-[var(--text-2)]"
                                  : "bg-[var(--warn-soft)] text-[var(--warn)]"
                              }`}
                            >
                              {c.direction === "mine" ? "我答应" : "等对方"}
                            </span>
                            {c.overdue && (
                              <span className="rounded-full bg-[var(--warn-soft)] text-[var(--warn)] px-2 py-0.5 font-medium num whitespace-nowrap shrink-0">
                                超过 3 天未跟进
                              </span>
                            )}
                            {c.due_hint && <span className="text-[var(--muted)]">{c.due_hint}</span>}
                            <button
                              type="button"
                              onClick={() =>
                                navigate(
                                  `#/m/${c.mid}?t=${Math.max(0, Math.floor((c.start_ms || 0) / 1000))}`,
                                )
                              }
                              className="btn-ghost rounded-[6px] px-1.5 h-7 text-xs leading-[18px] text-[var(--muted)] hover:text-[var(--text)] inline-flex items-center gap-1 min-w-0 cursor-pointer ml-auto"
                            >
                              <span className="truncate max-w-[120px]">{c.meeting_title}</span>
                              {c.ts && <span className="num-mono shrink-0">[{c.ts}]</span>}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section
            className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 xl:p-6 space-y-4"
            aria-label="人物快捷入口"
          >
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                  人物与发言
                </h2>
                {people.length > 0 && (
                  <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                    {people.length} 位
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {clusters.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setVpWizardOpen(true)}
                    className="h-7 px-2.5 text-xs leading-[18px] rounded-[8px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    批量认人
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => navigate("#/people")}
                  className="btn-ghost rounded-[8px] px-1.5 -mr-1.5 h-7 text-xs leading-[18px] inline-flex items-center gap-0.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>管理与修改</span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                </button>
              </div>
            </div>

            {topPeople.length > 0 ? (
              <>
                <div className="space-y-1.5">
                  {topPeople.map((p, idx) => {
                    const ratio = Math.max(0.1, Math.min(1, Number(p.total_s || 0) / maxPersonSec));
                    const barOpacity = SPEAKER_BAR_OPACITIES[idx] ?? 0.28;
                    return (
                      <button
                        key={p.name}
                        type="button"
                        onClick={() => navigate(`#/people/${encodeURIComponent(p.name)}`)}
                        className="w-full rounded-[10px] px-3 py-2.5 text-left hover:bg-[var(--fill)] transition-colors space-y-2 cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-6 h-6 rounded-full bg-[var(--ink)] text-[var(--ink-fg)] inline-flex items-center justify-center text-xs leading-none font-semibold shrink-0">
                              {p.name.slice(0, 1)}
                            </span>
                            <span className="text-sm leading-[20px] font-medium text-[var(--text)] truncate">
                              {p.name}
                            </span>
                            {p.has_voiceprint && (
                              <span className="rounded-full bg-[var(--ok-soft)] text-[var(--ok)] px-2 py-0.5 text-xs leading-[16px] font-medium whitespace-nowrap shrink-0">
                                声纹
                              </span>
                            )}
                          </div>
                          <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                            {p.meetings} 场 · {fmtDur(p.total_s)}
                          </span>
                        </div>
                        <div
                          className="h-1.5 w-full rounded-full bg-[var(--chart-track)] overflow-hidden"
                          aria-hidden="true"
                        >
                          <div
                            className="h-full w-full origin-left rounded-full bg-[var(--ink)] mn-chart-anim transition-transform duration-300"
                            style={{
                              transform: `scaleX(${ratio.toFixed(3)})`,
                              opacity: barOpacity,
                            }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs leading-[18px] text-[var(--muted)] m-0">
                  点任一人物可查看参会记录，直接改名、合并或纠正认错场次
                </p>
              </>
            ) : clusters.length > 0 ? (
              <button
                type="button"
                onClick={() => setVpWizardOpen(true)}
                className="w-full rounded-[12px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] px-4 py-3 text-left text-[13px] leading-[20px] text-[var(--text)] flex items-center justify-between gap-2 cursor-pointer transition-colors"
              >
                <span className="num">发现 {clusters.length} 位常见声音，点此批量认人</span>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--muted)] shrink-0" aria-hidden="true" />
              </button>
            ) : (
              <p className="text-[13px] leading-[20px] text-[var(--muted)] m-0">
                在转写稿中命名说话人后，这里会展示发言时长对比与快捷纠错入口
              </p>
            )}
          </section>

          {meetings.length > 0 && (
            <section
              className="rounded-[16px] bg-[var(--surface)] shadow-[var(--shadow-1)] p-5 xl:p-6 space-y-4"
              aria-label="记录构成与活跃专题"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap shrink-0">
                  记录构成
                </h2>
                <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                  累计 {meetings.length} 场
                </span>
              </div>

              <CompositionBar segments={sourceSegments} />

              {projects.length > 0 && (
                <div className="pt-3 border-t border-[var(--line-2)] space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] leading-[20px] font-medium text-[var(--text-2)] whitespace-nowrap shrink-0">
                      活跃专题
                    </span>
                    <button
                      type="button"
                      onClick={() => navigate("#/projects")}
                      className="btn-ghost rounded-[6px] px-2 h-7 text-xs leading-[18px] inline-flex items-center gap-0.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <span>查看脉络</span>
                      <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {projects.slice(0, 4).map((pr) => (
                      <button
                        key={pr.id}
                        type="button"
                        onClick={() => navigate("#/projects")}
                        className="h-8 rounded-[8px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] px-3 text-[13px] leading-[20px] text-[var(--text)] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        <span className="font-medium truncate max-w-[140px]">{pr.name}</span>
                        <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                          {pr.meeting_count} 场
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      <DrawerShell
        open={insightsOpen}
        onClose={() => setInsightsOpen(false)}
        label="智能识别建议"
        widthClass="w-full max-w-[440px]"
      >
        <div className="px-6 py-4 border-b border-[var(--line-2)] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] leading-[22px] font-semibold text-[var(--text)] m-0 whitespace-nowrap">
              智能识别建议
            </h2>
            <p className="text-xs leading-[18px] text-[var(--muted)] mt-0.5 m-0">
              处理完后会自动收起，不占用首页工作区
            </p>
          </div>
          <button
            type="button"
            onClick={() => setInsightsOpen(false)}
            aria-label="关闭智能识别建议"
            className="btn-ghost rounded-[6px] w-7 h-7 flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {insightCount === 0 ? (
            <div className="py-12 text-center text-[13px] leading-[20px] text-[var(--muted)]">
              当前暂无待处理的建议，稍后有新发现会在这里提醒。
            </div>
          ) : (
            <>
              {clusters.length > 0 && (
                <div className="rounded-[12px] bg-[var(--fill)] px-4 py-3 flex flex-wrap items-center justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="text-sm leading-[22px] font-medium text-[var(--text)] num">
                      发现 {clusters.length} 位跨会议重复出现的未命名声音
                    </div>
                    <div className="text-xs leading-[18px] text-[var(--muted)] mt-0.5">
                      试听 5 秒即可批量给多场记录一次认人
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setInsightsOpen(false);
                      setVpWizardOpen(true);
                    }}
                    className="rounded-[8px] px-3 h-8 text-xs leading-[18px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    批量认人
                  </button>
                </div>
              )}

              {vocabCandidates.slice(0, 3).map((c) => {
                const keyAcc = `acc:${c.from}:${c.to}`;
                const keyDis = `dis:${c.from}:${c.to}`;
                return (
                  <div
                    key={`${c.from}-${c.to}`}
                    className="rounded-[12px] bg-[var(--fill)] px-4 py-3 space-y-2 text-sm leading-[22px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        发现候选纠错：<span className="text-[var(--muted)]">{c.from}</span> →{" "}
                        <span className="font-semibold text-[var(--text)]">{c.to}</span>
                      </span>
                      <span className="text-xs leading-[18px] text-[var(--muted)] num whitespace-nowrap shrink-0">
                        {c.count ?? 1} 次
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busyAction === keyAcc || busyAction === keyDis}
                        onClick={() => void handleVocabCandidate(c.from, c.to, false)}
                        className="btn-ghost rounded-[8px] px-2.5 h-7 text-xs leading-[18px] whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        忽略
                      </button>
                      <button
                        type="button"
                        disabled={busyAction === keyAcc || busyAction === keyDis}
                        onClick={() => void handleVocabCandidate(c.from, c.to, true)}
                        className="btn-secondary rounded-[8px] px-2.5 h-7 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        采纳规则
                      </button>
                    </div>
                  </div>
                );
              })}

              {seedMeeting && clusters.length === 0 && (
                <div className="rounded-[12px] bg-[var(--fill)] px-4 py-3 flex items-center justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="text-sm leading-[22px] font-medium text-[var(--text)]">
                      命名 1 场常驻同事即可启用声纹自动认人
                    </div>
                    <div className="text-xs leading-[18px] text-[var(--muted)] truncate num mt-0.5">
                      推荐从「{seedMeeting.title || "未命名会议"}」（{fmtDur(effDuration(seedMeeting))}）开始
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setInsightsOpen(false);
                      navigate(`#/m/${seedMeeting.id}`);
                    }}
                    className="btn-secondary rounded-[8px] px-2.5 h-7 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    去命名
                  </button>
                </div>
              )}

              {conflictCount > 0 && !seedMeeting && (
                <div className="rounded-[12px] bg-[var(--warn-soft)] px-4 py-3 flex items-center justify-between gap-2">
                  <span className="text-[13px] leading-[20px] text-[var(--warn)] font-medium num">
                    发现 {conflictCount} 条声纹冲突待确认
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setInsightsOpen(false);
                      openSettingsTab("rsi");
                    }}
                    className="btn-secondary rounded-[8px] px-2.5 h-7 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    去处理
                  </button>
                </div>
              )}

              {highValueDiscarded.map((d) => (
                <div key={d.id} className="rounded-[12px] bg-[var(--fill)] px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs leading-[18px]">
                    <span className="text-[var(--muted)] num">
                      短片段回收站 · <span className="num-mono">{hm(d.time)}</span> · {Math.round(d.voiced_s)}
                      秒
                    </span>
                    <button
                      type="button"
                      disabled={busyAction === `restore:${d.id}`}
                      onClick={() => {
                        setInsightsOpen(false);
                        void handleRestoreDiscarded(d.id);
                      }}
                      className="btn-secondary rounded-[8px] px-2.5 h-7 text-xs leading-[18px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span>恢复并转写</span>
                    </button>
                  </div>
                  <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0 line-clamp-2">{d.text}</p>
                </div>
              ))}

              {hasHotwordAdvice && (
                <button
                  type="button"
                  onClick={() => {
                    setInsightsOpen(false);
                    openSettingsTab("rsi");
                  }}
                  className="w-full rounded-[12px] bg-[var(--fill)] hover:bg-[var(--fill-hover)] px-4 py-3 text-left text-[13px] leading-[20px] text-[var(--text-2)] flex items-center justify-between gap-2 cursor-pointer transition-colors"
                >
                  <span className="truncate">
                    {rsi?.ambient?.advice?.warning ||
                      `已自动停用易误识别的热词：${ctcDemoted.map((x) => `「${x.word}」`).join("、")}`}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-[var(--line-2)] flex justify-end">
          <button
            type="button"
            onClick={() => {
              setInsightsOpen(false);
              openSettingsTab("rsi");
            }}
            className="btn-ghost rounded-[8px] px-3 h-8 text-[13px] leading-[20px] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>前往词库与声纹设置</span>
            <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </DrawerShell>
    </div>
  );
}
