"""后端 P0/P1/P2 加固回归测试：覆盖存储安全、并发锁、ws_live 回滚、repetition 加速、
minutes_check 增强、gen_minutes 取消/并发 Map、waveform 容错、本地 LLM 限制与状态校验。
不加载语音模型、不联网。

用法：.venv/bin/python tests/test_backend_hardening.py
"""
import asyncio
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-hard-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException, UploadFile, WebSocketDisconnect  # noqa: E402
from starlette.requests import Request  # noqa: E402

import app  # noqa: E402
import llm  # noqa: E402
import marks as marks_mod  # noqa: E402
import meeting_state as ms  # noqa: E402
import minutes_check as mc  # noqa: E402
import prompts  # noqa: E402
import repetition  # noqa: E402
import store  # noqa: E402
import vocab  # noqa: E402
import waveform  # noqa: E402


def _make_request(client_host: str = "127.0.0.1") -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/llm/local",
        "headers": [],
        "client": (client_host, 12345),
        "scheme": "http",
        "server": ("127.0.0.1", 8770),
    }
    return Request(scope)


def test_p0_store_list_all_ds_store_and_corrupt():
    """P0 #2: .DS_Store 与损坏 meta.json 不能让 list_all() 崩溃。"""
    import shutil
    m = store.create("正常会议", source="mic")
    ds = store.MEETINGS / ".DS_Store"
    bad_dir = store.MEETINGS / "20260101-000000-bad1"
    bad_dir2 = store.MEETINGS / "20260101-000000-bad2"
    no_created = store.MEETINGS / "20260101-000000-nocr"
    try:
        ds.write_bytes(b"\x00\x00\x00\x01Bud1")
        bad_dir.mkdir(exist_ok=True)
        (bad_dir / "meta.json").write_text("[1, 2, 3]", encoding="utf-8")
        bad_dir2.mkdir(exist_ok=True)
        (bad_dir2 / "meta.json").write_text("{not-json", encoding="utf-8")
        no_created.mkdir(exist_ok=True)
        (no_created / "meta.json").write_text(json.dumps({"id": "20260101-000000-nocr", "title": "缺时间"}), encoding="utf-8")

        items = store.list_all()
        ids = {x["id"] for x in items}
        assert m["id"] in ids
        assert "20260101-000000-nocr" in ids
        assert "20260101-000000-bad1" not in ids
        assert "20260101-000000-bad2" not in ids
        assert store.read_json(ds / "meta.json") is None
    finally:
        if ds.exists():
            ds.unlink()
        for d in (bad_dir, bad_dir2, no_created):
            shutil.rmtree(d, ignore_errors=True)


def test_p0_atomic_write_and_permissions():
    """P0 #3: 并发 write_json 不损坏文件、不残留 .tmp，且 mode=0o600 生效。"""
    target = store.DATA / "concurrent_test.json"
    errs: list[Exception] = []

    def worker(tid: int):
        try:
            for i in range(25):
                store.write_json(target, {"tid": tid, "i": i, "payload": "x" * 200}, mode=0o600)
        except Exception as e:  # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=worker, args=(k,)) for k in range(6)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errs, f"并发写出错: {errs}"
    data = store.read_json(target)
    assert isinstance(data, dict) and "tid" in data
    leftovers = list(store.DATA.glob(".concurrent_test.json.*.tmp"))
    assert not leftovers, f"残留临时文件: {leftovers}"
    if os.name != "nt":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
    txt = store.DATA / "atomic_note.md"
    store.write_text(txt, "笔记内容", mode=0o600)
    assert txt.read_text("utf-8") == "笔记内容"
    if os.name != "nt":
        assert stat.S_IMODE(txt.stat().st_mode) == 0o600


def test_p0_mdir_and_upload_validation():
    """P0 #4: mdir 严格拦截穿越/点号/反斜杠；upload_meeting 后缀白名单与失败清理。"""
    for bad in ("", ".", "..", "a/b", "a\\b", "C:\\Windows", "foo.bar", "../x", "a\x00b"):
        try:
            store.mdir(bad)
            raise AssertionError(f"应拒绝非法 id: {bad!r}")
        except ValueError:
            pass
    assert store.mdir("20261121-120000-ab12").name == "20261121-120000-ab12"

    # 上传尾随点号文件名或含斜杠文件名不能报 AttributeError/FileNotFoundError，且解码失败后必须删掉孤儿目录
    before = {x["id"] for x in store.list_all()}
    for bad_name in ("recording.", "a.b/../../evil", "x.mp3"):
        up = UploadFile(filename=bad_name, file=io.BytesIO(b"not-valid-audio"))
        try:
            app.upload_meeting(file=up, title="", num_spk=0, hotword="", template="general")
            raise AssertionError("无效音频应返回 400")
        except HTTPException as e:
            assert e.status_code == 400, f"{bad_name}: {e}"
    after = {x["id"] for x in store.list_all()}
    assert after == before, f"上传失败不应残留空会议目录: {after - before}"


