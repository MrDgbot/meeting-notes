"""会议上下文热词的合并上限，以及不支持热词的模型在转写后的纠错。不加载语音模型。

用法：.venv/bin/python tests/test_context_hotwords.py
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-hw-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import context_hotwords as hw
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


def test_priority_and_cap():
    user = [f"词{i:02d}" for i in range(20)] + ["长尾词"]
    notes = "今天提到「观远数据」和 ASIN，还有「长尾词」。"
    history = ["上次也说了「预算池」和「观远数据」", "另一场又出现「观远数据」和「预算池」"]
    words = hw.merge_hotwords(user, title="Q3 评审", title_auto=False, speakers={"0": "李娜", "1": "说话人2"},
                              notes=notes, history=history, limit=30)
    check(words[0] == "词00" and "长尾词" in words and "李娜" in words, f"本场热词和参会人排在前面：{words[:3]} … {words[-4:]}")
    check(len(words) <= 30, f"不超过 30 个，实际 {len(words)}")
    check("李娜" in words, "参会人姓名要进去")
    check("说话人2" not in words, "没改过的「说话人N」不是热词")
    check("ASIN" in words or "观远数据" in words, f"笔记里的专名要进去：{words}")
    # 名额被本场热词占满时，历史专名进不去
    packed = hw.merge_hotwords([f"词{i:02d}" for i in range(30)], notes="「不该出现」", history=["「不该出现」", "「不该出现」"])
    check("不该出现" not in packed and len(packed) == 30, "用户的词优先，满了就不再加上下文")


def test_auto_title_and_dedup():
    words = hw.merge_hotwords(["asin"], title="会议 11-04 10:00", title_auto=True, notes="再说一次 ASIN")
    check(words == ["asin"], f"自动标题不进热词，英文大小写只留一条：{words}")
    words = hw.merge_hotwords([], title="长尾词周会", title_auto=False)
    check("长尾词" in words or "长尾词周会" in words, f"手写的短标题要留下专名：{words}")


def test_history_needs_repeat():
    once = hw.merge_hotwords([], history=["只出现一次的「孤证词」"])
    twice = hw.merge_hotwords([], history=["甲场「孤证词」", "乙场又是「孤证词」"])
    check("孤证词" not in once, f"只在一场里出现的专名不收：{once}")
    check("孤证词" in twice, f"至少两场出现过才收：{twice}")


def test_fallback_correction():
    prev = vocab.get()
    try:
        vocab.save({"hotwords": "", "fixes": []})
        out = hw.correct_by_lexicon("他说的以陈伟驰打流量", "长尾词 以图搜图")
        check(out == "他说的以长尾词打流量", f"豆包这条路按读音把热词改回来：{out}")
        kept = hw.correct_by_lexicon("这个预算是多少", "长尾词 预算池")
        check(kept == "这个预算是多少", f"常用词不改：{kept}")
        check(hw.correct_by_lexicon("陈伟驰", "") == "陈伟驰", "没有热词就不动原文")
        check(hw.correct_by_lexicon("", "长尾词") == "", "空文本保持空")
    finally:
        vocab.save(prev)


def test_for_meeting_string():
    prev = vocab.get()
    try:
        vocab.save({"hotwords": "预算池", "fixes": []})
        meta = {"title": "会议 11-04 10:00", "title_auto": True, "hotword": "长尾词", "speakers": {"0": "李娜"}}
        s = hw.for_meeting(meta, "笔记里写了「观远数据」", [], vocab.hotwords(""))
        words = s.split()
        check(words[:2] == ["预算池", "长尾词"], f"常用词库在本场热词前面：{words}")
        check("李娜" in words and "观远数据" in words, f"姓名和笔记专名拼进同一串：{words}")
    finally:
        vocab.save(prev)


def test_noise_word_filtering_preserves_acronyms_and_explicit_user_words():
    hw._PN_CACHE.clear()
    noisy_text = (
        "OK 好的，今天下午普通员工聊聊这个东西，宝贵的英语和中文资料，第一版入口关联维度太多，多少钱呢？"
        "Also check it to in on the and yes no, but keep ASIN, ERP, AI, IT, US, MCP, Codex 和「观远数据」。"
    )
    nouns = hw.proper_nouns(noisy_text)
    for bad in ("OK", "今天下午", "普通员工", "东西", "宝贵", "英语", "中文", "第一版", "入口", "关联", "维度", "太多", "多少钱",
                "Also", "it", "to", "in", "on", "the", "and", "yes", "no", "but", "keep"):
        check(bad not in nouns and bad.lower() not in {x.lower() for x in nouns if x != "IT" and x != "US"},
              f"非专名噪声词不应被自动抽取：{bad} -> {nouns}")
    for good in ("ASIN", "ERP", "AI", "IT", "US", "MCP", "Codex", "观远数据"):
        check(good in nouns, f"真实专名与缩写应保留：{good} -> {nouns}")

    # 短标题若是噪声词（如「第一版」「多少钱」）不进自动热词；但用户显式填写的热词仍保留
    from_title = hw.merge_hotwords([], title="第一版", title_auto=False, gallery_names=[])
    check("第一版" not in from_title, f"噪声短标题不应进自动热词：{from_title}")
    explicit = hw.merge_hotwords(["OK", "东西"], gallery_names=[])
    check(explicit == ["OK", "东西"], f"用户显式热词不受自动噪声过滤影响：{explicit}")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_priority_and_cap()
    test_auto_title_and_dedup()
    test_history_needs_repeat()
    test_fallback_correction()
    test_for_meeting_string()
    test_noise_word_filtering_preserves_acronyms_and_explicit_user_words()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
