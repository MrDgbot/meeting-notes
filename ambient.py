"""全天模式：后台直接从电脑麦克风持续采音，只在有人说话时录音与转写，按长静音把一天切成一段段对话。
采音用 ffmpeg：macOS 用 avfoundation，Linux 用 PulseAudio / PipeWire（没有就用 ALSA），Windows 用 DirectShow。

开销（M 系列 Mac 实测）：
- 没人说话：只跑 ffmpeg 采音 + FSMN-VAD（CPU，每 0.3 秒一块）≈ 单核 3%
- 有人说话：每句话说完识别一次（MPS）；有网页在看时说话过程中每秒再出一次临时文字；
  一段对话结束后整段精准转写 + 说话人区分
存储：只写有人说话的音频（句间静音最多保留 1.5 秒）；精准转写后只留 mp3（约 29MB/小时发言）。
"""
import logging
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime

import numpy as np

import store
import vocab
from asr_engine import SR

log = logging.getLogger("ambient")

DEFAULTS = {
    "enabled": False,
    "device": "",  # 采音设备名（list_devices() 里的名字）；空 = 系统默认输入
    "hotword": "",  # 常用人名/术语，所有自动记录都会用
    "split_min": 5,  # 静音超过 N 分钟，结束当前对话
    "min_speech_s": 20,  # 有效发言不足 N 秒的对话直接丢弃（咳嗽、偶尔一句话）
    "max_conv_min": 120,  # 单段对话最长 N 分钟（按录音长度），超出自动切开
    "summary_time": "21:30",  # 每天自动生成当日汇总；空 = 不自动
    "audio_keep_days": 30,  # 自动记录的录音保留天数，0 = 永久；文字一直保留
    "keep_awake": True,  # 开启期间阻止电脑空闲休眠（屏幕仍可关闭）
    "sensitivity": "high",  # 收音灵敏度，见 SENS
    "paused_until": 0,  # 暂停到什么时候（时间戳）；-1 = 直到手动恢复。存下来，重启服务后仍保持暂停
}
# VAD 每次处理 0.3 秒：开口后约 0.6 秒判断出有人说话（1 秒一块要 0.9~1.3 秒），开销约单核 3%（1 秒一块约 1%），切分结果相同
CHUNK_MS = 300
PARTIAL_EVERY = 1.0  # 有网页在看时，说话过程中每秒出一次临时文字
# 收音灵敏度 = FSMN-VAD 的 speech_noise_thres：语音概率要比静音概率高出多少才算有人说话，越小越灵敏。
# 实测把办公室远场录音整体调小 6dB（相当于人离远一倍）：0.6（模型默认）漏掉 22% 的句子，0.4 漏 12%，
# 0.2 漏 4%，但把杂音当人声的时长是默认的 3 倍。误触发的片段识别不出字，不算有效发言（见 _worker）
SENS = {"normal": 0.6, "high": 0.4, "max": 0.2}
PAD_MS = 250  # 每句前后多留的音频
GAP_KEEP_MS = 1500  # 对话内两句之间最多保留的静音
MERGE_GAP_S = 2.5  # 实时文字：与上一句间隔小于这个秒数就合起来重新识别
MERGE_MAX_MS = 20000  # 合并后最长 20 秒


def get_cfg() -> dict:
    return {**DEFAULTS, **(store.get_settings().get("ambient") or {})}


def sens_thres(cfg: dict | None = None) -> float:
    return SENS.get((cfg or get_cfg()).get("sensitivity"), SENS["high"])


def save_cfg(cfg: dict) -> dict:
    s = store.get_settings()
    s["ambient"] = {k: cfg.get(k, v) for k, v in DEFAULTS.items()}
    store.save_settings(s)
    return s["ambient"]


