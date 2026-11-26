"""Integration tests for Wave 2 audio runtime, telemetry, worker pool, model manager, and clip export in app.py."""
from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import tempfile
import wave
import zipfile
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-app-opt-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

import app
import meeting_state as ms
import model_manager
import runtime_telemetry
import store


def _client() -> TestClient:
    return TestClient(app.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))


def _make_wav(path: Path, dur_s: float = 2.0, sr: int = 16000) -> None:
    t = np.linspace(0.0, dur_s, int(dur_s * sr), endpoint=False, dtype=np.float32)
    samples = 0.25 * np.sin(2.0 * np.pi * 440.0 * t)
    sf.write(str(path), samples, sr, subtype="PCM_16", format="WAV")


def _make_pcm(path: Path, dur_s: float = 1.0, sr: int = 16000) -> None:
    t = np.linspace(0.0, dur_s, int(dur_s * sr), endpoint=False, dtype=np.float32)
    pcm = (0.2 * np.sin(2.0 * np.pi * 440.0 * t) * 32767.0).astype(np.int16)
    path.write_bytes(pcm.tobytes())


def test_asr_unload_idle_and_busy_409():
    client = _client()
    calls: list[str] = []
    orig_unload = app.engine.unload

    def fake_unload(target: str = "all") -> dict:
        calls.append(target)
        return {"unloaded": [target], "memory": {"total_bytes": 100, "available_bytes": 50}}

    app.engine.unload = fake_unload
    try:
        # Idle -> 200
        resp = client.post("/api/asr/unload", json={"target": "nano"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["unloaded"] == ["nano"]
        assert "engine" in data
        assert calls == ["nano"]

        # Busy via LIVE -> 409
        app.LIVE["fake-live"] = SimpleNamespace()
        try:
            resp_live = client.post("/api/asr/unload", json={"target": "all"})
            assert resp_live.status_code == 409
        finally:
            app.LIVE.pop("fake-live", None)

        # Busy via _inflight -> 409
        with app._inflight_lock:
            app._inflight.add("fake-inflight")
        try:
            resp_inf = client.post("/api/asr/unload", json={"target": "all"})
            assert resp_inf.status_code == 409
        finally:
            with app._inflight_lock:
                app._inflight.discard("fake-inflight")

        # Busy via ambient active -> 409 unless force=True
        orig_enabled = app.ambient.enabled
        app.ambient.enabled = True
        try:
            resp_amb = client.post("/api/asr/unload", json={"target": "all"})
            assert resp_amb.status_code == 409
            resp_force = client.post("/api/asr/unload", json={"target": "all", "force": True})
            assert resp_force.status_code == 200
            assert calls[-1] == "all"
        finally:
            app.ambient.enabled = orig_enabled

        # Invalid target -> 400
        resp_bad = client.post("/api/asr/unload", json={"target": "unknown"})
        assert resp_bad.status_code == 400
    finally:
        app.engine.unload = orig_unload


def test_put_asr_unloads_unused_previous_model():
    unloaded: list[str] = []
    ensured: list[tuple[str, bool]] = []
    orig_unload = app.engine.unload
    orig_ensure = app.engine.ensure
    orig_ready = app.engine.ready
    orig_settings = store.get_settings()

    app.engine.unload = lambda target="all": unloaded.append(target) or {"unloaded": [target]}
    app.engine.ensure = lambda mode, force=False: ensured.append((mode, force)) or mode
    app.engine.ready = True
    try:
        # Switch paraformer -> nano
        with store.locked():
            s = store.get_settings()
            s["asr"] = {**(s.get("asr") or {}), "model": "paraformer"}
            store.save_settings(s)

        app._apply_asr_model_switch("nano", "paraformer")
        assert "live_asr" in unloaded and "paraformer" in unloaded
        assert ensured[-1] == ("nano", True)

        unloaded.clear()
        app._apply_asr_model_switch("paraformer", "nano")
        assert unloaded == ["nano"]
        assert ensured[-1] == ("paraformer", True)
    finally:
        app.engine.unload = orig_unload
        app.engine.ensure = orig_ensure
        app.engine.ready = orig_ready
        store.save_settings(orig_settings)


def test_local_llm_memory_admission_auto_unloads_idle_asr():
    orig_adm = runtime_telemetry.check_memory_admission
    orig_unload = app.engine.unload
    orig_start = app._start_local_llm
    orig_launch = app._local_llm_launch
    orig_proc = app._llm["proc"]
    orig_amb_cfg = dict(app.ambient.cfg)

    unloaded: list[str] = []
    calls = {"adm": 0}

    def fake_adm(need_bytes: int, label: str = "model", margin_bytes: int = 0, **kw):
        calls["adm"] += 1
        if calls["adm"] == 1:
            return {"ok": False, "available_bytes": 1024**3, "total_bytes": 8 * 1024**3, "warning": "low"}
        return {"ok": True, "available_bytes": 5 * 1024**3, "total_bytes": 8 * 1024**3, "warning": ""}

    class FakeProc:
        pid = 99999
        returncode = None

        def poll(self):
            return None

    runtime_telemetry.check_memory_admission = fake_adm
    app.engine.unload = lambda target="all": unloaded.append(target) or {"unloaded": ["nano"]}
    app._local_llm_launch = lambda: (["echo", "ok"], True)
    app._start_local_llm = lambda cmd, env, kw: FakeProc()
    app.ambient.cfg["enabled"] = False
    app._llm["proc"] = None

    try:
        req = SimpleNamespace(client=("127.0.0.1", 12345), headers={})
        orig_only_here = app.lan._only_here
        app.lan._only_here = lambda r: None
        try:
            res = asyncio.run(app.local_llm_action(req, {"action": "start"}))
        finally:
            app.lan._only_here = orig_only_here
        assert unloaded == ["all"]
        assert res["unloaded_asr"] is True
        assert res["memory"]["ok"] is True
    finally:
        runtime_telemetry.check_memory_admission = orig_adm
        app.engine.unload = orig_unload
        app._start_local_llm = orig_start
        app._local_llm_launch = orig_launch
        app._llm["proc"] = orig_proc
        app.ambient.cfg.update(orig_amb_cfg)


def test_audio_cache_control_clip_and_audio_export():
    client = _client()
    m = store.create("裁剪测试/会议", source="upload", status="ready")
    mid = m["id"]
    d = store.mdir(mid)
    _make_wav(d / "audio.wav", dur_s=2.0)

    # 1) /audio returns Cache-Control: no-store
    r_aud = client.get(f"/api/meetings/{mid}/audio")
    assert r_aud.status_code == 200
    assert r_aud.headers.get("cache-control") == "no-store"

    # 2) /audio/clip lossless WAV slice
    r_clip = client.get(f"/api/meetings/{mid}/audio/clip?start=0.25&end=1.25&fmt=wav")
    assert r_clip.status_code == 200
    assert r_clip.headers.get("cache-control") == "no-store"
    assert "attachment" in (r_clip.headers.get("content-disposition") or "").lower()
    with wave.open(io.BytesIO(r_clip.content), "rb") as wf:
        assert wf.getframerate() == 16000
        assert 15500 <= wf.getnframes() <= 16500

    # 3) /audio/clip invalid args -> 400
    assert client.get(f"/api/meetings/{mid}/audio/clip?start=1.5&end=1.0&fmt=wav").status_code == 400
    assert client.get(f"/api/meetings/{mid}/audio/clip?start=-1&end=1.0&fmt=wav").status_code == 400
    assert client.get(f"/api/meetings/{mid}/audio/clip?start=0&end=1.0&fmt=aac").status_code == 400

    # 4) /export?fmt=audio
    r_exp = client.get(f"/api/meetings/{mid}/export?fmt=audio")
    assert r_exp.status_code == 200
    assert "attachment" in (r_exp.headers.get("content-disposition") or "").lower()
    assert r_exp.headers.get("cache-control") == "no-store"
    assert len(r_exp.content) > 100

    # 5) PCM-only meeting materializes WAV for clip, and missing audio -> 404
    m_pcm = store.create("PCM会议", source="mic", status="ready")
    _make_pcm(store.mdir(m_pcm["id"]) / "audio.pcm", dur_s=1.0)
    r_pcm_clip = client.get(f"/api/meetings/{m_pcm['id']}/audio/clip?start=0.0&end=0.5&fmt=wav")
    assert r_pcm_clip.status_code == 200
    assert (store.mdir(m_pcm["id"]) / "audio.wav").exists()

    m_empty = store.create("无音频", source="mic", status="new")
    assert client.get(f"/api/meetings/{m_empty['id']}/audio/clip?start=0&end=1&fmt=wav").status_code == 404
    assert client.get(f"/api/meetings/{m_empty['id']}/export?fmt=audio").status_code == 404


def test_delete_and_trash_blocked_when_inflight():
    client = _client()
    m = store.create("转写中会议", source="upload", status="transcribing")
    mid = m["id"]
    with app._inflight_lock:
        app._inflight.add(mid)
    try:
        r_del = client.delete(f"/api/meetings/{mid}")
        assert r_del.status_code == 409
        r_trash = client.post(f"/api/meetings/{mid}/trash")
        assert r_trash.status_code == 409
    finally:
        with app._inflight_lock:
            app._inflight.discard(mid)
    # Now deletion succeeds
    assert client.delete(f"/api/meetings/{mid}").status_code == 200


def test_run_transcribe_timings_health_and_retranscribe_boot_retries():
    m = store.create("遥测会议", source="upload", status="queued", boot_retries=1, queued_at=1.0)
    mid = m["id"]
    d = store.mdir(mid)
    _make_wav(d / "audio.wav", dur_s=1.0)

    orig_ready = app.engine.ready
    orig_transcribe = app.engine.transcribe
    orig_make_mp3 = app.make_mp3
    orig_mjobs = app.minutes_jobs

    seen_ckpt: list[Path | None] = []

    def fake_transcribe(wav, num_spk=0, hotword="", vad_kw=None, checkpoint_dir=None):
        seen_ckpt.append(checkpoint_dir)
        app.engine.last_timings = {"model_load_s": 0.1, "asr_s": 0.4, "postprocess_s": 0.05}
        app.engine.last_info = {
            "engine": "paraformer",
            "audio_health": {
                "ok": False,
                "warnings": ["Audio is completely silent (all-silent)"],
                "dead_channels": [],
                "max_silent_s": 1.0,
            },
        }
        return [{"start": 0, "end": 1000, "spk": 0, "text": "测试文本"}]

    class FakePool:
        def submit(self, fn, *a):
            return None

    app.engine.ready = True
    app.engine.transcribe = fake_transcribe
    app.make_mp3 = lambda wav, mp3: mp3.write_bytes(b"ID3test")
    app.minutes_jobs = FakePool()
    try:
        app.run_transcribe(mid)
    finally:
        app.engine.ready = orig_ready
        app.engine.transcribe = orig_transcribe
        app.make_mp3 = orig_make_mp3
        app.minutes_jobs = orig_mjobs

    assert seen_ckpt == [d]
    tr = store.load(mid, "transcript.json")
    assert tr is not None
    assert "timings" in tr
    assert tr["timings"]["asr_s"] == 0.4
    assert "queue_s" in tr["timings"] and tr["timings"]["queue_s"] >= 0.0
    assert "ffmpeg_s" in tr["timings"] and tr["timings"]["ffmpeg_s"] >= 0.0
    assert tr["audio_health"]["warnings"] == ["Audio is completely silent (all-silent)"]

    meta = store.get(mid)
    assert meta["status"] == ms.READY
    assert meta["boot_retries"] == 0
    assert meta["audio_health"]["warnings"] == ["Audio is completely silent (all-silent)"]

    # Manual retranscribe resets boot_retries=0
    store.update(mid, boot_retries=2)
    orig_q = app.queue_transcribe
    queued: list[str] = []
    app.queue_transcribe = lambda x, reason="queue": queued.append(x)
    try:
        res = app.retranscribe(mid, {})
    finally:
        app.queue_transcribe = orig_q
    assert res["boot_retries"] == 0
    assert queued == [mid]


def test_startup_crash_loop_guard_and_lifecycle_hooks():
    m1 = store.create("首次中断", source="upload", status="transcribing")
    _make_wav(store.mdir(m1["id"]) / "audio.wav", dur_s=0.5)

    m2 = store.create("二次中断", source="upload", status="queued", boot_retries=1)
    _make_wav(store.mdir(m2["id"]) / "audio.wav", dur_s=0.5)

    orig_q = app.queue_transcribe
    orig_load = app.load_models
    orig_housekeeping = app._housekeeping
    orig_lan_apply = app.lan.server.apply
    orig_amb_start = app.ambient.start

    queued: list[str] = []

    async def noop_async():
        return None

    app.queue_transcribe = lambda mid, reason="queue": queued.append(mid)
    app.load_models = lambda: None
    app._housekeeping = noop_async
    app.lan.server.apply = noop_async
    app.ambient.start = lambda restore=False: None
    try:
        asyncio.run(app._startup())
    finally:
        app.queue_transcribe = orig_q
        app.load_models = orig_load
        app._housekeeping = orig_housekeeping
        app.lan.server.apply = orig_lan_apply
        app.ambient.start = orig_amb_start

    # First restart (0 -> 1 < 2) queues normally
    assert m1["id"] in queued
    assert store.get(m1["id"])["boot_retries"] == 1

    # Second restart (1 -> 2 >= 2) transitions to ERROR instead of re-queueing
    assert m2["id"] not in queued
    m2_after = store.get(m2["id"])
    assert m2_after["boot_retries"] == 2
    assert m2_after["status"] == ms.ERROR
    assert "中断" in m2_after["error"]

    # Rotating log configured
    assert (store.DATA / "logs" / "app.log").exists()


def test_diagnostics_export_sanitized_zip():
    client = _client()
    secret_meeting = store.create("机密会议TITLE_XYZ", source="mic", status="ready")
    store.save(secret_meeting["id"], "notes.md", "SECRET_NOTE_CONTENT")
    with store.locked():
        s = store.get_settings()
        orig_s = json.loads(json.dumps(s))
        s["providers"][0]["api_key"] = "sk-supersecretkey123456"
        store.save_settings(s)
    try:
        resp = client.get("/api/diagnostics/export")
        assert resp.status_code == 200
        assert resp.headers.get("content-type") == "application/zip"
        assert "meeting-notes-support.zip" in (resp.headers.get("content-disposition") or "")
        with zipfile.ZipFile(io.BytesIO(resp.content), "r") as zf:
            names = zf.namelist()
            assert "diagnostics.json" in names
            diag_raw = zf.read("diagnostics.json").decode("utf-8")
            assert "sk-supersecretkey123456" not in diag_raw
            assert "SECRET_NOTE_CONTENT" not in diag_raw
            assert "机密会议TITLE_XYZ" not in diag_raw
            diag = json.loads(diag_raw)
            assert "memory" in diag
            assert "state_snapshot" in diag
    finally:
        store.save_settings(orig_s)


def test_models_status_roots_download_cancel_and_state():
    client = _client()
    root_dir = Path(tempfile.mkdtemp(prefix="mn-model-root-"))
    (root_dir / "qwen-test.gguf").write_bytes(b"GGUF" + b"\x00" * 16)

    # Status
    r_st = client.get("/api/models/status")
    assert r_st.status_code == 200
    st = r_st.json()
    assert "models" in st and len(st["models"]) >= 1
    assert "roots" in st

    # Roots CRUD
    r_add = client.post("/api/models/roots", json={"path": str(root_dir)})
    assert r_add.status_code == 200
    assert str(root_dir.resolve()) in r_add.json()["roots"]

    r_roots = client.get("/api/models/roots")
    assert r_roots.status_code == 200
    assert any(g["name"] == "qwen-test.gguf" for g in r_roots.json()["gguf"])

    r_del = client.request("DELETE", "/api/models/roots", json={"path": str(root_dir)})
    assert r_del.status_code == 200
    assert str(root_dir.resolve()) not in r_del.json()["roots"]

    # Download & cancel normalization ("hf" -> "huggingface")
    mgr = model_manager.default_manager()
    orig_start = mgr.start_download
    orig_cancel = mgr.cancel_download
    seen_dl: list[tuple[str, str]] = []
    mgr.start_download = lambda mid, source="auto": seen_dl.append((mid, source)) or {"id": "t1", "model_id": mid, "source": source, "status": "queued"}
    mgr.cancel_download = lambda: {"id": "t1", "status": "cancelled"}
    try:
        r_dl = client.post("/api/models/download", json={"model_id": "fun-asr-nano", "source": "hf"})
        assert r_dl.status_code == 200
        assert seen_dl == [("fun-asr-nano", "huggingface")]
        r_can = client.post("/api/models/cancel")
        assert r_can.status_code == 200
        assert r_can.json()["task"]["status"] == "cancelled"
    finally:
        mgr.start_download = orig_start
        mgr.cancel_download = orig_cancel

    # Enriched /api/state
    r_state = client.get("/api/state")
    assert r_state.status_code == 200
    state = r_state.json()
    assert "memory" in state and "total_bytes" in state["memory"]
    assert "workers" in state and "pyannote" in state["workers"]
    assert "asr_idle_s" in state and isinstance(state["asr_idle_s"], (int, float))
