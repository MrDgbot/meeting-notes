// 网页录音链路（单/双声道 AudioWorklet、断网缓存 15 分钟续传、黑洞检测、音频缺口追踪）
import { CAN_MIC, CAN_SYS, GAP_TEXT, REMOTE, fmtDur, hooks } from "./utils.js";
import { toast } from "./ui.js";

export const MIC_OPTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };
export const MONO_CHUNK = 3200;
export const BUF_MAX = 15 * 60 * 10;

const WORKLET_URL = "/static/pcm-worklet.js?v=2";
const wsUrl = path => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

export async function getSysAudio() {
  const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include" });
  if (!disp.getAudioTracks().length) {
    disp.getTracks().forEach(t => t.stop());
    throw new Error("没有拿到电脑声音：共享时请选择“整个屏幕”或“标签页”，并勾选“共享音频”");
  }
  disp.getVideoTracks().forEach(t => t.stop());
  return disp;
}

export function interleavePcm(micBuf, sysBuf) {
  const a = new Int16Array(micBuf), b = new Int16Array(sysBuf);
  const n = Math.min(a.length, b.length), o = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) { o[i * 2] = a[i]; o[i * 2 + 1] = b[i]; }
  return o.buffer;
}

export const newRecId = () => (
  crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)
).replace(/-/g, "").slice(0, 20);

function stopStreamTracks(s) {
  if (!s) return;
  s.getTracks().forEach(t => {
    t.onended = t.onmute = t.onunmute = null;
    try { t.stop(); } catch {}
  });
}

