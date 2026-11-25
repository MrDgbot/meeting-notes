export type MeetingStatus = "new" | "recording" | "queued" | "transcribing" | "ready" | "error";

export type MeetingSource = "" | "mic" | "upload" | "ambient";

export type ThemeMode = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export type GapReason = "hidden" | "interrupted" | "muted" | "overflow" | "stall";

export interface RecGap {
  at_ms: number;
  dur_ms: number;
  reason: GapReason | string;
}

export interface RecHealthEntry {
  rec: string;
  device?: string;
  started?: string;
  ended?: string | null;
  end?: string;
  start_bytes?: number;
  reconnects?: number;
  gaps?: RecGap[];
  produced?: number;
  dropped?: number;
  received?: number;
}

export interface SpeakerAutoMeta {
  name?: string;
  score?: number;
}

export interface SpeakerMergeHint {
  name: string;
  spks: number[];
}

export interface SpeakerMeta {
  auto?: Record<string, SpeakerAutoMeta>;
  suggest?: Record<string, { name: string; score?: number }>;
  merge_hints?: SpeakerMergeHint[];
}

export interface MeetingAsrMeta {
  engine?: string;
  cloud_failed?: string;
  nano_failed?: string;
  units?: number;
  failed?: number;
  local?: number;
}

export interface MeetingMeta {
  id: string;
  title: string;
  title_auto?: boolean;
  title_source?: string;
  brief?: string;
  tags?: string[];
  created: string;
  started_at?: string;
  ended_at?: string;
  status: MeetingStatus;
  source: MeetingSource;
  duration: number;
  speech_s?: number;
  num_spk: number;
  num_speakers?: number;
  chars?: number;
  hotword: string;
  template: string;
  speakers: Record<string, string>;
  speaker_meta?: SpeakerMeta;
  audio_channels?: number;
  rec_health?: RecHealthEntry[];
  asr?: MeetingAsrMeta;
  rsi_exclude?: boolean;
  error: string;
  filename?: string;
  clock_start?: string;
  clock_end?: string;
}

export interface TranscriptParagraph {
  start: number;
  end: number;
  spk: number;
  spks?: number[];
  text: string;
  edited?: boolean;
  orig_text?: string;
  ch?: number;
  _idx?: number;
}

export interface TranscriptData {
  asr?: string;
  cost?: number;
  paragraphs: TranscriptParagraph[];
}

export interface LiveSegment {
  start: number;
  end: number;
  text: string;
  ch?: number;
}

export interface MarkItem {
  id: string;
  t_ms: number;
  label: string;
  snippet?: string;
}

export interface HighlightItem {
  text: string;
  start_ms?: number | null;
  end_ms?: number | null;
  marked?: boolean;
}

export interface MinutesData {
  markdown: string;
  orig_markdown?: string;
  template: string;
  provider: string;
  model: string;
  created: string;
  cost?: number;
  src_hash?: string;
  notes_hash?: string;
  from_live?: boolean;
  edited?: boolean;
  checks?: unknown[];
  highlights?: HighlightItem[];
}

export interface SuspectHotword {
  text: string;
  hotword: string;
  count: number;
  at: number[];
}

export interface QaItem {
  q: string;
  a: string;
  t: string;
}

export interface LiveStateInfo {
  state: "recording" | "reconnecting" | "ended";
  rec?: string;
  grace_left?: number;
}

export interface SkipRange {
  pos_ms: number;
  skipped_s: number;
  from: number;
  to: number;
}

export type SegMapEntry = [number, number];

export interface MeetingDetail {
  meta: MeetingMeta;
  transcript: TranscriptData | null;
  live: LiveSegment[];
  segmap: SegMapEntry[] | null;
  skips: SkipRange[];
  minutes: MinutesData | null;
  marks: MarkItem[];
  minutes_stale: ("transcript" | "notes")[];
  suspects: SuspectHotword[];
  notes: string;
  qa: QaItem[];
  has_audio: boolean;
  live_active: boolean;
  live_state: LiveStateInfo | null;
  ambient_active: boolean;
}

