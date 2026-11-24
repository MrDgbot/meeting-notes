import { fmtDur, GAP_TEXT } from "@shared/format";
import { wsUrl } from "./api";

export const MIC_OPTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

export const MONO_CHUNK = 3200;
export const BUF_MAX = 15 * 60 * 10;
const WORKLET_URL = "/pcm-worklet.js";

export interface RecorderLiveSegment {
  start: number;
  end: number;
  text: string;
  ch?: number;
}

export interface RecorderGap {
  type: "gap";
  at_ms: number;
  dur_ms: number;
  reason: string;
}

export interface RecorderSnapshot {
  active: boolean;
  paused: boolean;
  stopping: boolean;
  mid: string | null;
  elapsedMs: number;
  pendingSec: number;
  level: number;
  conn: "ok" | "reconnecting";
  channels: 1 | 2;
  lost: "mic" | "sys" | null;
  stall: { reason: string } | null;
  finals: RecorderLiveSegment[];
  partial: { text: string; ch?: number } | null;
  gaps: RecorderGap[];
}

export interface RecorderCallbacks {
  onSnapshot: (snap: RecorderSnapshot) => void;
  onToast: (msg: string, ms?: number) => void;
  onClosed: () => void;
  onBeforeRemoteEnd?: () => Promise<void>;
}

export function interleavePcm(micBuf: ArrayBuffer, sysBuf: ArrayBuffer): ArrayBuffer {
  const a = new Int16Array(micBuf);
  const b = new Int16Array(sysBuf);
  const n = Math.min(a.length, b.length);
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = a[i] ?? 0;
    out[i * 2 + 1] = b[i] ?? 0;
  }
  return out.buffer;
}

function stopStreamTracks(stream: MediaStream | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.onended = null;
    track.onmute = null;
    track.onunmute = null;
    try {
      track.stop();
    } catch {}
  }
}

async function getSysAudio(): Promise<MediaStream> {
  const disp = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  if (!disp.getAudioTracks().length) {
    for (const t of disp.getTracks()) t.stop();
    throw new Error("没有拿到电脑声音：请在系统权限里允许“屏幕录制”并共享音频");
  }
  for (const t of disp.getVideoTracks()) t.stop();
  return disp;
}

const newRecId = () =>
  (typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2)
  )
    .replace(/-/g, "")
    .slice(0, 20);

interface AudioChunkMsg {
  pcm: ArrayBuffer;
  level: number;
  frame?: number;
  rate: number;
}

export class RecorderEngine {
  private callbacks: RecorderCallbacks;
  private active = false;
  private paused = false;
  private stopping = false;
  private mid: string | null = null;
  private recId = "";
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private ctx0: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private sources: MediaStreamAudioSourceNode[] = [];
  private node: AudioWorkletNode | null = null;
  private nodes: AudioWorkletNode[] | null = null;
  private channels: 1 | 2 = 1;
  private queues: [AudioChunkMsg[], AudioChunkMsg[]] = [[], []];
  private samples = 0;
  private offsetMs = 0;
  private finals: RecorderLiveSegment[] = [];
  private partial: { text: string; ch?: number } | null = null;
  private level = 0;
  private wake: WakeLockSentinel | null = null;
  private lost: "mic" | "sys" | null = null;

  private buf: ArrayBuffer[] = [];
  private base = 0;
  private next = 0;
  private sent = 0;
  private startBytes = 0;
  private conn: "ok" | "reconnecting" = "ok";
  private retry = 0;
  private retryT: ReturnType<typeof setTimeout> | null = null;
  private flushT: ReturnType<typeof setTimeout> | null = null;
  private stopT: ReturnType<typeof setTimeout> | null = null;
  private muteT: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private dropped = 0;
  private overflow: { t: number; at: number } | null = null;
  private stopRes: ((res: { lost: number; timeout?: boolean; gaveUp?: boolean }) => void) | null = null;
  private stopPromise: Promise<{ lost: number; timeout?: boolean; gaveUp?: boolean }> | null = null;
  private stopSentOn: WebSocket | null = null;
  private ctl: Record<string, unknown>[] = [];
  private reconnectingDevice = false;

