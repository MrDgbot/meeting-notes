"""音量归一、按说话人拆句、pyannote 说话人合并的单元测试（docs/improvements.md 第 1、2、4 项）。不加载语音模型，几秒跑完。

用法：.venv/bin/python tests/test_split_level.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

os.environ["MEETING_DATA"] = tempfile.mkdtemp(prefix="mn-test-")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import asr_engine  # noqa: E402
from asr_engine import Engine  # noqa: E402

E = Engine


def db(x):
    return 20 * np.log10(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def test_level():
    r = np.random.default_rng(0)
    quiet = (r.normal(size=16000 * 5) * 10 ** (-55 / 20)).astype(np.float32)
    y = asr_engine.level(quiet)
    assert abs(db(y) - (-30)) < 0.5 and np.abs(y).max() <= 1.0, db(y)
    loud = (r.normal(size=16000) * 10 ** (-20 / 20)).astype(np.float32)
    assert asr_engine.level(loud) is loud  # 已经够响：原样返回，不缩小
    silent = (r.normal(size=16000 * 5) * 1e-5).astype(np.float32)  # -100 dBFS：最多放大 30 dB
    assert abs(db(asr_engine.level(silent)) - (db(silent) + 30)) < 0.5
    spiky = quiet.copy()
    spiky[100] = 0.9  # 峰值放大后会远超 1：软限幅，不超过 1；0.8 以下的样本不受影响
    ys = asr_engine.level(spiky)
    assert np.abs(ys).max() <= 1.0 and np.allclose(ys[1:100], spiky[1:100] * (ys[1:100] / spiky[1:100]).mean())
    for mode, want in (("off", (False, False)), ("vad", (False, True)), ("all", (True, True))):
        asr_engine.LEVEL_USE = mode
        a, v = asr_engine.level_pair(quiet)
        assert (a is not quiet, v is not quiet) == want, mode
    asr_engine.LEVEL_USE = "all"
    print("ok 音量归一：小声放大到 -30 dBFS、够响的不动、最多 +30 dB、软限幅；off/vad/all 三种用法")


def toks(text, start=0.0, step=0.2):
    """每个字一个时间戳（秒），标点不给时间，和 Nano 的输出一样。"""
    out, t = [], start
    for ch in text:
        if ch in asr_engine.CLAUSE_END:
            continue
        out.append({"token": ch, "start_time": round(t, 3), "end_time": round(t + step, 3)})
        t += step
    return out


def test_clause_times():
    text = "我们先看数据，然后再定。"
    cl = E._clauses(text, toks(text), 1000, 4000)
    assert [c["text"] for c in cl] == ["我们先看数据，", "然后再定。"]
    for c in cl:
        assert len(c["ct"]) == len(c["text"]), c
        assert c["ct"][-1] is None  # 标点没有时间
    assert cl[0]["start"] == 1000 and cl[0]["ct"][0] == (1000, 1200)
    cl = E._clauses("没有时间戳的一句", [], 0, 3000)
    assert len(cl) == 1 and cl[0]["ct"] == [None] * len(cl[0]["text"])
    print("ok 小句带逐字时间（ct），标点和没有时间戳的字是 None")


def test_split():
    # “……合适呀都是一天吧。”：前 12 个字是 A（0–2.4s），后 5 个字是 B（2.4–3.4s），中间没有标点
    text = "咱们年会办几天比较合适呀都是一天吧。"
    cl = E._clauses(text, toks(text), 0, 4000)
    turns = [(0, 2400, 0), (2400, 3500, 1)]
    same = E._assign_speakers([dict(c) for c in cl], turns, 0)
    assert len(same) == 1 and same[0]["spk"] == 0  # 不拆：整句给占多数的 A
    out = E._assign_speakers([dict(c) for c in cl], turns, 800)
    assert [(c["spk"], c["text"]) for c in out] == [(0, "咱们年会办几天比较合适呀"), (1, "都是一天吧。")], out
    assert out[1]["start"] == 2400 and out[1]["end"] == 3400
    # 换过去的人说得太短（不到 min_ms）：不拆
    out = E._assign_speakers([dict(c) for c in cl], turns, 1500)
    assert len(out) == 1 and out[0]["spk"] == 0
    # 边界附近 3 个字以内有标点：切在标点后面
    text = "这个方案我觉得可以，你看呢我同意的。"
    cl = E._clauses(text, toks(text), 0, 5000)
    turns = [(0, 1600, 0), (1600, 4000, 1)]  # 声纹在第 8 个字（“可”之后）就换人了，标点在第 10 个字
    out = E._assign_speakers([dict(c) for c in cl], turns, 500)
    assert [c["text"] for c in out] == ["这个方案我觉得可以，", "你看呢我同意的。"], [c["text"] for c in out]
    # 中间夹一小段别人（声纹抖动）：并回两边，不拆成三段
    text = "第一季度的收入比预期高了一些主要是新客户"
    cl = E._clauses(text, toks(text), 0, 5000)
    turns = [(0, 1800, 0), (1800, 2200, 1), (2200, 5000, 0)]
    out = E._assign_speakers([dict(c) for c in cl], turns, 1000)
    assert len(out) == 1 and out[0]["spk"] == 0
    # 拆完以后段落照常合并、文字一个不少
    paras = E._paragraphs(E._assign_speakers(E._clauses("咱们年会办几天比较合适呀都是一天吧。", toks("咱们年会办几天比较合适呀都是一天吧。"), 0, 4000),
                                             [(0, 2400, 0), (2400, 3500, 1)], 1000))
    assert "".join(p["text"] for p in paras) == "咱们年会办几天比较合适呀都是一天吧。" and [p["spk"] for p in paras] == [0, 1]
    print("ok 按说话人拆句：句中换人且够长才拆、短抖动并回、切点挪到标点后、文字不丢")


def test_merge():
    r = np.random.default_rng(1)
    a, b = r.normal(size=192), r.normal(size=192)
    # pyannote 把同一个人 A 拆成 0 和 2，B 是 1
    turns = [(0, 4000, 0), (4000, 8000, 1), (8000, 12000, 2), (12000, 16000, 1)]
    chunk_t, X = [], []
    for s, e, spk in turns:
        for t in np.arange(s / 1000, e / 1000 - 1.5 + 1e-9, 0.75):
            chunk_t.append([float(t), float(t) + 1.5])
            X.append((a if spk in (0, 2) else b) + 0.1 * r.normal(size=192))
    X = np.array(X)
    out = asr_engine.merge_turn_speakers(turns, chunk_t, X, 0.78)
    assert [t[2] for t in out] == [0, 1, 0, 1], out
    out = asr_engine.merge_turn_speakers(turns, chunk_t, X, 0.9999)  # 阈值太高：都不并，编号照旧按出现先后
    assert [t[2] for t in out] == [0, 1, 2, 1], out
    assert asr_engine.merge_turn_speakers([], [], np.zeros((0, 192))) == []
    print("ok pyannote 说话人合并：声纹像的并成一人、不像的不并、按出现先后重新编号")


def test_diarizer_setting():
    assert asr_engine.diarizer_mode() == "campp"
    p = Path(os.environ["MEETING_DATA"]) / "settings.json"
    for v, want in (("pyannote", "pyannote"), ("不存在", "campp")):
        p.write_text(json.dumps({"asr": {"model": "nano", "diarizer": v}}))
        assert asr_engine.diarizer_mode() == want, v
    p.unlink()
    print("ok 说话人分离方式：默认 CAM++，设置里选 pyannote 生效，未知值退回 CAM++")


if __name__ == "__main__":
    test_level()
    test_clause_times()
    test_split()
    test_merge()
    test_diarizer_setting()
    print("全部通过")