def test_p0_run_transcribe_mp3_guard_and_speaker_merge():
    """P0 #1 & P1 #3 & P1 #8: mp3 失败时不删 pcm/wav；成功时先删再 release 并异步刷新纪要；保留转写期间改名。"""
    orig_ready = app.engine.ready
    orig_transcribe = app.engine.transcribe
    orig_make_mp3 = app.make_mp3
    orig_pcm_to_wav = app.pcm_to_wav
    orig_to_wav16k = app.to_wav16k
    orig_dur = app.duration_of
    orig_hw = app._meeting_hotwords
    orig_mjobs = app.minutes_jobs

    submitted_minutes = []

    class FakePool:
        def submit(self, fn, *a):
            submitted_minutes.append((fn, a))

    try:
        app.engine.ready = True
        app.duration_of = lambda p: 10.0
        app._meeting_hotwords = lambda mid, meta: ""
        app.pcm_to_wav = lambda pcm, wav, ch=1: wav.write_bytes(b"RIFFfakewav")
        app.to_wav16k = lambda src, dst: dst.write_bytes(b"RIFFdecoded")
        app.minutes_jobs = FakePool()

        # 1) make_mp3 失败（产出 0 字节 mp3）时绝不能删除 pcm / wav
        m1 = store.create("全天1", source="ambient", status="queued")
        d1 = store.mdir(m1["id"])
        (d1 / "audio.pcm").write_bytes(b"\0" * 32000)
        app.make_mp3 = lambda wav, mp3: mp3.write_bytes(b"")  # 模拟空文件
        app.engine.transcribe = lambda wav, *a: [{"start": 0, "end": 1000, "spk": 0, "text": "你好"}]
        app.run_transcribe(m1["id"])
        assert (d1 / "audio.pcm").exists() and (d1 / "audio.wav").exists(), "mp3 为空时不能删原始录音"
        assert len(submitted_minutes) == 1 and submitted_minutes[-1][1] == (m1["id"],), "自动刷纪要应提交到独立 minutes_jobs"

        # 2) make_mp3 成功（非空）时才删 pcm / wav
        m2 = store.create("全天2", source="ambient", status="queued")
        d2 = store.mdir(m2["id"])
        (d2 / "audio.pcm").write_bytes(b"\0" * 32000)
        app.make_mp3 = lambda wav, mp3: mp3.write_bytes(b"ID3validmp3")
        app.run_transcribe(m2["id"])
        assert not (d2 / "audio.pcm").exists() and not (d2 / "audio.wav").exists(), "mp3 有效后应清理 pcm/wav"

        # 3) from_mp3=True 时转写报错也要清理临时 audio.wav
        m3 = store.create("全天3", source="ambient", status="queued")
        d3 = store.mdir(m3["id"])
        (d3 / "audio.mp3").write_bytes(b"ID3validmp3")

        def boom(*a):
            raise RuntimeError("asr fail")

        app.engine.transcribe = boom
        app.run_transcribe(m3["id"])
        assert not (d3 / "audio.wav").exists(), "from_mp3 转写异常时应清理临时 audio.wav"
        assert (d3 / "audio.mp3").exists()

        # 4) 双声道转写期间用户改名，不能被旧 meta 快照覆盖
        m4 = store.create("双声道", source="mic", status="queued", speakers={})
        d4 = store.mdir(m4["id"])
        (d4 / "audio.wav").write_bytes(b"RIFFwav")

        def mid_rename(wav, *a):
            store.update(m4["id"], speakers={"0": "老王"})
            return [
                {"start": 0, "end": 3000, "spk": 0, "ch": 0, "text": "我来说"},
                {"start": 3000, "end": 6000, "spk": 1, "ch": 1, "text": "好的"},
            ]

        app.engine.transcribe = mid_rename
        app.run_transcribe(m4["id"])
        sp = store.get(m4["id"])["speakers"]
        assert sp.get("0") == "老王" and sp.get("1") == "对方", f"应保留转写期间用户改名并补全未命名声道: {sp}"
    finally:
        app.engine.ready = orig_ready
        app.engine.transcribe = orig_transcribe
        app.make_mp3 = orig_make_mp3
        app.pcm_to_wav = orig_pcm_to_wav
        app.to_wav16k = orig_to_wav16k
        app.duration_of = orig_dur
        app._meeting_hotwords = orig_hw
        app.minutes_jobs = orig_mjobs