  private lastChunk = 0;
  private lastAck = 0;
  private stall: { reason: string } | null = null;
  private flags: { hidden?: boolean; interrupted?: boolean; muted?: boolean } = {};
  private gaps: RecorderGap[] = [];
  private clock: {
    base: number;
    cand: { t: number; at: number; min: number; n: number; reason: string } | null;
  } | null = null;
  private muted: { t: number; at: number; hidden: boolean } | null = null;

  constructor(callbacks: RecorderCallbacks) {
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: RecorderCallbacks): void {
    this.callbacks = callbacks;
  }

  snapshot(): RecorderSnapshot {
    const elapsedMs = this.offsetMs + this.samples / 16;
    const pendingSec = (this.next - this.base) / 10;
    return {
      active: this.active,
      paused: this.paused,
      stopping: this.stopping,
      mid: this.mid,
      elapsedMs,
      pendingSec,
      level: this.level,
      conn: this.conn,
      channels: this.channels,
      lost: this.lost,
      stall: this.stall,
      finals: [...this.finals],
      partial: this.partial ? { ...this.partial } : null,
      gaps: [...this.gaps],
    };
  }

  private emitSnapshot(): void {
    const snap = this.snapshot();
    this.callbacks.onSnapshot(snap);
    window.desktopAPI?.syncTrayState({
      active: snap.active || snap.stopping,
      paused: snap.paused,
      mid: snap.mid,
      elapsedMs: snap.elapsedMs,
    });
  }

  private chunkBytes(): number {
    return this.channels === 2 ? MONO_CHUNK * 2 : MONO_CHUNK;
  }

  private bytesPerSec(): number {
    return this.chunkBytes() * 10;
  }

  private elapsedMs(): number {
    return this.offsetMs + this.samples / 16;
  }

  prime(): void {
    if (this.active || this.stopping || this.ctx0) return;
    try {
      this.ctx0 = new AudioContext();
      void this.ctx0.resume().catch(() => {});
    } catch {
      this.ctx0 = null;
    }
  }

  private dropCtx0(): void {
    try {
      void this.ctx0?.close();
    } catch {}
    this.ctx0 = null;
  }

  private async keepAwake(): Promise<void> {
    if (!this.active || this.wake || !navigator.wakeLock || document.visibilityState !== "visible") return;
    try {
      this.wake = await navigator.wakeLock.request("screen");
      this.wake.onrelease = () => {
        this.wake = null;
      };
    } catch {
      this.wake = null;
    }
  }

  async start(mid: string, source: "mic" | "mix"): Promise<void> {
    if (this.active || this.stopping) {
      this.dropCtx0();
      throw new Error("已有会议在录音");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.dropCtx0();
      throw new Error("当前环境不支持麦克风录音");
    }

    const streams: MediaStream[] = [];
    try {
      streams.push(await navigator.mediaDevices.getUserMedia(MIC_OPTS));
      if (source === "mix" && typeof navigator.mediaDevices.getDisplayMedia === "function") {
        streams.push(await getSysAudio());
      }
    } catch (err) {
      streams.forEach(stopStreamTracks);
      this.dropCtx0();
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        throw new Error("没有获得麦克风或屏幕音频捕获权限");
      }
      throw err;
    }

    this.channels = streams.length > 1 ? 2 : 1;
    this.queues = [[], []];
    this.mid = mid;
    this.recId = newRecId();
    this.buf = [];
    this.base = 0;
    this.next = 0;
    this.sent = 0;
    this.conn = "ok";
    this.retry = 0;
    this.dropped = 0;
    this.overflow = null;
    this.stopping = false;
    this.stopRes = null;
    this.stopPromise = null;
    this.stopSentOn = null;
    this.ctl = [];
    this.gaps = [];
    this.flags = {};
    this.stall = null;
    this.lastChunk = 0;
    this.samples = 0;
    this.finals = [];
    this.partial = null;
    this.lost = null;
    this.clock = null;
    this.muted = null;
    this.sources = [];
    this.reconnectingDevice = false;
    if (this.stopT) {
      clearTimeout(this.stopT);
      this.stopT = null;
    }

    try {
      await this.connect(true);
    } catch (err) {
      streams.forEach(stopStreamTracks);
      try {
        this.ws?.close();
      } catch {}
      this.ws = null;
      this.dropCtx0();
      throw err;
    }