# ---------- 采音设备（按系统） ----------
def _ffmpeg(*args: str) -> subprocess.CompletedProcess | None:
    try:  # Windows 上设备名可能是中文：ffmpeg 输出 UTF-8，不按系统编码（GBK）解
        return subprocess.run(["ffmpeg", "-hide_banner", *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=15)
    except (OSError, subprocess.SubprocessError):  # 没装 ffmpeg
        return None


def parse_avfoundation(stderr: str) -> list[str]:
    out, on = [], False
    for line in stderr.splitlines():
        if "audio devices" in line:
            on = True
            continue
        m = re.search(r"\]\s*\[(\d+)\]\s*(.+)$", line)
        if on and m:
            out.append(m.group(2).strip())
    return out


def parse_dshow(stderr: str) -> list[str]:
    """ffmpeg -list_devices true -f dshow 的输出。新版每行带 (audio)/(video)，旧版分“DirectShow audio devices”一节。"""
    out, sec = [], ""
    for line in stderr.splitlines():
        if "DirectShow audio devices" in line:
            sec = "audio"
        elif "DirectShow video devices" in line:
            sec = "video"
        m = re.search(r'\]\s+"(.+)"(?:\s+\(([^)]*)\))?\s*$', line)  # “Alternative name "@device…"”那行不匹配
        if m and ("audio" in m.group(2) if m.group(2) else sec == "audio"):
            out.append(m.group(1))
    return out


def parse_sources(stdout: str) -> list[str] | None:
    """ffmpeg -sources pulse|alsa 的输出，每行“[*] 名字 [说明]”。连不上音频服务时返回 None。"""
    if "Cannot list sources" in stdout or "Auto-detected sources" not in stdout:
        return None
    return [m.group(1) for line in stdout.splitlines() if (m := re.match(r"^\s*\*?\s*(\S+)\s+\[", line))]


def _linux_backend() -> tuple[str, list[str]]:
    """有 PulseAudio / PipeWire（pipewire-pulse）就用 pulse，否则用 ALSA。返回 (ffmpeg 输入格式, 设备列表)。"""
    p = _ffmpeg("-sources", "pulse")
    devs = parse_sources(p.stdout + p.stderr) if p else None
    if devs is not None:
        return "pulse", devs
    p = _ffmpeg("-sources", "alsa")
    devs = parse_sources(p.stdout + p.stderr) if p else None
    return "alsa", [d for d in devs or [] if d not in ALSA_PLUGINS]


# ALSA 列出来的这些是重采样、混音之类的插件，不是录音设备（null 是丢弃 / 静音设备）
ALSA_PLUGINS = {"null", "lavrate", "samplerate", "speexrate", "speex", "upmix", "vdownmix", "jack", "oss", "pulse"}


def list_devices() -> list[str]:
    if sys.platform == "darwin":
        p = _ffmpeg("-f", "avfoundation", "-list_devices", "true", "-i", "")
        return parse_avfoundation(p.stderr) if p else []
    if sys.platform == "win32":
        p = _ffmpeg("-list_devices", "true", "-f", "dshow", "-i", "dummy")
        return parse_dshow(p.stderr) if p else []
    return _linux_backend()[1]


def input_args(dev: str) -> list[str]:
    """ffmpeg 采音的输入参数。dev 是 list_devices() 里的名字，空 = 系统默认输入。"""
    if sys.platform == "darwin":
        return ["-f", "avfoundation", "-i", f":{dev or 'default'}"]
    if sys.platform == "win32":
        if not dev:  # DirectShow 没有“默认设备”这个名字：用列表里第一个音频输入
            devs = list_devices()
            if not devs:
                raise RuntimeError("没有找到麦克风（DirectShow 里没有音频输入设备）")
            dev = devs[0]
        # 缓冲默认 500ms，改小一点，开口后更快判断出有人说话
        return ["-f", "dshow", "-audio_buffer_size", "50", "-i", f"audio={dev}"]
    fmt = _linux_backend()[0]
    return ["-f", fmt, "-i", dev or "default"]


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds")


@dataclass
class Conv:
    mid: str
    f: object
    started: float  # 墙钟
    last_end: float  # 最后一句结束（墙钟）
    samples: int = 0  # 对话音频当前样本数
    speech_ms: int = 0
    n_seg: int = 0

    @property
    def pos_ms(self) -> int:
        return self.samples * 1000 // SR


class Ambient:
    def __init__(self, engine, on_closed):
        self.e = engine
        self.on_closed = on_closed  # 对话结束且有效 → 排队精准转写
        self.lock = threading.RLock()
        self.cfg = get_cfg()
        self.enabled = False
        pu = float(self.cfg.get("paused_until") or 0)
        self.paused_until = math.inf if pu < 0 else pu  # > now 表示暂停；inf = 直到手动恢复
        self.holds: set[str] = set()  # 网页手动录音时占用，暂停全天采集
        self.state = "off"  # off | starting | listening | speech | paused | held | error
        self.error = ""
        self.level_db = -100.0
        self.conv: Conv | None = None
        self.proc: subprocess.Popen | None = None
        self.caff: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None
        self._restart = False
        self.fallback = ""  # 选定的麦克风不在（如 iPhone 断开）时临时改用系统默认，这里记下原设备名
        self.q: queue.Queue = queue.Queue()
        self.viewers = 0  # 正在看的网页数（/ws/ambient 连接数）；没人看时不出临时文字，省 GPU
        self.partial: dict | None = None  # 说话过程中的临时文字 {"seq": 句子编号, "text": …}
        self.last: dict | None = None  # 最近一句定稿的实时文字 {"text", "at"}，卡片上显示一会儿
        self.live_rev = 0  # 实时文字每写一次 +1，网页据此刷新
        self._seq = 0  # 句子编号：每检测到一次开口 +1
        self._done_seq = 0  # 已出最终文字（或已放弃）的最大句子编号
        self._preq: tuple | None = None  # 最新一次临时识别请求 (句子编号, 音频)
        self._pev = threading.Event()
        self._plock = threading.Lock()
        self.voiced: dict[str, int] = {}  # 每段对话里识别出字的发言毫秒数
        self.discarded: dict | None = None  # 最近一次因发言太短丢弃的对话，网页据此提示
        threading.Thread(target=self._worker, daemon=True, name="ambient-asr").start()
        threading.Thread(target=self._partial_worker, daemon=True, name="ambient-partial").start()

    # ---------- 控制 ----------
    def start(self, restore: bool = False):
        """restore=True：服务启动时按上次状态恢复，保留没到期的暂停；用户手动开启时清掉暂停。"""
        with self.lock:
            self.cfg = get_cfg()
            if not self.cfg["enabled"]:
                self.cfg["enabled"] = True
                save_cfg(self.cfg)
            if self.enabled:
                return
            self.enabled, self.error = True, ""
            if not restore:
                self._set_pause(0.0)
            self._awake(True)
            self.thread = threading.Thread(target=self._loop, daemon=True, name="ambient-capture")
            self.thread.start()
            log.info("ambient mode started")

    def stop(self):
        with self.lock:
            self.cfg["enabled"] = False
            save_cfg(self.cfg)
            self.enabled = False
        self._kill_proc()
        if self.thread:
            self.thread.join(timeout=5)
        self._awake(False)
        log.info("ambient mode stopped")

    def pause(self, minutes: float | None):
        self._set_pause(time.time() + minutes * 60 if minutes else math.inf)
        self._kill_proc()  # 立刻关闭麦克风（菜单栏橙点消失）

    def resume(self):
        self._set_pause(0.0)

    def _set_pause(self, until: float):
        self.paused_until = until
        with self.lock:
            self.cfg = get_cfg()
            self.cfg["paused_until"] = -1 if until == math.inf else round(until)
            save_cfg(self.cfg)

    def hold(self, key: str):
        self.holds.add(key)
        self._kill_proc()

    def release(self, key: str):
        self.holds.discard(key)

    def split(self):
        """手动结束当前这段对话。"""
        self._close_conv()

    def discard(self, mid: str) -> bool:
        """用户删除正在记录的对话：停止写入且不转写。"""
        with self.lock:
            c = self.conv
            if not c or c.mid != mid:
                return False
            self.conv = None
            c.f.close()
            self.voiced.pop(mid, None)
            return True

    def reload_cfg(self):
        old = self.cfg
        self.cfg = get_cfg()
        changed = any(old.get(k) != self.cfg.get(k) for k in ("device", "sensitivity"))
        if changed and self.proc:  # 换麦克风 / 灵敏度：重开采集
            self._restart = True
            self._kill_proc()
        if old.get("keep_awake") != self.cfg.get("keep_awake") and self.enabled:
            self._awake(False)
            self._awake(True)

    def status(self) -> dict:
        c = self.conv
        pu = self.paused_until
        p, last = self.partial, self.last
        return {
            "enabled": self.enabled, "state": self.state, "error": self.error, "level_db": round(self.level_db, 1),
            "fallback": self.fallback,
            "paused_until": (-1 if pu == math.inf else pu) if pu > time.time() else 0,
            "conv": {"id": c.mid, "started": c.started, "last_end": c.last_end, "speech_s": round(c.speech_ms / 1000),
                     "dur_s": round(c.pos_ms / 1000), "voiced_s": round(self.voiced.get(c.mid, 0) / 1000)} if c else None,
            "partial": vocab.apply(p["text"]) if p else "",
            "last": vocab.apply(last["text"]) if last and time.time() - last["at"] < 20 else "",
            "live_rev": self.live_rev,
            "discarded": self.discarded if self.discarded and time.time() - self.discarded["at"] < 120 else None,
            "cfg": self.cfg,
        }

    # ---------- 采集循环 ----------
    def _blocked(self) -> str:
        if self.holds:
            return "held"
        if self.paused_until > time.time():
            return "paused"
        return ""

    def _loop(self):
        backoff = 2
        while self.enabled:
            b = self._blocked()
            if b:
                self._close_conv()
                self.state, self.level_db = b, -100.0
                time.sleep(0.5)
                continue
            if self.paused_until:  # 暂停到期自动恢复
                self._set_pause(0.0)
            if not self.e.ready:
                if self.e.error:  # 模型加载失败：不要一直显示“等待语音模型就绪”
                    self.state, self.error = "error", "语音模型加载失败：" + self.e.error[:200]
                else:
                    self.state = "starting"
                time.sleep(1)
                continue
            t0 = time.time()
            try:
                self._capture()
                if self.enabled and not self._blocked() and not self._restart:
                    raise RuntimeError("麦克风采集意外结束")
                self._restart = False
                backoff = 2
            except Exception as ex:  # noqa: BLE001
                log.warning("ambient capture: %s", ex)
                self.error, self.state, self.level_db = str(ex)[:300], "error", -100.0
                self._close_conv()
                if time.time() - t0 > 60:
                    backoff = 2
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        self._close_conv()
        self.state, self.level_db = "off", -100.0

    @staticmethod
    def _read_exact(f, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = f.read(n - len(buf))
            if not chunk:
                break
            buf += chunk
        return buf

    def _capture(self):
        want = self.cfg.get("device") or ""
        dev = want
        self.fallback = ""
        if want and not os.environ.get("AMBIENT_TEST_FILE") and want not in list_devices():
            # iPhone 等外接麦克风断开：先用系统默认麦克风继续录，设备回来后自动切回
            log.info("ambient: device %r not available, using default input", want)
            dev, self.fallback = "", want
        if os.environ.get("AMBIENT_TEST_FILE"):  # 测试用：用音频文件代替麦克风，可加速播放
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                   "-readrate", os.environ.get("AMBIENT_TEST_READRATE", "1"), "-readrate_initial_burst", "0",
                   "-i", os.environ["AMBIENT_TEST_FILE"],
                   "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
        else:
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", *input_args(dev),
                   "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.proc = proc
        err: list[str] = []
        threading.Thread(target=lambda: err.extend(proc.stderr.read().decode("utf-8", "ignore").splitlines()),
                         daemon=True).start()
        vad = self.e.new_vad(max_end_silence_time=800, max_single_segment_time=30000,
                             speech_noise_thres=sens_thres(self.cfg))
        cache: dict = {}
        nbytes = SR * CHUNK_MS // 1000 * 2
        ring = np.zeros(0, np.float32)  # 最近的音频，ring[0] 对应样本号 ring_base
        ring_base = fed = 0
        seg_start = None
        last_partial = 0.0
        last_now = time.time()

        def wall_of(ms: int) -> float:  # VAD 时间（本次采集内的毫秒）→ 墙钟
            return last_now - (fed / SR - ms / 1000)

        got_audio = False
        stop_probe = threading.Event()
        if self.fallback:
            def probe():  # 每 30 秒看一下原设备回来了没有
                while not stop_probe.wait(30):
                    if self.fallback in list_devices():
                        log.info("ambient: device %r is back, switching", self.fallback)
                        self._restart = True
                        self._kill_proc(proc)
                        return
            threading.Thread(target=probe, daemon=True).start()
        try:
            while self.enabled and not self._blocked() and not self._restart:
                data = self._read_exact(proc.stdout, nbytes)
                if len(data) < 2:
                    break
                data = data[: len(data) // 2 * 2]
                last_now = time.time()
                x = np.frombuffer(data, np.int16).astype(np.float32) / 32768.0
                fed += len(x)
                ring = np.concatenate([ring, x])
                self.level_db = 20 * math.log10(float(np.sqrt(np.mean(x * x))) + 1e-7)
                if not got_audio:
                    got_audio, self.error = True, ""
                r = vad.generate(input=x, cache=cache, is_final=False, chunk_size=CHUNK_MS)
                for beg, end in (r[0]["value"] if r else []):
                    if beg >= 0 and end >= 0:
                        self._seq += 1
                        self._segment(ring, ring_base, beg, end, wall_of, self._seq)
                        seg_start = None
                    elif beg >= 0:
                        self._seq += 1
                        seg_start, last_partial = beg, 0.0
                    elif end >= 0 and seg_start is not None:
                        self._segment(ring, ring_base, seg_start, end, wall_of, self._seq)
                        seg_start = None
                self.state = "speech" if seg_start is not None else "listening"
                if seg_start is not None and self.viewers and last_now - last_partial >= PARTIAL_EVERY:
                    a0 = max(0, (seg_start - PAD_MS) * SR // 1000 - ring_base)
                    if len(ring) - a0 >= SR * 0.6:  # 交给临时识别线程，采集不等它
                        last_partial = last_now
                        self._preq = (self._seq, ring[a0:].copy())
                        self._pev.set()
                c = self.conv
                if c and seg_start is None and last_now - c.last_end > float(self.cfg["split_min"]) * 60:
                    self._close_conv()
                # 只保留当前句开始以来的音频（无人说话时保留最近 3 秒）
                keep = (seg_start - PAD_MS) * SR // 1000 if seg_start is not None else fed - SR * 3
                cut = min(keep - ring_base, len(ring))
                if cut > 0:
                    ring = ring[cut:]
                    ring_base += cut
        finally:
            stop_probe.set()
            if seg_start is not None and fed:
                try:
                    self._segment(ring, ring_base, seg_start, fed * 1000 // SR, wall_of, self._seq)
                except Exception:  # noqa: BLE001
                    log.exception("flush segment")
            self._kill_proc(proc)
        if not got_audio and err and self.enabled and not self._blocked() and not self._restart:
            raise RuntimeError("无法打开麦克风：" + err[-1][:200])

    def _segment(self, ring, ring_base, beg: int, end: int, wall_of, seq: int):
        a0 = max(0, (beg - PAD_MS) * SR // 1000 - ring_base)
        a1 = min(len(ring), (end + PAD_MS) * SR // 1000 - ring_base)
        audio = ring[a0:a1].copy()
        if len(audio) < SR * 0.3:
            self._finish_seq(seq)
            return
        wb, we = wall_of(beg), wall_of(end)
        cfg = self.cfg
        with self.lock:
            c = self.conv
            if c and (wb - c.last_end > float(cfg["split_min"]) * 60 or c.pos_ms > float(cfg["max_conv_min"]) * 60000):
                self._close_conv()
                c = None
            if c is None:
                # 标题只是占位（title_auto），生成纪要后会换成纪要里的标题
                meta = store.create(title=datetime.fromtimestamp(wb).strftime("自动记录 %H:%M"), source="ambient",
                                    status="recording", started_at=iso(wb), title_auto=True)  # 热词用词库里的常用热词
                c = self.conv = Conv(meta["id"], open(store.mdir(meta["id"]) / "audio.pcm", "ab"), wb, wb)
                log.info("ambient: new conversation %s", c.mid)
            if c.samples:
                gap = int(min(GAP_KEEP_MS, max(0.0, (wb - c.last_end) * 1000)) * SR / 1000)
                c.f.write(np.zeros(gap, np.int16).tobytes())
                c.samples += gap
            start = c.pos_ms
            c.f.write((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
            c.f.flush()
            c.samples += len(audio)
            c.speech_ms += end - beg
            c.n_seg += 1
            c.last_end = we
            store.update(c.mid, duration=c.pos_ms / 1000, speech_s=round(c.speech_ms / 1000, 1), ended_at=iso(we))
            self.q.put(("seg", c.mid, audio, start, c.pos_ms, wb - PAD_MS / 1000, seq, end - beg))

    def _close_conv(self):
        with self.lock:
            c, self.conv = self.conv, None
        if c:
            c.f.close()
            self.q.put(("close", c.mid, c.speech_ms))

    def _finish_seq(self, seq: int):
        """这句已出最终文字（或太短放弃）：撤掉它的临时文字。"""
        with self._plock:
            self._done_seq = max(self._done_seq, seq)
            p = self.partial
            if p and p["seq"] <= seq:
                self.partial = None

    def _partial_worker(self):
        """说话过程中的临时文字：只识别最新的一次请求；最终识别排着队时先让路。"""
        while True:
            self._pev.wait()
            self._pev.clear()
            req, self._preq = self._preq, None
            if not req or req[0] <= self._done_seq or not self.q.empty():
                continue
            seq, audio = req
            try:
                text = self.e.asr_segment(audio, vocab.hotwords())
            except Exception:  # noqa: BLE001
                log.exception("ambient partial")
                continue
            with self._plock:
                if text and seq > self._done_seq:
                    self.partial = {"seq": seq, "text": text}

    # ---------- 识别（单独线程，按顺序处理） ----------
    def _worker(self):
        # 上一句：(mid, start, end, audio, 墙钟结束, 是否认出字, 发言毫秒)，用于把紧挨着的短句合起来重识别
        prev = None
        while True:
            item = self.q.get()
            try:
                if item[0] == "seg":
                    _, mid, audio, s, e, wall, seq, sp_ms = item
                    try:
                        if store.exists(mid):
                            prev = self._recognize(prev, mid, audio, s, e, wall, sp_ms)
                    finally:
                        self._finish_seq(seq)
                        self.live_rev += 1
                elif item[0] == "close":
                    _, mid, speech_ms = item
                    voiced = self.voiced.pop(mid, 0)
                    if not store.exists(mid):
                        continue
                    # 有效发言只算识别出字的：灵敏度调高后，杂音触发的片段识别不出字，不该让对话留下来
                    # 但用户在这段里写过笔记、改过标题或文字、生成过纪要/问答的，一律保留
                    if voiced < float(self.cfg["min_speech_s"]) * 1000 and not has_user_content(mid):
                        store.delete(mid)
                        self.discarded = {"id": mid, "at": time.time(), "voiced_s": round(voiced / 1000, 1),
                                          "min_s": float(self.cfg["min_speech_s"])}
                        log.info("ambient: discarded %s (speech %.1fs, voiced %.1fs)", mid, speech_ms / 1000, voiced / 1000)
                    else:
                        log.info("ambient: closed %s (speech %.0fs, voiced %.0fs)", mid, speech_ms / 1000, voiced / 1000)
                        self.on_closed(mid)
            except Exception:  # noqa: BLE001
                log.exception("ambient worker")

    def _recognize(self, prev, mid, audio, s, e, wall, sp_ms):
        wall_end = wall + len(audio) / SR
        segmap = store.load(mid, "segmap.json", [])
        segmap.append([s, round(wall, 2)])
        store.save(mid, "segmap.json", segmap)
        # 间隔很短的相邻句一起识别：一两秒的碎句上下文太少，合起来明显更准
        merge = (prev and prev[0] == mid and wall - prev[4] < MERGE_GAP_S
                 and e - prev[1] <= MERGE_MAX_MS and s >= prev[2])
        if merge:
            gap = np.zeros(int((s - prev[2]) * SR / 1000), np.float32)
            text = self.e.asr_segment(np.concatenate([prev[3], gap, audio]), vocab.hotwords())
            if not text:  # 合起来反而没认出字：保留上一句，这句单独识别
                merge = False
        if not merge:
            text = self.e.asr_segment(audio, vocab.hotwords())
        live = store.load(mid, "live.json", [])
        if merge:
            s0, audio = prev[1], np.concatenate([prev[3], gap, audio])
            if live and live[-1]["start"] == s0:
                live.pop()
            voiced_ms = sp_ms + (0 if prev[5] else prev[6])  # 上一句当时没认出字，合起来认出了：一起算
            sp_ms += prev[6]
        else:
            s0, voiced_ms = s, sp_ms
        if text:
            live.append({"start": s0, "end": e, "text": text})
            self.voiced[mid] = self.voiced.get(mid, 0) + voiced_ms
            self.last = {"text": text, "at": time.time()}
        store.save(mid, "live.json", live)
        return (mid, s0, e, audio, wall_end, bool(text), sp_ms)

    # ---------- 进程 ----------
    def _kill_proc(self, proc: subprocess.Popen | None = None):
        p = proc or self.proc
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
        if p is self.proc and (proc is None or proc is self.proc):
            self.proc = None

    def _awake(self, on: bool):
        if on and self.cfg.get("keep_awake", True) and not self.caff:
            self.caff = keep_awake()
        elif not on and self.caff:
            self.caff.terminate()
            self.caff = None

    def shutdown(self):
        self.enabled = False
        self._kill_proc()
        if self.thread:
            self.thread.join(timeout=5)
        self._close_conv()
        self._awake(False)


class _WinAwake:
    """Windows：SetThreadExecutionState 只对调用它的线程有效，单开一个线程一直占着，terminate() 时放开。"""

    def __init__(self):
        self._stop = threading.Event()
        threading.Thread(target=self._run, daemon=True, name="keep-awake").start()

    def _run(self):
        import ctypes
        k = ctypes.windll.kernel32
        k.SetThreadExecutionState(0x80000000 | 0x00000001)  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED：阻止睡眠，屏幕照常熄灭
        self._stop.wait()
        k.SetThreadExecutionState(0x80000000)

    def terminate(self):
        self._stop.set()


def keep_awake():
    """阻止电脑空闲休眠（屏幕照常熄灭），返回带 terminate() 的对象；这个系统上做不到就返回 None。"""
    pid = str(os.getpid())
    if sys.platform == "win32":
        return _WinAwake()
    if sys.platform == "darwin":
        # -i 阻止空闲休眠，-s 接电源时阻止系统休眠；屏幕照常熄灭。随本进程退出自动结束。
        cmd = ["caffeinate", "-i", "-s", "-w", pid]
    else:  # Linux（systemd）：tail --pid 等本进程退出，抑制随之解除
        cmd = ["systemd-inhibit", "--what=idle:sleep", "--who=会议记录", "--why=全天模式正在记录", "--mode=block",
               "tail", f"--pid={pid}", "-f", "/dev/null"]
    try:
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:  # 没有 systemd（容器里）等：不阻止休眠，照常记录
        log.info("keep awake not available: %s", cmd[0])
        return None


def has_user_content(mid: str) -> bool:
    """这段记录里有没有用户自己加的东西：笔记、改过的标题/说话人/文字、纪要、问答。"""
    d = store.mdir(mid)
    meta = store.get(mid) or {}
    if not meta.get("title_auto", True) or meta.get("speakers"):
        return True
    if (d / "notes.md").exists() and (d / "notes.md").read_text("utf-8").strip():
        return True
    if (d / "minutes.json").exists() or store.load(mid, "qa.json", []):
        return True
    return any(p.get("edited") for p in store.load(mid, "live.json", []))


def purge_candidates(keep_days: int) -> list[dict]:
    """超过保留天数、录音还在的自动记录。只清理已转写成功的：转写失败的还要靠录音重新转写。"""
    if not keep_days or keep_days <= 0:
        return []
    cutoff = time.time() - keep_days * 86400
    return [m for m in store.list_all()
            if m.get("source") == "ambient" and not m.get("audio_purged") and m["status"] == "ready"
            and datetime.fromisoformat(m["created"]).timestamp() < cutoff]


def purge_old_audio(keep_days: int) -> int:
    """删除超过保留天数的自动记录录音（文字、纪要保留）。"""
    ms = purge_candidates(keep_days)
    for m in ms:
        d = store.mdir(m["id"])
        for name in ("audio.pcm", "audio.wav", "audio.mp3"):
            (d / name).unlink(missing_ok=True)
        store.update(m["id"], audio_purged=True)
    return len(ms)
