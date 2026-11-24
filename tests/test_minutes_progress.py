"""纪要生成时，模型还在思考就要把进度推给页面，避免一直停在「准备中」。
也确认请求里指定的模型就是实际调用的那一个。

用法：.venv/bin/python tests/test_minutes_progress.py
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-prog-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app  # noqa: E402
import store  # noqa: E402

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


RAW = json.dumps({
    "title": "周会",
    "summary": "讨论了预算。",
    "sections": [],
    "keywords": ["预算"],
    "actions": [],
}, ensure_ascii=False)


def _meeting():
    meta = store.create("周会", status="ready", source="upload", num_spk=0, speakers={}, template="general")
    store.save(meta["id"], "transcript.json", {
        "paragraphs": [{"start": 1000, "end": 2000, "spk": 0, "text": "测试预算的事我来申请，时间还没定"}],
    })
    return meta


def test_think_status_before_done():
    """思考进度必须在正文出来之前通过 on_status 推出去。"""
    statuses = []

    async def fake_events(p, messages, **kw):
        yield "think", 2
        yield "think", 4
        yield "text", RAW

    def fail_chat(*a, **k):
        raise AssertionError("应走 chat_events，不能整段等 chat() 结束")

    meta = _meeting()
    prov = {"name": "Gemini 2.5 Flash（测试）", "model": "gemini-2.5-flash", "max_input_chars": 60000}

    async def on_status(msg):
        statuses.append(msg)

    with mock.patch.object(app, "chat_events", fake_events), mock.patch.object(app, "chat", fail_chat):
        rec = asyncio.run(app.compose_minutes(meta["id"], "general", prov, on_status))

    check(any("正在思考" in s and "2 秒" in s for s in statuses), f"应先推送思考进度：{statuses}")
    check(any("正在思考" in s and "4 秒" in s for s in statuses), f"思考进度要更新：{statuses}")
    check(any(prov["name"] in s for s in statuses), f"进度里应带上实际在用的模型名：{statuses}")
    check(rec.get("provider") == prov["name"] and rec.get("model") == prov["model"],
          f"纪要应记下实际用的模型：{rec.get('provider')} {rec.get('model')}")
    check("讨论了预算" in (rec.get("markdown") or ""), f"应产出纪要正文：{rec.get('markdown', '')[:80]}")


def test_requested_provider_is_used():
    """下拉里选的模型必须是实际调用的那个，不能悄悄换成默认接口。"""
    seen = []

    async def fake_events(p, messages, **kw):
        seen.append(p.get("id") or p.get("name"))
        yield "text", RAW

    settings_path = store.DATA / "settings.json"
    had_settings = settings_path.exists()
    prev_raw = settings_path.read_bytes() if had_settings else None
    try:
        s = store.get_settings()
        s["active"] = "default_prov"
        s["providers"] = [
            {"id": "default_prov", "name": "DeepSeek", "base_url": "http://127.0.0.1:9/v1",
             "api_key": "k", "env_key": "", "model": "deepseek-chat", "max_input_chars": 60000, "extra_body": {}},
            {"id": "picked_prov", "name": "Gemini 2.5 Flash（caifree）", "base_url": "http://127.0.0.1:9/v1",
             "api_key": "k", "env_key": "", "model": "gemini-2.5-flash", "max_input_chars": 60000, "extra_body": {}},
        ]
        store.save_settings(s)
        meta = _meeting()
        prov = app._prov("picked_prov")
        with mock.patch.object(app, "chat_events", fake_events):
            rec = asyncio.run(app.compose_minutes(meta["id"], "general", prov, None))
        check(seen == ["picked_prov"], f"应调用选中的接口，而不是默认：{seen}")
        check(rec["provider"] == "Gemini 2.5 Flash（caifree）" and rec["model"] == "gemini-2.5-flash",
              f"记下的应是选中的模型：{rec['provider']} {rec['model']}")
        check(store.get_settings()["active"] == "default_prov", "生成纪要不应改掉默认接口")
    finally:
        if had_settings and prev_raw is not None:
            settings_path.write_bytes(prev_raw)
        elif settings_path.exists():
            settings_path.unlink()


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_think_status_before_done()
    test_requested_provider_is_used()
    print("PASS" if not fails else f"{fails} FAIL")
    sys.exit(1 if fails else 0)
