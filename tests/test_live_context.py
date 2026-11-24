"""实时识别把上一句放进 Fun-ASR-Nano 的上下文提示。不加载模型。

用法：.venv/bin/python tests/test_live_context.py
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-ctx-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asr_engine

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


BARE = "语音转写成中文："
WITH_HOT = ("请结合上下文信息，更加准确地完成语音转写任务。如果没有相关信息，我们会留空。\n\n\n"
            "**上下文信息：**\n\n\n热词列表：[长尾词]\n语音转写成中文：")


def test_prompt():
    check(asr_engine.apply_nano_context(BARE, "") == BARE, "没有上一句就不改提示")
    out = asr_engine.apply_nano_context(BARE, "内部转岗是吧")
    check(out.startswith("上一句转写（仅供参考，不要照抄）：内部转岗是吧\n"), out)
    check(out.endswith(BARE), "原来的转写指令还在")
    out = asr_engine.apply_nano_context(WITH_HOT, "预算还没定")
    check("上一句转写（仅供参考，不要照抄）：预算还没定" in out and "热词列表：[长尾词]" in out, out)
    check(asr_engine.recent_context(["", "  上一句。  ", "这句"]) == "这句", "取最后一句并去掉空白")
    long = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥"
    check(asr_engine.recent_context([long]) == long[-20:], f"上一句只留末尾 20 字：{asr_engine.recent_context([long])}")
    check(asr_engine.recent_context(["尔" * 10]) == "", "上一句自己在复读就不传")
    check(asr_engine.apply_nano_context(BARE, "尔" * 10) == BARE, "复读的上一句不写进提示")


def test_echo():
    check(asr_engine.strip_context_echo("内部转岗是吧，那我申请", "内部转岗是吧") == "那我申请", "抄了上一句开头就去掉")
    check(asr_engine.strip_context_echo("内部转岗是吧", "内部转岗是吧") == "内部转岗是吧", "整句都是上一句时留下，可能真的又说了一遍")
    check(asr_engine.strip_context_echo("今天开会", "内部转岗") == "今天开会", "没抄就不改")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_prompt()
    test_echo()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
