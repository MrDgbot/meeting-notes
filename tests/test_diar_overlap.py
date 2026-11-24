"""重叠说话的时间段和切句。不下载、不加载 Nemotron。

用法：.venv/bin/python tests/test_diar_overlap.py
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-ov-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

import asr_engine
import diar_overlap as d

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


def test_probs_keep_overlap_drop_blip():
    # 10ms 一帧。说话人 0：0–500ms；说话人 1：300–800ms；说话人 2 只有 50ms，丢掉
    p = np.zeros((80, 3))
    p[0:50, 0] = 0.9
    p[30:80, 1] = 0.9
    p[10:15, 2] = 0.9
    turns = d.probs_to_turns(p)
    check(d.turns_overlap(turns), f"两个人重叠的段要保留：{turns}")
    check(all(s != 2 for _, _, s in turns) or len({s for _, _, s in turns}) == 2, f"短于 200ms 的人丢掉：{turns}")
    check([t[2] for t in turns] == [0, 1], f"按先开口的顺序编号：{turns}")
    # 中间空 50ms（5 帧）应接上
    q = np.zeros((40, 1))
    q[0:10, 0] = 0.8
    q[15:40, 0] = 0.8
    bridged = d.probs_to_turns(q, gap_ms=100)
    check(len(bridged) == 1 and bridged[0][1] - bridged[0][0] >= 400, f"短空隙接成一段：{bridged}")
    check(d.probs_to_turns(np.zeros((0, 2))) == [], "空概率没有时间段")


def test_limit_speakers():
    turns = [(0, 5000, 0), (1000, 2000, 1), (0, 1000, 2)]
    kept = d.limit_speakers(turns, 2)
    spk = {t[2] for t in kept}
    check(spk == {0, 1} and all(t[2] != 2 for t in kept), f"只留说得最久的两个人：{kept}")
    check(not d.turns_overlap([(0, 1000, 0), (1000, 2000, 1)]), "首尾相接不算重叠")


def test_split_on_overlap():
    sent = [{"start": 0, "end": 2000, "text": "我先说完你再说",
             "ct": [(i * 100, i * 100 + 90) for i in range(8)]}]
    # 前 4 个字（0–400ms）只有 0，后 4 个字（400–800ms）0 和 1 一起说
    turns = [(0, 800, 0), (400, 900, 1)]
    out = d.split_sentence(sent, turns, min_ms=200)
    check(len(out) >= 2, f"重叠开始的地方要切开：{out}")
    check(any(x.get("spks") and 1 in x["spks"] and 0 in x["spks"] for x in out), f"重叠的那一段标两个人：{out}")
    check("".join(x["text"] for x in out).replace("，", "") == "我先说完你再说", f"字没有丢：{out}")
    # 没有重叠：原样返回，好让原来的拆句逻辑继续用
    plain = [{"start": 0, "end": 500, "text": "你好", "spk": 3, "ct": [(0, 200), (200, 400)]}]
    same = d.split_sentence(plain, [(0, 500, 3)], min_ms=1000)
    check(same == plain, "只有一个人时不改原句")


def test_assign_uses_overlap_only_when_needed():
    clauses = [
        {"start": 0, "end": 400, "text": "我先说，", "ct": [(0, 180), (180, 360), (360, 390), (390, 400)]},
        {"start": 400, "end": 800, "text": "你接着说。", "ct": [(400, 520), (520, 640), (640, 760), (760, 800)]},
    ]
    exclusive = [(0, 800, 0)]
    out = asr_engine.Engine._assign_speakers(clauses, exclusive, min_ms=1000)
    check(all("spks" not in x for x in out), f"不重叠时不标多人：{out}")
    overlap = [(0, 800, 0), (400, 800, 1)]
    out2 = asr_engine.Engine._assign_speakers([dict(c) for c in clauses], overlap, min_ms=200)
    check(any(x.get("spks") for x in out2), f"重叠时切句并标多人：{out2}")


def test_setting_keeps_default():
    check(asr_engine.diarizer_mode() == "campp", "默认仍是 CAM++")
    check("nemotron" in asr_engine.DIARIZERS and "pyannote" in asr_engine.DIARIZERS, "设置里能选到 Nemotron 和会议室远场")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_probs_keep_overlap_drop_blip()
    test_limit_speakers()
    test_split_on_overlap()
    test_assign_uses_overlap_only_when_needed()
    test_setting_keeps_default()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
