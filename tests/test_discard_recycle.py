"""全天模式发言太短时，对话挪进回收站而不是直接删掉。不加载语音模型做转写。

用法：.venv/bin/python tests/test_discard_recycle.py
"""
import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-discard-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ambient  # noqa: E402
import app  # noqa: E402
import lan  # noqa: E402
import store  # noqa: E402
from fastapi import HTTPException  # noqa: E402

fails = 0
_STANDALONE = False
queued = []


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


def fake_queue(mid):
    queued.append(mid)
    store.update(mid, status="queued", error="")


def make_meeting(text="第一句有字"):
    meta = store.create(title="", source="ambient", status="recording", title_auto=True)
    mid = meta["id"]
    d = store.mdir(mid)
    (d / "audio.pcm").write_bytes(b"pcm-16s")
    live = [{"start": 0, "end": 100, "text": ""}, {"start": 100, "end": 16000, "text": text}]
    store.save(mid, "live.json", live)
    return store.get(mid)


async def hit(method, path, headers, client):
    got = {}

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.start":
            got["status"] = msg["status"]
        elif msg["type"] == "http.response.body":
            got["body"] = (got.get("body") or b"") + (msg.get("body") or b"")

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": b"", "headers": headers, "client": client,
        "server": ("127.0.0.1", 80), "root_path": "",
    }
    await lan.Guard(app.app)(scope, receive, send)
    return got


def test_short_conversation_is_recycled():
    meta = make_meeting("内部转岗先不动")
    mid = meta["id"]
    check(ambient.should_auto_discard(mid, 16_000, 20), "16 秒、没写过东西，该进回收站")
    info = ambient.auto_discard(mid, 16_000, 20)
    check(info and info["voiced_s"] == 16.0, f"记下有效发言秒数：{info}")
    check(not store.mdir(mid).exists(), "会议目录里已经不在")
    kept = store.DISCARDED / mid
    check((kept / "audio.pcm").read_bytes() == b"pcm-16s", "录音还在回收站")
    check((kept / "meta.json").exists() and (kept / "live.json").exists(), "转写和元数据一起搬走")
    items = store.list_discarded()
    mine = next(x for x in items if x["id"] == mid)
    check(mine["time"] == meta["created"], f"时间是这段对话的开始时间：{mine['time']}")
    check(mine["voiced_s"] == 16.0 and mine["text"] == "内部转岗先不动", f"列表带发言秒数和第一句：{mine}")
    listed = app.discarded_list()["items"]
    check(any(x["id"] == mid and x["text"] == "内部转岗先不动" for x in listed), "接口列出同一段")


def test_notes_and_long_speech_stay():
    noted = make_meeting("有笔记")
    (store.mdir(noted["id"]) / "notes.md").write_text("先记下来", encoding="utf-8")
    check(ambient.auto_discard(noted["id"], 16_000, 20) is None, "写过笔记的短对话不丢")
    check((store.mdir(noted["id"]) / "audio.pcm").exists(), "笔记那场还在会议目录")
    long = make_meeting("够长")
    check(ambient.auto_discard(long["id"], 25_000, 20) is None, "超过 20 秒不丢")
    check(store.mdir(long["id"]).exists(), "够长的还在会议目录")


def test_user_delete_is_not_recycled():
    meta = make_meeting("用户自己删")
    mid = meta["id"]
    app.delete_meeting(mid)
    check(not store.mdir(mid).exists(), "用户删除后会议目录没了")
    check(not (store.DISCARDED / mid).exists(), "用户删除不进回收站")


