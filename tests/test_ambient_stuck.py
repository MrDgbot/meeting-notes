"""全天记录停在 recording 时，什么情况下该送去精准转写。不采音、不加载模型。

用法：.venv/bin/python tests/test_ambient_stuck.py
"""
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-stuck-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ambient

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


def ts(s):
    return datetime.fromisoformat(s).timestamp()


META = {
    "id": "20261104-182435-blek",
    "source": "ambient",
    "status": "recording",
    "created": "2026-11-04T18:24:35",
    "started_at": "2026-11-04T18:24:35",
    "ended_at": "2026-11-04T19:18:00",
}


def test_merge_cap_splits_at_pause():
    # 10 秒后再来 5 秒，间隔 1 秒：并进去
    check(ambient.should_merge_segment(0, 10000, 100.0, 101.0, 15000), "短句并到上一句")
    # 已经 28 秒，再并到 32 秒会超过 30 秒上限：停在这处停顿
    check(not ambient.should_merge_segment(0, 28000, 100.0, 100.4, 32000), "碰到上限就在停顿处切开")
    # 以前的 20 秒上限会把 19.9 秒后再来的一句切开；现在 25 秒仍可并
    check(ambient.should_merge_segment(0, 19900, 100.0, 101.0, 25000), "30 秒上限内容得下原来被 20 秒截断的下一段")
    check(not ambient.should_merge_segment(0, 19900, 100.0, 101.0, 25000, max_ms=20000), "旧的 20 秒上限确实会切开")
    check(not ambient.should_merge_segment(0, 10000, 100.0, 103.0, 12000), "间隔超过 2.5 秒不并")
    check(ambient.END_SILENCE_MS == 1200 and ambient.MERGE_MAX_MS == 30000, "断句静音 1.2 秒，合并上限 30 秒")


def test_sensitivity_default():
    check(ambient.DEFAULTS["sensitivity"] == "high", "默认仍是高灵敏度，不因为嘈杂办公室改掉原来的安静远场")
    check(ambient.SENS["normal"] == 0.6 and ambient.SENS["high"] == 0.4, "标准是模型默认阈值，高更灵敏")


def test_stuck_after_silence():
    later = ts("2026-11-04T19:30:00")  # 结束后 12 分钟，超过默认的 5 分钟
    check(ambient.is_stuck_ambient(META, later, 5), "停了又过了静音阈值，该去精准转写")
    check(not ambient.is_stuck_ambient(META, later, 5, active_id=META["id"]), "正在写的这一段先别抢")
    check(not ambient.is_stuck_ambient(META, later, 5, pending={META["id"]}), "已经在收尾队列里的不重复排队")
    check(not ambient.is_stuck_ambient({**META, "status": "ready"}, later, 5), "已经转写完的不动")
    check(not ambient.is_stuck_ambient({**META, "source": "mic"}, later, 5), "手动录音不走这条")
    soon = ts("2026-11-04T19:20:00")  # 只过了 2 分钟
    check(not ambient.is_stuck_ambient(META, soon, 5), "静音还没到阈值，先当它还在这段对话里")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_sensitivity_default()
    test_stuck_after_silence()
    test_merge_cap_splits_at_pause()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
