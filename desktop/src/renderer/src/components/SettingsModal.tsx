import { fmtDur } from "@shared/format";
import type {
  AmbientConfig,
  AmbientStorage,
  AsrConfig,
  LanStatus,
  LlmProvider,
  LocalLlmStatus,
  McpConfigResponse,
  RsiState,
  VocabData,
} from "@shared/types";
import {
  BookOpen,
  Bot,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  Mic,
  Plus,
  Radio,
  RefreshCw,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyButton, Disclosure, InlineConfirm, ModalShell } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { normalizeSettingsTab, type SettingsTab, useAppStore } from "@/stores/appStore";

type CanonicalSettingsTab = "llm" | "asr" | "vocab" | "ambient" | "lan" | "about";

const NAV_TABS: Array<{ id: CanonicalSettingsTab; label: string; icon: typeof Bot }> = [
  { id: "llm", label: "AI 模型", icon: Bot },
  { id: "asr", label: "语音识别", icon: Mic },
  { id: "vocab", label: "词库与声纹", icon: BookOpen },
  { id: "ambient", label: "全天模式", icon: Radio },
  { id: "lan", label: "多端与集成", icon: Smartphone },
  { id: "about", label: "关于与更新", icon: Info },
];

const LLM_PRESETS: Array<{ name: string; base_url: string; model: string }> = [
  { name: "DeepSeek", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "通义千问", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "本机 Ollama", base_url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
];

const FIELD_LABEL = "block text-sm leading-[22px] font-medium text-[var(--text)] mb-1.5";
const FIELD_INPUT =
  "h-9 rounded-[10px] text-sm leading-[22px] px-3 bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] focus:ring-2 focus:ring-[var(--ink-ring)] transition-colors";
const FIELD_TEXTAREA =
  "rounded-[10px] text-sm leading-[22px] px-3 py-2 bg-[var(--surface-elev)] border border-[var(--line)] hover:border-[var(--line-focus)] focus:border-[var(--line-focus)] focus:ring-2 focus:ring-[var(--ink-ring)] transition-colors";
const BTN_BRAND =
  "h-9 rounded-[10px] px-4 text-sm leading-[22px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 active:scale-[0.98] disabled:opacity-50";
const BTN_BRAND_SM =
  "h-8 rounded-[8px] px-3 text-[13px] leading-[20px] font-medium bg-[var(--ink)] hover:bg-[var(--ink-hover)] text-[var(--ink-fg)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 active:scale-[0.98] disabled:opacity-50";
const BTN_BRAND_SOFT =
  "h-8 rounded-[8px] px-3 text-[13px] leading-[20px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] border border-[var(--line)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 disabled:opacity-50";
const BTN_SECONDARY_MD =
  "btn-secondary h-9 rounded-[10px] px-3.5 text-sm leading-[22px] font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer";
const BTN_SECONDARY_SM =
  "btn-secondary h-8 rounded-[8px] px-3 text-[13px] leading-[20px] font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer";

interface EditableProvider extends LlmProvider {
  api_key_input?: string;
}

function qrDataUri(svg: string): string {
  const raw = (svg || "").trim();
  if (!raw) return "";
  const patched = raw.replace(/^<svg\b/, (tag) => {
    let out = tag;
    if (!/\bxmlns=/.test(raw)) out += ' xmlns="http://www.w3.org/2000/svg"';
    if (!/\bwidth=/.test(raw)) out += ' width="128" height="128"';
    return out;
  });
  return `data:image/svg+xml;utf8,${encodeURIComponent(patched)}`;
}

function detectPresetName(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("deepseek.com")) return "DeepSeek";
  if (lower.includes("dashscope")) return "通义千问";
  if (lower.includes("openai.com")) return "OpenAI";
  if (lower.includes("11434")) return "本机 Ollama";
  if (lower.includes("volces.com") || lower.includes("ark.")) return "火山方舟";
  if (lower.includes("127.0.0.1") || lower.includes("localhost")) return "本机模型";
  return "";
}

