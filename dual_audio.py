"""线上会议的双路录音：麦克风一路、电脑声音一路。

这里只有不加载语音模型的纯函数。单声道（线下会议、手机当麦克风）的块大小和字节数跟原来一样。
"""
import re
import unicodedata
from difflib import SequenceMatcher

import numpy as np

MONO_CHUNK = 3200  # 100ms × 16kHz × 16bit
SR = 16000


def channels_of(n) -> int:
    return 2 if int(n or 1) == 2 else 1


def chunk_bytes(channels: int) -> int:
    return MONO_CHUNK * channels_of(channels)


def bytes_per_ms(channels: int) -> int:
    """16kHz、16bit，单声道每毫秒 32 字节，双声道 64 字节。"""
    return 32 * channels_of(channels)


def offset_ms(start_bytes: int, channels: int) -> int:
    return int(start_bytes) // bytes_per_ms(channels)


def pcm_duration_s(nbytes: int, channels: int) -> float:
    return max(0, int(nbytes)) / (SR * 2 * channels_of(channels))


def align_bytes(size: int, start: int, channels: int) -> int:
    """把 pcm 截到整块。网页按固定大小重传，半块对不上。"""
    step = chunk_bytes(channels)
    return int(start) + max(0, int(size) - int(start)) // step * step


def split_interleaved(data: bytes) -> tuple[bytes, bytes]:
    """交错的 s16le（左麦克风、右电脑声音）拆成两路。不成对的尾巴丢掉。"""
    data = data[: len(data) // 4 * 4]
    x = np.frombuffer(data, dtype="<i2")
    if len(x) % 2:
        x = x[: len(x) // 2 * 2]
    if len(x) == 0:
        return b"", b""
    return np.ascontiguousarray(x[0::2]).tobytes(), np.ascontiguousarray(x[1::2]).tobytes()


def interleave(mic: bytes, system: bytes) -> bytes:
    a = np.frombuffer(mic, dtype="<i2")
    b = np.frombuffer(system, dtype="<i2")
    n = min(len(a), len(b))
    if n == 0:
        return b""
    out = np.empty(n * 2, dtype="<i2")
    out[0::2] = a[:n]
    out[1::2] = b[:n]
    return out.tobytes()


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    return re.sub(r"[\W_]+", "", s)


def _similar(a: str, b: str, thr: float) -> bool:
    na, nb = _norm(a), _norm(b)
    if len(na) < 4 or len(nb) < 4:
        return False
    if na in nb or nb in na:
        return min(len(na), len(nb)) / max(len(na), len(nb)) >= 0.6
    return SequenceMatcher(None, na, nb).ratio() >= thr


def drop_bleed(paras: list[dict], overlap: float = 0.45, sim: float = 0.72) -> list[dict]:
    """两路时间重叠、文字又很像，多半是串音，留下音量更大的那路。

    文字不同的重叠（两个人同时说不同的话）两路都留。这是双路录音相对单声道混音少漏字的地方。
    """
    items = [dict(p) for p in paras]
    drop: set[int] = set()
    for i, a in enumerate(items):
        if i in drop or a.get("ch") is None:
            continue
        for j in range(i + 1, len(items)):
            b = items[j]
            if j in drop or b.get("ch") is None or a.get("ch") == b.get("ch"):
                continue
            span = min(a["end"], b["end"]) - max(a["start"], b["start"])
            if span <= 0:
                continue
            short = min(a["end"] - a["start"], b["end"] - b["start"])
            if short <= 0 or span / short < overlap:
                continue
            if not _similar(a.get("text", ""), b.get("text", ""), sim):
                continue
            ra, rb = float(a.get("rms") or 0), float(b.get("rms") or 0)
            if abs(ra - rb) > 1e-6:
                loser = i if ra < rb else j
            else:
                loser = i if len(_norm(a.get("text", ""))) <= len(_norm(b.get("text", ""))) else j
            drop.add(loser)
            if loser == i:
                break
    kept = [p for i, p in enumerate(items) if i not in drop]
    kept.sort(key=lambda p: (p.get("start", 0), p.get("ch") or 0))
    return kept


def suggest_channel_names(paras: list[dict], existing: dict | None = None) -> dict:
    """麦克风一路里说得最久的人标成「我」；电脑声音只有一个人时标成「对方」。已经起过的名字不覆盖。"""
    names = {str(k): v for k, v in (existing or {}).items()}

    def main(ch: int):
        dur: dict[int, int] = {}
        for p in paras:
            if p.get("ch") != ch:
                continue
            try:
                spk = int(p.get("spk"))
            except (TypeError, ValueError):
                continue
            if spk < 0:
                continue
            dur[spk] = dur.get(spk, 0) + max(0, int(p["end"]) - int(p["start"]))
        if not dur:
            return None
        return max(dur, key=lambda s: (dur[s], -s))

    mic = main(0)
    if mic is not None:
        names.setdefault(str(mic), "我")
    remote = []
    for p in paras:
        if p.get("ch") != 1:
            continue
        try:
            remote.append(int(p.get("spk")))
        except (TypeError, ValueError):
            continue
    remote = [s for s in remote if s >= 0]
    if remote and len(set(remote)) == 1:
        names.setdefault(str(remote[0]), "对方")
    return names
