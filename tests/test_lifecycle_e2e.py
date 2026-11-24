from __future__ import annotations

import io
import json
import logging
import struct
import threading
import time
import wave
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import ambient
import app
import asr_engine
import lan
import meeting_state as ms
import store

LOCAL_HEADERS = {"origin": "http://127.0.0.1"}


def _client() -> TestClient:
    return TestClient(
        lan.Guard(app.app),
        base_url="http://127.0.0.1",
        client=("127.0.0.1", 50000),
    )


def _wav_bytes(duration_s: float = 0.25, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    n = int(duration_s * sr)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(struct.pack("<" + "h" * n, *([0] * n)))
    return buf.getvalue()


@contextmanager
def _capture_warnings():
    warnings: list[str] = []

    class _Handler(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.WARNING:
                warnings.append(record.getMessage())

    handler = _Handler()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        yield warnings
    finally:
        root.removeHandler(handler)


class _ManualExecutor:
    def __init__(self):
        self.submitted: list[tuple] = []

    def submit(self, fn, *args):
        self.submitted.append((fn, args))


class _FakeLiveSession:
    def __init__(self, pcm_path: Path, channels: int = 1):
        self.channels = channels
        self.frame_bytes = 2 * channels
        self.offset = (pcm_path.stat().st_size // self.frame_bytes) if pcm_path.exists() else 0
        self.written = 0
        self._byte_rem = b""
        self.f = open(pcm_path, "ab")
        self.closed = False

    @property
    def file_bytes(self) -> int:
        return self.offset * self.frame_bytes + self.written

    @property
    def total_ms(self) -> int:
        return int((self.file_bytes // self.frame_bytes) * 1000 / 16000)

    def feed(self, data: bytes) -> list[dict]:
        if self.closed or not data:
            return []
        self.f.write(data)
        self.f.flush()
        self.written += len(data)
        return []

    def finish(self) -> list[dict]:
        self.close()
        return []

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.f.close()


def test_meeting_lifecycle_http_upload_marks_and_state_schema():
    client = _client()
    executor = _ManualExecutor()

    with mock.patch.object(app, "jobs", executor):
        r_new = client.post("/api/meetings", json={"title": "E2E 周会"}, headers=LOCAL_HEADERS)
        assert r_new.status_code == 200
        created = r_new.json()
        mid = created["id"]
        assert created["status"] == ms.NEW
        assert (store.mdir(mid) / "meta.json").exists()

        r_up = client.post(
            "/api/meetings/upload",
            files={"file": ("sample.wav", _wav_bytes(0.3), "audio/wav")},
            data={"title": "上传测试"},
            headers=LOCAL_HEADERS,
        )
        assert r_up.status_code == 200
        up_mid = r_up.json()["id"]
        assert (store.mdir(up_mid) / "audio.wav").exists()

        r_audio = client.get(f"/api/meetings/{up_mid}/audio")
        assert r_audio.status_code == 200
        assert len(r_audio.content) > 44

        r_mk = client.post(
            f"/api/meetings/{mid}/marks",
            json={"t_ms": 1500, "label": "重点决议"},
            headers=LOCAL_HEADERS,
        )
        assert r_mk.status_code == 200
        mark_id = r_mk.json()["mark"]["id"]
        assert len(client.get(f"/api/meetings/{mid}").json()["marks"]) == 1

        r_del_mk = client.delete(f"/api/meetings/{mid}/marks/{mark_id}", headers=LOCAL_HEADERS)
        assert r_del_mk.status_code == 200
        assert client.get(f"/api/meetings/{mid}").json()["marks"] == []

        r_patch = client.patch(
            f"/api/meetings/{mid}",
            json={"title": "已改标题", "speakers": {"0": "张三"}},
            headers=LOCAL_HEADERS,
        )
        assert r_patch.status_code == 200
        detail = client.get(f"/api/meetings/{mid}").json()
        assert detail["meta"]["title"] == "已改标题"
        assert detail["meta"]["speakers"] == {"0": "张三"}

        r_state = client.get("/api/state")
        assert r_state.status_code == 200
        state = r_state.json()
        json.dumps(state, ensure_ascii=False)
        assert set(state) >= {
            "meetings", "transcribe_queue", "live", "ambient",
            "engine", "auto_daily", "lan", "schema",
        }
        assert state["schema"]["meeting"]["transitions"]["new"]
        assert state["schema"]["ambient"]["states"]
        assert up_mid in state["transcribe_queue"]["inflight"]

        r_del = client.delete(f"/api/meetings/{mid}", headers=LOCAL_HEADERS)
        assert r_del.status_code == 200
        assert not store.mdir(mid).exists()
        assert client.get(f"/api/meetings/{mid}").status_code == 404

        orig_err, orig_load = app.engine.error, app.engine.loading
        try:
            app.engine.error, app.engine.loading = "no-model", False
            for fn, args in executor.submitted:
                fn(*args)
        finally:
            app.engine.error, app.engine.loading = orig_err, orig_load
        client.delete(f"/api/meetings/{up_mid}", headers=LOCAL_HEADERS)


def test_meeting_state_public_transition_contract():
    with _capture_warnings() as warnings:
        m = store.create(title="state-contract", source="upload")
        assert m["status"] == ms.NEW
        ms.transition(m["id"], ms.QUEUED, reason="contract")
        assert store.get(m["id"])["status"] == ms.QUEUED

        before_illegal = ms.illegal_count()
        warnings.clear()
        ms.transition(m["id"], ms.READY, reason="contract-illegal", chars=7)
        meta = store.get(m["id"])
        assert meta["status"] == ms.READY and meta["chars"] == 7
        assert ms.illegal_count() == before_illegal + 1
        assert any("queued -> ready" in w for w in warnings)

        last = ms.history()[-1]
        assert last["from"] == ms.QUEUED and last["to"] == ms.READY
        assert last["ok"] is False and last["reason"] == "contract-illegal"

        try:
            ms.transition("20000101-000000-none", ms.READY)
            raise AssertionError("expected KeyError for missing meeting")
        except KeyError:
            pass

        assert all(s in ms.TRANSITIONS for s in ms.STATES)
        assert all(t in ms.STATES for targets in ms.TRANSITIONS.values() for t in targets)
        for frm, to in [
            ("new", "recording"), ("recording", "queued"), ("queued", "transcribing"),
            ("transcribing", "ready"), ("transcribing", "error"), ("ready", "queued"),
            ("ready", "recording"), ("error", "queued"), ("recording", "ready"),
            ("recording", "new"), ("transcribing", "queued"),
        ]:
            assert ms.allowed(frm, to), f"{frm} -> {to} should be allowed"
        for frm, to in [
            ("new", "transcribing"), ("ready", "transcribing"),
            ("recording", "transcribing"), ("ready", "error"),
        ]:
            assert not ms.allowed(frm, to), f"{frm} -> {to} should be disallowed"

        st = _client().get("/api/state").json()
        assert st["meetings"]["counts"]["ready"] >= 1
        assert st["meetings"]["unexpected_transitions"] >= 1
        assert all(s in ambient.TRANSITIONS for s in ambient.STATES)


def test_transcribe_queue_dedup_and_retry_via_http():
    client = _client()
    executor = _ManualExecutor()
    orig_err, orig_load = app.engine.error, app.engine.loading

    m = store.create(title="dedup-http", source="upload")
    mid = m["id"]
    (store.mdir(mid) / "audio.wav").write_bytes(_wav_bytes(0.2))

    with mock.patch.object(app, "jobs", executor):
        try:
            r1 = client.post(f"/api/meetings/{mid}/transcribe", json={}, headers=LOCAL_HEADERS)
            r2 = client.post(f"/api/meetings/{mid}/transcribe", json={}, headers=LOCAL_HEADERS)
            assert r1.status_code == 200 and r2.status_code == 409
            app.queue_transcribe(mid, reason="concurrent-sweep")
            assert len(executor.submitted) == 1
            assert store.get(mid)["status"] == ms.QUEUED

            st_queued = client.get("/api/state").json()
            assert mid in st_queued["transcribe_queue"]["inflight"]

            app.engine.error, app.engine.loading = "boom", False
            fn, args = executor.submitted[0]
            fn(*args)

            meta = store.get(mid)
            assert meta["status"] == ms.ERROR
            assert meta["error"].startswith(app.MODEL_FAIL)
            st_after = client.get("/api/state").json()
            assert mid not in st_after["transcribe_queue"]["inflight"]

            r3 = client.post(f"/api/meetings/{mid}/transcribe", json={}, headers=LOCAL_HEADERS)
            assert r3.status_code == 200
            assert len(executor.submitted) == 2
            assert store.get(mid)["status"] == ms.QUEUED
            executor.submitted[1][0](*executor.submitted[1][1])
        finally:
            app.engine.error, app.engine.loading = orig_err, orig_load
            store.delete(mid)


def test_discarded_restore_via_http_with_and_without_audio():
    client = _client()
    executor = _ManualExecutor()

    m_no_audio = store.create(title="", source="ambient", status="recording", title_auto=True)
    store.save(m_no_audio["id"], "live.json", [{"start": 0, "end": 1000, "text": "有字"}])
    store.recycle(m_no_audio["id"], voiced_s=1.0, min_s=20.0)

    m_with_audio = store.create(title="", source="ambient", status="recording", title_auto=True)
    (store.mdir(m_with_audio["id"]) / "audio.pcm").write_bytes(b"\0" * 64000)
    store.recycle(m_with_audio["id"], voiced_s=1.0, min_s=20.0)

    orig_err, orig_load = app.engine.error, app.engine.loading
    with mock.patch.object(app, "jobs", executor):
        try:
            r1 = client.post(f"/api/discarded/{m_no_audio['id']}/restore", headers=LOCAL_HEADERS)
            assert r1.status_code == 200
            assert store.get(m_no_audio["id"])["status"] == ms.READY
            assert len(executor.submitted) == 0

            r2 = client.post(f"/api/discarded/{m_with_audio['id']}/restore", headers=LOCAL_HEADERS)
            assert r2.status_code == 200
            assert store.get(m_with_audio["id"])["status"] == ms.QUEUED
            assert len(executor.submitted) == 1
            assert m_with_audio["id"] in client.get("/api/state").json()["transcribe_queue"]["inflight"]

            app.engine.error, app.engine.loading = "skip-model", False
            executor.submitted[0][0](*executor.submitted[0][1])
        finally:
            app.engine.error, app.engine.loading = orig_err, orig_load
            store.delete(m_no_audio["id"])
            store.delete(m_with_audio["id"])


def test_ambient_generation_token_prevents_stale_thread_clobber():
    gen1_entered = threading.Event()
    gen1_release = threading.Event()
    gen2_entered = threading.Event()
    gen2_release = threading.Event()
    capture_calls = 0

    class _StubEngine:
        ready = True
        error = ""

    a = ambient.Ambient(_StubEngine(), lambda mid: None)
    a._awake = lambda on: None

    def _controlled_capture():
        nonlocal capture_calls
        capture_calls += 1
        call_no = capture_calls
        if call_no == 1:
            a._set_state(ambient.LISTENING)
            gen1_entered.set()
            gen1_release.wait(timeout=5)
        else:
            a._set_state(ambient.LISTENING)
            gen2_entered.set()
            gen2_release.wait(timeout=5)

    a._capture = _controlled_capture
    try:
        a.start()
        assert gen1_entered.wait(timeout=3)
        t1 = a.thread
        assert t1 is not None

        # Simulate stop() returning while gen1 thread is still winding down, followed by immediate start().
        with a.lock:
            a.enabled = False
        a.start()
        assert gen2_entered.wait(timeout=3)

        gen1_release.set()
        t1.join(timeout=3)
        assert not t1.is_alive()

        st = a.status()
        info = a.state_info()
        assert st["enabled"] is True
        assert st["state"] == ambient.LISTENING
        assert "state_since" in st
        assert info["state"] == ambient.LISTENING
        assert st["error"] == ""

        a.hold("live-rec-1")
        assert a.state_info()["holds"] == ["live-rec-1"]
        a.release("live-rec-1")
        assert a.state_info()["holds"] == []
    finally:
        gen1_release.set()
        gen2_release.set()
        a.stop()
        assert a.status()["state"] == ambient.OFF


def test_live_ws_disconnect_grace_and_remote_end():
    client = _client()
    executor = _ManualExecutor()
    m = store.create(title="live-ws-e2e")
    mid = m["id"]

    class _StubEngine:
        ready = True
        error = ""
        loading = False

        def live_session(self, pcm_path: Path, hotword: str = "", channels: int = 1):
            return _FakeLiveSession(pcm_path, channels)

        def state_info(self):
            return {"main": "ready", "nano": "unloaded", "error": ""}

    with (
        mock.patch.object(app, "engine", _StubEngine()),
        mock.patch.object(app, "jobs", executor),
    ):
        ws_headers = {"host": "127.0.0.1", "origin": "http://127.0.0.1"}
        try:
            with client.websocket_connect(f"/ws/live/{mid}?rec=r1&ch=1", headers=ws_headers) as ws:
                ready_msg = ws.receive_json()
                assert ready_msg["type"] == "ready"
                assert ready_msg["rec"] == "r1"
                ws.send_bytes(b"\x01\x00" * 20000)
                time.sleep(0.05)

            state_after_drop = client.get("/api/state").json()
            live_entry = next((x for x in state_after_drop["live"] if x["id"] == mid), None)
            assert live_entry is not None
            assert live_entry["phase"] == "reconnecting"

            detail = client.get(f"/api/meetings/{mid}").json()
            assert detail["live_active"] is True
            assert detail["live_state"]["state"] == "reconnecting"

            r_end = client.post(f"/api/meetings/{mid}/live/end", headers=LOCAL_HEADERS)
            assert r_end.status_code == 200
            assert r_end.json()["ok"] is True

            state_after_end = client.get("/api/state").json()
            assert all(x["id"] != mid for x in state_after_end["live"])
            assert (store.mdir(mid) / "audio.pcm").stat().st_size == 40000
            assert store.get(mid)["status"] == ms.QUEUED
            assert len(executor.submitted) == 1
        finally:
            if executor.submitted:
                app.engine.ready, app.engine.error = False, "cleanup"
                executor.submitted[0][0](*executor.submitted[0][1])
            store.delete(mid)


def test_ambient_stale_thread_error_cannot_clobber_restarted_run():
    gen1_entered = threading.Event()
    gen1_release = threading.Event()
    gen2_entered = threading.Event()
    gen2_release = threading.Event()
    closed_convs: list[object] = []
    capture_calls = 0

    class _StubEngine:
        ready = True
        error = ""

    a = ambient.Ambient(_StubEngine(), lambda mid: None)
    a._awake = lambda on: None

    def _controlled_capture():
        nonlocal capture_calls
        capture_calls += 1
        if capture_calls == 1:
            a._set_state(ambient.LISTENING)
            gen1_entered.set()
            gen1_release.wait(timeout=5)
            raise RuntimeError("stale capture device failed")
        a._set_state(ambient.LISTENING)
        gen2_entered.set()
        gen2_release.wait(timeout=5)

    a._capture = _controlled_capture
    orig_close_conv = a._close_conv

    def _spy_close_conv():
        if a.conv is not None:
            closed_convs.append(a.conv)
        orig_close_conv()

    a._close_conv = _spy_close_conv
    try:
        a.start()
        assert gen1_entered.wait(timeout=3)
        t1 = a.thread
        assert t1 is not None

        with a.lock:
            a.enabled = False
        a.start()
        assert gen2_entered.wait(timeout=3)

        sentinel_conv = ambient.Conv(
            mid="20261123-000000-gen2",
            f=io.BytesIO(),
            started="2026-11-23T00:00:00",
            last_end=time.time(),
        )
        with a.lock:
            a.conv = sentinel_conv
            stale_gen = a._run_gen - 1

        # Directly prove expected_gen blocks stale state writes under lock.
        a._set_state(ambient.OFF, -100.0, expected_gen=stale_gen)
        assert a.status()["state"] == ambient.LISTENING

        # Release gen1 into its except branch; it must not set error, change state, or close gen2's conv.
        gen1_release.set()
        t1.join(timeout=3)
        assert not t1.is_alive()

        st = a.status()
        assert st["enabled"] is True
        assert st["state"] == ambient.LISTENING
        assert st["error"] == ""
        assert a.conv is sentinel_conv
        assert sentinel_conv not in closed_convs
    finally:
        with a.lock:
            a.conv = None
        gen1_release.set()
        gen2_release.set()
        a.stop()


def test_live_takeover_keeps_ambient_hold_continuous_and_blocks_inflight():
    client = _client()
    executor = _ManualExecutor()
    m = store.create(title="live-takeover-e2e")
    mid = m["id"]
    releases: list[str] = []

    class _StubEngine:
        ready = True
        error = ""
        loading = False

        def live_session(self, pcm_path: Path, hotword: str = "", channels: int = 1):
            return _FakeLiveSession(pcm_path, channels)

        def state_info(self):
            return {"main": "ready", "nano": "unloaded", "error": ""}

    orig_release = app.ambient.release

    def _spy_release(key: str):
        releases.append(key)
        return orig_release(key)

    ws_headers = {"host": "127.0.0.1", "origin": "http://127.0.0.1"}
    with (
        mock.patch.object(app, "engine", _StubEngine()),
        mock.patch.object(app, "jobs", executor),
        mock.patch.object(app.ambient, "release", _spy_release),
    ):
        try:
            # 1. Start rec r1, then drop into reconnecting grace phase.
            with client.websocket_connect(f"/ws/live/{mid}?rec=r1&ch=1", headers=ws_headers) as ws1:
                assert ws1.receive_json()["type"] == "ready"
                ws1.send_bytes(b"\x01\x00" * 1600)
                time.sleep(0.05)

            assert mid in app.ambient.state_info()["holds"]
            releases.clear()

            # 2. New session rec r2 takes over: ambient hold must NOT drop and re-acquire.
            with client.websocket_connect(f"/ws/live/{mid}?rec=r2&ch=1", headers=ws_headers) as ws2:
                ready2 = ws2.receive_json()
                assert ready2["type"] == "ready" and ready2["rec"] == "r2"
                assert mid not in releases, f"ambient hold dropped during takeover: {releases}"
                assert mid in app.ambient.state_info()["holds"]
                ws2.send_bytes(b"\x01\x00" * 1600)
                time.sleep(0.05)

            r_end = client.post(f"/api/meetings/{mid}/live/end", headers=LOCAL_HEADERS)
            assert r_end.status_code == 200
            assert mid in releases
            assert mid not in app.ambient.state_info()["holds"]

            # 3. Verify ws_live rejects a meeting in _inflight even before status transitions to QUEUED.
            m2 = store.create(title="inflight-race-check")
            mid2 = m2["id"]
            with app._inflight_lock:
                app._inflight.add(mid2)
            try:
                with client.websocket_connect(f"/ws/live/{mid2}?rec=r3&ch=1", headers=ws_headers) as ws3:
                    err = ws3.receive_json()
                    assert err["type"] == "error" and err["code"] == "busy"
            finally:
                with app._inflight_lock:
                    app._inflight.discard(mid2)
                store.delete(mid2)
        finally:
            if executor.submitted:
                app.engine.ready, app.engine.error = False, "cleanup"
                for fn, args in executor.submitted:
                    fn(*args)
            store.delete(mid)


def test_engine_load_single_flight_and_error_recovery():
    main_loads: list[str] = []
    started = threading.Event()
    release = threading.Event()

    class _SlowAutoModel:
        def __init__(self, **kw):
            model = kw.get("model", "")
            if model == "paraformer-zh" and "vad_model" in kw:
                main_loads.append(model)
                started.set()
                release.wait(timeout=5)

        def generate(self, **kw):
            return [{"text": ""}]

    with (
        mock.patch.object(asr_engine, "AutoModel", _SlowAutoModel),
        mock.patch.object(asr_engine, "asr_mode", lambda: "paraformer"),
    ):
        e = asr_engine.Engine()
        assert e.state_info()["main"] == "idle"
        threads = [threading.Thread(target=e.load) for _ in range(5)]
        for t in threads:
            t.start()
        assert started.wait(timeout=3)
        assert e.state_info()["main"] == "loading"
        release.set()
        for t in threads:
            t.join(timeout=5)
        assert len(main_loads) == 1
        assert e.state_info()["main"] == "ready"
        assert e.state_info()["nano"] == "unloaded"

    def _failing_model(**kw):
        raise RuntimeError("weights missing")

    with (
        mock.patch.object(asr_engine, "AutoModel", _failing_model),
        mock.patch.object(asr_engine, "asr_mode", lambda: "paraformer"),
    ):
        e2 = asr_engine.Engine()
        e2.load()
        assert e2.state_info()["main"] == "error"
        assert "weights missing" in e2.state_info()["error"]


def test_settings_schema_migration_preserves_explicit_empty_providers():
    settings_path = store.SETTINGS
    backup = settings_path.read_bytes() if settings_path.exists() else None
    try:
        store.write_json(settings_path, {"active": "custom"})
        migrated = store.get_settings()
        assert len(migrated["providers"]) == len(store.DEFAULT_SETTINGS["providers"])

        store.save_settings({"active": "", "providers": []})
        kept_empty = store.get_settings()
        assert kept_empty["providers"] == []
    finally:
        if backup is not None:
            settings_path.write_bytes(backup)
        elif settings_path.exists():
            settings_path.unlink()
