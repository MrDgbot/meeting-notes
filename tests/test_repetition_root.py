"""复读在送进解码器之前就拦住：切短、上下文不带复读、生成长度有上限、复读了再认一次。不加载语音模型。

用法：.venv/bin/python tests/test_repetition_root.py
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-reproot-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

import asr_engine
import doubao_asr
import store

fails = 0
_STANDALONE = False
SR = asr_engine.SR


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


def test_split_long_audio():
    short = np.ones(int(8 * SR), np.float32) * 0.1
    one = asr_engine.split_decode_spans(short)
    check(one == [(0, len(short))], f"不到 10 秒不切：{one}")
    long = np.ones(int(18 * SR), np.float32) * 0.1
    spans = asr_engine.split_decode_spans(long)
    check(all(b - a <= int(10 * SR) for a, b in spans), f"每段不超过 10 秒：{spans}")
    check(spans[0] == (0, int(10 * SR)) and spans[-1][1] == len(long), f"没有停顿就切在 10 秒上：{spans}")
    check(all(spans[i][1] == spans[i + 1][0] for i in range(len(spans) - 1)), "段首尾相接")
    gapped = np.ones(int(18 * SR), np.float32) * 0.1
    gap = int(9 * SR)
    gapped[gap:gap + int(0.4 * SR)] = 0
    cut = asr_engine.split_decode_spans(gapped)
    check(len(cut) == 2 and gap <= cut[0][1] <= gap + int(0.5 * SR), f"切在静音上：{cut}")
    check(cut[0][1] - cut[0][0] <= int(10 * SR) and cut[1][1] - cut[1][0] <= int(10 * SR), cut)


def test_piece_timestamps():
    n = int(18 * SR)
    audio = np.ones(n, np.float32) * 0.1
    seen = []

    def decode(clip, hotword, context):
        seen.append(len(clip))
        return f"第{len(seen)}段"

    pieces = asr_engine.decode_capped(audio, 1000, 1000 + 18000, decode, "热词", "上一句很正常")
    check(seen and max(seen) <= int(10 * SR), f"解码器拿到的每段都不超过 10 秒：{seen}")
    check(pieces[0]["start"] == 1000 and pieces[-1]["end"] == 19000, f"时间盖住原来的整段：{pieces}")
    check(all(pieces[i]["end"] <= pieces[i + 1]["start"] for i in range(len(pieces) - 1)), pieces)
    check([p["text"] for p in pieces] == [f"第{i}段" for i in range(1, len(pieces) + 1)], pieces)


def test_context_skips_repetition():
    clean = "今天讨论预算和排期，先不调人。"
    check(asr_engine.safe_context(clean) == clean, clean)
    long = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥"
    check(asr_engine.safe_context(long) == long[-20:], asr_engine.safe_context(long))
    check(asr_engine.safe_context("尔" * 10) == "", "单字失控循环不传")
    check(asr_engine.safe_context("哈哈哈哈哈哈") == "", "六个哈还不收束，但已经是连写，不传")
    check(asr_engine.safe_context("对对对对对。") == "", "五个对不传")
    check(asr_engine.safe_context("说说说说") == "", "四字连写不传")
    check(asr_engine.safe_context("内部转岗，内部转岗") == "", "短语连着两遍不传")
    check(asr_engine.safe_context("走走走") == "", "三字连写不传")
    check(asr_engine.recent_context(["", "  " + clean + "  "]) == clean, "空句跳过，正常句留下")
    check(asr_engine.recent_context(["今天开会", "尔" * 12]) == "", "上一句是复读就什么都不传")
    bare = "语音转写成中文："
    check(asr_engine.apply_nano_context(bare, "内部转岗，内部转岗") == bare, "短语复读不写进提示")


def test_decode_guard_retries_without_context():
    calls = []

    def decode(hotword, context, limit):
        calls.append((hotword, context, limit))
        if len(calls) == 1:
            return {"text": "内部转岗，" * 8, "timestamps": [{"token": "内"}]}
        return {"text": "内部转岗讨论到这里。", "timestamps": [{"token": "讨"}]}

    audio = np.zeros(SR, np.float32)
    out = asr_engine.nano_decode_guard(decode, audio, "长尾词", "尔" * 10)
    check(len(calls) == 2, f"复读会再认一次：{calls}")
    check(calls[0][0] == "长尾词" and calls[0][1] == "", f"复读的上一句第一次就不传：{calls[0]}")
    check(calls[0][2] == asr_engine.max_new_tokens_for(SR), calls[0])
    check(calls[1][0] == "" and calls[1][1] == "", f"第二次不带热词和上下文：{calls[1]}")
    check(out["text"] == "内部转岗讨论到这里。", out["text"])
    calls.clear()

    def clean(hotword, context, limit):
        calls.append((hotword, context, limit))
        return {"text": "今天开会讨论预算。", "timestamps": []}

    out = asr_engine.nano_decode_guard(clean, audio, "长尾词", "上一句没有重复")
    check(len(calls) == 1, f"正常句子不再认：{calls}")
    check(calls[0][1] == "上一句没有重复", calls[0])
    check(out["text"] == "今天开会讨论预算。", out)
    ten = np.zeros(10 * SR, np.float32)
    check(asr_engine.max_new_tokens_for(len(ten)) == 88, asr_engine.max_new_tokens_for(len(ten)))
    check(asr_engine.looks_like_loop("内部转岗，" * 8), "长复读算循环")
    check(asr_engine.looks_like_loop("内部会议" * 4), "收束后短一截也算循环")
    check(not asr_engine.looks_like_loop("今天开会讨论预算和排期。"), "正常句子不是循环")
    check(asr_engine.pick_less_repetitive("内部转岗，" * 8, "") == "内部转岗，" * 8, "再认是空的就留原来的")


def test_doubao_ddc_defaults_on():
    settings_path = store.DATA / "settings.json"
    had_settings = settings_path.exists()
    prev_raw = settings_path.read_bytes() if had_settings else None
    try:
        body = doubao_asr.session_body(False, "did", "app")
        check(body["enable_ddc"] is True, body)
        kept = doubao_asr.with_ddc({"enable_punctuation": True, "enable_ddc": False}, True)
        check(kept["enable_ddc"] is False, "已经写了 enable_ddc 就不覆盖")
        check(doubao_asr.ddc_enabled() is True, "设置里没写时默认开")
        store.save_settings({"providers": store.get_settings()["providers"], "active": "dashscope",
                             "asr": {"doubao_ddc": False}})
        check(doubao_asr.ddc_enabled() is False, "设置关掉之后请求里也关")
        off = doubao_asr.session_body(False, "did", "app")
        check(off["enable_ddc"] is False, off)
        store.save_settings({"providers": store.get_settings()["providers"], "active": "dashscope",
                             "asr": {"model": "nano"}})
        check(doubao_asr.ddc_enabled() is True, "只改了模型、没写这个开关时仍默认开")
    finally:
        if had_settings and prev_raw is not None:
            settings_path.write_bytes(prev_raw)
        elif settings_path.exists():
            settings_path.unlink()


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_split_long_audio()
    test_piece_timestamps()
    test_context_skips_repetition()
    test_decode_guard_retries_without_context()
    test_doubao_ddc_defaults_on()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
