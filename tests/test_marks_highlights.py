"""录音打点、纪要要点（带来源时间范围）、打包导出。不加载语音模型，不调用大模型。

用法：.venv/bin/python tests/test_marks_highlights.py
"""
import asyncio
import io
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest import mock

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-marks-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app  # noqa: E402
import marks as mk  # noqa: E402
import minutes_check as mc  # noqa: E402
import prompts  # noqa: E402
import store  # noqa: E402
from fastapi import HTTPException  # noqa: E402

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


PARAS = [
    {"start": 5000, "end": 12000, "spk": 0, "text": "先说一下上线时间，定在下周三"},
    {"start": 60000, "end": 70000, "spk": 1, "text": "预算这边先批二十万，不够再追加"},
    {"start": 200000, "end": 210000, "spk": 0, "text": "供应商那边要换一家，李娜去谈"},
]


def _meeting(audio=False, minutes=None, marks=None):
    meta = store.create("周会/预算", status="ready", source="upload", num_spk=0, speakers={}, template="general", duration=210.0)
    mid = meta["id"]
    store.save(mid, "transcript.json", {"paragraphs": PARAS})
    if minutes is not None:
        store.save(mid, "minutes.json", minutes)
    if marks is not None:
        store.save(mid, "marks.json", marks)
    if audio:
        (store.mdir(mid) / "audio.mp3").write_bytes(b"ID3fake-mp3")
    return mid


def test_marks_store():
    mid = _meeting()
    check(mk.load(mid) == [], "没有 marks.json 就是没有打点")
    m1, ms1, new1 = mk.add(mid, 65000)
    check(new1 and len(ms1) == 1 and m1["t_ms"] == 65000, "新增打点")
    m2, ms2, new2 = mk.add(mid, 66000)
    check(not new2 and m2["id"] == m1["id"] and len(ms2) == 1, "2 秒内连点不重复新增")
    mk.add(mid, 5000)
    check([m["t_ms"] for m in mk.load(mid)] == [5000, 65000], "按时间排序")
    try:
        mk.add(mid, -1)
        check(False, "负时间应拒绝")
    except ValueError:
        check(True, "负时间应拒绝")
    left = mk.remove(mid, m1["id"])
    check([m["t_ms"] for m in left] == [5000], "删除打点")
    try:
        mk.remove(mid, "nope")
        check(False, "删不存在的打点应报 KeyError")
    except KeyError:
        check(True, "删不存在的打点应报 KeyError")
    store.save(mid, "marks.json", [{"t_ms": "x"}, "bad", {"t_ms": 3000, "id": "a"}])
    check([m["t_ms"] for m in mk.load(mid)] == [3000], "坏数据被忽略，不报错")


def test_endpoints():
    mid = _meeting()
    r = app.add_mark(mid, {"t_ms": 61000})
    check(r["created"] and r["mark"]["t_ms"] == 61000, "POST 打点")
    try:
        app.add_mark(mid, {"t_ms": "abc"})
        check(False, "非法 t_ms 应 400")
    except HTTPException as e:
        check(e.status_code == 400, "非法 t_ms 应 400")
    try:
        app.add_mark("no-such", {"t_ms": 1})
        check(False, "会议不存在应 404")
    except HTTPException as e:
        check(e.status_code == 404, "会议不存在应 404")
    d = app.get_meeting(mid)
    check(len(d["marks"]) == 1 and "预算" in d["marks"][0]["snippet"], "get_meeting 带打点和附近转写")
    app.delete_mark(mid, r["mark"]["id"])
    check(app.get_meeting(mid)["marks"] == [], "删除后没有打点")


def test_prompt_block():
    meta = {"title": "t", "created": "2026-01-01T00:00:00", "speakers": {}}
    marks = [{"id": "a", "t_ms": 65000, "label": "", "created": ""}]
    blk = mk.prompt_block(meta, marks, PARAS, prompts.spk_name)
    check("预算这边先批二十万" in blk and "供应商" not in blk, "打点前后 30 秒的转写进了提示，远处的没进")
    check("[01:00]" in blk and "打点 1 · 01:05" in blk, "带时间戳和打点序号")
    check(mk.prompt_block(meta, [], PARAS, prompts.spk_name) == "", "没有打点时为空")
    msgs = prompts.minutes_json_messages(meta, "", "general", "正文", marks_text=blk)
    check("预算这边先批二十万" in msgs[1]["content"] and "highlights" in msgs[1]["content"], "提示词里有打点块和 highlights 结构")
    msgs0 = prompts.minutes_json_messages(meta, "", "general", "正文")
    check("打点" not in msgs0[1]["content"], "没有打点时提示词里不提打点")


