"""复读循环收束。用真实转写里的句子，自然重复必须原样留下。不加载语音模型。

用法：.venv/bin/python tests/test_repetition.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-rep-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import repetition
import vocab

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


# 附件 live.json 里 start=616166 的那句，按原文结构拼出来：前缀 + 126 个带逗号的「内部转岗，」+ 末尾不带逗号的一遍
LOOP = "转岗是吧？" + "内部转岗，" * 126 + "内部转岗"
KEEP = [
    "45啊，45啊，45啊，我操啊！",
    "你先提给你先提给你先找刘佳琪，刘佳琪过一会再找你。好吧，你先第一，你过的需求。我出啥衣服？对啊，你刚才刚打通关了。",
    "对对对，就是讲那个。",
    "走走走",
    "来来来",
    "对对对对对。",
    "说说说说",
    "哈哈哈哈哈哈",
    "就是你们你们那个之前怎么怎么怎么怎么对",
    "sorry，我说这这这这。",
    "有发有发，是有发呀",
    "我以为我以为在那看",
]


def runaway(text: str) -> bool:
    """收束之后不应该再有「四字及以上短语连着四遍」或「两字及以上连着六遍」。"""
    n = len(text)
    for length in range(2, 21):
        i = 0
        while i + length * 4 <= n:
            unit = text[i:i + length]
            content = "".join(ch for ch in unit if ch not in repetition._PUNCT)
            count = 1
            while i + (count + 1) * length <= n and text[i + count * length:i + (count + 1) * length] == unit:
                count += 1
            if len(content) >= 4 and count >= 4:
                return True
            if len(content) >= 2 and count >= 6:
                return True
            i += 1 if count == 1 else count * length
    return False


def test_loop_from_recording():
    check(LOOP.count("内部转岗") == 127, f"样本和附件一致，共 127 遍，实际 {LOOP.count('内部转岗')}")
    out = repetition.collapse_repetition(LOOP)
    check(out.count("内部转岗") == 2, f"失控循环只留两遍：{out}")
    check(out.startswith("转岗是吧？"), f"循环前面的话留下：{out}")
    check(not runaway(out), out)
    check(repetition.collapse_repetition(out) == out, "再跑一次不变")


def test_natural_repeats_stay():
    for text in KEEP:
        got = repetition.collapse_repetition(text)
        check(got == text, f"自然重复不动：{text!r} -> {got!r}")


CHAR_LOOP = "同性恋语言在乔杰尔尔尔尔尔尔尔尔尔尔"
CHAR_DONE = "同性恋语言在乔杰尔尔尔"
CLAUSE_LOOP = (
    "说当，必须要经过米尔恩后了，而且现在最高法院米尔恩还没放出来。"
    "那法律的滞后性，判决更加滞后了，而且现在最高法院米尔恩还没放出来。所以"
)
CLAUSE_DONE = (
    "说当，必须要经过米尔恩后了，而且现在最高法院米尔恩还没放出来。"
    "那法律的滞后性，判决更加滞后了。所以"
)


def test_single_char_run():
    check(CHAR_LOOP.count("尔") == 10, f"样本里尔应是 10 遍，实际 {CHAR_LOOP.count('尔')}")
    out = repetition.collapse_repetition(CHAR_LOOP)
    check(out == CHAR_DONE, f"单字连写 7 遍及以上收成 3 遍：{out}")
    check(repetition.collapse_repetition(out) == out, "单字收束后再跑一次不变")
    check(repetition.collapse_repetition("尔" * 7) == "尔尔尔", "刚好 7 遍收成 3 遍")
    check(repetition.collapse_repetition("尔" * 6) == "尔" * 6, "6 遍不动")
    check(repetition.collapse_repetition("尔" * 6 + "，" + "尔" * 6) == "尔" * 6 + "，" + "尔" * 6, "标点隔开的两段都不满 7")
    check(repetition.collapse_repetition("尔" * 8 + "。") == "尔尔尔。", "句号留在收束之后")


def test_repeated_clause():
    clause = "而且现在最高法院米尔恩还没放出来"
    check(len(repetition._content(clause)) >= 12, "样本分句够 12 个字")
    out = repetition.collapse_repetition(CLAUSE_LOOP)
    check(out == CLAUSE_DONE, f"后一次长分句删掉，句号留给上一分句：{out}")
    check(out.count(clause) == 1, f"长分句只留第一次：{out}")
    check("，。" not in out and "。。" not in out, f"不留下双标点：{out}")
    check(repetition.collapse_repetition(out) == out, "分句收束后再跑一次不变")
    short = "一二三四五六七八九十甲"
    check(len(repetition._content(short)) == 11, f"11 字分句：{short}")
    stayed = repetition.collapse_repetition(f"{short}，另一句，{short}。")
    check(stayed == f"{short}，另一句，{short}。", f"不满 12 字的分句不删：{stayed}")
    long = "一二三四五六七八九十甲乙"
    check(len(repetition._content(long)) == 12, long)
    dropped = repetition.collapse_repetition(f"开头，{long}，中间短句，{long}，结尾")
    check(dropped == f"开头，{long}，中间短句，结尾", f"刚好 12 字且不是句末，删掉后一次和它的逗号：{dropped}")
    ended = repetition.collapse_repetition(f"{long}，短，{long}！后面")
    check(ended == f"{long}，短！后面", f"被删分句是句末时，句末标点换到紧挨着的前一个分句：{ended}")


def test_other_shapes():
    bare = "内部转岗" * 40
    check(repetition.collapse_repetition(bare) == "内部转岗内部转岗", repetition.collapse_repetition(bare))
    short = "不知道不知道不知道"  # 三遍，留下
    check(repetition.collapse_repetition(short) == short, short)
    stutter = "不知道" * 4  # 三字四遍，还像口吃，先留着
    check(repetition.collapse_repetition(stutter) == stutter, stutter)
    four = "内部会议" * 4
    check(repetition.collapse_repetition(four).count("内部会议") == 2, repetition.collapse_repetition(four))
    check(repetition.collapse_repetition("") == "", "空串")
    check(repetition.collapse_repetition("今天开会") == "今天开会", "普通句子")


def test_attached_file_if_present():
    candidates = [
        Path("/home/ubuntu/.cursor/projects/workspace/uploads/repeat-loop-live_a31e.json"),
        Path(__file__).resolve().parents[1] / "uploads" / "repeat-loop-live_a31e.json",
    ]
    path = next((p for p in candidates if p.exists()), None)
    if path is None:
        print("ok   附件不在这台机器上，跳过整文件检查")
        return
    segs = json.loads(path.read_text())
    changed = []
    for seg in segs:
        got = repetition.collapse_repetition(seg["text"])
        check(not runaway(got), f"start {seg['start']} 仍有循环：{got[:80]}")
        if got != seg["text"]:
            changed.append(seg["start"])
    check(changed == [616166], f"整份转写只有那一段被改：{changed}")


def test_loaded_transcript_is_cleaned():
    prev = vocab.get()
    try:
        vocab.save({"hotwords": "", "fixes": []})
        check(vocab.apply(LOOP).count("内部转岗") == 2, "读出来的旧转写也会收束，不依赖重新转写")
        check(vocab.apply("对对对") == "对对对", "词库替换之前也不误伤自然重复")
        check(vocab.apply(CHAR_LOOP) == CHAR_DONE, "读出来的单字循环也会收束")
        check(vocab.apply(CLAUSE_LOOP) == CLAUSE_DONE, "读出来的重复分句也会收束")
        paras = vocab.apply_paras([
            {"text": LOOP, "start": 616166, "end": 700000, "spk": 0},
            {"text": "对对对", "start": 1, "end": 2, "spk": 0, "edited": True},
        ])
        check(paras[0]["text"].count("内部转岗") == 2, paras[0]["text"])
        check(paras[1]["text"] == LOOP or paras[1]["text"] == "对对对", "手改过的段落不自动改写")
        check(paras[1]["text"] == "对对对", paras[1]["text"])
    finally:
        vocab.save(prev)


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_loop_from_recording()
    test_natural_repeats_stay()
    test_single_char_run()
    test_repeated_clause()
    test_other_shapes()
    test_attached_file_if_present()
    test_loaded_transcript_is_cleaned()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