    let ctx: AudioContext | null = null;
    const sources: MediaStreamAudioSourceNode[] = [];
    try {
      ctx = this.ctx0 && this.ctx0.state !== "closed" ? this.ctx0 : new AudioContext();
      this.ctx0 = null;
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const wire = (s: MediaStream) => {
        if (!ctx) throw new Error("AudioContext missing");
        const node = new AudioWorkletNode(ctx, "pcm16k", { channelCount: 1, channelCountMode: "explicit" });
        const src = ctx.createMediaStreamSource(s);
        src.connect(node);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
        sources.push(src);
        return node;
      };

      let node: AudioWorkletNode;
      let nodes: AudioWorkletNode[] | null = null;
      if (this.channels === 2) {
        nodes = streams.map(wire);
        nodes.forEach((n, idx) => {
          n.port.onmessage = (ev) => this.onChannel(idx, ev.data as AudioChunkMsg);
        });
        node = nodes[0] as AudioWorkletNode;
      } else {
        node = wire(streams[0] as MediaStream);
        node.port.onmessage = (ev) => this.onChunk(ev.data as AudioChunkMsg);
      }

      ctx.onstatechange = () => {
        if (this.active && !this.paused && ctx?.state !== "running") {
          this.flags.interrupted = true;
        }
      };

      this.active = true;
      this.paused = false;
      this.ctx = ctx;
      this.node = node;
      this.nodes = nodes;
      this.streams = streams;
      this.sources = sources;

      streams.forEach((s, i) => {
        this.watchStream(s, i ? "sys" : "mic");
      });
      this.timers = [
        setInterval(() => this.checkStall(), 500),
        setInterval(() => this.sendCtl(this.stat(), true), 5000),
      ];
      if (this.ws?.readyState !== 1) {
        this.conn = "reconnecting";
        this.scheduleReconnect(true);
      }
      void this.keepAwake();
      this.emitSnapshot();
    } catch (err) {
      for (const src of sources) {
        try {
          src.disconnect();
        } catch {}
      }
      streams.forEach(stopStreamTracks);
      try {
        if (ctx && ctx.state !== "closed") void ctx.close();
      } catch {}
      const ws = this.ws;
      this.ws = null;
      try {
        if (ws && ws.readyState <= 1) ws.close();
      } catch {}
      this.dropCtx0();
      this.active = false;
      this.stopping = false;
      this.emitSnapshot();
      throw err;
    }
  }

  private onChannel(idx: number, data: AudioChunkMsg): void {
    this.queues[idx]?.push(data);
    const mic = this.queues[0];
    const remote = this.queues[1];
    while (mic.length && remote.length) {
      const a = mic.shift();
      const b = remote.shift();
      if (a && b) {
        this.onChunk({
          pcm: interleavePcm(a.pcm, b.pcm),
          level: Math.max(a.level || 0, b.level || 0),
          frame: a.frame,
          rate: a.rate,
        });
      }
    }
    if (mic.length >= 4 && !remote.length) this.padChannel(0);
    if (remote.length >= 4 && !mic.length) this.padChannel(1);
  }

  private padChannel(idx: 0 | 1): void {
    const src = this.queues[idx].shift();
    if (!src) return;
    const n = new Int16Array(src.pcm).length;
    const silent = new Int16Array(n).buffer;
    const pcm = idx === 0 ? interleavePcm(src.pcm, silent) : interleavePcm(silent, src.pcm);
    this.onChunk({ pcm, level: src.level || 0, frame: src.frame, rate: src.rate });
  }

  private drainDualQueues(): void {
    if (this.channels !== 2) return;
    const mic = this.queues[0];
    const remote = this.queues[1];
    while (mic.length && remote.length) {
      const a = mic.shift();
      const b = remote.shift();
      if (a && b) {
        this.onChunk({
          pcm: interleavePcm(a.pcm, b.pcm),
          level: Math.max(a.level || 0, b.level || 0),
          frame: a.frame,
          rate: a.rate,
        });
      }
    }
    while (mic.length) this.padChannel(0);
    while (remote.length) this.padChannel(1);
  }

  private onChunk({ pcm, level, frame, rate }: AudioChunkMsg): void {
    const now = performance.now();
    this.level = level;
    if (frame !== undefined) {
      const off = now - (frame / rate) * 1000;
      if (!this.clock) {
        this.clock = { base: off, cand: null };
      }
      const c = this.clock;
      if (this.paused) {
        c.base = off;
        c.cand = null;
      } else {
        const d = off - c.base;
        if (c.cand) {
          c.cand.min = Math.min(c.cand.min, d);
          if (now - c.cand.t >= 2000 && ++c.cand.n >= 5) {
            if (c.cand.min > 1200) {
              this.addGap(c.cand.min, c.cand.reason, c.cand.at);
              c.base += c.cand.min;
            }
            c.cand = null;
          }
        } else if (d > 1200 && this.active && !this.paused) {
          c.cand = { t: now, at: this.elapsedMs(), min: d, n: 0, reason: this.gapReason() };
        } else if (d > 0 && d < 300) {
          c.base += d * 0.05;
        }
      }
    }
    this.lastChunk = now;
    if (!document.hidden) this.flags = {};
    if (this.stall) {
      this.stall = null;
    }
    if (this.active && !this.paused) {
      if (this.next - this.base >= BUF_MAX) {
        this.dropped += this.chunkBytes();
        if (!this.overflow) this.overflow = { t: now, at: this.elapsedMs() };
      } else {
        if (this.overflow) {
          this.addGap(now - this.overflow.t, "overflow", this.overflow.at);
          this.overflow = null;
        }
        this.buf.push(pcm);
        this.next++;
        this.samples += 1600;
        this.flush();
      }
    }
    this.emitSnapshot();
  }

  private gapReason(): string {
    return document.hidden || this.flags.hidden
      ? "hidden"
      : this.flags.interrupted
        ? "interrupted"
        : this.flags.muted
          ? "muted"
          : "stall";
  }

  private addGap(ms: number, reason: string, at?: number): void {
    const atMs = Math.round(at ?? this.elapsedMs());
    const same = this.gaps.find((g) => Math.abs(g.at_ms - atMs) < 1500);
    if (same) {
      if (ms > same.dur_ms) {
        same.dur_ms = Math.round(ms);
        this.sendCtl({ ...same });
      }
      return;
    }
    const g: RecorderGap = { type: "gap", at_ms: atMs, dur_ms: Math.round(ms), reason };
    this.gaps.push(g);
    this.sendCtl({ ...g });
    this.emitSnapshot();
    if (!document.hidden) {
      const text = GAP_TEXT[reason] || GAP_TEXT.stall;
      this.callbacks.onToast(
        `刚才有 ${Math.max(1, Math.round(ms / 1000))} 秒没录到：${text}。转写稿里会标出这一段。`,
        6000,
      );
    }
  }

  private checkStall(): void {
    if (this.conn === "ok" && (this.active || this.stopping) && (!this.ws || this.ws.readyState >= 2)) {
      this.ws = null;
      if (this.stopT) {
        clearTimeout(this.stopT);
        this.stopT = null;
      }
      this.conn = "reconnecting";
      this.stopSentOn = null;
      this.emitSnapshot();
      this.scheduleReconnect(true);
    }

    const awaitingStopAck = this.stopping && this.stopSentOn && this.stopSentOn === this.ws;
    if (
      !awaitingStopAck &&
      this.conn === "ok" &&
      this.ws?.readyState === 1 &&
      performance.now() - this.lastAck > 8000
    ) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {}
      if (this.stopT) {
        clearTimeout(this.stopT);
        this.stopT = null;
      }
      this.conn = "reconnecting";
      this.stopSentOn = null;
      this.emitSnapshot();
      this.scheduleReconnect(true);
    }

    if (!this.active || this.paused || !this.lastChunk || this.stall) return;
    if (performance.now() - this.lastChunk > 1500) {
      this.stall = { reason: this.gapReason() };
      this.emitSnapshot();
    }
  }

  private stat(): Record<string, unknown> {
    return {
      type: "stat",
      produced: this.next * this.chunkBytes() + this.dropped,
      dropped: this.dropped,
    };
  }

  private sendCtl(msg: Record<string, unknown>, replace = false): void {
    if (replace) {
      this.ctl = this.ctl.filter((m) => m.type !== msg.type);
    }
    this.ctl.push(msg);
    this.flushCtl();
  }

  private flushCtl(): void {
    const ws = this.ws;
    if (ws?.readyState !== 1 || this.conn !== "ok") return;
    while (this.ctl.length) {
      const item = this.ctl.shift();
      if (item) ws.send(JSON.stringify(item));
    }
  }

  private flush(): void {
    if (this.flushT) {
      clearTimeout(this.flushT);
      this.flushT = null;
    }
    const ws = this.ws;
    if (ws?.readyState !== 1 || this.conn !== "ok") return;
    while (this.sent < this.next && ws.bufferedAmount < 256 * 1024) {
      const chunk = this.buf[this.sent - this.base];
      if (chunk) ws.send(chunk);
      this.sent++;
    }
    if (this.sent < this.next) {
      this.flushT = setTimeout(() => this.flush(), 100);
    } else if (this.stopping) {
      if (ws.bufferedAmount > 0) this.flushT = setTimeout(() => this.flush(), 50);
      else this.sendStop();
    }
  }

  private ackTo(bytes: number): void {
    const idx = Math.min(this.next, Math.floor(bytes / this.chunkBytes()));
    if (idx > this.base) {
      this.buf.splice(0, idx - this.base);
      this.base = idx;
    }
    if (this.sent < this.base) this.sent = this.base;
  }

  private connect(first: boolean): Promise<void> {
    const ws = new WebSocket(wsUrl(`/ws/live/${this.mid}?rec=${this.recId}&ch=${this.channels || 1}`));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let ok = false;
      ws.onmessage = (ev) => {
        if (this.ws !== ws) return;
        const j = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (j.type === "ready") {
          ok = true;
          this.onReady(j, first);
          resolve();
        } else if (j.type === "stopped") {
          ok = true;
          resolve();
          this.onStopped(j);
        } else if (j.type === "error" && !ok) {
          reject(Object.assign(new Error(String(j.msg || "连接失败")), { code: j.code }));
        } else if (j.type === "status") {
          this.callbacks.onToast(String(j.msg || ""));
        } else {
          this.onMsg(j);
        }
      };
      ws.onerror = () => {
        if (!ok) reject(new Error("实时转写连接失败"));
      };
      ws.onclose = () => {
        if (!ok) reject(new Error("连接已关闭"));
        else this.onClose(ws);
      };
    });
  }

  private onReady(j: Record<string, unknown>, first: boolean): void {
    if (this.stopT) {
      clearTimeout(this.stopT);
      this.stopT = null;
    }
    if (first) {
      this.offsetMs = Number(j.offset_ms || 0);
      this.startBytes = Number(j.start_bytes || 0);
    }
    this.ackTo(Number(j.file_bytes || 0) - this.startBytes);
    this.sent = this.base;
    const was = this.conn;
    this.conn = "ok";
    this.retry = 0;
    this.lastAck = performance.now();
    this.flushCtl();
    this.flush();
    this.emitSnapshot();
    if (!first && was !== "ok") {
      this.callbacks.onToast(j.resumed ? "已重新连上后端，断开期间的录音已补传" : "已重新连上后端");
    }
  }

  private onMsg(j: Record<string, unknown>): void {
    if (j.type === "ack") {
      this.lastAck = performance.now();
      this.ackTo(Number(j.bytes || 0));
      this.emitSnapshot();
      return;
    }
    if (j.type === "end_requested") {
      if (this.stopping) return;
      this.callbacks.onToast("在另一端触发了结束录音");
      void Promise.resolve(this.callbacks.onBeforeRemoteEnd?.()).finally(() => {
        void this.stop().then(() => this.callbacks.onClosed());
      });
      return;
    }
    if (j.type === "partial") {
      this.partial = { text: String(j.text || ""), ch: typeof j.ch === "number" ? j.ch : undefined };
    } else if (j.type === "final") {
      this.finals.push({
        start: Number(j.start || 0),
        end: Number(j.end || 0),
        text: String(j.text || ""),
        ch: typeof j.ch === "number" ? j.ch : undefined,
      });
      this.partial = null;
    } else if (j.type === "error") {
      this.callbacks.onToast(String(j.msg || "转写异常"), 5000);
    }
    this.emitSnapshot();
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.ws || (!this.active && !this.stopping)) return;
    if (this.stopT) {
      clearTimeout(this.stopT);
      this.stopT = null;
    }
    this.conn = "reconnecting";
    this.stopSentOn = null;
    this.emitSnapshot();
    this.scheduleReconnect();
  }

  scheduleReconnect(now = false): void {
    if (this.retryT) clearTimeout(this.retryT);
    if (this.conn !== "reconnecting") return;
    const delays = [500, 1000, 2000, 3000, 5000];
    const delay = now ? 0 : (delays[Math.min(this.retry, delays.length - 1)] ?? 5000);
    this.retryT = setTimeout(async () => {
      this.retry++;
      try {
        await this.connect(false);
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
        if (code === "busy" || code === "gone") {
          const msg = err instanceof Error ? err.message : "会话已结束";
          this.callbacks.onToast(`${msg}，这里的录音停止了`, 8000);
          this.cleanup();
          this.callbacks.onClosed();
          return;
        }
        this.scheduleReconnect();
      }
    }, delay);
  }

  private onStopped(j: Record<string, unknown>): void {
    if (this.stopT) {
      clearTimeout(this.stopT);
      this.stopT = null;
    }
    const totalBytes = this.next * this.chunkBytes();
    const fileBytes = typeof j.file_bytes === "number" ? j.file_bytes : null;
    const lost =
      fileBytes !== null
        ? Math.max(0, this.startBytes + totalBytes - fileBytes)
        : Math.max(0, (this.next - this.base) * this.chunkBytes());
    if (j.already && lost >= this.chunkBytes()) {
      this.callbacks.onToast(
        `后端已结束这次录音，最后 ${Math.round(lost / this.bytesPerSec())} 秒没能传上`,
        8000,
      );
    } else if (j.timeout && lost >= this.chunkBytes()) {
      this.callbacks.onToast(
        `等待后端确认超时，最后 ${fmtDur(lost / this.bytesPerSec())} 的录音可能未保存`,
        8000,
      );
    }
    const res = this.stopRes;
    this.stopRes = null;
    if (res) {
      res({ lost, timeout: Boolean(j.timeout) });
    } else {
      this.cleanup();
      this.callbacks.onClosed();
    }
  }

  private watchStream(stream: MediaStream, kind: "mic" | "sys"): void {
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (!this.active) return;
        this.lost = kind;
        this.emitSnapshot();
        this.callbacks.onToast(
          kind === "sys"
            ? this.channels === 2
              ? "电脑声音已断开。这一路先记成静音，麦克风继续单独录"
              : "电脑声音已断开，现在只录麦克风"
            : "麦克风断开了，现在录不到声音",
          6000,
        );
      };
      if (kind !== "mic") continue;
      track.onmute = () => {
        this.flags.muted = true;
        if (this.active && !this.paused) {
          this.muted = { t: performance.now(), at: this.elapsedMs(), hidden: document.hidden };
        }
        if (this.muteT) clearTimeout(this.muteT);
        this.muteT = setTimeout(() => {
          if (this.active && track.muted && !this.lost) {
            this.lost = "mic";
            this.emitSnapshot();
          }
        }, 3000);
      };
      track.onunmute = () => {
        if (this.muteT) clearTimeout(this.muteT);
        this.endMute();
        if (this.lost === "mic" && track.readyState === "live") {
          this.lost = null;
          this.emitSnapshot();
        }
      };
    }
  }

  private endMute(): void {
    const m = this.muted;
    this.muted = null;
    if (m && performance.now() - m.t > 1500) {
      this.addGap(
        performance.now() - m.t,
        m.hidden || document.hidden || this.flags.hidden ? "hidden" : "muted",
        m.at,
      );
    }
  }

  async reconnectDevice(): Promise<void> {
    const kind = this.lost;
    if (!kind || !this.active || this.reconnectingDevice) return;
    this.reconnectingDevice = true;
    try {
      let s: MediaStream;
      try {
        s = kind === "sys" ? await getSysAudio() : await navigator.mediaDevices.getUserMedia(MIC_OPTS);
      } catch (err) {
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          throw new Error("没有获得麦克风或屏幕音频捕获权限");
        }
        throw err;
      }
      if (!this.active || !this.ctx || this.ctx.state === "closed") {
        stopStreamTracks(s);
        return;
      }
      const idx = kind === "sys" ? 1 : 0;
      const targetNode = this.nodes?.[idx] ?? this.node;
      if (!targetNode) {
        stopStreamTracks(s);
        return;
      }
      try {
        this.sources[idx]?.disconnect();
      } catch {}
      stopStreamTracks(this.streams[idx]);
      const src = this.ctx.createMediaStreamSource(s);
      src.connect(targetNode);
      this.sources[idx] = src;
      this.streams[idx] = s;
      this.watchStream(s, kind);
      this.lost = null;
      this.emitSnapshot();
    } finally {
      this.reconnectingDevice = false;
    }
  }

  pause(): void {
    this.paused = true;
    this.emitSnapshot();
  }

  resume(): void {
    this.paused = false;
    this.lastChunk = performance.now();
    this.emitSnapshot();
  }

  async stop(): Promise<{ lost: number; timeout?: boolean; gaveUp?: boolean }> {
    if (this.stopping && this.stopPromise) return this.stopPromise;
    if (!this.active) return { lost: 0 };
    this.drainDualQueues();
    this.active = false;
    this.stopping = true;
    this.lastAck = performance.now();
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.overflow) {
      this.addGap(performance.now() - this.overflow.t, "overflow", this.overflow.at);
      this.overflow = null;
    }
    this.endMute();
    for (const src of this.sources) {
      try {
        src.disconnect();
      } catch {}
    }
    this.streams.forEach(stopStreamTracks);
    try {
      await this.ctx?.close();
    } catch {}
    this.emitSnapshot();
    this.timers = [setInterval(() => this.checkStall(), 1000)];
    this.stopPromise = new Promise<{ lost: number; timeout?: boolean; gaveUp?: boolean }>((resolve) => {
      this.stopRes = resolve;
      this.flush();
    }).finally(() => {
      this.cleanup();
    });
    return this.stopPromise;
  }

  private sendStop(): void {
    const ws = this.ws;
    if (
      !this.stopping ||
      this.conn !== "ok" ||
      !ws ||
      ws.readyState !== 1 ||
      this.sent < this.next ||
      ws.bufferedAmount > 0 ||
      this.stopSentOn === ws
    ) {
      return;
    }
    this.stopSentOn = ws;
    this.flushCtl();
    ws.send(JSON.stringify({ ...this.stat(), type: "stop" }));
    if (this.stopT) clearTimeout(this.stopT);
    this.stopT = setTimeout(() => {
      if (this.stopRes) this.onStopped({ timeout: true });
    }, 30000);
  }

  giveUp(): void {
    const res = this.stopRes;
    if (!res) return;
    this.stopRes = null;
    if (this.stopT) {
      clearTimeout(this.stopT);
      this.stopT = null;
    }
    res({ lost: (this.next - this.base) * this.chunkBytes(), gaveUp: true });
  }

  handleVisibilityChange(): void {
    if (!this.active && !this.stopping) return;
    if (document.visibilityState !== "visible") {
      this.flags.hidden = true;
      return;
    }
    void this.keepAwake();
    if (this.ctx && this.ctx.state !== "running" && this.ctx.state !== "closed") {
      void this.ctx.resume().catch(() => {});
    }
    if (this.conn === "reconnecting") this.scheduleReconnect(true);
  }

  handleOnline(): void {
    if (this.conn === "reconnecting") this.scheduleReconnect(true);
  }

  cleanup(): void {
    this.active = false;
    this.stopping = false;
    this.reconnectingDevice = false;
    this.stopPromise = null;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.retryT) clearTimeout(this.retryT);
    this.retryT = null;
    if (this.flushT) clearTimeout(this.flushT);
    this.flushT = null;
    if (this.stopT) clearTimeout(this.stopT);
    this.stopT = null;
    if (this.muteT) clearTimeout(this.muteT);
    this.muteT = null;
    for (const src of this.sources) {
      try {
        src.disconnect();
      } catch {}
    }
    this.sources = [];
    this.streams.forEach(stopStreamTracks);
    this.streams = [];
    this.queues = [[], []];
    try {
      if (this.ctx && this.ctx.state !== "closed") void this.ctx.close();
    } catch {}
    const ws = this.ws;
    this.ws = null;
    try {
      if (ws && ws.readyState <= 1) ws.close();
    } catch {}
    try {
      void this.wake?.release();
    } catch {}
    this.wake = null;
    this.buf = [];
    this.conn = "ok";
    this.emitSnapshot();
  }
}