def test_p0_ws_live_rollback_and_takeover_lock():
    """P0 #7 & P1 #2: ws_live 握手失败彻底回滚（不泄漏 LIVE/holds/FD）；并发 takeover 串行不双写。"""
    orig_ready = app.engine.ready
    orig_live_session = app.engine.live_session
    orig_hw = app._meeting_hotwords
    opened_sessions = []

    class FakeSess:
        def __init__(self, path, hw, ch):
            self.path = path
            self.channels = ch
            self.file_bytes = path.stat().st_size if path.exists() else 0
            self.closed = False
            opened_sessions.append(self)

        def finish(self):
            self.closed = True
            return []

        def close(self):
            self.closed = True

    class FakeWS:
        def __init__(self, *, fail_on_ready=False, wait_ev=None):
            self.headers = {"user-agent": "Mac"}
            self.sent = []
            self.closed = False
            self.fail_on_ready = fail_on_ready
            self.wait_ev = wait_ev

        async def accept(self):
            pass

        async def send_json(self, obj):
            self.sent.append(obj)
            if self.fail_on_ready and obj.get("type") == "ready":
                raise WebSocketDisconnect(1006)

        async def receive(self):
            if self.wait_ev is not None:
                await self.wait_ev.wait()
            return {"type": "websocket.disconnect"}

        async def close(self, code=1000):
            self.closed = True

    async def scenario():
        app.engine.ready = True
        app._meeting_hotwords = lambda mid, meta: ""
        app.engine.live_session = lambda p, hw, ch=1: FakeSess(p, hw, ch)

        # 1) 发送 ready 时断开：必须完整回滚 LIVE / live_active / ambient.holds / sess FD
        m = store.create("握手断开测试", source="mic")
        mid = m["id"]
        ws1 = FakeWS(fail_on_ready=True)
        await app.ws_live(ws1, mid, rec="r1", ch=1)
        assert mid not in app.LIVE, "握手断开后 LIVE 不应残留"
        assert not app.is_live_active(mid), "握手断开后 is_live_active 应为 False"
        assert mid not in app.ambient.holds, "握手断开后 ambient.holds 不应泄漏"
        assert opened_sessions and opened_sessions[-1].closed, "LiveSession FD 应关闭"
        assert store.get(mid)["status"] == ms.NEW, f"应回滚状态: {store.get(mid)}"

        # 2) 并发 takeover：老 rec 处于 reconnecting，两条新连接同时接管时只能成功一条，另一条收 busy
        m2 = store.create("并发接管测试", source="mic")
        mid2 = m2["id"]
        old_ctx = app.LiveRec(mid2, "old_rec", 0, {"rec": "old_rec", "reconnects": 0, "gaps": [], "received": 0, "start_bytes": 0})
        old_ctx.sess = FakeSess(store.mdir(mid2) / "audio.pcm", "", 1)
        app.LIVE[mid2] = old_ctx

        hold_ev = asyncio.Event()
        ws_a = FakeWS(wait_ev=hold_ev)
        ws_b = FakeWS(wait_ev=hold_ev)

        async def run_both():
            t1 = asyncio.create_task(app.ws_live(ws_a, mid2, rec="new_a", ch=1))
            t2 = asyncio.create_task(app.ws_live(ws_b, mid2, rec="new_b", ch=1))
            await asyncio.sleep(0.15)
            hold_ev.set()
            await asyncio.gather(t1, t2)

        await run_both()
        # 清理残留 ctx
        if mid2 in app.LIVE:
            await app._live_finalize(app.LIVE[mid2], "stop", queue=False)
        types_a = [x.get("type") for x in ws_a.sent]
        types_b = [x.get("type") for x in ws_b.sent]
        ready_count = ("ready" in types_a) + ("ready" in types_b)
        busy_count = any(x.get("code") == "busy" for x in ws_a.sent) + any(x.get("code") == "busy" for x in ws_b.sent)
        assert ready_count == 1 and busy_count == 1, f"并发接管应一成一忙: a={ws_a.sent}, b={ws_b.sent}"

    try:
        asyncio.run(scenario())
    finally:
        app.engine.ready = orig_ready
        app.engine.live_session = orig_live_session
        app._meeting_hotwords = orig_hw


def test_p1_repetition_speed_and_store_search_cache():
    """P1 #1: repetition 提速且无语义回归；store meta 缓存感知外部修改；search 缓存感知笔记/词库变化。"""
    paras = [
        f"第{i}段讨论下个季度的产品规划与研发排期{i}，包括长尾词优化策略{i}、自动化测试链路改造{i}以及数据回写方案细节{i}。"
        f"另外团队同步了第{i}批客户反馈{i}、上线灰度窗口{i}和资源预算评估结果{i}。"
        for i in range(260)  # ~25k 字，不含重复分句
    ]
    t0 = time.perf_counter()
    for p in paras:
        assert repetition.collapse_repetition(p) == p
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert elapsed_ms < 200, f"25k 字去复读过慢: {elapsed_ms:.1f} ms"
    assert repetition.collapse_repetition("转岗？" + "内部转岗，" * 20 + "内部转岗") == "转岗？内部转岗，内部转岗"

    # store meta cache：返回副本（外部修改不影响缓存）且感知直接写盘
    m = store.create("缓存测试", source="mic")
    mid = m["id"]
    lst = store.list_all()
    got = next(x for x in lst if x["id"] == mid)
    got["title"] = "内存篡改"
    assert store.get(mid)["title"] == "缓存测试", "缓存应返回拷贝，避免调用方污染"
    raw_meta = store.read_json(store.mdir(mid) / "meta.json")
    raw_meta["title"] = "磁盘外部改写"
    store.write_json(store.mdir(mid) / "meta.json", raw_meta)
    assert store.get(mid)["title"] == "磁盘外部改写", "外部写盘后应自动失效缓存"

    # search 缓存更新
    store.save(mid, "transcript.json", {"paragraphs": [{"start": 0, "end": 1000, "spk": 0, "text": "初始口令甲"}]})
    r1 = app.search("初始口令甲")
    assert any(x["id"] == mid for x in r1)
    store.write_text(store.mdir(mid) / "notes.md", "新增笔记暗号乙")
    r2 = app.search("新增笔记暗号乙")
    assert any(x["id"] == mid for x in r2), "笔记变更后搜索缓存应自动失效"
    vocab.save({"hotwords": "", "fixes": [{"from": "初始口令甲", "to": "修正口令丙"}]})
    r3 = app.search("修正口令丙")
    assert any(x["id"] == mid for x in r3), "词库变更后搜索缓存应自动失效"
    vocab.save({"hotwords": "", "fixes": []})


