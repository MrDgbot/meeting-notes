import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { DetectedMeetingApp } from "@shared/types";
import type { RecorderSyncState } from "./tray";

const execFileAsync = promisify(execFile);

interface MeetingPattern {
  id: string;
  name: string;
  match: (baseName: string, fullLine: string) => boolean;
}

const MEETING_PATTERNS: MeetingPattern[] = [
  {
    id: "zoom",
    name: "Zoom 会议",
    match: (base, full) =>
      base === "CptHost" || base === "zoom.us" || /\/zoom\.us\.app\/|\/CptHost(?:\.app|$)/i.test(full),
  },
  {
    id: "feishu",
    name: "飞书会议",
    match: (base, full) =>
      /\/(?:Lark|Feishu)\.app\//i.test(full) ||
      /^(?:Feishu|Lark|Lark Helper(?:\s*\([^)]+\))?|ByteRTC|LarkMeetings|FeishuMeetings)$/i.test(base),
  },
  {
    id: "tencent",
    name: "腾讯会议",
    match: (base, full) =>
      /\/TencentMeeting\.app\//i.test(full) || /^(?:TencentMeeting|wemeetapp)$/i.test(base),
  },
  {
    id: "teams",
    name: "Teams 会议",
    match: (base, full) =>
      /\/Microsoft Teams.*\.app\//i.test(full) || /MSTeams|Microsoft Teams Call/i.test(base),
  },
  {
    id: "wecom",
    name: "企业微信会议",
    match: (base, full) =>
      /\/(?:企业微信|WeCom|WXWork)\.app\//i.test(full) || /^(?:WXWork|WeWork)$/i.test(base),
  },
  {
    id: "dingtalk",
    name: "钉钉会议",
    match: (base, full) => /\/DingTalk\.app\//i.test(full) || /^DingTalk/i.test(base),
  },
  {
    id: "webex",
    name: "Webex 会议",
    match: (base, full) => /\/Webex\.app\//i.test(full) || base === "CiscoCollabHost",
  },
  {
    id: "facetime",
    name: "FaceTime 通话",
    match: (base, full) =>
      /\/FaceTime\.app\//i.test(full) ||
      base === "avconferenced" ||
      base === "FaceTime" ||
      base.startsWith("com.apple.FaceTime"),
  },
];

const PID_HEADER_RE = /^\s*pid\s+\d+\(([^)]+)\):\s+\[[^\]]+\]\s+(\d+):(\d{2}):(\d{2})\s+/i;

export function parseCoreAudioInputPids(pmsetOutput: string, minDurationSec = 10): Set<number> {
  const result = new Set<number>();
  if (!pmsetOutput) return result;

  let owner = "";
  let durationSec = 0;
  let createdForPid: number | null = null;
  let hasAudioIn = false;

  const flush = () => {
    if (
      owner.toLowerCase() === "coreaudiod" &&
      hasAudioIn &&
      createdForPid !== null &&
      Number.isInteger(createdForPid) &&
      durationSec >= minDurationSec
    ) {
      result.add(createdForPid);
    }
    owner = "";
    durationSec = 0;
    createdForPid = null;
    hasAudioIn = false;
  };

  for (const rawLine of pmsetOutput.split(/\r?\n/)) {
    const headerMatch = rawLine.match(PID_HEADER_RE);
    if (headerMatch) {
      flush();
      owner = (headerMatch[1] || "").trim();
      const h = Number(headerMatch[2] || 0);
      const m = Number(headerMatch[3] || 0);
      const s = Number(headerMatch[4] || 0);
      durationSec = h * 3600 + m * 60 + s;
      continue;
    }

    if (/^\S/.test(rawLine)) {
      flush();
      continue;
    }

    if (!owner) continue;

    const pidMatch = rawLine.match(/^\s*Created for PID:\s*(\d+)/i);
    if (pidMatch) {
      createdForPid = Number(pidMatch[1]);
      continue;
    }

    if (/^\s*Resources:.*\baudio-in\b/i.test(rawLine)) {
      hasAudioIn = true;
    }
  }
  flush();

  return result;
}

export function parseProcessTable(psOutput: string): Map<number, string> {
  const procMap = new Map<number, string>();
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const m = rawLine.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const comm = (m[2] || "").trim();
    if (Number.isInteger(pid) && comm) {
      procMap.set(pid, comm);
    }
  }
  return procMap;
}

