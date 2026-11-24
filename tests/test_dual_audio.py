"""双路录音的纯函数：块大小、交错、串音去重、通道命名。不加载语音模型。

用法：.venv/bin/python tests/test_dual_audio.py
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-dual-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

import dual_audio as d

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


def test_mono_layout_unchanged():
    check(d.channels_of(None) == 1 and d.channels_of(1) == 1 and d.channels_of("1") == 1, "缺省和 1 都是单声道")
    check(d.chunk_bytes(1) == 3200 and d.bytes_per_ms(1) == 32, "单声道仍是 3200 字节一块、每毫秒 32 字节")
    check(d.offset_ms(3200, 1) == 100, "单声道 3200 字节对应 100 毫秒")
    check(abs(d.pcm_duration_s(16000 * 2, 1) - 1) < 1e-9, "单声道 1 秒是 32000 字节")
    check(d.align_bytes(3200 * 5 + 10, 0, 1) == 3200 * 5, "单声道截到整块")


def test_stereo_layout():
    check(d.channels_of(2) == 2 and d.channels_of("2") == 2, "2 是双声道")
    check(d.chunk_bytes(2) == 6400 and d.bytes_per_ms(2) == 64, "双声道一块 6400 字节、每毫秒 64 字节")
    check(d.offset_ms(6400, 2) == 100, "双声道 6400 字节仍是 100 毫秒")
    check(abs(d.pcm_duration_s(16000 * 4, 2) - 1) < 1e-9, "双声道 1 秒是 64000 字节")
    check(d.align_bytes(6400 * 3 + 100, 6400, 2) == 6400 * 3, "双声道从已有起点接着截到整块")


def test_interleave_roundtrip():
    mic = (np.arange(8, dtype="<i2") * 10).tobytes()
    sys = (np.arange(8, dtype="<i2") * 10 + 1).tobytes()
    raw = d.interleave(mic, sys)
    check(len(raw) == 32, "8 个采样点交错后是 32 字节")
    a, b = d.split_interleaved(raw)
    check(a == mic and b == sys, "拆开后两路和原来一样")
    check(d.split_interleaved(raw + b"\x00")[0] == mic, "多出来的奇数字节丢掉，不把下一路错位")
    check(d.interleave(mic, sys[:4]) == d.interleave(mic[:4], sys[:4]), "两路长度不同时按短的对齐")


def test_keep_real_overlap_drop_bleed():
    paras = [
        {"ch": 0, "spk": 0, "start": 0, "end": 2000, "text": "我这边周五给一版", "rms": 0.2},
        {"ch": 1, "spk": 1, "start": 100, "end": 1800, "text": "预算要单独申请", "rms": 0.2},
        {"ch": 0, "spk": 0, "start": 3000, "end": 5000, "text": "长尾词下周再看效果", "rms": 0.05},
        {"ch": 1, "spk": 1, "start": 3100, "end": 4900, "text": "长尾词下周再看效果", "rms": 0.3},
    ]
    kept = d.drop_bleed(paras)
    texts = [(p["ch"], p["text"]) for p in kept]
    check((0, "我这边周五给一版") in texts and (1, "预算要单独申请") in texts, "两路同时说不同的话都留下")
    check((0, "长尾词下周再看效果") not in texts and (1, "长尾词下周再看效果") in texts, "文字几乎一样的串音留下更响的那路")
    check(all("rms" in p for p in kept), "去重不改其它字段")


def test_names_do_not_overwrite():
    paras = [
        {"ch": 0, "spk": 3, "start": 0, "end": 5000, "text": "a"},
        {"ch": 0, "spk": 4, "start": 5000, "end": 6000, "text": "b"},
        {"ch": 1, "spk": 7, "start": 0, "end": 4000, "text": "c"},
    ]
    names = d.suggest_channel_names(paras, {"3": "周会主持人"})
    check(names["3"] == "周会主持人", "用户已经起的名字不动")
    check(names.get("4") is None, "麦克风上时间更短的人不自动叫「我」")
    check(names["7"] == "对方", "电脑声音只有一个人时叫「对方」")
    many = d.suggest_channel_names(paras + [{"ch": 1, "spk": 8, "start": 0, "end": 1000, "text": "d"}], {})
    check(many["3"] == "我" and "7" not in many and "8" not in many, "对方不止一个人时不硬标成同一个「对方」")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_mono_layout_unchanged()
    test_stereo_layout()
    test_interleave_roundtrip()
    test_keep_real_overlap_drop_bleed()
    test_names_do_not_overwrite()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