def test_p1_minutes_check_enhancements():
    """P1 #4: 具名说话人、复合负责人、就近 quote_hit、邻轮期限、礼拜/中文日期/周天、数字抽核。"""
    paras = [
        {"start": 10000, "end": 15000, "spk": 0, "text": "这个问题下周再看，先记下来"},
        {"start": 60000, "end": 65000, "spk": 1, "text": "下礼拜五之前能把接口补完吗？"},
        {"start": 66000, "end": 72000, "spk": 0, "text": "行，我来把接口补完，预算大概二十万"},
        {"start": 300000, "end": 308000, "spk": 1, "text": "这个问题下周再看，十月十五号上线"},
    ]
    speakers = {"0": "张三", "1": "李四"}
    raw = json.dumps({
        "title": "项目同步",
        "summary": "预算约20万，价差控制在21%以内。[01:06]",
        "sections": [{"heading": "细节", "body": "接口按期推进，成本降幅达到35%。[01:06]"}],
        "actions": [
            {"task": "补完接口", "owner": "张三", "due": "下周五", "time": "01:06", "quote": "我来把接口补完"},
            {"task": "联调验收", "owner": "张三、李四", "due": "10月15日", "time": "05:00", "quote": "这个问题下周再看"},
            {"task": "部分编造负责人", "owner": "张三、王五", "due": "待定", "time": "01:06", "quote": "我来把接口补完"},
        ],
        "highlights": [
            {"text": "预算20万", "start": "01:06", "end": "01:12", "quote": "预算大概二十万"},
        ],
        "keywords": ["接口"],
    }, ensure_ascii=False)
    doc, checks = mc.build(raw, paras, speakers=speakers)
    by = {a["task"]: a for a in doc["actions"]}

    assert by["补完接口"]["owner"] == "张三", f"已改名说话人自领待办应保留: {by['补完接口']}"
    assert by["补完接口"]["due"] == "下周五", f"邻轮问句里的下礼拜五应支撑下周五: {by['补完接口']}"
    assert by["联调验收"]["owner"] == "张三、李四", f"复合负责人应保留: {by['联调验收']}"
    assert by["联调验收"]["time"].startswith("05:00"), f"重复短语应就近匹配 05:00 而非 00:10: {by['联调验收']}"
    assert by["联调验收"]["due"] == "10月15日", f"十月十五号应支撑 10月15日: {by['联调验收']}"
    assert by["部分编造负责人"]["owner"] == "张三", f"复合负责人里编造的人应剔除: {by['部分编造负责人']}"
    assert "21%（待确认）" in doc["summary"], f"编造的 21% 应标待确认: {doc['summary']}"
    assert "20万（待确认）" not in doc["summary"], f"与二十万一致的 20万 不应误标: {doc['summary']}"
    assert "35%（待确认）" in doc["sections"][0]["body"], f"小节里编造的 35% 应标待确认: {doc['sections'][0]}"
    assert any(c["kind"] == "number" and c["from"] == "21%" for c in checks)
    assert not any(c["kind"] == "number" and "20万" in c.get("from", "") for c in checks)
    assert mc.due_supported("周日", "周天之前搞定")
    assert mc.due_supported("下周五", "下礼拜五交")
    assert mc.due_supported("10月15日", "十月十五号前")


