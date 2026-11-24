"""播放器上的音频波形：把录音解成低采样率单声道，按固定时长分桶算响度，结果缓存在 peaks.json。"""
import json
import math
import subprocess
import threading
from pathlib import Path

import numpy as np

import store

RATE = 4000  # 只看响度，不需要高采样率；2 小时录音解出来约 57MB，边读边算
MAX_BUCKETS = 2400
FRAME_S = 0.125  # 找静音段用的细粒度帧（波形的桶长录音可达 3 秒，太粗）
QUIET_MIN_S = 1.5  # 至少这么长的安静才算静音段（播放器「静音加速」用）
QUIET_EDGE_S = 0.25  # 静音段两头各让出这么多，开口前后不被加速
CACHE_VER = 2

_locks_guard = threading.Lock()
_dir_locks: dict[str, threading.Lock] = {}


def _lock_for(d: Path) -> threading.Lock:
    k = str(d.resolve())
    with _locks_guard:
        lk = _dir_locks.get(k)
        if lk is None:
            if len(_dir_locks) > 512:
                for ok in [x for x, v in _dir_locks.items() if not v.locked()]:
                    _dir_locks.pop(ok, None)
            lk = _dir_locks[k] = threading.Lock()
        return lk


def frame_db(samples: np.ndarray, per: int) -> list[float]:
    n = len(samples) // per
    if not n:
        return []
    x = samples[: n * per].reshape(n, per)
    return (20 * np.log10(np.sqrt(np.mean(x * x, axis=1)) + 1e-7)).round(1).tolist()


def quiet_ranges(db: list[float], frame_s: float = FRAME_S, min_s: float = QUIET_MIN_S,
                 edge_s: float = QUIET_EDGE_S) -> list[list[float]]:
    """安静的时间段 [[开始秒, 结束秒], …]。门限随录音自适应：底噪（10% 分位）之上，
    取到响亮处（95% 分位）距离的 35%，至少高出 6dB——房间底噪、增益不同都能用。
    数字静音一律算安静。"""
    if len(db) < 3:
        return []
    a = np.asarray(db, np.float32)
    real = a[a > -85]  # 数字静音（老录音补的全 0）不算底噪，否则门限会低到只认全 0
    if len(real) < 3:
        return []
    floor, loud = float(np.percentile(real, 10)), float(np.percentile(real, 95))
    if loud - floor < 10:  # 整段几乎一样响：要么全是静音、要么一直有声音，都不处理
        return []
    thr = floor + max(6.0, (loud - floor) * 0.35)
    q = np.r_[False, a < thr, False]
    d = np.diff(q.astype(np.int8))
    out = []
    for i0, i1 in zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)):
        if (i1 - i0) * frame_s >= min_s:
            t0, t1 = i0 * frame_s + edge_s, i1 * frame_s - edge_s
            if t1 - t0 >= 0.5:
                out.append([round(float(t0), 2), round(float(t1), 2)])
    return out


def bucket_s(duration_s: float) -> float:
    """每个桶多长：短录音 0.25 秒一格，长录音拉长，总数不超过 MAX_BUCKETS。"""
    return max(0.25, math.ceil(duration_s / MAX_BUCKETS * 4) / 4) if duration_s > 0 else 0.25


def levels(samples: np.ndarray, per: int) -> list[float]:
    """每 per 个样本一格，取 RMS 换成 0~1（-60dB → 0，0dB → 1）。"""
    out = []
    for i in range(0, len(samples), per):
        x = samples[i:i + per]
        if not len(x):
            break
        db = 20 * math.log10(float(np.sqrt(np.mean(x * x))) + 1e-7)
        out.append(round(min(1.0, max(0.0, (db + 60) / 60)), 3))
    return out


def compute(path: Path, duration_s: float) -> dict:
    bs = bucket_s(duration_s)
    per = max(1, int(RATE * bs))
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
         "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    vals: list[float] = []
    dbs: list[float] = []
    fper = int(RATE * FRAME_S)
    rest = np.zeros(0, np.float32)
    carry = b""
    failed = False
    try:
        assert proc.stdout is not None
        while True:
            data = proc.stdout.read(per * 2 * 200)
            if not data:
                break
            if carry:
                data = carry + data
                carry = b""
            even = len(data) // 2 * 2
            if even < len(data):
                carry = data[even:]
            if not even:
                continue
            x = np.frombuffer(data[:even], np.int16).astype(np.float32) / 32768.0
            rest = np.concatenate([rest, x])
            n = len(rest) // per * per
            if n:
                vals += levels(rest[:n], per)
                dbs += frame_db(rest[:n], fper)  # per 是 fper 的整数倍（桶长是 0.25 秒的倍数）
                rest = rest[n:]
        if len(rest):
            vals += levels(rest, per)
            dbs += frame_db(rest, fper)
    except BaseException:
        failed = True
        raise
    finally:
        if proc.stdout:
            try:
                proc.stdout.close()
            except OSError:
                pass
        if failed and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
        else:
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg waveform failed (code {proc.returncode})")
    return {"bucket_s": bs, "levels": vals, "quiet": quiet_ranges(dbs)}


def peaks(d: Path, duration_s: float) -> dict | None:
    """d 里 audio.mp3 / audio.wav 的波形；录音没变就用缓存。"""
    with _lock_for(d):
        for name in ("audio.mp3", "audio.wav"):
            src = d / name
            if src.exists():
                break
        else:
            return None
        st = src.stat()
        bs = bucket_s(duration_s)
        key = f"v{CACHE_VER}:{name}:{st.st_size}:{st.st_mtime_ns}:{bs}"
        cache = d / "peaks.json"
        if cache.exists():
            try:
                c = json.loads(cache.read_text("utf-8"))
                if isinstance(c, dict) and c.get("key") == key:
                    return c
            except (OSError, ValueError):
                pass
        out = {"key": key, **compute(src, duration_s)}
        store.write_text(cache, json.dumps(out))
        return out