export const REC = {
  active: false, paused: false, mid: null, ws: null, ctx: null, streams: [], sources: [], samples: 0, offsetMs: 0,
  finals: [], partial: null, level: 0, onUpdate: null, node: null, nodes: null, channels: 1, queues: [[], []],
  ctx0: null, wake: null, lost: null, // mic = 麦克风断开，sys = 电脑声音停止共享
  // 传输
  rec: null, buf: [], base: 0, next: 0, sent: 0, startBytes: 0, conn: "ok", retry: 0, retryT: null, flushT: null,
  dropped: 0, overflow: null, stopping: false, stopRes: null, stopPromise: null, stopSentOn: null, stopT: null,
  ctl: [], timers: [], muteT: null, _reconnecting: false,
  // 缺口：多久没收到声音、为什么
  lastChunk: 0, lastAck: 0, stall: null, flags: {}, gaps: [], clock: null, muted: null,
  elapsedMs() { return this.offsetMs + this.samples / 16; },
  pendingSec() { return (this.next - this.base) / 10; },
  chunkBytes() { return this.channels === 2 ? MONO_CHUNK * 2 : MONO_CHUNK; },
  bytesPerSec() { return this.chunkBytes() * 10; },
  // iPhone / iPad 的 Safari 只允许在点击的那一刻启动声音处理
  prime() {
    if (this.active || this.stopping || this.ctx0) return;
    try { this.ctx0 = new AudioContext(); this.ctx0.resume().catch(() => {}); } catch { this.ctx0 = null; }
  },
  dropCtx0() { try { this.ctx0 && this.ctx0.close(); } catch {} this.ctx0 = null; },
  async keepAwake() {
    if (!this.active || this.wake || !navigator.wakeLock || document.visibilityState !== "visible") return;
    try { this.wake = await navigator.wakeLock.request("screen"); this.wake.onrelease = () => { this.wake = null; }; } catch { this.wake = null; }
  },
  emit(type) { this.onUpdate && this.onUpdate(type); },

  async start(mid, source) {
    if (this.active || this.stopping) { this.dropCtx0(); throw new Error("已有会议在录音"); }
    if (!CAN_MIC) { this.dropCtx0(); throw new Error(window.isSecureContext ? "这个浏览器不支持录音" : "要用 https 地址打开才能录音"); }
    const streams = [];
    try {
      streams.push(await navigator.mediaDevices.getUserMedia(MIC_OPTS));
      if (source === "mix" && CAN_SYS) streams.push(await getSysAudio());
    } catch (e) {
      streams.forEach(stopStreamTracks);
      this.dropCtx0();
      throw e.name === "NotAllowedError" ? new Error("没有获得麦克风/屏幕共享权限") : e;
    }
    this.channels = streams.length > 1 ? 2 : 1;
    this.queues = [[], []];
    Object.assign(this, {
      mid, rec: newRecId(), buf: [], base: 0, next: 0, sent: 0, conn: "ok", retry: 0, dropped: 0, overflow: null,
      stopping: false, stopRes: null, stopPromise: null, stopSentOn: null, ctl: [], gaps: [], flags: {}, stall: null,
      lastChunk: 0, samples: 0, finals: [], partial: null, lost: null, clock: null, muted: null, sources: [], _reconnecting: false,
    });
    clearTimeout(this.stopT); this.stopT = null;
    try {
      await this.connect(true);
    } catch (e) {
      streams.forEach(stopStreamTracks);
      try { this.ws && this.ws.close(); } catch {}
      this.ws = null;
      this.dropCtx0();
      throw e;
    }

    let ctx = null;
    const sources = [];
    try {
      ctx = this.ctx0 && this.ctx0.state !== "closed" ? this.ctx0 : new AudioContext();
      this.ctx0 = null;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const wire = (s) => {
        const node = new AudioWorkletNode(ctx, "pcm16k", { channelCount: 1, channelCountMode: "explicit" });
        const src = ctx.createMediaStreamSource(s);
        src.connect(node);
        const mute = ctx.createGain(); mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
        sources.push(src);
        return node;
      };
      let node, nodes = null;
      if (this.channels === 2) {
        nodes = streams.map(wire);
        nodes.forEach((n, i) => { n.port.onmessage = e => this.onChannel(i, e.data); });
        node = nodes[0];
      } else {
        node = wire(streams[0]);
        node.port.onmessage = e => this.onChunk(e.data);
      }
      // Safari 被来电、Siri 打断时状态是 interrupted，别的浏览器是 suspended
      ctx.onstatechange = () => { if (this.active && !this.paused && ctx.state !== "running") this.flags.interrupted = true; };
      Object.assign(this, { active: true, paused: false, ctx, node, nodes, streams, sources });
      streams.forEach((s, i) => this.watch(s, i ? "sys" : "mic"));
      this.timers = [setInterval(() => this.checkStall(), 500), setInterval(() => this.sendCtl(this.stat(), true), 5000)];
      // 若在 addModule 期间 WS 刚好断了，立刻进入重连而不是卡在 conn="ok"
      if (!this.ws || this.ws.readyState !== 1) {
        this.conn = "reconnecting"; this.emit("conn"); this.scheduleReconnect(true);
      }
      this.keepAwake();
      hooks.renderPill && hooks.renderPill();
    } catch (e) {
      // 异常路径彻底释放流、AudioContext、WebSocket，避免麦克风红点/句柄/服务端 LIVE 锁泄漏
      sources.forEach(src => { try { src.disconnect(); } catch {} });
      streams.forEach(stopStreamTracks);
      try { ctx && ctx.state !== "closed" && ctx.close(); } catch {}
      const ws = this.ws; this.ws = null;
      try { ws && ws.readyState <= 1 && ws.close(); } catch {}
      this.dropCtx0();
      this.active = false; this.stopping = false;
      throw e;
    }
  },

  onChannel(i, data) {
    this.queues[i].push(data);
    const mic = this.queues[0], remote = this.queues[1];
    while (mic.length && remote.length) {
      const a = mic.shift(), b = remote.shift();
      this.onChunk({ pcm: interleavePcm(a.pcm, b.pcm), level: Math.max(a.level || 0, b.level || 0), frame: a.frame, rate: a.rate });
    }
    if (mic.length >= 4 && !remote.length) this.padChannel(0);
    if (remote.length >= 4 && !mic.length) this.padChannel(1);
  },
  padChannel(i) {
    const src = this.queues[i].shift();
    if (!src) return;
    const n = new Int16Array(src.pcm).length;
    const silent = new Int16Array(n).buffer;
    const pcm = i === 0 ? interleavePcm(src.pcm, silent) : interleavePcm(silent, src.pcm);
    this.onChunk({ pcm, level: src.level || 0, frame: src.frame, rate: src.rate });
  },
  drainDualQueues() {
    if (this.channels !== 2) return;
    const mic = this.queues[0], remote = this.queues[1];
    while (mic.length && remote.length) {
      const a = mic.shift(), b = remote.shift();
      this.onChunk({ pcm: interleavePcm(a.pcm, b.pcm), level: Math.max(a.level || 0, b.level || 0), frame: a.frame, rate: a.rate });
    }
    while (mic.length) this.padChannel(0);
    while (remote.length) this.padChannel(1);
  },

  onChunk({ pcm, level, frame, rate }) {
    const now = performance.now();
    this.level = level;
    if (frame !== undefined) {
      const off = now - frame / rate * 1000;
      const c = this.clock || (this.clock = { base: off, cand: null });
      if (this.paused) {
        // 主动暂停期间不计缺口，保持音频时钟锚点同步
        c.base = off; c.cand = null;
      } else {
        const d = off - c.base;
        if (c.cand) {
          c.cand.min = Math.min(c.cand.min, d);
          if (now - c.cand.t >= 2000 && ++c.cand.n >= 5) {
            if (c.cand.min > 1200) { this.addGap(c.cand.min, c.cand.reason, c.cand.at); c.base += c.cand.min; }
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
    if (this.stall) { this.stall = null; this.emit("lost"); }
    if (this.active && !this.paused) {
      if (this.next - this.base >= BUF_MAX) {
        this.dropped += this.chunkBytes();
        if (!this.overflow) this.overflow = { t: now, at: this.elapsedMs() };
      } else {
        if (this.overflow) { this.addGap(now - this.overflow.t, "overflow", this.overflow.at); this.overflow = null; }
        this.buf.push(pcm); this.next++; this.samples += 1600;
        this.flush();
      }
    }
    this.emit("tick");
  },

  gapReason() {
    return document.hidden || this.flags.hidden ? "hidden" : this.flags.interrupted ? "interrupted" : this.flags.muted ? "muted" : "stall";
  },
  addGap(ms, reason, at) {
    at = Math.round(at ?? this.elapsedMs());
    const same = this.gaps.find(g => Math.abs(g.at_ms - at) < 1500);
    if (same) { if (ms > same.dur_ms) { same.dur_ms = Math.round(ms); this.sendCtl({ ...same }); } return; }
    const g = { type: "gap", at_ms: at, dur_ms: Math.round(ms), reason };
    this.gaps.push(g); this.sendCtl(g);
    this.emit("gap");
    if (!document.hidden) toast(`刚才有 ${Math.max(1, Math.round(ms / 1000))} 秒没录到：${GAP_TEXT[reason]}。转写稿里会标出这一段。`, 6000);
  },

  checkStall() {
    if (this.conn === "ok" && (this.active || this.stopping) && (!this.ws || this.ws.readyState >= 2)) {
      this.ws = null; clearTimeout(this.stopT); this.stopT = null;
      this.conn = "reconnecting"; this.stopSentOn = null; this.emit("conn"); this.scheduleReconnect(true);
    }
    // 已经发送 stop 等待服务端收尾时，不再因为 8 秒没 ack 而误杀正常连接（交由 stopT 与 socket 断连处理）
    const awaitingStopAck = this.stopping && this.stopSentOn && this.stopSentOn === this.ws;
    if (!awaitingStopAck && this.conn === "ok" && this.ws && this.ws.readyState === 1 && performance.now() - this.lastAck > 8000) {
      const ws = this.ws; this.ws = null;
      try { ws.close(); } catch {}
      clearTimeout(this.stopT); this.stopT = null;
      this.conn = "reconnecting"; this.stopSentOn = null; this.emit("conn"); this.scheduleReconnect(true);
    }
    if (!this.active || this.paused || !this.lastChunk || this.stall) return;
    if (performance.now() - this.lastChunk > 1500) { this.stall = { reason: this.gapReason() }; this.emit("lost"); }
  },

  stat() { return { type: "stat", produced: this.next * this.chunkBytes() + this.dropped, dropped: this.dropped }; },
  sendCtl(msg, replace) {
    if (replace) this.ctl = this.ctl.filter(m => m.type !== msg.type);
    this.ctl.push(msg); this.flushCtl();
  },
  flushCtl() {
    const ws = this.ws; if (!ws || ws.readyState !== 1 || this.conn !== "ok") return;
    while (this.ctl.length) ws.send(JSON.stringify(this.ctl.shift()));
  },
  flush() {
    clearTimeout(this.flushT); this.flushT = null;
    const ws = this.ws; if (!ws || ws.readyState !== 1 || this.conn !== "ok") return;
    while (this.sent < this.next && ws.bufferedAmount < 256 * 1024) {
      ws.send(this.buf[this.sent - this.base]);
      this.sent++;
    }
    if (this.sent < this.next) {
      this.flushT = setTimeout(() => this.flush(), 100);
    } else if (this.stopping) {
      if (ws.bufferedAmount > 0) this.flushT = setTimeout(() => this.flush(), 50);
      else this.sendStop();
    }
  },
  ackTo(bytes) {
    const idx = Math.min(this.next, Math.floor(bytes / this.chunkBytes()));
    if (idx > this.base) { this.buf.splice(0, idx - this.base); this.base = idx; }
    if (this.sent < this.base) this.sent = this.base;
  },

  connect(first) {
    const ws = new WebSocket(wsUrl(`/ws/live/${this.mid}?rec=${this.rec}&ch=${this.channels || 1}`));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    return new Promise((res, rej) => {
      let ok = false;
      ws.onmessage = ev => {
        if (this.ws !== ws) return;
        const j = JSON.parse(ev.data);
        if (j.type === "ready") { ok = true; this.onReady(j, first); res(); }
        else if (j.type === "stopped") { ok = true; res(); this.onStopped(j); }
        else if (j.type === "error" && !ok) rej(Object.assign(new Error(j.msg), { code: j.code }));
        else if (j.type === "status") toast(j.msg);
        else this.onMsg(j);
      };
      ws.onerror = () => {
        if (!ok) rej(new Error(REMOTE && /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && "ontouchend" in document
          ? "实时转写连接失败。iPhone / iPad 上要先安装并信任电脑的证书（电脑上“设置 · 平板、手机访问”里有步骤）" : "连接服务失败"));
      };
      ws.onclose = () => { if (!ok) rej(new Error("连接已关闭")); else this.onClose(ws); };
    });
  },

  onReady(j, first) {
    clearTimeout(this.stopT); this.stopT = null;
    if (first) { this.offsetMs = j.offset_ms; this.startBytes = j.start_bytes; }
    this.ackTo(j.file_bytes - this.startBytes);
    this.sent = this.base;
    const was = this.conn; this.conn = "ok"; this.retry = 0; this.lastAck = performance.now();
    this.flushCtl(); this.flush();
    if (!first && was !== "ok") {
      this.emit("conn");
      toast(j.resumed ? "已重新连上电脑，断开期间的录音已补传" : "已重新连上电脑");
    }
  },

  onMsg(j) {
    if (j.type === "ack") { this.lastAck = performance.now(); this.ackTo(j.bytes); this.emit("ack"); return; }
    if (j.type === "end_requested") {
      if (this.stopping) return; // 已在结束流程中，防止重复触发提前退页
      toast("在别的设备上点了结束录音");
      Promise.resolve(hooks.saveNotesNow && hooks.saveNotesNow()).finally(() => {
        this.stop().then(() => this.emit("closed"));
      });
      return;
    }
    if (j.type === "partial") this.partial = j;
    else if (j.type === "final") { this.finals.push(j); this.partial = null; }
    else if (j.type === "error") toast(j.msg, 5000);
    this.emit(j.type);
  },

  onClose(ws) {
    if (ws !== this.ws || (!this.active && !this.stopping)) return;
    clearTimeout(this.stopT); this.stopT = null; // 重连补传期间绝不能让旧 stopT 误超时丢稿
    this.conn = "reconnecting"; this.stopSentOn = null; this.emit("conn");
    this.scheduleReconnect();
  },

  scheduleReconnect(now) {
    clearTimeout(this.retryT);
    if (this.conn !== "reconnecting") return;
    const delay = now ? 0 : [500, 1000, 2000, 3000, 5000][Math.min(this.retry, 4)];
    this.retryT = setTimeout(async () => {
      this.retry++;
      try { await this.connect(false); }
      catch (e) {
        if (e.code === "busy" || e.code === "gone") { toast(e.message + "，这里的录音停止了", 8000); this.cleanup(); this.emit("closed"); return; }
        this.scheduleReconnect();
      }
    }, delay);
  },

  onStopped(j) {
    clearTimeout(this.stopT); this.stopT = null;
    const totalBytes = this.next * this.chunkBytes();
    const lost = j.file_bytes != null
      ? Math.max(0, this.startBytes + totalBytes - j.file_bytes)
      : Math.max(0, (this.next - this.base) * this.chunkBytes());
    if (j.already && lost >= this.chunkBytes()) {
      toast(`电脑那边已经结束了这次录音，最后 ${Math.round(lost / this.bytesPerSec())} 秒没能传上`, 8000);
    } else if (j.timeout && lost >= this.chunkBytes()) {
      toast(`等待电脑确认超时，最后 ${fmtDur(lost / this.bytesPerSec())} 的录音可能没有保存`, 8000);
    }
    const r = this.stopRes; this.stopRes = null;
    if (r) r({ lost, timeout: !!j.timeout });
    else { this.cleanup(); this.emit("closed"); }
  },

  watch(s, kind) {
    s.getTracks().forEach(t => {
      t.onended = () => {
        if (!this.active) return;
        this.lost = kind; this.emit("lost");
        toast(kind === "sys"
          ? (this.channels === 2 ? "电脑声音已断开（停止了共享）。这一路先记成静音，麦克风继续单独录" : "电脑声音已断开（停止了共享），现在只录麦克风")
          : "麦克风断开了，现在录不到声音", 6000);
      };
      if (kind !== "mic") return;
      t.onmute = () => {
        this.flags.muted = true;
        if (this.active && !this.paused) this.muted = { t: performance.now(), at: this.elapsedMs(), hidden: document.hidden };
        clearTimeout(this.muteT);
        this.muteT = setTimeout(() => { if (this.active && t.muted && !this.lost) { this.lost = "mic"; this.emit("lost"); } }, 3000);
      };
      t.onunmute = () => {
        clearTimeout(this.muteT);
        this.endMute();
        if (this.lost === "mic" && t.readyState === "live") { this.lost = null; this.emit("lost"); }
      };
    });
  },
  endMute() {
    const m = this.muted; this.muted = null;
    if (m && performance.now() - m.t > 1500) this.addGap(performance.now() - m.t, m.hidden || document.hidden || this.flags.hidden ? "hidden" : "muted", m.at);
  },

  async reconnect() {
    const kind = this.lost; if (!kind || !this.active || this._reconnecting) return;
    this._reconnecting = true;
    let s;
    try {
      try { s = kind === "sys" ? await getSysAudio() : await navigator.mediaDevices.getUserMedia(MIC_OPTS); }
      catch (e) { throw e.name === "NotAllowedError" ? new Error("没有获得麦克风/屏幕共享权限") : e; }
      // 权限弹窗期间可能已经点了结束录音：立刻释放新流，不再碰已关闭的 AudioContext
      if (!this.active || !this.ctx || this.ctx.state === "closed") {
        stopStreamTracks(s);
        return;
      }
      const idx = kind === "sys" ? 1 : 0;
      const node = (this.nodes && this.nodes[idx]) || this.node;
      // 停掉并替换同槽位旧轨与旧源节点，避免静音恢复后双轨叠加及 wakeAudio 检查旧轨
      try { this.sources[idx] && this.sources[idx].disconnect(); } catch {}
      stopStreamTracks(this.streams[idx]);
      const src = this.ctx.createMediaStreamSource(s);
      src.connect(node);
      this.sources[idx] = src;
      this.streams[idx] = s;
      this.watch(s, kind);
      this.lost = null; this.emit("lost");
    } finally {
      this._reconnecting = false;
    }
  },

  async wakeAudio() {
    if (this.ctx && this.ctx.state !== "running" && this.ctx.state !== "closed") await this.ctx.resume().catch(() => {});
    const mic = this.streams[0] && this.streams[0].getAudioTracks()[0];
    if (mic && mic.readyState === "ended" && !this.lost) { this.lost = "mic"; this.emit("lost"); }
  },

  pause() { this.paused = true; hooks.renderPill && hooks.renderPill(); },
  resume() { this.paused = false; this.lastChunk = performance.now(); hooks.renderPill && hooks.renderPill(); },

  async stop() {
    if (this.stopping && this.stopPromise) return this.stopPromise;
    if (!this.active) return { lost: 0 };
    // 先把双声道尚未配对的尾块补齐送进 buf，再停收音
    this.drainDualQueues();
    this.active = false; this.stopping = true; this.lastAck = performance.now();
    this.timers.forEach(clearInterval); this.timers = [];
    if (this.overflow) { this.addGap(performance.now() - this.overflow.t, "overflow", this.overflow.at); this.overflow = null; }
    this.endMute();
    this.sources.forEach(src => { try { src && src.disconnect(); } catch {} });
    this.streams.forEach(stopStreamTracks);
    try { await this.ctx.close(); } catch {}
    this.emit("conn");
    hooks.renderPill && hooks.renderPill();
    this.timers = [setInterval(() => this.checkStall(), 1000)];
    this.stopPromise = new Promise(res => { this.stopRes = res; this.flush(); })
      .finally(() => { this.cleanup(); hooks.renderPill && hooks.renderPill(); });
    return this.stopPromise;
  },

  sendStop() {
    const ws = this.ws;
    if (!this.stopping || this.conn !== "ok" || !ws || ws.readyState !== 1 || this.sent < this.next || ws.bufferedAmount > 0 || this.stopSentOn === ws) return;
    this.stopSentOn = ws;
    this.flushCtl();
    ws.send(JSON.stringify({ ...this.stat(), type: "stop" }));
    clearTimeout(this.stopT);
    this.stopT = setTimeout(() => this.stopRes && this.onStopped({ timeout: true }), 30000);
  },

  giveUp() {
    const r = this.stopRes; if (!r) return;
    this.stopRes = null;
    clearTimeout(this.stopT); this.stopT = null;
    r({ lost: (this.next - this.base) * this.chunkBytes(), gaveUp: true });
  },

  cleanup() {
    this.active = false; this.stopping = false; this._reconnecting = false; this.stopPromise = null;
    this.timers.forEach(clearInterval); this.timers = [];
    clearTimeout(this.retryT); this.retryT = null;
    clearTimeout(this.flushT); this.flushT = null;
    clearTimeout(this.stopT); this.stopT = null;
    clearTimeout(this.muteT); this.muteT = null;
    this.sources.forEach(src => { try { src && src.disconnect(); } catch {} });
    this.sources = [];
    this.streams.forEach(stopStreamTracks);
    this.streams = [];
    this.queues = [[], []];
    try { this.ctx && this.ctx.state !== "closed" && this.ctx.close(); } catch {}
    const ws = this.ws; this.ws = null;
    try { ws && ws.readyState <= 1 && ws.close(); } catch {}
    try { this.wake && this.wake.release(); } catch {}
    this.wake = null; this.buf = []; this.conn = "ok";
  },
};

export function initRecorderListeners() {
  document.addEventListener("visibilitychange", () => {
    if (!REC.active && !REC.stopping) return;
    if (document.visibilityState !== "visible") { REC.flags.hidden = true; return; }
    REC.keepAwake();
    if (REC.ctx && REC.ctx.state !== "running" && REC.ctx.state !== "closed") REC.ctx.resume().catch(() => {});
    if (REC.conn === "reconnecting") REC.scheduleReconnect(true);
  });
  window.addEventListener("online", () => { if (REC.conn === "reconnecting") REC.scheduleReconnect(true); });
}