def test_p1_gen_minutes_cancel_concurrent_map_and_marks_budget():
    """P1 #5 & P2 #3: 断连取消 task；云端 Map 并发、本地串行；marks 预算按模型缩放；from_live 快照防 TOCTOU。"""
    orig_events = app.chat_events
    orig_compose = app.compose_minutes

    async def scenario():
        # 1) gen_minutes 断连取消 compose_minutes
        m = store.create("取消测试", source="mic")
        mid = m["id"]
        store.save(mid, "transcript.json", {"paragraphs": [{"start": 0, "end": 1000, "spk": 0, "text": "讨论计划"}]})
        cancelled = asyncio.Event()
        started = asyncio.Event()

        async def slow_compose(mid_, tpl, prov, on_status=None):
            started.set()
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                cancelled.set()
                raise

        app.compose_minutes = slow_compose
        prov_id = store.get_settings()["providers"][0]["id"]
        resp = await app.gen_minutes(mid, {"provider": prov_id})
        agen = resp.body_iterator
        # 驱动一点点后立即关闭流模拟断连
        task_pull = asyncio.create_task(agen.__anext__())
        await asyncio.wait_for(started.wait(), timeout=2)
        task_pull.cancel()
        try:
            await task_pull
        except BaseException:
            pass
        await agen.aclose()
        await asyncio.wait_for(cancelled.wait(), timeout=2)
        assert mid not in app._minutes_tasks

        # 2) 云端 Map 并发（max_active >= 2），本地 127.0.0.1 串行（max_active == 1）
        app.compose_minutes = orig_compose
        m2 = store.create("长会并发测试", source="mic")
        mid2 = m2["id"]
        big_paras = [
            {"start": i * 1000, "end": i * 1000 + 800, "spk": 0,
             "text": f"第{i}段讨论产品规划与版本排期{i}，涵盖搜索缓存{i}、纪要校验{i}、权限隔离{i}、波形并发{i}、性能压测{i}以及监控告警{i}等落地事项{i}。"}
            for i in range(120)
        ]
        store.save(mid2, "transcript.json", {"paragraphs": big_paras})

        active, peak = 0, 0

        async def fake_events(p, messages, **kw):
            nonlocal active, peak
            is_map = "分段" in messages[-1]["content"] or "部分" in messages[-1]["content"] and "提炼" in messages[-1]["content"]
            if is_map:
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.05)
                active -= 1
                yield "text", "要点笔记"
            else:
                yield "text", json.dumps({"title": "长会", "summary": "概要", "sections": [], "actions": [], "keywords": []})

        app.chat_events = fake_events
        cloud_prov = {"name": "Cloud", "model": "m", "base_url": "https://api.example.com/v1", "api_key": "k", "max_input_chars": 4000}
        await app.compose_minutes(mid2, "general", cloud_prov)
        assert peak >= 2, f"云端 Map 应并发，实际 peak={peak}"

        active = peak = 0
        local_prov = {"name": "Local", "model": "m", "base_url": "http://127.0.0.1:8090/v1", "api_key": "local", "max_input_chars": 4000}
        await app.compose_minutes(mid2, "general", local_prov)
        assert peak == 1, f"本地模型 Map 应保持串行，实际 peak={peak}"

        # 3) from_live TOCTOU：从 live.json 开跑，生成中途 transcript.json 落地，结果仍记 from_live=True
        m3 = store.create("TOCTOU", source="mic")
        mid3 = m3["id"]
        store.save(mid3, "live.json", [{"start": 0, "end": 1000, "text": "实时稿"}])

        async def fake_events_toctou(p, messages, **kw):
            store.save(mid3, "transcript.json", {"paragraphs": [{"start": 0, "end": 1000, "spk": 0, "text": "精转稿"}]})
            yield "text", json.dumps({"title": "T", "summary": "S", "sections": [], "actions": [], "keywords": []})

        app.chat_events = fake_events_toctou
        rec = await app.compose_minutes(mid3, "general", cloud_prov)
        assert rec["from_live"] is True, "开跑时用的是 live.json，from_live 应基于同一快照为 True"

        # 4) marks 预算缩放
        many_marks = [{"id": f"m{i}", "t_ms": i * 2000, "label": "", "created": ""} for i in range(40)]
        blk = marks_mod.prompt_block(m2, many_marks, big_paras, prompts.spk_name, max_total_chars=2000)
        assert len(blk) <= 2300, f"打点块应受动态预算上限控制: len={len(blk)}"

    try:
        asyncio.run(scenario())
    finally:
        app.chat_events = orig_events
        app.compose_minutes = orig_compose


def test_p1_waveform_error_and_odd_bytes():
    """P1 #7: ffmpeg 非 0 退出不缓存空 peaks；cache key 含 bucket_s；奇数字节分块安全拼接。"""
    orig_popen = waveform.subprocess.Popen
    tmp_dir = Path(tempfile.mkdtemp(prefix="mn-wave-"))
    (tmp_dir / "audio.wav").write_bytes(b"RIFFfake")

    class FakeProc:
        def __init__(self, chunks, rc):
            self._chunks = list(chunks)
            self.returncode = rc
            self.terminated = False

            class _Out:
                def __init__(self, outer):
                    self.outer = outer

                def read(self, n=-1):
                    return self.outer._chunks.pop(0) if self.outer._chunks else b""

                def close(self):
                    pass

            self.stdout = _Out(self)

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

        def wait(self, timeout=None):
            return self.returncode

    try:
        # 1) ffmpeg 失败不能写 peaks.json
        waveform.subprocess.Popen = lambda *a, **kw: FakeProc([], 1)
        try:
            waveform.peaks(tmp_dir, 10.0)
            raise AssertionError("ffmpeg 返回 1 应抛 RuntimeError")
        except RuntimeError:
            pass
        assert not (tmp_dir / "peaks.json").exists(), "ffmpeg 失败不应污染缓存"

        # 2) 奇数字节流式块安全拼接，且 duration 改变 bucket_s 时重新计算
        import numpy as np
        pcm = (np.ones(4000, dtype=np.int16) * 10000).tobytes()  # 1 秒 4kHz = 8000 字节
        odd_chunks = [pcm[:3], pcm[3:1001], pcm[1001:]]  # 刻意切成奇数长度块
        calls = 0

        def ok_popen(*a, **kw):
            nonlocal calls
            calls += 1
            return FakeProc(odd_chunks, 0)

        waveform.subprocess.Popen = ok_popen
        p1 = waveform.peaks(tmp_dir, 60.0)
        assert p1 and p1["bucket_s"] == 0.25 and len(p1["levels"]) == 4
        p1_cached = waveform.peaks(tmp_dir, 60.0)
        assert calls == 1 and p1_cached["key"] == p1["key"]
        p2 = waveform.peaks(tmp_dir, 7200.0)  # bucket_s 从 0.25 变成 3.0，key 必须变
        assert calls == 2 and p2["bucket_s"] == 3.0 and p2["key"] != p1["key"]
    finally:
        waveform.subprocess.Popen = orig_popen