export interface AudioPeaks {
  levels: number[];
  quiet: [number, number][];
}

export interface HealthStatus {
  asr_ready: boolean;
  asr_error: string;
  asr_loading: boolean;
  asr_note: string;
  device: string;
  remote: boolean;
  templates: Record<string, string>;
}

export interface AsrConfig {
  model: string;
  options: Record<string, string>;
  nano_loaded: boolean;
  nano_loading: boolean;
  nano_error: string;
  diarizer: string;
  diarizers: Record<string, string>;
  doubao_ddc: boolean;
}

export interface VocabFix {
  from: string;
  to: string;
}

export interface VocabData {
  hotwords: string;
  fixes: VocabFix[];
}

export interface LlmProvider {
  id: string;
  name: string;
  base_url: string;
  model: string;
  env_key?: string;
  api_key_masked?: string;
  api_key_from_env?: boolean;
  max_input_chars: number;
  extra_body: Record<string, unknown>;
}

export interface SettingsData {
  active: string;
  providers: LlmProvider[];
}

export interface LocalLlmStatus {
  script: boolean;
  url: string;
  running: boolean;
  starting: boolean;
  ours: boolean;
  exit_code: number | null;
  log: string;
}

export type AmbientState = "off" | "starting" | "listening" | "speech" | "paused" | "held" | "error";

export interface AmbientConfig {
  enabled: boolean;
  device: string;
  sensitivity: string;
  split_min: number;
  min_speech_s: number;
  max_conv_min: number;
  summary_time: string;
  audio_keep_days: number;
  keep_awake: boolean;
  keep_silence: boolean;
  paused_until?: number;
}

export interface AmbientTodayStats {
  date: string;
  count: number;
  speech_s: number;
}

export interface AmbientActiveConv {
  id: string;
  started: string;
  last_end: string | number;
  speech_s: number;
  dur_s: number;
  voiced_s: number;
}

export interface AmbientDiscardedNotice {
  id: string;
  at: number;
  voiced_s: number;
  min_s: number;
}

export interface AmbientStatus {
  enabled: boolean;
  state: AmbientState;
  error: string;
  level_db: number;
  state_since: number;
  fallback: string;
  paused_until: number;
  conv: AmbientActiveConv | null;
  partial: string;
  last: string;
  live_rev: number;
  discarded: AmbientDiscardedNotice | null;
  cfg: AmbientConfig;
  today: AmbientTodayStats;
}

export interface DiscardedItem {
  id: string;
  time: string;
  voiced_s: number;
  text: string;
}

export interface AmbientStorage {
  days: number;
  mb_per_hour: number;
  skip_h_day: number;
  skip_mb_day: number;
  cont_h_day: number;
  cont_mb_day: number;
  keep_days: number;
}

export interface RsiState {
  config: {
    paused?: boolean;
    auto_name?: boolean;
  };
  voiceprints?: {
    tau_auto?: number;
    tau_suggest?: number;
    persons?: { name: string; sessions?: number; voiced_s?: number }[];
    conflicts?: unknown[];
  };
  vocab?: {
    candidates?: { from: string; to: string; count?: number }[];
    demoted_rules?: { from: string; to: string; hits?: number; reverts?: number }[];
    ctc_demoted?: { word: string; rejects?: number; accepts?: number }[];
    dismissed_count?: number;
  };
  ambient?: {
    devices?: { device?: string; noise_floor_p20_db?: number; vad_false_ratio?: number }[];
    discard_stats?: {
      purged_7d?: number;
      restored?: number;
      restored_7d?: number;
      user_deleted_short?: number;
    };
    advice?: { warning?: string; suggested_min_speech_s?: number; reason?: string };
  };
  registry?: { at?: string | number; kind?: string; detail?: string }[];
  error?: string;
}

export interface LanUrlEntry {
  url: string;
  label: string;
  qr: string;
}

