"""全天模式：后台直接从电脑麦克风持续采音，只在有人说话时录音与转写，按长静音把一天切成一段段对话。
采音用 ffmpeg：macOS 用 avfoundation，Linux 用 PulseAudio / PipeWire（没有就用 ALSA），Windows 用 DirectShow。

开销（M 系列 Mac 实测）：
- 没人说话：只跑 ffmpeg 采音 + FSMN-VAD（CPU，每 0.3 秒一块）≈ 单核 3%
- 有人说话：每句话说完识别一次（MPS）；有网页在看时说话过程中每秒再出一次临时文字；
  一段对话结束后整段精准转写 + 说话人区分
存储：对话内写连续的真实音频（句间不超过 GAP_KEEP_MS 的停顿原样保留，不再用数字静音代替；设置里选「不跳过静音」则停顿全部保留）；
更长的静音不写进文件，而是记一个「跳过」（skips.json），播放器上显示跳点和真实时间。精准转写后只留 mp3（64kbps，约 29MB/小时）。
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
from collections import deque
from dataclasses import dataclass
from datetime import datetime

import numpy as np

import store
import vocab
from asr_engine import SR, decode_capped, recent_context

log = logging.getLogger("ambient")

DEFAULTS = {
    "enabled": False,
    "device": "",  # 采音设备名（list_devices() 里的名字）；空 = 系统默认输入
    "hotword": "",  # 常用人名/术语，所有自动记录都会用
    "split_min": 5,  # 静音超过 N 分钟，结束当前对话
    "min_speech_s": 20,  # 有效发言不足 N 秒的对话移进回收站（咳嗽、偶尔一句话），7 天内可恢复
    "max_conv_min": 120,  # 单段对话最长 N 分钟（按录音长度），超出自动切开
    "summary_time": "21:30",  # 每天自动生成当日汇总；空 = 不自动
    "audio_keep_days": 30,  # 自动记录的录音保留天数，0 = 永久；文字一直保留
    "keep_awake": True,  # 开启期间阻止电脑空闲休眠（屏幕仍可关闭）
    "sensitivity": "high",  # 收音灵敏度，见 SENS
    "paused_until": 0,  # 暂停到什么时候（时间戳）；-1 = 直到手动恢复。存下来，重启服务后仍保持暂停
    "keep_silence": False,  # True = 对话里的停顿不管多长都原样录下（不记跳点）；只影响之后的新录音
}
# VAD 每次处理 0.3 秒：开口后约 0.6 秒判断出有人说话（1 秒一块要 0.9~1.3 秒），开销约单核 3%（1 秒一块约 1%），切分结果相同
CHUNK_MS = 300
PARTIAL_EVERY = 1.0  # 有网页在看时，说话过程中每秒出一次临时文字
# 收音灵敏度 = FSMN-VAD 的 speech_noise_thres：语音概率要比静音概率高出多少才算有人说话，越小越灵敏。
# 实测把办公室远场录音整体调小 6dB（相当于人离远一倍）：0.6（模型默认）漏掉 22% 的句子，0.4 漏 12%，
# 0.2 漏 4%，但把杂音当人声的时长是默认的 3 倍。误触发的片段识别不出字，不算有效发言（见 _worker）
SENS = {"normal": 0.6, "high": 0.4, "max": 0.2}
PAD_MS = 250  # 每句前后多留的音频
GAP_KEEP_MS = 3000  # 两句之间的停顿不超过这么长：原样写真实音频（环境声），播放连贯
RING_IDLE_MS = 6000  # 没人说话时环形缓冲保留最近这么久，够补上 GAP_KEEP_MS 的停顿
SKIP_FADE_MS = 20  # 跳点后的音频淡入，避免咔哒声
KEEP_SILENCE_MAX_MIN = 30  # 「不跳过静音」时缓冲最多留这么久（30 分钟 float32 约 115MB），再长的停顿只能记跳点
MP3_KBPS = 64  # 精准转写后只留的 mp3 码率（asr_engine.make_mp3）


def gap_keep_ms(cfg: dict) -> int:
    """两句之间多长的停顿原样写进文件。不跳过静音：到「静音多久算对话结束」为止都写（超过就是另一段对话了）。"""
    if cfg.get("keep_silence"):
        return int(min(float(cfg.get("split_min") or 5), KEEP_SILENCE_MAX_MIN) * 60000)
    return GAP_KEEP_MS


def ring_keep_from(seg_start_ms: int | None, fed: int, gap_ms: int) -> int:
    """环形缓冲从第几个样本开始保留。

    说话时也要留住这句开头之前 gap_ms 的音频：句间停顿要靠它补上。以前说话时只留到这句开头，
    多数句子（开口和说完不在同一块里）的停顿就没了，0.2 秒的换气也被记成跳点。
    """
    back = (gap_ms + RING_IDLE_MS - GAP_KEEP_MS) * SR // 1000  # 多留 3 秒余量
    if seg_start_ms is None:
        return fed - back
    return (seg_start_ms - PAD_MS) * SR // 1000 - back


def storage_estimate(metas: list[dict], days: int = 14, kbps: int = MP3_KBPS, now: float | None = None) -> dict:
    """按最近 days 天的全天记录估算每天占多少空间：跳过静音 = 录音时长；不跳过 = 每段对话从开始到结束的墙钟时长。"""
    now = now or time.time()
    mb_h = kbps * 1000 / 8 * 3600 / 1e6
    since = now - days * 86400
    skip_s = cont_s = 0.0
    active = set()
    for m in metas:
        if m.get("source") != "ambient":
            continue
        try:
            t0 = datetime.fromisoformat(m.get("started_at") or m["created"]).timestamp()
            t1 = datetime.fromisoformat(m.get("ended_at") or m.get("started_at") or m["created"]).timestamp()
        except (KeyError, ValueError, TypeError):
            continue
        if t0 < since:
            continue
        dur = float(m.get("duration") or 0)
        skip_s += dur
        cont_s += max(dur, t1 - t0)
        active.add(datetime.fromtimestamp(t0).date())
    n = max(1, len(active))
    return {"mb_per_hour": round(mb_h, 1), "days": len(active),
            "skip_h_day": round(skip_s / 3600 / n, 2), "cont_h_day": round(cont_s / 3600 / n, 2),
            "skip_mb_day": round(skip_s / 3600 / n * mb_h), "cont_mb_day": round(cont_s / 3600 / n * mb_h)}


def plan_write(same_capture: bool, wrote_abs: int | None, a0: int, a1: int, ring_base: int, keep: int):
    """这一句要往对话文件里写哪一段（采集内的绝对样本号），以及中间有没有跳过。

    返回 (从, 到, 跳过的样本数)。
    - 和上一句挨着或重叠：从上一句写到的地方接着写，不重复（以前两边各留 250ms 会把这段重复播一遍）。
    - 间隔不超过 keep 且缓冲里还有：把间隔里的真实音频一起写上，不用数字静音代替。
    - 更长、换了采集进程、或者缓冲里已经没有：从这一句开头写，返回跳过的长度（调用方记成跳点）。
    """
    if same_capture and wrote_abs is not None:
        if a1 <= wrote_abs:
            return wrote_abs, wrote_abs, 0
        if a0 <= wrote_abs:
            return wrote_abs, a1, 0
        if a0 - wrote_abs <= keep and wrote_abs >= ring_base:
            return wrote_abs, a1, 0
        return a0, a1, a0 - wrote_abs
    return a0, a1, -1  # -1：不知道跳了多久（换了采集进程），按墙钟算


def join_clips(a: np.ndarray, b: np.ndarray, gap_ms: int) -> np.ndarray:
    """两句音频按文件里的相对位置拼起来：有间隔补静音（只给识别用），重叠就去掉 b 开头重复的部分。"""
    n = int(gap_ms * SR / 1000)
    if n >= 0:
        return np.concatenate([a, np.zeros(n, np.float32), b])
    return np.concatenate([a, b[min(len(b), -n):]])


def skips_from_segmap(segmap: list | None, min_s: float = 0.6) -> list[dict]:
    """老录音没有 skips.json：用分段映射（文件位置 → 墙钟）推出哪里被压掉了静音。"""
    out = []
    sm = segmap or []
    for (p0, w0), (p1, w1) in zip(sm, sm[1:]):
        lost = (w1 - w0) - (p1 - p0) / 1000
        if lost >= min_s:
            out.append({"pos_ms": int(p1), "skipped_s": round(lost, 1), "from": round(w1 - lost, 2), "to": round(w1, 2)})
    return out
# 句尾静音多久才断句。800ms 会在换气处切开，实时稿碎；1200ms 多等 0.4 秒，少切在半句上。
END_SILENCE_MS = 1200
MERGE_GAP_S = 2.5  # 两句间隔再大就不并：这已经是一句和下一句之间的停顿
MERGE_MAX_MS = 30000  # 并完最长 30 秒，和 VAD 单段上限一致。再长就停在这一处停顿，不从句子中间截


# ---------- 采集状态机 ----------
# 状态由采集线程按“开没开 / 有没有被手动录音占用 / 暂停没 / 模型好没好 / 有没有人在说话”算出来。
# 以前散落在 _loop/_capture 里直接给 self.state 赋值；现在都走 Ambient._set_state()，
# 不在表里的跳转只记 warning，照样切过去（不改变行为），GET /api/state 能看到最近的跳转。
OFF, STARTING, LISTENING, SPEECH, PAUSED, HELD, ERROR = "off", "starting", "listening", "speech", "paused", "held", "error"
STATES = (OFF, STARTING, LISTENING, SPEECH, PAUSED, HELD, ERROR)
TRANSITIONS: dict[str, set[str]] = {
    OFF: {STARTING, LISTENING, SPEECH, PAUSED, HELD, ERROR},  # 开启后第一轮循环
    STARTING: {STARTING, LISTENING, SPEECH, PAUSED, HELD, ERROR, OFF},
    LISTENING: {LISTENING, SPEECH, PAUSED, HELD, ERROR, OFF},  # 模型加载好以后不会再回到 starting
    SPEECH: {SPEECH, LISTENING, PAUSED, HELD, ERROR, OFF},
    PAUSED: {PAUSED, STARTING, LISTENING, SPEECH, HELD, ERROR, OFF},
    HELD: {HELD, STARTING, LISTENING, SPEECH, PAUSED, ERROR, OFF},
    ERROR: {ERROR, STARTING, LISTENING, SPEECH, PAUSED, HELD, OFF},
}


def should_merge_segment(prev_start_ms: int, prev_end_ms: int, prev_wall_end: float, this_wall: float,
                         this_end_ms: int, gap_s: float = MERGE_GAP_S, max_ms: int = MERGE_MAX_MS) -> bool:
    """间隔够近、并完不超过上限，才把下一句并进上一句重识别。

    超过上限返回 False：切在 VAD 给出的停顿上，而不是把已经很长的一段再粘过去。
    """
    if this_wall - prev_wall_end >= gap_s:
        return False
    if this_end_ms < prev_end_ms:
        return False
    if this_end_ms - prev_start_ms > max_ms:
        return False
    return True


def parse_iso(value: str) -> float | None:
    try:
        return datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError):
        return None


def is_stuck_ambient(meta: dict, now: float, split_min: float, active_id: str | None = None,
                     pending: set | None = None) -> bool:
    """全天记录已经停了，却还停在 recording、没有去排队精准转写。

    正在写的那一段（active_id）和已经排队收尾的（pending）不算。
    最后一句的结束时间超过「静音多久算一段结束」才算卡住，避免把刚开口的对话提前收掉。
    """
    if meta.get("source") != "ambient" or meta.get("status") != "recording":
        return False
    mid = meta.get("id")
    if not mid or mid == active_id or (pending and mid in pending):
        return False
    ended = parse_iso(meta.get("ended_at") or "")
    if ended is None:
        ended = parse_iso(meta.get("started_at") or meta.get("created") or "")
    if ended is None:
        return False
    return now - ended > float(split_min) * 60


def get_cfg() -> dict:
    return {**DEFAULTS, **(store.get_settings().get("ambient") or {})}


def sens_thres(cfg: dict | None = None) -> float:
    return SENS.get((cfg or get_cfg()).get("sensitivity"), SENS["high"])


def save_cfg(cfg: dict) -> dict:
    with store.locked():
        s = store.get_settings()
        s["ambient"] = {k: cfg.get(k, v) for k, v in DEFAULTS.items()}
        store.save_settings(s)
        return s["ambient"]


# ---------- 采音设备（按系统） ----------
_NO_WIN = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}


def _ffmpeg(*args: str) -> subprocess.CompletedProcess | None:
    try:  # Windows 上设备名可能是中文：ffmpeg 输出 UTF-8，不按系统编码（GBK）解
        return subprocess.run(["ffmpeg", "-hide_banner", *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=15, **_NO_WIN)
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


class _RingBuffer:
    """分块环形音频缓冲：append 与按绝对样本号裁剪均为 O(1)，避免 keep_silence=True 时反复整块拷贝。"""

    def __init__(self):
        self._chunks: deque[np.ndarray] = deque()
        self.base: int = 0
        self._len: int = 0

    def __len__(self) -> int:
        return self._len

    @property
    def end(self) -> int:
        return self.base + self._len

    def append(self, x: np.ndarray) -> None:
        if len(x):
            self._chunks.append(x)
            self._len += len(x)

    def trim_to(self, keep_abs: int) -> None:
        while self._chunks and self.base + len(self._chunks[0]) <= keep_abs:
            c = self._chunks.popleft()
            self.base += len(c)
            self._len -= len(c)

    def slice(self, a0_abs: int, a1_abs: int) -> np.ndarray:
        lo = max(self.base, a0_abs)
        hi = min(self.end, a1_abs)
        if hi <= lo:
            return np.zeros(0, np.float32)
        parts: list[np.ndarray] = []
        cur = self.base
        for c in self._chunks:
            nxt = cur + len(c)
            if nxt <= lo:
                cur = nxt
                continue
            if cur >= hi:
                break
            parts.append(c[max(0, lo - cur):min(len(c), hi - cur)])
            cur = nxt
        if not parts:
            return np.zeros(0, np.float32)
        if len(parts) == 1:
            return parts[0].copy()
        return np.concatenate(parts)


@dataclass
class Conv:
    mid: str
    f: object
    started: float  # 墙钟
    last_end: float  # 最后一句结束（墙钟）
    samples: int = 0  # 对话音频当前样本数
    speech_ms: int = 0
    n_seg: int = 0
    cap: int = 0  # 最后写入时的采集进程编号
    wrote_abs: int | None = None  # 文件末尾对应这个采集进程里的第几个样本

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
        self.state = OFF  # 见 STATES / TRANSITIONS；只通过 _set_state() 改
        self.state_since = time.time()
        self.state_hist: deque = deque(maxlen=50)  # 最近的状态跳转 {"t", "from", "to", "ok"}
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
        self._cap = 0  # 采集进程编号：每次重开 ffmpeg +1，样本号从 0 重新算
        self._seq = 0  # 句子编号：每检测到一次开口 +1
        self._done_seq = 0  # 已出最终文字（或已放弃）的最大句子编号
        self._preq: tuple | None = None  # 最新一次临时识别请求 (句子编号, 音频)
        self._pev = threading.Event()
        self._plock = threading.Lock()
        self.voiced: dict[str, int] = {}  # 每段对话里识别出字的发言毫秒数
        self.discarded: dict | None = None  # 最近一次因发言太短丢弃的对话，网页据此提示
        self._pending_close: set[str] = set()  # 已丢进队列、等识别线程收尾的对话
        self._live_cache: dict[str, list[dict]] = {}  # 当前/待收尾对话的实时稿缓存，减少频繁读盘
        self._segmap_cache: dict[str, list] = {}
        self._stuck_swept = False
        self._run_gen = 0
        threading.Thread(target=self._worker, daemon=True, name="ambient-asr").start()
        threading.Thread(target=self._watch_stuck, daemon=True, name="ambient-stuck").start()
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
            self._run_gen += 1
            gen = self._run_gen
            self.thread = threading.Thread(target=self._loop, args=(gen,), daemon=True, name="ambient-capture")
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
        with self.lock:
            self.holds.add(key)
        self._kill_proc()

    def release(self, key: str):
        with self.lock:
            self.holds.discard(key)

    def split(self):
        """手动结束当前这段对话。"""
        self._close_conv()

    def finalize_stuck(self, now: float | None = None) -> list[str]:
        """把停住的全天记录送去精准转写。

        采集线程堵在读麦克风上时，静音计时不会走，对话会一直停在 recording。
        这里按墙上的时间再看一遍：当前这段静音够久就结束它；磁盘上已经不是当前这段、
        状态却还是 recording 的，直接排队（比如收尾那一步失败了，或者进程重启前没来得及）。
        """
        now = time.time() if now is None else now
        split_min = float(self.cfg.get("split_min") or 5)
        with self.lock:
            c = self.conv
            if c and now - c.last_end > split_min * 60:
                self._close_conv()
            active = self.conv.mid if self.conv else None
            pending = set(self._pending_close)
        queued = []
        for meta in store.list_all():
            if not is_stuck_ambient(meta, now, split_min, active, pending):
                continue
            d = store.mdir(meta["id"])
            if not any((d / name).exists() for name in ("audio.pcm", "audio.wav", "audio.mp3")):
                continue
            self.on_closed(meta["id"])
            queued.append(meta["id"])
        return queued

    def _watch_stuck(self):
        while True:
            time.sleep(15)
            try:
                with self.lock:
                    need = self.enabled or self.conv is not None or bool(self._pending_close) or not self._stuck_swept
                if not need:
                    continue
                self.finalize_stuck()
                self._stuck_swept = True
            except Exception:  # noqa: BLE001
                log.exception("ambient finalize stuck")

    def _drop_caches(self, mid: str):
        lc = getattr(self, "_live_cache", None)
        if lc is not None:
            lc.pop(mid, None)
        sc = getattr(self, "_segmap_cache", None)
        if sc is not None:
            sc.pop(mid, None)

    def _get_live_cached(self, mid: str) -> list[dict]:
        with self.lock:
            lc = getattr(self, "_live_cache", None)
            if lc is not None and mid in lc:
                return list(lc[mid])
        live = store.load(mid, "live.json", [])
        with self.lock:
            lc = getattr(self, "_live_cache", None)
            if lc is not None:
                lc[mid] = list(live)
        return live

    def _get_segmap_cached(self, mid: str) -> list:
        with self.lock:
            sc = getattr(self, "_segmap_cache", None)
            if sc is not None and mid in sc:
                return list(sc[mid])
        sm = store.load(mid, "segmap.json", [])
        with self.lock:
            sc = getattr(self, "_segmap_cache", None)
            if sc is not None:
                sc[mid] = list(sm)
        return sm

    def discard(self, mid: str) -> bool:
        """用户删除正在记录的对话：停止写入且不转写。"""
        with self.lock:
            c = self.conv
            if not c or c.mid != mid:
                return False
            self.conv = None
            c.f.close()
            self.voiced.pop(mid, None)
            self._drop_caches(mid)
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

    def _set_state(self, new: str, level_db: float | None = None, *, expected_gen: int | None = None):
        with self.lock:
            if expected_gen is not None and self._run_gen != expected_gen:
                return
            if level_db is not None:
                self.level_db = level_db
            old = self.state
            if new == old:
                return
            ok = new in TRANSITIONS.get(old, set())
            self.state, self.state_since = new, time.time()
            self.state_hist.append({"t": round(self.state_since, 3), "from": old, "to": new, "ok": ok})
        if not ok:
            log.warning("ambient: unexpected state change %s -> %s", old, new)

    def state_info(self) -> dict:
        """给 /api/state：当前状态、为什么是这个状态、最近的跳转。只读。"""
        with self.lock:
            c = self.conv
            pu = self.paused_until
            holds = sorted(self.holds)
            pending = sorted(self._pending_close)
            hist = list(self.state_hist)[-20:]
            state, state_since, enabled = self.state, self.state_since, self.enabled
            error, fallback, proc = self.error, self.fallback, self.proc
        return {
            "state": state, "since": round(state_since, 3), "enabled": enabled,
            "error": error, "holds": holds,
            "paused_until": (-1 if pu == math.inf else pu) if pu > time.time() else 0,
            "mic_open": bool(proc and proc.poll() is None), "fallback": fallback,
            "conv": c.mid if c else None, "pending_close": pending,
            "asr_queue": self.q.qsize(), "viewers": self.viewers,
            "history": hist,
        }

    def status(self) -> dict:
        with self.lock:
            c = self.conv
            voiced_ms = self.voiced.get(c.mid, 0) if c else 0
            state, state_since, enabled = self.state, self.state_since, self.enabled
            error, level_db, fallback = self.error, self.level_db, self.fallback
            pu = self.paused_until
            cfg = self.cfg
        p, last = self.partial, self.last
        return {
            "enabled": enabled, "state": state, "error": error, "level_db": round(level_db, 1),
            "state_since": round(state_since, 3),
            "fallback": fallback,
            "paused_until": (-1 if pu == math.inf else pu) if pu > time.time() else 0,
            "conv": {"id": c.mid, "started": c.started, "last_end": c.last_end, "speech_s": round(c.speech_ms / 1000),
                     "dur_s": round(c.pos_ms / 1000), "voiced_s": round(voiced_ms / 1000)} if c else None,
            "partial": vocab.apply(p["text"]) if p else "",
            "last": vocab.apply(last["text"]) if last and time.time() - last["at"] < 20 else "",
            "live_rev": self.live_rev,
            "discarded": self.discarded if self.discarded and time.time() - self.discarded["at"] < 120 else None,
            "cfg": cfg,
        }

    # ---------- 采集循环 ----------
    def _blocked(self) -> str:
        with self.lock:
            if self.holds:
                return "held"
        if self.paused_until > time.time():
            return "paused"
        return ""

    def _loop(self, gen: int | None = None):
        backoff = 2
        if gen is None:
            gen = self._run_gen
        while self.enabled and self._run_gen == gen:
            b = self._blocked()
            if b:
                with self.lock:
                    if self._run_gen != gen:
                        break
                    self._close_conv()
                    self._set_state(b, -100.0, expected_gen=gen)
                time.sleep(0.5)
                continue
            if self.paused_until:  # 暂停到期自动恢复
                with self.lock:
                    if self._run_gen != gen:
                        break
                    self._set_pause(0.0)
            if not self.e.ready:
                with self.lock:
                    if self._run_gen != gen:
                        break
                    if self.e.error:  # 模型加载失败：不要一直显示“等待语音模型就绪”
                        self.error = "语音模型加载失败：" + self.e.error[:200]
                        self._set_state(ERROR, expected_gen=gen)
                    else:
                        self._set_state(STARTING, expected_gen=gen)
                time.sleep(1)
                continue
            t0 = time.time()
            try:
                self._capture()
                if self.enabled and self._run_gen == gen and not self._blocked() and not self._restart:
                    raise RuntimeError("麦克风采集意外结束")
                self._restart = False
                backoff = 2
            except Exception as ex:  # noqa: BLE001
                log.warning("ambient capture: %s", ex)
                with self.lock:
                    if self._run_gen != gen:
                        break
                    self.error = str(ex)[:300]
                    self._set_state(ERROR, -100.0, expected_gen=gen)
                    self._close_conv()
                if time.time() - t0 > 60:
                    backoff = 2
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        with self.lock:
            if self._run_gen != gen:
                return
            self._close_conv()
            self._set_state(OFF, -100.0, expected_gen=gen)

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
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, **_NO_WIN)
        with self.lock:
            self.proc = proc
        self._cap += 1
        err: list[str] = []

        def _read_err():
            try:
                err.extend(proc.stderr.read().decode("utf-8", "ignore").splitlines())
            except (OSError, ValueError):
                pass

        err_t = threading.Thread(target=_read_err, daemon=True)
        err_t.start()
        vad = self.e.new_vad(max_end_silence_time=END_SILENCE_MS, max_single_segment_time=30000,
                             speech_noise_thres=sens_thres(self.cfg))
        cache: dict = {}
        nbytes = SR * CHUNK_MS // 1000 * 2
        ring = _RingBuffer()  # 最近的音频，分块存储，ring.base 对应首块样本号
        fed = 0
        seg_start = None
        last_partial = 0.0
        last_now = time.time()
        active_dev = dev or "default"
        noise_ring: deque[float] = deque(maxlen=12000)  # 约 1 小时 300ms 分块音量，用于底噪 p10 画像
        last_noise_flush = last_now

        def _flush_noise_floor() -> None:
            if not noise_ring:
                return
            try:
                import rsi_ambient
                p10 = float(np.percentile(list(noise_ring), 10))
                rsi_ambient.record_noise_floor(active_dev, p10)
            except Exception:  # noqa: BLE001
                log.debug("rsi_ambient record_noise_floor failed", exc_info=True)
            noise_ring.clear()

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
                ring.append(x)
                self.level_db = 20 * math.log10(float(np.sqrt(np.mean(x * x))) + 1e-7)
                if math.isfinite(self.level_db):
                    noise_ring.append(self.level_db)
                    if last_now - last_noise_flush >= 3600 and len(noise_ring) >= 20:
                        _flush_noise_floor()
                        last_noise_flush = last_now
                if not got_audio:
                    got_audio, self.error = True, ""
                r = vad.generate(input=x, cache=cache, is_final=False, chunk_size=CHUNK_MS)
                for beg, end in (r[0]["value"] if r else []):
                    if beg >= 0 and end >= 0:
                        self._seq += 1
                        self._segment(ring, ring.base, beg, end, wall_of, self._seq)
                        seg_start = None
                    elif beg >= 0:
                        self._seq += 1
                        seg_start, last_partial = beg, 0.0
                    elif end >= 0 and seg_start is not None:
                        self._segment(ring, ring.base, seg_start, end, wall_of, self._seq)
                        seg_start = None
                self._set_state(SPEECH if seg_start is not None else LISTENING)
                if seg_start is not None and self.viewers and last_now - last_partial >= PARTIAL_EVERY:
                    a0_abs = max(ring.base, (seg_start - PAD_MS) * SR // 1000)
                    if ring.end - a0_abs >= SR * 0.6:  # 交给临时识别线程，采集不等它
                        last_partial = last_now
                        with self._plock:
                            self._preq = (self._seq, ring.slice(a0_abs, ring.end))
                        self._pev.set()
                c = self.conv
                if c and seg_start is None and last_now - c.last_end > float(self.cfg["split_min"]) * 60:
                    self._close_conv()
                # 保留当前句开头之前够补句间停顿的音频（见 ring_keep_from）
                keep = ring_keep_from(seg_start, fed, gap_keep_ms(self.cfg))
                ring.trim_to(keep)
        finally:
            stop_probe.set()
            if len(noise_ring) >= 10:
                _flush_noise_floor()
            if seg_start is not None and fed:
                try:
                    self._segment(ring, ring.base, seg_start, fed * 1000 // SR, wall_of, self._seq)
                except Exception:  # noqa: BLE001
                    log.exception("flush segment")
            self._kill_proc(proc)
            err_t.join(timeout=1)
            for pipe in (proc.stdout, proc.stderr):
                if pipe is not None:
                    try:
                        pipe.close()
                    except OSError:
                        pass
        if not got_audio and err and self.enabled and not self._blocked() and not self._restart:
            raise RuntimeError("无法打开麦克风：" + err[-1][:200])

    def _segment(self, ring, ring_base, beg: int, end: int, wall_of, seq: int):
        if isinstance(ring, _RingBuffer):
            ring_base = ring.base
            a0_abs = max(ring_base, (beg - PAD_MS) * SR // 1000)
            a1_abs = min(ring.end, (end + PAD_MS) * SR // 1000)
            audio = ring.slice(a0_abs, a1_abs)
        else:
            a0_abs = max(ring_base, (beg - PAD_MS) * SR // 1000)
            a1_abs = min(ring_base + len(ring), (end + PAD_MS) * SR // 1000)
            audio = ring[a0_abs - ring_base:a1_abs - ring_base].copy()
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
                meta = store.create(title=f"自动记录 {datetime.fromtimestamp(wb).strftime('%H:%M')}", source="ambient",
                                    status="recording", started_at=iso(wb), title_auto=True)  # 热词用词库里的常用热词
                c = self.conv = Conv(meta["id"], open(store.mdir(meta["id"]) / "audio.pcm", "ab"), wb, wb)
                store.save(c.mid, "skips.json", [])  # 有这个文件 = 新写法录的，跳点以它为准
                lc = getattr(self, "_live_cache", None)
                if lc is not None:
                    lc[c.mid] = []
                sc = getattr(self, "_segmap_cache", None)
                if sc is not None:
                    sc[c.mid] = []
                log.info("ambient: new conversation %s", c.mid)
            fresh = not c.samples
            w0, w1, skipped = plan_write(c.cap == self._cap, c.wrote_abs, a0_abs, a1_abs, ring_base,
                                         gap_keep_ms(cfg) * SR // 1000)
            if skipped and not fresh:
                # 长静音不写进文件，但一定记下来：播放器上显示跳点和被跳过的真实时间
                to_w = wall_of(beg) - PAD_MS / 1000
                from_w = to_w - skipped / SR if skipped > 0 else c.last_end + PAD_MS / 1000
                sk = store.load(c.mid, "skips.json", [])
                sk.append({"pos_ms": c.pos_ms, "skipped_s": round(max(0.0, to_w - from_w), 1),
                           "from": round(from_w, 2), "to": round(to_w, 2)})
                store.save(c.mid, "skips.json", sk)
            chunk = ring.slice(w0, w1) if isinstance(ring, _RingBuffer) else ring[w0 - ring_base:w1 - ring_base]
            if skipped and not fresh and len(chunk):
                chunk = chunk.copy()
                n = min(len(chunk), SKIP_FADE_MS * SR // 1000)
                chunk[:n] *= np.linspace(0, 1, n, dtype=np.float32)
            c.f.write((np.clip(chunk, -1, 1) * 32767).astype(np.int16).tobytes())
            c.f.flush()
            c.samples += len(chunk)
            c.cap, c.wrote_abs = self._cap, w1
            # 这句开头在文件里的位置：文件末尾对应 w1，往回数 a1-a0（同一段连续音频里）
            start = max(0, (c.samples - (w1 - a0_abs)) * 1000 // SR)
            c.speech_ms += end - beg
            c.n_seg += 1
            c.last_end = we
            store.update(c.mid, duration=c.pos_ms / 1000, speech_s=round(c.speech_ms / 1000, 1), ended_at=iso(we))
            self.q.put(("seg", c.mid, audio, start, start + len(audio) * 1000 // SR, wb - PAD_MS / 1000, seq, end - beg))

    def _close_conv(self):
        with self.lock:
            c, self.conv = self.conv, None
            if c:
                self._pending_close.add(c.mid)
                try:
                    c.f.close()
                except Exception:  # noqa: BLE001
                    log.exception("close conv file %s", c.mid)
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
            with self._plock:
                req, self._preq = self._preq, None
                done_seq = self._done_seq
            if not req or req[0] <= done_seq or not self.q.empty():
                continue
            seq, audio = req
            try:
                ctx = ""
                cur = self.conv
                if cur:
                    ctx = recent_context([x.get("text") or "" for x in self._get_live_cached(cur.mid)])
                text = self.e.asr_segment(audio, vocab.hotwords(), context=ctx)
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
                    try:
                        with self.lock:
                            voiced = self.voiced.pop(mid, 0)
                            dev_name = (self.cfg.get("device") or "") if not self.fallback else ""
                        if not store.exists(mid):
                            continue
                        try:
                            import rsi_ambient
                            rsi_ambient.record_conv_vad(dev_name or "default", speech_ms, voiced)
                        except Exception:  # noqa: BLE001
                            log.debug("rsi_ambient record_conv_vad failed", exc_info=True)
                        # 有效发言只算识别出字的：灵敏度调高后，杂音触发的片段识别不出字，不该让对话留下来
                        # 但用户在这段里写过笔记、改过标题或文字、生成过纪要/问答的，一律保留
                        # 太短的不删文件，挪进回收站，7 天内可以恢复
                        info = auto_discard(mid, voiced, float(self.cfg["min_speech_s"]))
                        if info:
                            self.discarded = {**info, "at": time.time()}
                            log.info("ambient: discarded %s (speech %.1fs, voiced %.1fs)", mid, speech_ms / 1000, voiced / 1000)
                        else:
                            log.info("ambient: closed %s (speech %.0fs, voiced %.0fs)", mid, speech_ms / 1000, voiced / 1000)
                            self.on_closed(mid)
                    finally:
                        with self.lock:
                            self._pending_close.discard(mid)
                            self._drop_caches(mid)
            except Exception:  # noqa: BLE001
                log.exception("ambient worker")

    def _recognize(self, prev, mid, audio, s, e, wall, sp_ms):
        wall_end = wall + len(audio) / SR
        segmap = self._get_segmap_cached(mid)
        segmap.append([s, round(wall, 2)])
        with self.lock:
            sc = getattr(self, "_segmap_cache", None)
            if sc is not None:
                sc[mid] = list(segmap)
        if store.exists(mid):
            store.save(mid, "segmap.json", segmap)
        # 间隔很短的相邻句一起识别：一两秒的碎句上下文太少，合起来明显更准。
        # 合完可能超过 10 秒，识别前再按停顿切开，每段单独计时间。
        live = self._get_live_cached(mid)
        # 句子前后各留 250ms，挨得近的两句在文件里会重叠一点（s 比上一句的结束早）：也能并
        merge = bool(prev and prev[0] == mid and s >= prev[1]
                     and should_merge_segment(prev[1], prev[2], prev[4], wall, e))
        earlier = [x for x in live if x["start"] < prev[1]] if merge and prev else live
        ctx = recent_context([x.get("text") or "" for x in earlier])
        hw = vocab.hotwords()

        def run(clip, hotword, context):
            return self.e.asr_segment(clip, hotword, context=context)

        if merge:
            merged = join_clips(prev[3], audio, s - prev[2])
            pieces = decode_capped(merged, prev[1], e, run, hw, ctx)
            if not pieces:  # 合起来反而没认出字：保留上一句，这句单独识别
                merge = False
        if not merge:
            ctx = recent_context([x.get("text") or "" for x in live])
            pieces = decode_capped(audio, s, e, run, hw, ctx)
        live = self._get_live_cached(mid)
        if merge:
            s0, audio = prev[1], merged
            live = [x for x in live if x["start"] < s0]
            voiced_ms = sp_ms + (0 if prev[5] else prev[6])  # 上一句当时没认出字，合起来认出了：一起算
            sp_ms += prev[6]
        else:
            s0, voiced_ms = s, sp_ms
        if pieces:
            for p in pieces:
                live.append({"start": p["start"], "end": p["end"], "text": p["text"]})
            with self.lock:
                self.voiced[mid] = self.voiced.get(mid, 0) + voiced_ms
            self.last = {"text": pieces[-1]["text"], "at": time.time()}
        with self.lock:
            lc = getattr(self, "_live_cache", None)
            if lc is not None:
                lc[mid] = list(live)
        if store.exists(mid):
            store.save(mid, "live.json", live)
        return (mid, s0, e, audio, wall_end, bool(pieces), sp_ms)

    # ---------- 进程 ----------
    def _kill_proc(self, proc: subprocess.Popen | None = None):
        with self.lock:
            p = proc or self.proc
            if p is self.proc and (proc is None or proc is self.proc):
                self.proc = None
        if not p:
            return
        if p.poll() is None:
            try:
                p.terminate()
            except OSError:
                pass
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    p.kill()
                except OSError:
                    pass
                try:
                    p.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        else:
            try:
                p.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass

    def _awake(self, on: bool):
        caff = None
        with self.lock:
            if on and self.cfg.get("keep_awake", True) and not self.caff:
                self.caff = keep_awake()
                return
            if not on and self.caff:
                caff, self.caff = self.caff, None
        if caff is not None:
            try:
                caff.terminate()
                if hasattr(caff, "wait"):
                    try:
                        caff.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        caff.kill()
                        caff.wait(timeout=2)
            except Exception:  # noqa: BLE001
                log.debug("terminate keep_awake failed", exc_info=True)

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


def should_auto_discard(mid: str, voiced_ms: float, min_speech_s: float) -> bool:
    """认出字的发言不够长，而且用户没在这段里写过东西，才自动丢进回收站。"""
    return voiced_ms < float(min_speech_s) * 1000 and not has_user_content(mid)


def auto_discard(mid: str, voiced_ms: float, min_speech_s: float) -> dict | None:
    """挪进 data/discarded/<mid>/。不够丢弃条件时返回 None，调用方照常去精准转写。"""
    if not should_auto_discard(mid, voiced_ms, min_speech_s):
        return None
    voiced_s = round(voiced_ms / 1000, 1)
    min_s = float(min_speech_s)
    dev = str((get_cfg() or {}).get("device") or "")
    store.recycle(mid, voiced_s=voiced_s, min_s=min_s, device=dev)
    return {"id": mid, "voiced_s": voiced_s, "min_s": min_s}


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
        for name in ("audio.pcm", "audio.wav", "audio.mp3", "peaks.json"):
            (d / name).unlink(missing_ok=True)
        store.update(m["id"], audio_purged=True)
    return len(ms)