def test_p1_validation_state_and_local_llm():
    """P1 #8 & #9: 日期/时间校验、edit_paragraph/retranscribe/patch_meeting、空 transcript 不退回 live、local_llm 本机限制。"""
    # 日期与汇总时间校验
    for bad_date in ("2026-02-31", "2026-13-01", "not-a-date"):
        try:
            app._check_date(bad_date)
            raise AssertionError(f"应拒绝无效日期: {bad_date}")
        except HTTPException as e:
            assert e.status_code == 400
    assert app._check_date("2026-11-21") == "2026-11-21"

    for bad_tm in ("25:99", "24:00", "12:60"):
        try:
            app.ambient_config({"summary_time": bad_tm})
            raise AssertionError(f"应拒绝无效时间: {bad_tm}")
        except HTTPException as e:
            assert e.status_code == 400

    # edit_paragraph: BUSY / _pending_close 拦截，负 spk 拦截
    m = store.create("段落校验", source="ambient", status="transcribing")
    mid = m["id"]
    store.save(mid, "transcript.json", {"paragraphs": [{"start": 0, "end": 1000, "spk": 0, "text": "原句"}]})
    try:
        app.edit_paragraph(mid, 0, {"text": "改"})
        raise AssertionError("transcribing 时不能改段")
    except HTTPException as e:
        assert e.status_code == 409

    store.update(mid, status="ready")
    try:
        app.edit_paragraph(mid, 0, {"spk": -1})
        raise AssertionError("负说话人编号应返回 400")
    except HTTPException as e:
        assert e.status_code == 400

    # 删除最后一段后 transcript.json 为空，_paras() 不能退回到旧 live.json
    store.save(mid, "live.json", [{"start": 0, "end": 1000, "text": "旧实时稿"}])
    app.edit_paragraph(mid, 0, {"text": ""})
    assert app._paras(mid) == [], "空 transcript.json 不应回退到旧 live.json"

    # retranscribe：保留对卡住全天 recording 的恢复入口，但拦截 _pending_close
    m_rec = store.create("卡住的全天", source="ambient", status="recording")
    (store.mdir(m_rec["id"]) / "audio.pcm").write_bytes(b"\0" * 32000)
    with app.ambient.lock:
        app.ambient._pending_close.add(m_rec["id"])
    try:
        try:
            app.retranscribe(m_rec["id"], {})
            raise AssertionError("_pending_close 中应返回 409")
        except HTTPException as e:
            assert e.status_code == 409
    finally:
        with app.ambient.lock:
            app.ambient._pending_close.discard(m_rec["id"])

    orig_q = app.queue_transcribe
    queued = []
    app.queue_transcribe = lambda x, reason="queue": queued.append(x)
    try:
        app.retranscribe(m_rec["id"], {})
        assert queued == [m_rec["id"]], "不在 _pending_close 里的卡住全天 recording 仍允许手动重新转写"
    finally:
        app.queue_transcribe = orig_q

    # patch_meeting 类型校验
    for bad_body in ({"title": ""}, {"title": None}, {"num_spk": "abc"}, {"num_spk": -2}, {"speakers": ["a"]}, {"notes": 123}):
        try:
            app.patch_meeting(mid, bad_body)
            raise AssertionError(f"应拒绝非法 patch: {bad_body}")
        except HTTPException as e:
            assert e.status_code == 400
    updated = app.patch_meeting(mid, {"num_spk": "3", "speakers": {"0": "张三"}})
    assert updated["num_spk"] == 3 and isinstance(updated["num_spk"], int)

    # POST /api/llm/local 拒绝局域网远端调用（403）且 LOCAL_LLM_CMD 无效时返回 400
    async def check_local_llm():
        try:
            await app.local_llm_action(_make_request("192.168.1.50"), {"action": "start"})
            raise AssertionError("局域网设备应被 403 拒绝")
        except HTTPException as e:
            assert e.status_code == 403

        old_cmd = os.environ.get("LOCAL_LLM_CMD")
        os.environ["LOCAL_LLM_CMD"] = "/nonexistent/llama-binary-xyz"
        try:
            st = await app.local_llm_status()
            assert st["script"] is False
            try:
                await app.local_llm_action(_make_request("127.0.0.1"), {"action": "start"})
                raise AssertionError("不可执行命令应返回 400")
            except HTTPException as e:
                assert e.status_code == 400
        finally:
            if old_cmd is None:
                os.environ.pop("LOCAL_LLM_CMD", None)
            else:
                os.environ["LOCAL_LLM_CMD"] = old_cmd

    asyncio.run(check_local_llm())

    # _tail_file 只读末尾 8KB
    big_log = store.DATA / "big.log"
    big_log.write_text("line\n" * 5000 + "TAIL_A\nTAIL_B\nTAIL_C\n", encoding="utf-8")
    tail = app._tail_file(big_log)
    assert tail == "TAIL_A\nTAIL_B\nTAIL_C", f"尾读不对: {tail!r}"


