"""精准转写落地后，实时稿或已经对不上的纪要会自动重写；手改过的不动。不调用大模型。

用法：.venv/bin/python tests/test_minutes_refresh.py
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-refresh-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app  # noqa: E402
import prompts  # noqa: E402
import store  # noqa: E402

fails = 0
_STANDALONE = False
calls = []


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


async def fake_compose(mid, template, prov, on_status=None):
    calls.append((mid, template, prov.get("name")))
    meta = store.get(mid)
    lines = prompts.transcript_lines(meta, app._paras(mid))
    return {
        "markdown": "# 精转纪要\n\n## 会议概要\n\n按精转稿重写。\n",
        "template": template,
        "provider": prov["name"],
        "model": prov.get("model") or "m",
        "created": "2026-11-04T19:33:00",
        "cost": 0.1,
        "src_hash": app._hash("\n".join(lines)),
        "notes_hash": app._hash(app._notes(mid).strip()),
        "from_live": False,
        "checks": [],
    }


def _meeting(title="周会", **fields):
    return store.create(title, status="ready", source="upload", num_spk=0, speakers={}, **fields)


def _put(mid, name, obj):
    store.save(mid, name, obj)


def _minutes(mid, **kw):
    base = {
        "markdown": "# 实时纪要\n\n## 会议概要\n\n实时稿里的错字。\n",
        "template": "general",
        "provider": "阿里百炼（通义千问）",
        "model": "qwen-plus",
        "created": "2026-11-04T19:30:38",
        "from_live": True,
        "edited": False,
        "src_hash": "live",
        "notes_hash": app._hash(""),
    }
    base.update(kw)
    _put(mid, "minutes.json", base)
    return base


def _paras(text, spk=0):
    return [{"start": 1000, "end": 2000, "spk": spk, "text": text}]


def test_from_live_refreshes_with_speakers():
    calls.clear()
    with mock.patch.object(app, "compose_minutes", fake_compose):
        meta = _meeting(title="")
        mid = meta["id"]
        fine = _paras("内部转岗先不动。", spk=2)
        _put(mid, "transcript.json", {"paragraphs": fine})
        _minutes(mid)
        check(app.refresh_minutes_after_transcript(mid), "实时稿纪要会重写")
        saved = store.load(mid, "minutes.json")
        check(saved["markdown"].startswith("# 精转纪要"), saved["markdown"][:40])
        check(saved["from_live"] is False, "重写后不再标成实时稿")
        check(calls and calls[-1][0] == mid, "用的是这场会")
        # 说话人标签进了给模型的转写（compose 读的就是带说话人的段落）
        line = prompts.transcript_lines(store.get(mid), app._paras(mid))[0]
        check("说话人3" in line and "内部转岗先不动" in line, line)
        check(store.get(mid)["num_spk"] == 0, "自动重写不改用户要的人数")
        check(store.get(mid)["title"] == "精转纪要" and store.get(mid)["title_auto"] is False, "占位标题换成纪要标题")


def test_edited_not_overwritten():
    calls.clear()
    with mock.patch.object(app, "compose_minutes", fake_compose):
        meta = _meeting(title="已命名", title_auto=False)
        mid = meta["id"]
        _put(mid, "transcript.json", {"paragraphs": _paras("精转文本")})
        _minutes(mid, edited=True, markdown="# 我改过的\n")
        check(not app.refresh_minutes_after_transcript(mid), "手改过的不重写")
        check(store.load(mid, "minutes.json")["markdown"].startswith("# 我改过的"), "原文还在")
        check(not calls, "没有去调模型")
        check(store.get(mid)["title"] == "已命名", "标题不动")


def test_same_transcript_not_refreshed():
    calls.clear()
    with mock.patch.object(app, "compose_minutes", fake_compose):
        meta = _meeting(title="已命名", title_auto=False)
        mid = meta["id"]
        paras = _paras("精转文本")
        _put(mid, "transcript.json", {"paragraphs": paras})
        digest = app._hash("\n".join(prompts.transcript_lines(store.get(mid), paras)))
        _minutes(mid, from_live=False, src_hash=digest)
        (store.mdir(mid) / "notes.md").write_text("只改了笔记", encoding="utf-8")
        check(not app.refresh_minutes_after_transcript(mid), "只改笔记、转写没变，不重写")
        check(not calls, "没有去调模型")


def test_older_transcript_refreshes():
    calls.clear()
    with mock.patch.object(app, "compose_minutes", fake_compose):
        meta = _meeting(title="已命名", title_auto=False)
        mid = meta["id"]
        _put(mid, "transcript.json", {"paragraphs": _paras("新的精转")})
        _minutes(mid, from_live=False, src_hash="old-transcript")
        check(app.refresh_minutes_after_transcript(mid), "上一版转写生成的纪要会重写")
        check(store.load(mid, "minutes.json")["from_live"] is False, "仍然是精转稿纪要")
        check(store.get(mid)["title"] == "已命名", "用户定过的标题不改")


def test_edited_during_generation_wins():
    calls.clear()

    async def edit_midway(mid, template, prov, on_status=None):
        calls.append(mid)
        cur = store.load(mid, "minutes.json")
        cur["edited"] = True
        cur["markdown"] = "# 生成过程中改的\n"
        store.save(mid, "minutes.json", cur)
        return {
            "markdown": "# 不该盖掉\n",
            "template": template,
            "provider": prov["name"],
            "model": "m",
            "created": "t",
            "cost": 0,
            "src_hash": "new",
            "notes_hash": "n",
            "from_live": False,
            "checks": [],
        }

    with mock.patch.object(app, "compose_minutes", edit_midway):
        meta = _meeting(title="已命名", title_auto=False)
        mid = meta["id"]
        _put(mid, "transcript.json", {"paragraphs": _paras("精转")})
        _minutes(mid)
        check(not app.refresh_minutes_after_transcript(mid), "生成期间手改了就放弃覆盖")
        check(store.load(mid, "minutes.json")["markdown"].startswith("# 生成过程中改的"), "留下手改的")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_from_live_refreshes_with_speakers()
    test_edited_not_overwritten()
    test_same_transcript_not_refreshed()
    test_older_transcript_refreshes()
    test_edited_during_generation_wins()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