export function SettingsModal() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settingsTab = useAppStore((s) => s.settingsTab);
  const refreshSettings = useAppStore((s) => s.refreshSettings);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const desktopInfo = useAppStore((s) => s.desktopInfo);
  const sidecarStatus = useAppStore((s) => s.sidecarStatus);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const pushToast = useAppStore((s) => s.pushToast);

  const [tab, setTab] = useState<CanonicalSettingsTab>(() => normalizeSettingsTab(settingsTab));

  // LLM state
  const [activeId, setActiveId] = useState("");
  const [providers, setProviders] = useState<EditableProvider[]>([]);
  const [llmSaving, setLlmSaving] = useState(false);
  const [testingIdx, setTestingIdx] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [localLlm, setLocalLlm] = useState<LocalLlmStatus | null>(null);
  const [advLlmOpen, setAdvLlmOpen] = useState<Record<string, boolean>>({});

  // ASR state
  const [asr, setAsr] = useState<AsrConfig | null>(null);
  const asrSeqRef = useRef(0);
  const asrQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastSavedAsrRef = useRef<AsrConfig | null>(null);

  // Vocab & Voiceprint/RSI state
  const [vocab, setVocab] = useState<VocabData>({ hotwords: "", fixes: [] });
  const [newFixFrom, setNewFixFrom] = useState("");
  const [newFixTo, setNewFixTo] = useState("");
  const [vocabSaving, setVocabSaving] = useState(false);
  const [rsi, setRsi] = useState<RsiState | null>(null);
  const [advRsiOpen, setAdvRsiOpen] = useState(false);

  // Ambient config state
  const [ambCfg, setAmbCfg] = useState<AmbientConfig | null>(null);
  const [devices, setDevices] = useState<string[]>([]);
  const [storage, setStorage] = useState<AmbientStorage | null>(null);
  const [ambSaving, setAmbSaving] = useState(false);
  const [purgePreviewCount, setPurgePreviewCount] = useState<number | null>(null);

  // LAN + MCP state
  const [lan, setLan] = useState<LanStatus | null>(null);
  const [lanPw, setLanPw] = useState("");
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [lanPort, setLanPort] = useState("8771");
  const [lanEnabled, setLanEnabled] = useState(false);
  const [lanSaving, setLanSaving] = useState(false);
  const [mcp, setMcp] = useState<McpConfigResponse | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);

  const loadSection = useCallback(
    async (t: SettingsTab) => {
      const target = normalizeSettingsTab(t);
      try {
        if (target === "llm") {
          const [s, loc] = await Promise.all([
            refreshSettings(),
            api<LocalLlmStatus>("/api/llm/local").catch(() => null),
          ]);
          setActiveId(s.active);
          setProviders(s.providers.map((p) => ({ ...p, api_key_input: "" })));
          if (loc) setLocalLlm(loc);
        } else if (target === "asr") {
          const data = await api<AsrConfig>("/api/asr");
          lastSavedAsrRef.current = data;
          setAsr(data);
        } else if (target === "vocab") {
          const [vData, rData] = await Promise.all([api<VocabData>("/api/vocab"), api<RsiState>("/api/rsi")]);
          setVocab({ hotwords: vData.hotwords || "", fixes: vData.fixes || [] });
          setRsi(rData);
        } else if (target === "ambient") {
          const [amb, devs, stg, rData] = await Promise.all([
            api<{ cfg: AmbientConfig }>("/api/ambient"),
            api<{ devices?: string[] }>("/api/ambient/devices").catch(() => ({ devices: [] })),
            api<AmbientStorage>("/api/ambient/storage").catch(() => null),
            api<RsiState>("/api/rsi").catch(() => null),
          ]);
          setAmbCfg(amb.cfg);
          setDevices(Array.isArray(devs.devices) ? devs.devices : []);
          setStorage(stg);
          if (rData) setRsi(rData);
          setPurgePreviewCount(null);
        } else if (target === "lan") {
          const [lData, mData] = await Promise.all([
            api<LanStatus>("/api/lan"),
            api<McpConfigResponse>("/api/mcp/config").catch(() => null),
          ]);
          setLan(lData);
          setLanEnabled(lData.enabled);
          setLanPort(String(lData.port || 8771));
          setLanPw("");
          setMcp(mData);
        }
      } catch (err) {
        pushToast(err instanceof Error ? err.message : "读取设置失败", 4000);
      }
    },
    [pushToast, refreshSettings],
  );

  useEffect(() => {
    if (open) setTab(normalizeSettingsTab(settingsTab));
  }, [open, settingsTab]);

  useEffect(() => {
    if (!open) return;
    void loadSection(tab);
  }, [open, tab, loadSection]);

  const saveLlmSettings = async () => {
    setLlmSaving(true);
    try {
      const activeIndex = Math.max(
        0,
        providers.findIndex((p) => p.id === activeId),
      );
      const payload = {
        active: activeId,
        active_index: activeIndex,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          base_url: p.base_url,
          model: p.model,
          env_key: p.env_key || "",
          max_input_chars: p.max_input_chars || 60000,
          extra_body: p.extra_body || {},
          api_key: p.api_key_input?.trim() ? p.api_key_input.trim() : "",
          keep_key: !p.api_key_input?.trim(),
        })),
      };
      await api("/api/settings", { method: "PUT", body: payload });
      const fresh = await refreshSettings();
      setActiveId(fresh.active);
      setProviders(fresh.providers.map((p) => ({ ...p, api_key_input: "" })));
      pushToast("AI 模型配置已保存", { tone: "success" });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", { tone: "error", durationMs: 5000 });
    } finally {
      setLlmSaving(false);
    }
  };

  const testProvider = async (p: EditableProvider, idx: number) => {
    setTestingIdx(idx);
    try {
      const draftBody: Record<string, unknown> = {
        id: p.id,
        name: p.name,
        base_url: p.base_url,
        model: p.model,
        extra_body: p.extra_body || {},
      };
      if (p.api_key_input?.trim()) {
        draftBody.api_key = p.api_key_input.trim();
      }
      const r = await api<{ ok: boolean; msg?: string }>("/api/settings/test", {
        method: "POST",
        body: draftBody,
        timeout: 25000,
      });
      setTestResults((prev) => ({
        ...prev,
        [p.id]: {
          ok: Boolean(r.ok),
          text: r.ok ? `连接正常${r.msg ? `：${r.msg}` : ""}` : `连接失败：${r.msg || "请检查接口配置"}`,
        },
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [p.id]: {
          ok: false,
          text: `连接失败：${err instanceof Error ? err.message : "请求错误"}`,
        },
      }));
    } finally {
      setTestingIdx(null);
    }
  };

  const saveAsrImmediate = (next: AsrConfig) => {
    const seq = ++asrSeqRef.current;
    setAsr(next);
    asrQueueRef.current = asrQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const updated = await api<AsrConfig>("/api/asr", {
            method: "PUT",
            body: {
              model: next.model,
              diarizer: next.diarizer,
              doubao_ddc: next.doubao_ddc,
            },
          });
          lastSavedAsrRef.current = updated;
          if (seq === asrSeqRef.current) {
            setAsr(updated);
            void refreshHealth();
            pushToast("识别引擎设置已更新", { tone: "success", durationMs: 2000 });
          }
        } catch (err) {
          if (seq === asrSeqRef.current) {
            if (lastSavedAsrRef.current) {
              setAsr(lastSavedAsrRef.current);
            }
            pushToast(err instanceof Error ? err.message : "保存失败", { tone: "error", durationMs: 4000 });
          }
        }
      });
    return asrQueueRef.current;
  };

  const saveVocab = async (next: VocabData = vocab, silent = false) => {
    setVocabSaving(true);
    try {
      const saved = await api<VocabData>("/api/vocab", { method: "PUT", body: next });
      setVocab(saved);
      if (!silent) pushToast("词库与纠错规则已保存", { tone: "success" });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", { tone: "error", durationMs: 4000 });
    } finally {
      setVocabSaving(false);
    }
  };

  const saveAmbient = async (skipPurgeCheck = false) => {
    if (!ambCfg) return;
    setAmbSaving(true);
    try {
      const prevDays = storage?.keep_days ?? ambCfg.audio_keep_days;
      if (!skipPurgeCheck && ambCfg.audio_keep_days > 0 && ambCfg.audio_keep_days < prevDays) {
        const preview = await api<{ count: number }>(
          `/api/ambient/purge-preview?days=${ambCfg.audio_keep_days}`,
        ).catch(() => ({ count: 0 }));
        if (preview.count > 0) {
          setPurgePreviewCount(preview.count);
          setAmbSaving(false);
          return;
        }
      }
      setPurgePreviewCount(null);
      await api("/api/ambient/config", { method: "PUT", body: ambCfg });
      pushToast("全天模式设置已保存", { tone: "success" });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "保存失败", { tone: "error", durationMs: 5000 });
    } finally {
      setAmbSaving(false);
    }
  };

  const saveLan = async (overrides?: { enabled?: boolean }) => {
    setLanSaving(true);
    try {
      const updated = await api<LanStatus & { generated_password?: string }>("/api/lan", {
        method: "PUT",
        body: {
          enabled: overrides?.enabled ?? lanEnabled,
          port: Number(lanPort) || 8771,
          ...(lanPw.trim() ? { password: lanPw.trim() } : {}),
        },
      });
      setLan(updated);
      setLanEnabled(updated.enabled);
      setLanPort(String(updated.port || 8771));
      setLanPw("");
      if (updated.generated_password) {
        setGeneratedPin(updated.generated_password);
      } else if (!updated.enabled) {
        setGeneratedPin(null);
      }
      pushToast(updated.enabled ? "多端访问设置已更新" : "多端访问已关闭", { tone: "success" });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "更新失败", { tone: "error", durationMs: 5000 });
    } finally {
      setLanSaving(false);
    }
  };

  const isDoubaoSelected = Boolean(asr && /doubao/i.test(asr.model));

  return (
    <ModalShell
      open={open}
      onClose={() => setOpen(false)}
      label="设置"
      maxWidthClass="max-w-4xl"
      backdropClassName="bg-[var(--backdrop)] backdrop-blur-[4px]"
      panelClassName="h-[85vh] max-h-[calc(100vh-32px)] rounded-[20px] bg-[var(--surface-elev)] shadow-[var(--shadow-3)] flex flex-col sm:flex-row"
    >
      <nav
        aria-label="设置分类"
        className="w-full sm:w-52 shrink-0 border-b sm:border-b-0 sm:border-r border-[var(--line-2)] bg-[var(--sidebar-bg)] p-3 flex flex-row sm:flex-col gap-1 overflow-x-auto"
      >
        <h2
          id="settingsModalTitle"
          className="hidden sm:block text-base leading-[24px] font-semibold text-[var(--text)] px-3 pt-1.5 pb-2.5 m-0"
        >
          设置
        </h2>
        {NAV_TABS.map((it) => {
          const Icon = it.icon;
          const active = tab === it.id;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setTab(it.id)}
              className={`h-9 rounded-[10px] px-3 text-sm leading-[22px] flex items-center gap-2.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 ${
                active
                  ? "bg-[var(--fill-hover)] text-[var(--text)] font-medium"
                  : "text-[var(--text-2)] hover:bg-[var(--fill)] hover:text-[var(--text)]"
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${active ? "text-[var(--text)]" : "text-[var(--muted)]"}`} />
              <span>{it.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="h-14 px-6 border-b border-[var(--line-2)] flex items-center justify-between gap-3 shrink-0">
          <span className="text-base leading-[24px] font-semibold text-[var(--text)] whitespace-nowrap truncate">
            {NAV_TABS.find((t) => t.id === tab)?.label}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭设置"
            className="btn-ghost rounded-[8px] w-8 h-8 flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm leading-[22px] text-[var(--text)]">
          {tab === "llm" && (
            <>
              {localLlm?.script && (
                <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm leading-[22px] font-semibold text-[var(--text)]">
                      本机离线大模型服务
                    </div>
                    <div className="text-[13px] leading-[20px] text-[var(--text-2)] mt-0.5 num">
                      {localLlm.running ? `运行中 · ${localLlm.url}` : "未启动（生成纪要时会自动拉起）"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void api("/api/llm/local", {
                        method: "POST",
                        body: { action: localLlm.running ? "stop" : "start" },
                      })
                        .then(() => loadSection("llm"))
                        .catch((e) => pushToast(String(e), 4000));
                    }}
                    className={BTN_SECONDARY_SM}
                  >
                    {localLlm.running ? "停止" : "启动"}
                  </button>
                </div>
              )}

              <div className="space-y-4">
                {providers.map((p, idx) => {
                  const testRes = testResults[p.id];
                  const advOpen = Boolean(advLlmOpen[p.id]);
                  return (
                    <div
                      key={`${p.id}-${idx}`}
                      className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3.5"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <label className="inline-flex items-center gap-2.5 min-w-0 text-sm leading-[22px] font-semibold text-[var(--text)] cursor-pointer">
                          <input
                            type="radio"
                            name="activeProvRadio"
                            checked={activeId === p.id}
                            onChange={() => setActiveId(p.id)}
                            className="accent-[var(--ink)] w-4 h-4 shrink-0 cursor-pointer"
                          />
                          <span className="truncate">{p.name || "未命名接口"}</span>
                          {activeId === p.id && (
                            <span className="rounded-full bg-[var(--fill)] text-[var(--text-2)] px-2.5 py-0.5 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0">
                              当前默认
                            </span>
                          )}
                        </label>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={testingIdx === idx}
                            onClick={() => void testProvider(p, idx)}
                            className={BTN_BRAND_SOFT}
                          >
                            {testingIdx === idx ? "测试中…" : "测试连接"}
                          </button>
                          {providers.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const removed = p;
                                const removedIdx = idx;
                                setProviders((prev) => prev.filter((_, i) => i !== idx));
                                pushToast(`已移除「${removed.name}」`, {
                                  durationMs: 4500,
                                  action: {
                                    label: "撤销",
                                    onClick: () =>
                                      setProviders((prev) => {
                                        const next = [...prev];
                                        next.splice(removedIdx, 0, removed);
                                        return next;
                                      }),
                                  },
                                });
                              }}
                              aria-label={`删除 ${p.name}`}
                              className="btn-ghost btn-danger rounded-[8px] w-8 h-8 flex items-center justify-center shrink-0 cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      {testRes && (
                        <div
                          className={`text-[13px] leading-[20px] rounded-[8px] px-3 py-2 ${
                            testRes.ok
                              ? "bg-[var(--ok-soft)] text-[var(--ok)]"
                              : "bg-[var(--danger-soft)] text-[var(--danger)]"
                          }`}
                        >
                          {testRes.text}
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        <div>
                          <label htmlFor={`prov-name-${idx}`} className={FIELD_LABEL}>
                            显示名称
                          </label>
                          <input
                            id={`prov-name-${idx}`}
                            type="text"
                            value={p.name}
                            onChange={(e) =>
                              setProviders((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)),
                              )
                            }
                            aria-label="接口名称"
                            className={`w-full ${FIELD_INPUT}`}
                          />
                        </div>
                        <div>
                          <label htmlFor={`prov-model-${idx}`} className={FIELD_LABEL}>
                            模型名称
                          </label>
                          <input
                            id={`prov-model-${idx}`}
                            type="text"
                            value={p.model}
                            onChange={(e) =>
                              setProviders((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, model: e.target.value } : x)),
                              )
                            }
                            aria-label="模型标识"
                            className={`w-full ${FIELD_INPUT} font-mono`}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label htmlFor={`prov-url-${idx}`} className={FIELD_LABEL}>
                            接口地址{" "}
                            <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                              （OpenAI 兼容地址）
                            </span>
                          </label>
                          <input
                            id={`prov-url-${idx}`}
                            type="text"
                            value={p.base_url}
                            onChange={(e) => {
                              const nextUrl = e.target.value;
                              const detected = detectPresetName(nextUrl);
                              setProviders((prev) =>
                                prev.map((x, i) => {
                                  if (i !== idx) return x;
                                  const nextName =
                                    (!x.name || x.name === "自定义接口") && detected ? detected : x.name;
                                  return { ...x, base_url: nextUrl, name: nextName };
                                }),
                              );
                            }}
                            aria-label="Base URL"
                            className={`w-full ${FIELD_INPUT} font-mono`}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label htmlFor={`prov-key-${idx}`} className={FIELD_LABEL}>
                            API 密钥
                            {(p.api_key_masked || p.api_key_from_env) && (
                              <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                                {p.api_key_masked
                                  ? `（当前：${p.api_key_masked}，留空保留）`
                                  : "（已从环境变量读取）"}
                              </span>
                            )}
                          </label>
                          <input
                            id={`prov-key-${idx}`}
                            type="password"
                            value={p.api_key_input || ""}
                            onChange={(e) =>
                              setProviders((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, api_key_input: e.target.value } : x)),
                              )
                            }
                            placeholder={p.api_key_masked ? "留空保持原密钥不变" : "sk-..."}
                            aria-label="API Key"
                            className={`w-full ${FIELD_INPUT} font-mono`}
                          />
                        </div>
                      </div>

                      <div className="pt-0.5">
                        <button
                          type="button"
                          onClick={() => setAdvLlmOpen((m) => ({ ...m, [p.id]: !advOpen }))}
                          aria-expanded={advOpen}
                          className="btn-ghost rounded-[8px] h-7 px-2 text-xs leading-[18px] text-[var(--muted)] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>高级参数</span>
                          <ChevronDown
                            className={`w-3.5 h-3.5 transition-transform duration-200 ${advOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                        <Disclosure open={advOpen} contentClassName="pt-2.5">
                          <label htmlFor={`prov-max-${idx}`} className={FIELD_LABEL}>
                            单次最大发送字数
                          </label>
                          <input
                            id={`prov-max-${idx}`}
                            type="number"
                            min={4000}
                            value={p.max_input_chars || 60000}
                            onChange={(e) =>
                              setProviders((prev) =>
                                prev.map((x, i) =>
                                  i === idx ? { ...x, max_input_chars: Number(e.target.value) || 60000 } : x,
                                ),
                              )
                            }
                            aria-label="输入字符上限"
                            className={`w-48 ${FIELD_INPUT} font-mono num`}
                          />
                        </Disclosure>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs leading-[18px] text-[var(--muted)] whitespace-nowrap shrink-0 mr-0.5">
                    快速模板：
                  </span>
                  {LLM_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() =>
                        setProviders((prev) => [
                          ...prev,
                          {
                            id: `preset_${Date.now()}`,
                            name: preset.name,
                            base_url: preset.base_url,
                            model: preset.model,
                            max_input_chars: 60000,
                            extra_body: {},
                            api_key_input: "",
                          },
                        ])
                      }
                      className="btn-ghost rounded-[8px] h-7 px-2.5 text-xs leading-[18px] text-[var(--text-2)] hover:text-[var(--text)] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      +{preset.name}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-[var(--line-2)]">
                  <button
                    type="button"
                    onClick={() =>
                      setProviders((prev) => [
                        ...prev,
                        {
                          id: `custom_${Date.now()}`,
                          name: "自定义接口",
                          base_url: "https://api.openai.com/v1",
                          model: "gpt-4o-mini",
                          max_input_chars: 60000,
                          extra_body: {},
                          api_key_input: "",
                        },
                      ])
                    }
                    className={BTN_SECONDARY_MD}
                  >
                    <Plus className="w-4 h-4 shrink-0" /> 添加接口
                  </button>
                  <div className="flex items-center gap-2 ml-auto shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        void api("/api/settings/restore-providers", { method: "POST" })
                          .then(() => {
                            pushToast("已补回缺失的默认接口模板", { tone: "success" });
                            return loadSection("llm");
                          })
                          .catch((e) => pushToast(String(e), 4000));
                      }}
                      className="btn-ghost rounded-[10px] h-9 px-3 text-sm leading-[22px] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      补回默认
                    </button>
                    <button
                      type="button"
                      disabled={llmSaving}
                      onClick={() => void saveLlmSettings()}
                      className={BTN_BRAND}
                    >
                      {llmSaving ? "保存中…" : "保存 AI 配置"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === "asr" && asr && (
            <div className="space-y-5 max-w-xl">
              <div>
                <label htmlFor="asrModelSel" className={FIELD_LABEL}>
                  语音识别引擎{" "}
                  <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                    （切换后自动生效）
                  </span>
                </label>
                <select
                  id="asrModelSel"
                  value={asr.model}
                  onChange={(e) => void saveAsrImmediate({ ...asr, model: e.target.value })}
                  className={`w-full ${FIELD_INPUT}`}
                >
                  {Object.entries(asr.options).map(([k, lbl]) => (
                    <option key={k} value={k}>
                      {lbl}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="asrDiarSel" className={FIELD_LABEL}>
                  说话人区分方式
                </label>
                <select
                  id="asrDiarSel"
                  value={asr.diarizer}
                  onChange={(e) => void saveAsrImmediate({ ...asr, diarizer: e.target.value })}
                  className={`w-full ${FIELD_INPUT}`}
                >
                  {Object.entries(asr.diarizers).map(([k, lbl]) => (
                    <option key={k} value={k}>
                      {lbl}
                    </option>
                  ))}
                </select>
              </div>

              {isDoubaoSelected && (
                <label className="flex items-center gap-2.5 text-sm leading-[22px] text-[var(--text)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={asr.doubao_ddc}
                    onChange={(e) => void saveAsrImmediate({ ...asr, doubao_ddc: e.target.checked })}
                  />
                  <span>开启语义顺滑（自动去除口语重复与语气词）</span>
                </label>
              )}

              {asr.nano_error && (
                <div className="rounded-[10px] bg-[var(--danger-soft)] text-[var(--danger)] px-3.5 py-2.5 text-[13px] leading-[20px]">
                  语音识别模型状态异常：{asr.nano_error}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    void api("/api/asr/reload", { method: "POST" }).then(() =>
                      pushToast("已开始重新加载本机识别模型", { tone: "success" }),
                    );
                  }}
                  className={BTN_SECONDARY_MD}
                >
                  <RefreshCw className="w-4 h-4" /> 重新加载识别模型
                </button>
              </div>
            </div>
          )}

          {tab === "vocab" && (
            <div className="space-y-6">
              <div className="space-y-5">
                <div>
                  <label htmlFor="vocabHotInp" className={FIELD_LABEL}>
                    常用热词
                  </label>
                  <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0 mb-2">
                    人名、项目代号、专有缩写，使用空格或逗号分隔。
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <textarea
                      id="vocabHotInp"
                      value={vocab.hotwords}
                      onChange={(e) => setVocab({ ...vocab, hotwords: e.target.value })}
                      onBlur={() => void saveVocab(vocab, true)}
                      rows={2}
                      placeholder="例如：张伟 季度复盘 OKR"
                      className={`flex-1 ${FIELD_TEXTAREA}`}
                    />
                    <button
                      type="button"
                      disabled={vocabSaving}
                      onClick={() => void saveVocab()}
                      className={`${BTN_BRAND} self-end shrink-0`}
                    >
                      {vocabSaving ? "保存中…" : "保存热词"}
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div>
                    <div className="text-sm leading-[22px] font-medium text-[var(--text)]">
                      自动纠错词表{" "}
                      <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                        （改动后立即生效）
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newFixFrom}
                      onChange={(e) => setNewFixFrom(e.target.value)}
                      placeholder="易听错词"
                      aria-label="错误词"
                      className={`flex-1 ${FIELD_INPUT}`}
                    />
                    <span className="text-[var(--muted)]">→</span>
                    <input
                      type="text"
                      value={newFixTo}
                      onChange={(e) => setNewFixTo(e.target.value)}
                      placeholder="正确写法"
                      aria-label="正确词"
                      className={`flex-1 ${FIELD_INPUT}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const a = newFixFrom.trim();
                        const b = newFixTo.trim();
                        if (!a || a === b) return;
                        const next = { ...vocab, fixes: [{ from: a, to: b }, ...vocab.fixes] };
                        setNewFixFrom("");
                        setNewFixTo("");
                        void saveVocab(next);
                      }}
                      className={`${BTN_SECONDARY_MD} shrink-0`}
                    >
                      添加
                    </button>
                  </div>

                  <div className="max-h-52 overflow-y-auto divide-y divide-[var(--line-2)] border border-[var(--line)] rounded-[12px] bg-[var(--surface)]">
                    {!vocab.fixes.length ? (
                      <div className="p-5 text-center text-[13px] leading-[20px] text-[var(--muted)]">
                        暂无纠错规则
                      </div>
                    ) : (
                      vocab.fixes.map((f, idx) => (
                        <div
                          key={`${f.from}-${idx}`}
                          className="px-3.5 py-2.5 flex items-center justify-between gap-2 text-sm leading-[22px]"
                        >
                          <span>
                            <span className="text-[var(--text-2)]">{f.from}</span> →{" "}
                            <span className="font-semibold text-[var(--text)]">{f.to}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const prev = vocab;
                              const next = { ...vocab, fixes: vocab.fixes.filter((_, i) => i !== idx) };
                              void saveVocab(next, true).then(() => {
                                pushToast(`已删除「${f.from} → ${f.to}」`, {
                                  durationMs: 4500,
                                  action: {
                                    label: "撤销",
                                    onClick: () => void saveVocab(prev, true),
                                  },
                                });
                              });
                            }}
                            aria-label={`删除规则 ${f.from}`}
                            className="btn-ghost btn-danger rounded-[6px] w-7 h-7 flex items-center justify-center shrink-0 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {rsi && (
                <div className="space-y-5 pt-5 border-t border-[var(--line-2)]">
                  <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3.5 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4">
                    <label className="flex items-center gap-2.5 text-sm leading-[22px] text-[var(--text)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!rsi.config.paused}
                        onChange={(e) => {
                          void api("/api/rsi/config", {
                            method: "PUT",
                            body: { paused: !e.target.checked },
                          }).then(() => loadSection("vocab"));
                        }}
                      />
                      <span>根据改名与纠错记录持续优化识别</span>
                    </label>

                    <label className="flex items-center gap-2.5 text-sm leading-[22px] text-[var(--text)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(rsi.config.auto_name)}
                        onChange={(e) => {
                          void api("/api/rsi/config", {
                            method: "PUT",
                            body: { auto_name: e.target.checked },
                          }).then(() => loadSection("vocab"));
                        }}
                      />
                      <span>高把握声纹自动填入发言人姓名</span>
                    </label>
                  </div>

                  <section className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[15px] leading-[22px] font-semibold text-[var(--text)] num">
                        已建立的声纹档案（{rsi.voiceprints?.persons?.length || 0} 人）
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          useAppStore.getState().setVpWizardOpen(true);
                        }}
                        className={BTN_BRAND_SOFT}
                      >
                        批量认人
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(rsi.voiceprints?.persons || []).length === 0 ? (
                        <span className="text-[13px] leading-[20px] text-[var(--text-2)]">
                          暂无已入库声纹，给会议说话人改名后会自动建立
                        </span>
                      ) : (
                        (rsi.voiceprints?.persons || []).map((p) => (
                          <span
                            key={p.name}
                            className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 py-1 text-[13px] leading-[20px] text-[var(--text)] num"
                          >
                            <span>
                              {p.name} · {p.sessions ?? 0} 场 · {fmtDur(p.voiced_s ?? 0)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                void api(`/api/rsi/voiceprints/${encodeURIComponent(p.name)}`, {
                                  method: "DELETE",
                                }).then(() => {
                                  pushToast(`已删除「${p.name}」的声纹记录`);
                                  return loadSection("vocab");
                                });
                              }}
                              aria-label={`删除声纹 ${p.name}`}
                              className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                  </section>

                  {(rsi.vocab?.candidates?.length || 0) > 0 && (
                    <section className="space-y-2.5">
                      <div className="text-[15px] leading-[22px] font-semibold text-[var(--text)]">
                        发现的候选纠错词
                      </div>
                      <div className="space-y-2">
                        {(rsi.vocab?.candidates || []).map((c) => (
                          <div
                            key={`${c.from}-${c.to}`}
                            className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 flex items-center justify-between gap-3 text-sm leading-[22px]"
                          >
                            <span className="num">
                              <span className="text-[var(--text-2)]">{c.from}</span> →{" "}
                              <span className="font-semibold text-[var(--text)]">{c.to}</span>（{c.count ?? 1}{" "}
                              次）
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  void api("/api/rsi/vocab/candidate/accept", {
                                    method: "POST",
                                    body: { from: c.from, to: c.to, hotword: true },
                                  }).then(() => loadSection("vocab"));
                                }}
                                className="h-7 rounded-[8px] px-2.5 text-xs leading-[18px] font-medium bg-[var(--fill)] hover:bg-[var(--fill-hover)] text-[var(--text)] whitespace-nowrap shrink-0 transition-colors cursor-pointer"
                              >
                                采纳规则
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void api("/api/rsi/vocab/candidate/dismiss", {
                                    method: "POST",
                                    body: { from: c.from, to: c.to },
                                  }).then(() => loadSection("vocab"));
                                }}
                                className="btn-ghost h-7 rounded-[8px] px-2.5 text-xs leading-[18px] whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                忽略
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  <div>
                    <button
                      type="button"
                      onClick={() => setAdvRsiOpen((v) => !v)}
                      aria-expanded={advRsiOpen}
                      className="btn-ghost rounded-[8px] h-7 px-2 text-xs leading-[18px] text-[var(--muted)] inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <span>数据清理与重置</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform duration-200 ${advRsiOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    <Disclosure open={advRsiOpen} contentClassName="pt-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-3.5">
                        <span className="text-[13px] leading-[20px] text-[var(--text-2)]">
                          清空本机所有已学习的声纹档案与词库习惯
                        </span>
                        <InlineConfirm
                          triggerLabel="重置全部学习数据"
                          triggerClassName="btn-secondary btn-danger rounded-[8px] h-8 px-3 text-[13px] leading-[20px] font-medium whitespace-nowrap shrink-0"
                          message="确定清空所有声纹档案、识别阈值和词库学习记录吗？此操作无法撤销。"
                          confirmLabel="确认清空"
                          onConfirm={async () => {
                            await api("/api/rsi/reset", { method: "POST", body: { scope: "all" } });
                            pushToast("已重置全部自学习状态", { tone: "success" });
                            await loadSection("vocab");
                          }}
                        />
                      </div>
                    </Disclosure>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "ambient" && ambCfg && (
            <div className="space-y-5 max-w-2xl">
              {rsi?.ambient?.advice?.warning && (
                <div className="rounded-[12px] bg-[var(--warn-soft)] text-[var(--warn)] p-3.5 flex flex-wrap items-center justify-between gap-3 text-[13px] leading-[20px]">
                  <span>
                    {rsi.ambient.advice.warning}
                    {rsi.ambient.advice.reason ? `（${rsi.ambient.advice.reason}）` : ""}
                  </span>
                  {typeof rsi.ambient.advice.suggested_min_speech_s === "number" && (
                    <button
                      type="button"
                      onClick={() => {
                        const suggested = rsi.ambient?.advice?.suggested_min_speech_s;
                        if (typeof suggested !== "number") return;
                        setAmbCfg((cur) => (cur ? { ...cur, min_speech_s: suggested } : cur));
                        pushToast(`已将最短保留时长设为 ${suggested} 秒，点击保存生效`);
                      }}
                      className="btn-secondary rounded-[8px] h-8 px-3 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      采用建议
                    </button>
                  )}
                </div>
              )}

              {storage && (
                <div className="rounded-[12px] bg-[var(--surface-2)] px-4 py-3 text-[13px] leading-[20px] text-[var(--text-2)] num">
                  过去 {storage.days} 天日均空间：跳过静音约 {storage.skip_h_day} 小时/天（
                  {storage.skip_mb_day} MB/天）
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="ambDevSel" className={FIELD_LABEL}>
                    监听麦克风设备
                  </label>
                  <select
                    id="ambDevSel"
                    value={ambCfg.device}
                    onChange={(e) => setAmbCfg({ ...ambCfg, device: e.target.value })}
                    className={`w-full ${FIELD_INPUT}`}
                  >
                    <option value="">系统默认输入</option>
                    {devices.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="ambSensSel" className={FIELD_LABEL}>
                    收音灵敏度
                  </label>
                  <select
                    id="ambSensSel"
                    value={ambCfg.sensitivity}
                    onChange={(e) => setAmbCfg({ ...ambCfg, sensitivity: e.target.value })}
                    className={`w-full ${FIELD_INPUT}`}
                  >
                    <option value="normal">标准（嘈杂办公环境，优先防误触）</option>
                    <option value="high">高（安静房间，远场小声也拾音）</option>
                    <option value="max">很高（再远也录，杂音也会进来）</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="ambSplitMin" className={FIELD_LABEL}>
                    静音多久后自动分段{" "}
                    <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">（分钟）</span>
                  </label>
                  <input
                    id="ambSplitMin"
                    type="number"
                    min={1}
                    max={60}
                    value={ambCfg.split_min}
                    onChange={(e) => setAmbCfg({ ...ambCfg, split_min: Number(e.target.value) || 5 })}
                    className={`w-full ${FIELD_INPUT} num`}
                  />
                </div>

                <div>
                  <label htmlFor="ambMinSpk" className={FIELD_LABEL}>
                    最短保留讲话时长{" "}
                    <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">（秒）</span>
                  </label>
                  <input
                    id="ambMinSpk"
                    type="number"
                    min={0}
                    max={600}
                    value={ambCfg.min_speech_s}
                    onChange={(e) => setAmbCfg({ ...ambCfg, min_speech_s: Number(e.target.value) || 0 })}
                    className={`w-full ${FIELD_INPUT} num`}
                  />
                </div>

                <div>
                  <label htmlFor="ambKeepDays" className={FIELD_LABEL}>
                    全天录音保留天数{" "}
                    <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                      （0 = 永久）
                    </span>
                  </label>
                  <input
                    id="ambKeepDays"
                    type="number"
                    min={0}
                    max={3650}
                    value={ambCfg.audio_keep_days}
                    onChange={(e) => {
                      setPurgePreviewCount(null);
                      setAmbCfg({ ...ambCfg, audio_keep_days: Number(e.target.value) || 0 });
                    }}
                    className={`w-full ${FIELD_INPUT} num`}
                  />
                </div>

                <div>
                  <label htmlFor="ambSumTime" className={FIELD_LABEL}>
                    每日自动日报时间
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="ambSumTime"
                      type="time"
                      value={ambCfg.summary_time}
                      onChange={(e) => setAmbCfg({ ...ambCfg, summary_time: e.target.value })}
                      className={`flex-1 ${FIELD_INPUT} font-mono num`}
                    />
                    {ambCfg.summary_time && (
                      <button
                        type="button"
                        onClick={() => setAmbCfg({ ...ambCfg, summary_time: "" })}
                        aria-label="关闭每日自动日报"
                        className="btn-ghost rounded-[8px] h-9 px-2.5 text-xs leading-[18px] whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        关闭
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2.5">
                <label className="flex items-center gap-2.5 text-sm leading-[22px] text-[var(--text)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ambCfg.keep_awake}
                    onChange={(e) => setAmbCfg({ ...ambCfg, keep_awake: e.target.checked })}
                  />
                  <span>开启全天模式时阻止电脑自动休眠</span>
                </label>
                <label className="flex items-center gap-2.5 text-sm leading-[22px] text-[var(--text)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ambCfg.keep_silence}
                    onChange={(e) => setAmbCfg({ ...ambCfg, keep_silence: e.target.checked })}
                  />
                  <span>录音文件保留无人说话时的空白停顿（体积更大）</span>
                </label>
              </div>

              {purgePreviewCount !== null && purgePreviewCount > 0 && (
                <div className="rounded-[12px] bg-[var(--danger-soft)] text-[var(--danger)] p-3.5 flex flex-wrap items-center justify-between gap-3 text-[13px] leading-[20px]">
                  <span className="num">
                    缩短保留天数后，将清理 {purgePreviewCount} 条早于 {ambCfg.audio_keep_days}{" "}
                    天前的音频文件（转写与纪要保留）。
                  </span>
                  <div className="flex gap-2 ml-auto shrink-0">
                    <button
                      type="button"
                      onClick={() => setPurgePreviewCount(null)}
                      className="btn-secondary rounded-[8px] h-8 px-3 text-xs leading-[18px] font-medium whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveAmbient(true)}
                      className="rounded-[8px] h-8 px-3 text-xs leading-[18px] font-medium bg-[var(--danger)] hover:opacity-90 text-white whitespace-nowrap shrink-0 cursor-pointer transition-opacity"
                    >
                      确认清理并保存
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  disabled={ambSaving}
                  onClick={() => void saveAmbient(false)}
                  className={BTN_BRAND}
                >
                  {ambSaving ? "保存中…" : "保存全天模式设置"}
                </button>
              </div>
            </div>
          )}

          {tab === "lan" && lan && (
            <div className="space-y-5 max-w-2xl">
              <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-4 space-y-4">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="text-sm leading-[22px] font-semibold text-[var(--text)]">
                    允许同一 Wi-Fi 下手机 / iPad 访问
                  </span>
                  <input
                    type="checkbox"
                    checked={lanEnabled}
                    onChange={(e) => {
                      const nextOn = e.target.checked;
                      setLanEnabled(nextOn);
                      void saveLan({ enabled: nextOn });
                    }}
                  />
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label htmlFor="lanPortInp" className={FIELD_LABEL}>
                      HTTPS 端口{" "}
                      <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                        （默认 8771）
                      </span>
                    </label>
                    <input
                      id="lanPortInp"
                      type="number"
                      value={lanPort}
                      onChange={(e) => setLanPort(e.target.value)}
                      className={`w-full ${FIELD_INPUT} font-mono num`}
                    />
                  </div>
                  <div>
                    <label htmlFor="lanPwInp" className={FIELD_LABEL}>
                      访问口令{" "}
                      <span className="text-xs leading-[18px] font-normal text-[var(--muted)]">
                        {lan.has_password ? "（已设，留空不改）" : "（留空自动生成 6 位口令）"}
                      </span>
                    </label>
                    <input
                      id="lanPwInp"
                      type="password"
                      value={lanPw}
                      onChange={(e) => setLanPw(e.target.value)}
                      placeholder={lan.has_password ? "留空保持原口令" : "可选：输入 6 位以上口令"}
                      className={`w-full ${FIELD_INPUT}`}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <span className="text-xs leading-[18px] text-[var(--muted)]">
                    {lan.running ? "服务运行中" : "未启动"}
                    {lan.error ? ` · ${lan.error}` : ""}
                  </span>
                  <div className="flex items-center gap-2 ml-auto shrink-0">
                    {lan.running && (
                      <button
                        type="button"
                        onClick={() => {
                          void api("/api/lan/logout-all", { method: "POST" }).then(() =>
                            pushToast("已下线所有手机/平板登录态"),
                          );
                        }}
                        className={BTN_SECONDARY_MD}
                      >
                        踢出已登录设备
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={lanSaving}
                      onClick={() => void saveLan()}
                      className={BTN_BRAND}
                    >
                      {lanSaving ? "应用中…" : "保存并应用"}
                    </button>
                  </div>
                </div>

                {generatedPin && (
                  <div className="rounded-[10px] bg-[var(--ok-soft)] text-[var(--ok)] px-3.5 py-2.5 flex items-center justify-between gap-3 text-[13px] leading-[20px]">
                    <span>
                      已自动生成一次性显示访问口令：
                      <strong className="font-mono num text-sm font-semibold">{generatedPin}</strong>
                    </span>
                    <CopyButton text={generatedPin} label="复制口令" successToast="已复制访问口令" />
                  </div>
                )}
              </div>

              {lan.urls.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {lan.urls.map((u) => (
                    <div
                      key={u.url}
                      className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 flex flex-col items-center text-center gap-2.5"
                    >
                      {u.qr && (
                        <div className="bg-white p-2 rounded-[10px]">
                          <img src={qrDataUri(u.qr)} alt={`${u.label} 二维码`} className="w-28 h-28 block" />
                        </div>
                      )}
                      <div className="font-mono text-xs leading-[18px] text-[var(--text)] break-all">
                        {u.url}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs leading-[18px] text-[var(--muted)]">{u.label}</span>
                        <CopyButton text={u.url} label="复制地址" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {lan.ca_sha256 && (
                <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm leading-[22px] font-medium text-[var(--text)]">
                      iPhone / iPad 证书描述文件
                    </div>
                    <div className="text-xs leading-[18px] text-[var(--muted)] font-mono truncate max-w-xs mt-0.5">
                      SHA-256: {lan.ca_sha256}
                    </div>
                  </div>
                  <a
                    href="/lan/ca.cer"
                    download="meeting-notes-ca.cer"
                    className={`${BTN_SECONDARY_SM} no-underline shrink-0`}
                  >
                    下载 CA 证书
                  </a>
                </div>
              )}

              {mcp && (
                <div className="pt-3 border-t border-[var(--line-2)] space-y-2.5">
                  <button
                    type="button"
                    onClick={() => setMcpOpen((v) => !v)}
                    aria-expanded={mcpOpen}
                    className="btn-ghost rounded-[8px] h-8 px-2.5 text-sm leading-[22px] font-medium text-[var(--text)] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <span>AI 桌面客户端接入 (MCP)</span>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform duration-200 ${mcpOpen ? "rotate-180" : ""}`}
                    />
                  </button>

                  <Disclosure open={mcpOpen} contentClassName="space-y-3 pt-1">
                    <p className="text-[13px] leading-[20px] text-[var(--text-2)] m-0">
                      在 Claude Desktop、Cursor 等桌面助手里填入下面这段配置，即可直接检索和引用本机会议记录。
                    </p>
                    <div className="relative">
                      <CopyButton
                        text={JSON.stringify(mcp.config, null, 2)}
                        label="复制 JSON"
                        successToast="已复制 MCP 配置 JSON"
                        className="absolute right-3 top-3"
                      />
                      <pre className="rounded-[12px] bg-[var(--surface-2)] border border-[var(--line)] p-4 pr-24 text-xs leading-[18px] font-mono text-[var(--text-body)] overflow-x-auto m-0">
                        {JSON.stringify(mcp.config, null, 2)}
                      </pre>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {mcp.tools.map((t) => (
                        <code
                          key={t}
                          className="rounded-[6px] bg-[var(--fill)] px-2 py-0.5 text-xs leading-[18px] font-mono text-[var(--text-2)]"
                        >
                          {t}
                        </code>
                      ))}
                    </div>
                  </Disclosure>
                </div>
              )}
            </div>
          )}

          {tab === "about" && (
            <div className="space-y-4">
              <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-base leading-[24px] font-semibold text-[var(--text)]">
                    会议记录（Meeting Notes）
                  </div>
                  <div className="text-[13px] leading-[20px] text-[var(--text-2)] mt-1 num">
                    版本 v{updateStatus?.currentVersion || desktopInfo?.version || "0.1.0"} ·{" "}
                    {desktopInfo
                      ? `${desktopInfo.platform}/${desktopInfo.arch}`
                      : typeof navigator !== "undefined"
                        ? navigator.platform
                        : "Web"}{" "}
                    · {sidecarStatus?.mode === "standalone" ? "独立安装包" : "开发工作区模式"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (window.desktopAPI?.openReleasePage) {
                      void window.desktopAPI.openReleasePage(
                        "https://github.com/MrDgbot/meeting-notes/releases",
                      );
                    } else {
                      window.open("https://github.com/MrDgbot/meeting-notes/releases", "_blank");
                    }
                  }}
                  className={BTN_SECONDARY_SM}
                >
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>查看全部版本与日志</span>
                </button>
              </div>

              {window.desktopAPI && (
                <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm leading-[22px] font-semibold text-[var(--text)]">软件更新</div>
                      <div className="text-[13px] leading-[20px] text-[var(--text-2)] mt-0.5">
                        {updateStatus?.status === "downloaded"
                          ? `新版本 v${updateStatus.info?.version ?? ""} 已下载完成，重启即可安装`
                          : updateStatus?.status === "available"
                            ? `发现新版本 v${updateStatus.info?.version ?? ""}`
                            : updateStatus?.status === "downloading"
                              ? `正在下载更新… ${updateStatus.progress?.percent ?? 0}%`
                              : updateStatus?.status === "checking"
                                ? "正在检查是否有新版本…"
                                : updateStatus?.status === "not-available"
                                  ? "当前已是最新版本"
                                  : updateStatus?.status === "error"
                                    ? "检查更新时网络异常"
                                    : "保持桌面客户端与本地转写链路处于最新版本"}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={
                          updateStatus?.status === "checking" || updateStatus?.status === "downloading"
                        }
                        onClick={() => void window.desktopAPI?.checkForUpdates()}
                        className={`${BTN_SECONDARY_SM} disabled:opacity-60`}
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${updateStatus?.status === "checking" ? "animate-spin" : ""}`}
                          aria-hidden="true"
                        />
                        <span>{updateStatus?.status === "checking" ? "检查中…" : "检查更新"}</span>
                      </button>

                      {updateStatus?.status === "available" && (
                        <button
                          type="button"
                          onClick={() => void window.desktopAPI?.downloadUpdate()}
                          className={BTN_BRAND_SM}
                        >
                          <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{updateStatus.canAutoInstall ? "立即下载更新" : "前往下载新版"}</span>
                        </button>
                      )}

                      {updateStatus?.status === "downloaded" && (
                        <button
                          type="button"
                          onClick={() => void window.desktopAPI?.installUpdate()}
                          className={BTN_BRAND_SM}
                        >
                          <span>重启并安装更新</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {updateStatus?.status === "downloading" && updateStatus.progress && (
                    <div className="space-y-1.5">
                      <div className="w-full h-2 rounded-full bg-[var(--fill)] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--ink)] transition-[width] duration-200"
                          style={{ width: `${updateStatus.progress.percent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs leading-[18px] text-[var(--muted)] num">
                        <span>{updateStatus.progress.percent}%</span>
                        <span>
                          {Math.max(0, Math.round(updateStatus.progress.bytesPerSecond / 1024))} KB/s
                        </span>
                      </div>
                    </div>
                  )}

                  {updateStatus?.status === "error" && updateStatus.error && (
                    <div className="rounded-[10px] bg-[var(--danger-soft)] text-[var(--danger)] px-3.5 py-2.5 text-[13px] leading-[20px] break-words">
                      {updateStatus.error}
                    </div>
                  )}

                  {updateStatus?.info?.releaseNotes && (
                    <div className="rounded-[12px] bg-[var(--surface-2)] border border-[var(--line-2)] p-3.5 max-h-48 overflow-y-auto text-[13px] leading-[20px] whitespace-pre-wrap text-[var(--text-body)]">
                      {updateStatus.info.releaseNotes}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-4 pt-3 border-t border-[var(--line-2)]">
                    <div>
                      <div className="text-sm leading-[22px] font-medium text-[var(--text)]">
                        启动时自动检查更新
                      </div>
                      <div className="text-[13px] leading-[20px] text-[var(--text-2)] mt-0.5">
                        有新版本时在侧栏与托盘轻提示，不会在录音或转写过程中强行重启
                      </div>
                    </div>
                    <label className="ios-switch shrink-0" aria-label="启动时自动检查更新">
                      <input
                        type="checkbox"
                        checked={updateStatus?.autoCheck ?? true}
                        onChange={(e) => {
                          void window.desktopAPI?.setAutoCheckUpdates(e.target.checked);
                        }}
                      />
                      <i />
                    </label>
                  </div>
                </div>
              )}

              <div className="rounded-[12px] bg-[var(--surface-2)] p-4 text-[13px] leading-[20px] text-[var(--text-2)] space-y-1.5">
                <div>· 录音、VAD、FunASR / pyannote 声纹与实时转写均在本机完成，音频默认不上传云端。</div>
                <div>· 开源协议：GNU AGPL-3.0-or-later · GitHub: MrDgbot/meeting-notes</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