def test_p2_llm_eof_stream_and_misc():
    """P2 #3: llm 强制 stream=True、提前 EOF 报错；put_settings 校验 extra_body；get_day 用 segmap；prompts 容错。"""
    # 1) put_settings 拒绝非对象 extra_body
    cur = store.get_settings()
    bad_provs = [dict(cur["providers"][0], extra_body="[1, 2]")]
    try:
        app.put_settings({"providers": bad_provs, "active": cur["active"]})
        raise AssertionError("非 dict 的 extra_body 应报 400")
    except HTTPException as e:
        assert e.status_code == 400

    # 2) prompts.check_name_candidates 容忍非 dict 项
    tr = [{"start": 0, "end": 5000, "spk": 0, "text": "我是小王负责开发"}]
    res = prompts.check_name_candidates(["bad", 123, {"spk": 1, "name": "小王", "evidence": ["not-dict", {"ts": "00:00", "quote": "我是小王负责开发"}]}], tr)
    assert len(res) == 1 and res[0]["name"] == "小王"

    # 3) get_day 的 clock_end 走 segmap
    m = store.create("跳过静音测试", source="ambient", status="ready", duration=10.0)
    date = m["created"][:10]
    t0 = time.mktime(time.strptime(f"{date} 10:00:00", "%Y-%m-%d %H:%M:%S"))
    store.save(m["id"], "segmap.json", [[0, t0], [5000, t0 + 3600]])  # 中间跳了 1 小时
    day = app.get_day(date)
    mine = next(x for x in day["meetings"] if x["id"] == m["id"])
    assert mine["clock_start"] == "10:00" and mine["clock_end"] == "11:00", f"clock_end 应经 segmap 算成 11:00: {mine}"

    # 4) llm 强制 stream=True 且提前 EOF（无 [DONE] 且无 finish_reason）抛 LLMError
    seen_bodies = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen_bodies.append(body)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            c = {"choices": [{"index": 0, "delta": {"content": "半截"}, "finish_reason": None}]}
            self.wfile.write(f"data: {json.dumps(c, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            # 故意不写 [DONE] 也不写 finish_reason 直接断流

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        prov = {"name": "Mock", "base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1",
                "api_key": "k", "model": "m", "extra_body": {"stream": False}}
        try:
            asyncio.run(llm.chat(prov, [{"role": "user", "content": "hi"}]))
            raise AssertionError("无 [DONE] 且无 finish_reason 的断流应报 LLMError")
        except llm.LLMError as e:
            assert "中断" in str(e), str(e)
        assert seen_bodies and seen_bodies[-1]["stream"] is True, "extra_body 的 stream=False 不应覆盖 stream=True"
    finally:
        srv.shutdown()
        srv.server_close()

    # 5) delete_meeting 清理 _suspect_cache 和 _search_cache
    m_del = store.create("删缓存", source="mic")
    store.save(m_del["id"], "transcript.json", {"paragraphs": [{"start": 0, "end": 1000, "spk": 0, "text": "唯一检索词xyz"}]})
    app._suspects(m_del["id"], m_del)
    app.search("唯一检索词xyz")
    assert m_del["id"] in app._suspect_cache and m_del["id"] in app._search_cache
    app.delete_meeting(m_del["id"])
    assert m_del["id"] not in app._suspect_cache and m_del["id"] not in app._search_cache

    # 6) test_provider 使用 max_tokens=256（兼容推理模型）且 daily_gen 小预算不崩溃
    seen_max_tokens = []
    orig_chat = app.chat
    orig_events = app.chat_events

    async def fake_chat(prov, msgs, **kw):
        seen_max_tokens.append(kw.get("max_tokens"))
        return "你好"

    async def fake_events_daily(prov, msgs, **kw):
        yield "text", "# 汇总\n\n## 今日概览\n完成。"

    app.chat = fake_chat
    app.chat_events = fake_events_daily
    try:
        pid = store.get_settings()["providers"][0]["id"]
        res = asyncio.run(app.test_provider({"id": pid}))
        assert res["ok"] is True and seen_max_tokens[-1] == 256, f"test_provider max_tokens 应为 256: {seen_max_tokens}"

        # daily_gen 在 max_input_chars 极小时（<=3000）也不报错、不超预算
        m_day = store.create("当日会议", source="mic", status="ready")
        d_str = m_day["created"][:10]
        store.save(m_day["id"], "transcript.json", {
            "paragraphs": [
                {"start": i * 1000, "end": i * 1000 + 800, "spk": 0,
                 "text": f"当天第{i}段业务讨论记录{i}，涉及方案评审{i}、指标核对{i}、上线节点{i}与客户反馈{i}。"}
                for i in range(80)
            ]
        })
        tiny_prov = {"name": "Tiny", "model": "m", "base_url": "https://api.example.com/v1", "api_key": "k", "max_input_chars": 2500}

        async def run_daily():
            lines = [json.loads(ln) async for ln in app.daily_gen(d_str, tiny_prov)]
            return lines

        ev_lines = asyncio.run(run_daily())
        assert any(e.get("type") == "done" for e in ev_lines), f"daily_gen 小预算应成功: {ev_lines}"
    finally:
        app.chat = orig_chat
        app.chat_events = orig_events

    # 7) _NoCacheStatic 对 .js/.css 返回 Cache-Control: no-cache
    static_app = app._NoCacheStatic(directory=store.BASE / "static")
    scope = {"type": "http", "method": "GET", "path": "/static/app.js", "headers": []}
    resp = asyncio.run(static_app.get_response("app.js", scope))
    assert resp.headers.get("cache-control") == "no-cache", resp.headers


def test_ws_live_reconnect_resets_byte_rem():
    """#28 次要项 1: 断线重连进入 ctx.feed_lock 时清空 LiveSession._byte_rem，避免半帧残字节导致后续 PCM 永久错位。"""
    import asr_engine

    orig_ready = app.engine.ready
    orig_live_session = app.engine.live_session
    orig_hw = app._meeting_hotwords
    orig_q = app.queue_transcribe
    dummy_engine = SimpleNamespace(new_vad=lambda: SimpleNamespace(generate=lambda **kw: []))

    class ScriptedWS:
        def __init__(self, msgs):
            self.headers = {"user-agent": "Mac"}
            self.sent = []
            self._msgs = list(msgs)

        async def accept(self):
            pass

        async def send_json(self, obj):
            self.sent.append(obj)

        async def receive(self):
            if self._msgs:
                return self._msgs.pop(0)
            return {"type": "websocket.disconnect"}

        async def close(self, code=1000):
            pass

    async def scenario():
        app.engine.ready = True
        app._meeting_hotwords = lambda mid, meta: ""
        app.queue_transcribe = lambda mid, reason="queue": None
        app.engine.live_session = lambda p, hw, ch=1: asr_engine.LiveSession(dummy_engine, p, hw, ch)

        m = store.create("重连半帧对齐", source="mic")
        mid = m["id"]
        rec = "rec-rem-align"

        # 第一次连接：立体声每帧 4 字节，发 6 字节（落盘 4 字节，残留 2 字节在 _byte_rem）后异常断开
        ws1 = ScriptedWS([
            {"type": "websocket.receive", "bytes": b"\x01\x02\x03\x04\xAA\xBB"},
            {"type": "websocket.disconnect"},
        ])
        await app.ws_live(ws1, mid, rec=rec, ch=2)
        ctx = app.LIVE.get(mid)
        assert ctx is not None and ctx.sess is not None
        assert ctx.sess.file_bytes == 4, f"应仅落盘整帧 4 字节: {ctx.sess.file_bytes}"
        assert ctx.sess._byte_rem == b"\xAA\xBB", f"断开前应残留 2 字节半帧: {ctx.sess._byte_rem!r}"

        # 同 rec 重连：服务端告知 file_bytes=4 并清空 _byte_rem；客户端从偏移 4 重新发送整帧并正常结束
        ws2 = ScriptedWS([
            {"type": "websocket.receive", "bytes": b"\x10\x11\x12\x13"},
            {"type": "websocket.receive", "text": json.dumps({"type": "stop", "produced": 8, "dropped": 0})},
        ])
        await app.ws_live(ws2, mid, rec=rec, ch=2)
        ready_msg = next(x for x in ws2.sent if x.get("type") == "ready")
        assert ready_msg["resumed"] is True and ready_msg["file_bytes"] == 4, ready_msg
        pcm = (store.mdir(mid) / "audio.pcm").read_bytes()
        assert pcm == b"\x01\x02\x03\x04\x10\x11\x12\x13", f"重连后 PCM 不应被残留半帧错位: {pcm!r}"

    try:
        asyncio.run(scenario())
    finally:
        app.engine.ready = orig_ready
        app.engine.live_session = orig_live_session
        app._meeting_hotwords = orig_hw
        app.queue_transcribe = orig_q


def main():
    tests = [
        test_p0_store_list_all_ds_store_and_corrupt,
        test_p0_atomic_write_and_permissions,
        test_p0_mdir_and_upload_validation,
        test_p0_run_transcribe_mp3_guard_and_speaker_merge,
        test_p0_ws_live_rollback_and_takeover_lock,
        test_p1_repetition_speed_and_store_search_cache,
        test_p1_minutes_check_enhancements,
        test_p1_gen_minutes_cancel_concurrent_map_and_marks_budget,
        test_p1_waveform_error_and_odd_bytes,
        test_p1_validation_state_and_local_llm,
        test_p2_llm_eof_stream_and_misc,
        test_ws_live_reconnect_resets_byte_rem,
    ]
    for fn in tests:
        fn()
        print("ok  ", fn.__name__)
    print(f"全部通过（{len(tests)} 项）")


if __name__ == "__main__":
    main()