def test_purge_old_and_keep_recent():
    old = make_meeting("八天前丢掉的")
    ambient.auto_discard(old["id"], 5_000, 20)
    info = store.read_json(store.DISCARDED / old["id"] / "discard.json")
    info["discarded_at"] = (datetime.now() - timedelta(days=8)).isoformat(timespec="seconds")
    store.write_json(store.DISCARDED / old["id"] / "discard.json", info)
    fresh = make_meeting("刚丢掉的")
    ambient.auto_discard(fresh["id"], 9_000, 20)  # 丢弃时顺手清掉过期的
    check(not (store.DISCARDED / old["id"]).exists(), "超过 7 天的回收站记录被清掉")
    check((store.DISCARDED / fresh["id"] / "audio.pcm").read_bytes() == b"pcm-16s", "刚丢掉的还在")
    older = make_meeting("启动时清掉")
    ambient.auto_discard(older["id"], 4_000, 20)
    info = store.read_json(store.DISCARDED / older["id"] / "discard.json")
    info["discarded_at"] = (datetime.now() - timedelta(days=8)).isoformat(timespec="seconds")
    store.write_json(store.DISCARDED / older["id"] / "discard.json", info)
    gone = store.purge_discarded()
    check(older["id"] in gone and not (store.DISCARDED / older["id"]).exists(), "启动时用的清理会删过期记录")
    check((store.DISCARDED / fresh["id"]).exists(), "清理不碰还在 7 天内的")
    kept = make_meeting("正常会议不被清")
    startup_expired = make_meeting("服务启动事件清掉")
    ambient.auto_discard(startup_expired["id"], 3_000, 20)
    s_info = store.read_json(store.DISCARDED / startup_expired["id"] / "discard.json")
    s_info["discarded_at"] = (datetime.now() - timedelta(days=8)).isoformat(timespec="seconds")
    store.write_json(store.DISCARDED / startup_expired["id"] / "discard.json", s_info)

    async def _noop_coro():
        return None

    with (
        mock.patch.object(app, "load_models", lambda: None),
        mock.patch.object(app, "queue_transcribe", fake_queue),
        mock.patch.object(app, "_housekeeping", _noop_coro),
        mock.patch.object(app.lan.server, "apply", _noop_coro),
    ):
        asyncio.run(app._startup())
    check(not (store.DISCARDED / startup_expired["id"]).exists(), "服务启动实际清理过期回收站记录")
    check(store.mdir(kept["id"]).exists(), "清理不碰会议目录里的记录")


def test_restore_queues_transcription():
    meta = make_meeting("恢复后要转写")
    mid = meta["id"]
    ambient.auto_discard(mid, 16_000, 20)
    queued.clear()

    async def run():
        evil = await hit("POST", f"/api/discarded/{mid}/restore",
                         [(b"host", b"127.0.0.1"), (b"origin", b"https://evil.test")],
                         ("127.0.0.1", 9))
        still = (store.DISCARDED / mid).exists() and not store.mdir(mid).exists()
        remote = await hit("GET", "/api/discarded",
                           [(b"host", b"127.0.0.1")],
                           ("10.9.9.9", 9))
        ok = await hit("POST", f"/api/discarded/{mid}/restore",
                       [(b"host", b"127.0.0.1"), (b"origin", b"http://127.0.0.1")],
                       ("127.0.0.1", 9))
        return evil, still, remote, ok

    with mock.patch.object(app, "queue_transcribe", fake_queue):
        evil, still, remote, ok = asyncio.run(run())
        check(evil.get("status") == 403, f"跨站恢复被拒绝：{evil.get('status')}")
        check(still, "拒绝之后文件还在回收站")
        check(remote.get("status") == 401, f"局域网未登录不能看回收站：{remote.get('status')}")
        check(ok.get("status") == 200, f"本机同源可以恢复：{ok.get('status')} {ok.get('body')}")
        check(store.mdir(mid).exists() and not (store.DISCARDED / mid).exists(), "恢复后回到会议目录")
        check((store.mdir(mid) / "audio.pcm").read_bytes() == b"pcm-16s", "恢复后录音还在")
        check(not (store.mdir(mid) / "discard.json").exists(), "回收站标记不留在会议目录")
        check(queued == [mid], f"恢复后排队精准转写：{queued}")
        check(store.get(mid)["status"] == "queued", store.get(mid)["status"])
        check(all(x["id"] != mid for x in store.list_discarded()), "列表里不再出现已恢复的")
        try:
            app.discarded_restore(mid)
            check(False, "已经恢复的不应再恢复一次")
        except HTTPException as e:
            check(e.status_code == 404, f"不存在的回收站记录是 404：{e.status_code}")
        try:
            app.discarded_restore("../etc")
            check(False, "非法 id 应被拒绝")
        except HTTPException as e:
            check(e.status_code == 400, f"非法 id：{e.status_code}")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_short_conversation_is_recycled()
    test_notes_and_long_speech_stay()
    test_user_delete_is_not_recycled()
    test_purge_old_and_keep_recent()
    test_restore_queues_transcription()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