def test_build_highlights():
    raw = json.dumps({"title": "周会", "summary": "s", "sections": [], "actions": [], "keywords": [], "highlights": [
        {"text": "预算先批二十万", "start": "01:00", "end": "01:10", "quote": "预算这边先批二十万"},
        {"text": "时间写偏了但原话对得上", "start": "00:10", "end": "00:20", "quote": "供应商那边要换一家"},
        {"text": "时间完全对不上", "start": "30:00", "end": "30:30", "quote": "根本没说过的话"},
        {"text": "", "start": "00:05"},
        "垃圾",
    ]}, ensure_ascii=False)
    doc, checks = mc.build(raw, PARAS)
    hl = doc["highlights"]
    check(len(hl) == 3, f"空的和非对象的要点被丢掉：{len(hl)}")
    by = {h["text"]: h for h in hl}
    a = by["预算先批二十万"]
    check(a["start_ms"] == 60000 and a["end_ms"] == 70000 and a["verified"], "正常要点带起止时间")
    b = by["时间写偏了但原话对得上"]
    check(b["start_ms"] == 200000 and b["end_ms"] >= 210000, "起点按原话校正，终点不早于原话结束")
    c = by["时间完全对不上"]
    check(c["start_ms"] is None and not c["verified"], "对不上的要点保留文字、不给跳转")
    check(any(x["kind"] == "time" for x in checks), "校正和对不上都记进 checks")
    check([h["start_ms"] for h in hl if h["start_ms"] is not None] == [60000, 200000], "有出处的按时间排序")
    old, _ = mc.build(json.dumps({"title": "x", "summary": "s", "sections": [], "actions": [], "keywords": []}), PARAS)
    check(old["highlights"] == [], "模型没给 highlights 时是空列表，不报错")
    check("要点" not in mc.render(doc), "要点不混进纪要正文 markdown")


def test_old_meeting_degrades():
    mid = _meeting(minutes={"markdown": "# 旧纪要\n\n## 会议概要\n老内容\n", "template": "general", "provider": "x",
                            "model": "m", "created": "2026-01-01T00:00:00"})
    d = app.get_meeting(mid)
    check(d["minutes"]["markdown"].startswith("# 旧纪要") and "highlights" not in d["minutes"], "老纪要没有 highlights，原样返回")
    check(d["marks"] == [], "老会议没有打点")
    body = app.export(mid, fmt="md").body.decode()
    check("旧纪要" in body and "## 要点" not in body and "## 打点" not in body, "老会议的 Markdown 导出不多出空的要点/打点")


def test_compose_uses_marks():
    mid = _meeting(marks=[{"id": "a", "t_ms": 205000, "label": "", "created": ""}])
    seen = {}
    raw = json.dumps({"title": "周会", "summary": "s", "sections": [], "actions": [], "keywords": [], "highlights": [
        {"text": "换供应商，李娜去谈", "start": "03:20", "end": "03:30", "quote": "供应商那边要换一家"}]}, ensure_ascii=False)

    async def fake_events(p, messages, **kw):
        seen["prompt"] = messages[1]["content"]
        yield "text", raw

    with mock.patch.object(app, "chat_events", fake_events):
        prov = {"name": "测试", "model": "m", "max_input_chars": 60000}
        rec = asyncio.run(app.compose_minutes(mid, "general", prov))
    check("打点 1 · 03:25" in seen["prompt"] and "供应商那边要换一家" in seen["prompt"], "生成纪要时打点附近的转写作为重点传给模型")
    check(rec["highlights"] and rec["highlights"][0]["start_ms"] == 200000, "纪要记录里带 highlights")
    app._save_minutes(mid, rec)
    d = app.get_meeting(mid)
    check(d["minutes"]["highlights"][0]["marked"] is True, "附近有打点的要点标 marked")
    check("highlights" in store.load(mid, "minutes.json"), "highlights 存进 minutes.json")


def test_zip_export():
    hl = [{"text": "预算先批二十万", "start_ms": 60000, "end_ms": 70000, "quote": "", "verified": True},
          {"text": "没出处的要点", "start_ms": None, "end_ms": None, "quote": "", "verified": False}]
    mid = _meeting(audio=True, minutes={"markdown": "# 周会\n\n## 会议概要\n讨论预算。\n", "template": "general",
                                        "provider": "x", "model": "m", "created": "2026-01-01T00:00:00", "highlights": hl},
                   marks=[{"id": "a", "t_ms": 65000, "label": "", "created": ""}])
    resp = app.export(mid, fmt="zip")
    try:
        check(resp.media_type == "application/zip", "zip 的类型")
        with open(resp.path, "rb") as f:
            data = f.read()
    finally:
        if os.path.exists(resp.path):
            os.unlink(resp.path)
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    check(sorted(names) == ["纪要.md", "转写.txt", "音频.mp3"], f"zip 里有音频、转写、纪要：{names}")
    check(z.read("音频.mp3") == b"ID3fake-mp3", "音频是原文件")
    txt = z.read("转写.txt").decode()
    check("[01:00] 说话人2：预算这边先批二十万" in txt, "转写 TXT 内容")
    md = z.read("纪要.md").decode()
    check("## 要点" in md and "★ 预算先批二十万 [01:00]–[01:10]" in md and "- 没出处的要点" in md, "纪要含要点（有打点的带星，无出处的不带时间）")
    check("## 打点" in md and "- [01:05]：预算这边先批二十万" in md, "纪要含打点和附近转写")
    mid2 = _meeting()
    resp2 = app.export(mid2, fmt="zip")
    try:
        with zipfile.ZipFile(resp2.path) as z2:
            check(sorted(z2.namelist()) == ["纪要.md", "转写.txt"], "没有音频文件时不放音频")
    finally:
        if os.path.exists(resp2.path):
            os.unlink(resp2.path)
    check(resp2.headers["content-disposition"].startswith("attachment; filename*=UTF-8''"), "下载文件名带标题")
    check("%2F" not in resp2.headers["content-disposition"] and "_" in resp2.headers["content-disposition"], "标题里的斜杠已替换")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_marks_store()
    test_endpoints()
    test_prompt_block()
    test_build_highlights()
    test_old_meeting_degrades()
    test_compose_uses_marks()
    test_zip_export()
    print("PASS" if not fails else f"{fails} FAIL")
    sys.exit(1 if fails else 0)