export function detectActiveMeetingApp(
  psOutput: string,
  pmsetOutput = "",
  detectedAt = Date.now(),
  minAudioInSec = 10,
): DetectedMeetingApp | null {
  const procMap = parseProcessTable(psOutput);
  const audioInPids = parseCoreAudioInputPids(pmsetOutput, minAudioInSec);

  if (audioInPids.size > 0) {
    const activeEntries: Array<{ comm: string; base: string }> = [];
    for (const pid of audioInPids) {
      const comm = procMap.get(pid);
      if (!comm) continue;
      activeEntries.push({ comm, base: path.posix.basename(comm) });
    }

    for (const pattern of MEETING_PATTERNS) {
      for (const entry of activeEntries) {
        if (pattern.match(entry.base, entry.comm)) {
          return {
            id: pattern.id,
            name: pattern.name,
            processName: entry.base,
            detectedAt,
          };
        }
      }
    }
  }

  for (const comm of procMap.values()) {
    const base = path.posix.basename(comm);
    if (base === "CptHost" || /\/CptHost\.app\/Contents\/MacOS\/CptHost$/i.test(comm)) {
      return {
        id: "zoom",
        name: "Zoom 会议",
        processName: base,
        detectedAt,
      };
    }
  }

  return null;
}

async function defaultRunPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm="], { timeout: 3000 });
  return stdout;
}

async function defaultRunPmset(): Promise<string> {
  const { stdout } = await execFileAsync("pmset", ["-g", "assertions"], { timeout: 3000 });
  return stdout;
}

export interface MeetingDetectorDeps {
  getRecorderState: () => RecorderSyncState;
  onDetected: (app: DetectedMeetingApp | null) => void;
  onNotify?: (app: DetectedMeetingApp) => void;
  pollIntervalMs?: number;
  cooldownMs?: number;
  absenceResetMs?: number;
  minAudioInSec?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  runPs?: () => Promise<string>;
  runPmset?: () => Promise<string>;
}

export class MeetingDetector {
  private readonly deps: MeetingDetectorDeps;
  private readonly pollIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly absenceResetMs: number;
  private readonly minAudioInSec: number;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly runPs: () => Promise<string>;
  private readonly runPmset: () => Promise<string>;
  private readonly dismissedUntil = new Map<string, number>();
  private readonly dismissedSessions = new Set<string>();
  private readonly absentSince = new Map<string, number>();
  private readonly notifiedUntil = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private current: DetectedMeetingApp | null = null;

  constructor(deps: MeetingDetectorDeps) {
    this.deps = deps;
    this.pollIntervalMs = deps.pollIntervalMs ?? 15_000;
    this.cooldownMs = deps.cooldownMs ?? 30 * 60_000;
    this.absenceResetMs = deps.absenceResetMs ?? 60_000;
    this.minAudioInSec = deps.minAudioInSec ?? 10;
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? (() => Date.now());
    this.runPs = deps.runPs ?? defaultRunPs;
    this.runPmset = deps.runPmset ?? defaultRunPmset;
  }

  getCurrent(): DetectedMeetingApp | null {
    return this.current;
  }

  start(): void {
    if (this.platform !== "darwin") return;
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dismiss(appId?: string): void {
    const targetId = appId || this.current?.id;
    const ts = this.now();
    if (targetId) {
      this.dismissedUntil.set(targetId, ts + this.cooldownMs);
      this.dismissedSessions.add(targetId);
      this.absentSince.delete(targetId);
    }
    if (this.current && (!appId || this.current.id === appId)) {
      this.current = null;
      this.deps.onDetected(null);
    }
  }

  clearIfActive(): void {
    if (this.current) {
      this.current = null;
      this.deps.onDetected(null);
    }
  }

  async pollOnce(): Promise<DetectedMeetingApp | null> {
    if (this.platform !== "darwin") return null;
    if (this.polling) return this.current;
    this.polling = true;
    try {
      const rec = this.deps.getRecorderState();
      if (rec.active) {
        this.clearIfActive();
        return null;
      }

      const [psOutput, pmsetOutput] = await Promise.all([this.runPs(), this.runPmset()]);
      const ts = this.now();
      const found = detectActiveMeetingApp(psOutput, pmsetOutput, ts, this.minAudioInSec);

      for (const id of this.dismissedSessions) {
        if (found && found.id === id) {
          this.absentSince.delete(id);
        } else {
          const since = this.absentSince.get(id);
          if (since === undefined) {
            this.absentSince.set(id, ts);
          } else if (ts - since >= this.absenceResetMs) {
            this.dismissedSessions.delete(id);
            this.absentSince.delete(id);
          }
        }
      }

      if (!found) {
        this.clearIfActive();
        return null;
      }

      const suppressedUntil = this.dismissedUntil.get(found.id) ?? 0;
      if (this.dismissedSessions.has(found.id) || ts < suppressedUntil) {
        this.clearIfActive();
        return null;
      }

      const changed = !this.current || this.current.id !== found.id;
      this.current = changed ? found : this.current;
      if (changed) {
        this.deps.onDetected(found);
        const lastNotifiedUntil = this.notifiedUntil.get(found.id) ?? 0;
        if (ts >= lastNotifiedUntil) {
          this.notifiedUntil.set(found.id, ts + this.cooldownMs);
          this.deps.onNotify?.(found);
        }
      }
      return this.current;
    } catch {
      return this.current;
    } finally {
      this.polling = false;
    }
  }
}