export interface LanStatus {
  enabled: boolean;
  port: number;
  has_password: boolean;
  running: boolean;
  error: string;
  urls: LanUrlEntry[];
  ca_sha256: string | null;
  ca_replaced: number | null;
  firewall: boolean;
  local: boolean;
}

export interface McpConfigResponse {
  server_path: string;
  workspace: string;
  config: {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  tools: string[];
}

export interface RelatedMeeting {
  id: string;
  title: string;
  created: string;
  duration: number;
  source: string;
  has_minutes: boolean;
  score: number;
  shared_speakers: string[];
  shared_terms: string[];
}

export interface TodoItem {
  mid: string;
  meeting_title: string;
  meeting_created: string;
  idx: number;
  done: boolean;
  text: string;
  ts: string;
  speakers?: string[];
}

export interface TodosResponse {
  counts: { open: number; done: number; total: number };
  items: TodoItem[];
}

export interface PersonSummary {
  name: string;
  meetings: number;
  total_s: number;
  open_todos: number;
  last_seen: string;
  has_voiceprint?: boolean;
}

export interface PersonMeetingItem {
  id: string;
  title: string;
  created: string;
  duration: number;
  spoken_s: number;
  source: string;
  has_minutes: boolean;
  spks?: string[];
}

export interface PersonTimeline {
  name: string;
  total_meetings: number;
  total_s: number;
  meetings: PersonMeetingItem[];
  co_speakers: { name: string; count: number }[];
  top_terms: string[];
  todos: TodoItem[];
  voiceprint_sessions?: number;
}

export interface DaySummaryData {
  markdown: string;
  provider: string;
  model: string;
  created: string;
  cost: number;
  meetings: string[];
  src_hash: string;
}

export interface DayData {
  date: string;
  meetings: MeetingMeta[];
  summary: DaySummaryData | null;
  summary_stale: { new: number; changed: boolean } | null;
  auto_error: { at: string; error: string; tries: number; final: boolean } | null;
}

export interface SearchHit {
  id: string;
  hits: number;
  snippet: string;
}

export interface SpeakerEvidence {
  ts: string;
  spk: number;
  quote: string;
}

export interface SpeakerCandidate {
  spk: number;
  name: string;
  confidence: string;
  reason: string;
  evidence: SpeakerEvidence[];
}

export interface SpeakerNamesResponse {
  candidates: SpeakerCandidate[];
  raw_count: number;
  provider: string;
  cost: number;
}

export type SidecarPhase = "stopped" | "bootstrapping" | "starting" | "running" | "error" | "stopping";

export type BootstrapMirror = "cn" | "official";

export interface BootstrapProgress {
  stage: "python" | "deps" | "verify" | "starting";
  percent: number;
  message: string;
  mirror: BootstrapMirror;
  isUpgrade: boolean;
}

export interface SidecarStatus {
  phase: SidecarPhase;
  mode?: "repo" | "standalone";
  pid: number | null;
  port: number | null;
  backendDir: string | null;
  pythonBin: string | null;
  dataDir: string | null;
  error: string;
  restarts: number;
  startedAt: number | null;
  bootstrap?: BootstrapProgress | null;
}

export interface SidecarLogEntry {
  ts: number;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface DesktopRuntimeInfo {
  platform: string;
  arch: string;
  version: string;
  isPackaged: boolean;
  backendDir: string | null;
  dataDir: string | null;
}

export interface QuickMarkPayload {
  mid: string;
  tMs: number;
  markId?: string;
}

export interface VoiceprintClusterMember {
  mid: string;
  spk: string;
  title: string;
  created: string;
  voiced_s: number;
}

export interface VoiceprintClusterSample {
  mid: string;
  spk: string;
  title: string;
  created: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface VoiceprintCluster {
  cluster_id: string;
  meeting_count: number;
  total_voiced_s: number;
  avg_cos: number;
  members: VoiceprintClusterMember[];
  samples: VoiceprintClusterSample[];
}

export interface VoiceprintBatchNameResponse {
  name: string;
  updated_meetings: number;
  enrolled: number;
  skipped: number;
  conflicts: unknown[];
}

export interface CommitmentItem {
  id: string;
  mid: string;
  meeting_title: string;
  created: string;
  who: string;
  direction: "mine" | "theirs" | "team" | string;
  text: string;
  due_hint?: string;
  ts: string;
  start_ms: number;
  done: boolean;
  done_at?: string;
  dismissed?: boolean;
  overdue: boolean;
  source?: string;
}

export interface CommitmentsResponse {
  counts: {
    open: number;
    done: number;
    total: number;
    mine: number;
    theirs: number;
    overdue: number;
  };
  items: CommitmentItem[];
}

export interface GlobalAskCitation {
  mid: string;
  title: string;
  created: string;
  ts: string;
  start_ms: number;
  speaker: string;
  quote: string;
  score: number;
}

export interface GlobalAskResponse {
  query: string;
  answer: string;
  citations: GlobalAskCitation[];
  mode: "llm" | "search";
}

export interface ProjectMeetingSummary {
  id: string;
  title: string;
  brief?: string;
  tags?: string[];
  created: string;
  duration: number;
  has_minutes: boolean;
  source: string;
}

export interface ProjectStream {
  id: string;
  name: string;
  keywords: string[];
  meeting_count: number;
  total_s: number;
  latest_at: string;
  participants: string[];
  meetings: ProjectMeetingSummary[];
}

export interface WeeklyReport {
  week_id: string;
  start_date: string;
  end_date: string;
  markdown: string;
  provider?: string;
  model?: string;
  created?: string;
  cost?: number;
}

export interface WeeklyData {
  week_id: string;
  start_date: string;
  end_date: string;
  meeting_count: number;
  active_days: number;
  total_s: number;
  meetings: ProjectMeetingSummary[];
  daily_summaries: { date: string; markdown: string; created: string }[];
  todos: TodoItem[];
  commitments: CommitmentItem[];
  report: WeeklyReport | null;
}

export interface DetectedMeetingApp {
  id: string;
  name: string;
  processName: string;
  detectedAt: number;
}

export interface DesktopAPI {
  getInfo: () => Promise<DesktopRuntimeInfo>;
  getSidecarStatus: () => Promise<SidecarStatus>;
  getSidecarLogs: () => Promise<SidecarLogEntry[]>;
  restartSidecar: () => Promise<SidecarStatus>;
  retryBootstrap: (mirror?: BootstrapMirror) => Promise<SidecarStatus>;
  openDataDir: () => Promise<boolean>;
  revealMeeting: (mid: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;
  syncTrayState: (payload: {
    active: boolean;
    paused: boolean;
    mid: string | null;
    elapsedMs: number;
  }) => void;
  toggleQuickAsk: () => Promise<boolean>;
  hideQuickAsk: () => void;
  resizeQuickAsk: (height: number) => void;
  openMeetingFromQuickAsk: (mid: string, tSec?: number) => Promise<boolean>;
  dismissMeetingApp: (appId: string) => void;
  setThemeMode: (mode: ThemeMode) => void;
  onSidecarStatus: (cb: (status: SidecarStatus) => void) => () => void;
  onSidecarLog: (cb: (entry: SidecarLogEntry) => void) => () => void;
  onQuickMark: (cb: (payload: QuickMarkPayload) => void) => () => void;
  onOpenDiagnostics: (cb: () => void) => () => void;
  onNavigate: (cb: (hash: string) => void) => () => void;
  onQuickAskFocus: (cb: () => void) => () => void;
  onQuickAskHidden: (cb: () => void) => () => void;
  onMeetingAppDetected: (cb: (app: DetectedMeetingApp | null) => void) => () => void;
  onThemeChanged: (cb: (mode: ThemeMode) => void) => () => void;
  confirmQuit: () => void;
  onQuitRequested: (cb: () => void) => () => void;
}
