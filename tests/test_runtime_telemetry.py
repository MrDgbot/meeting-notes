"""Unit tests for runtime_telemetry and store safe pending-delete."""

from __future__ import annotations

import builtins
import io
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import types
from unittest import mock
import zipfile

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-telemetry-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

import runtime_telemetry as rt  # noqa: E402
import store  # noqa: E402


class _FakeClock:
    def __init__(self, start: float = 100.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, delta: float) -> None:
        self.now += delta


def _cleanup_managed_log_handlers() -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_meeting_notes_rotating", False):
            root.removeHandler(h)
            try:
                h.close()
            except OSError:
                pass


def test_job_clock_phases_nesting_external_and_finish():
    clk = _FakeClock(10.0)
    jc = rt.JobClock(clock=clk)

    jc.begin("queue_s")
    clk.advance(1.25)
    jc.end()

    jc.switch("ffmpeg_s")
    clk.advance(0.5)

    jc.begin("asr_s")
    clk.advance(2.0)
    jc.begin("model_load_s")
    clk.advance(1.5)
    jc.end("model_load_s")
    clk.advance(3.0)
    jc.end("asr_s")

    jc.begin("vad_s")
    clk.advance(0.75)
    jc.end()

    jc.add_external("diarize_load_s", 1.1)
    jc.add_external("diarize_run_s", 2.4)
    jc.add_external("postprocess_s", -5.0)
    jc.add_external("postprocess_s", float("nan"))

    snap_before_finish = jc.snapshot()
    assert snap_before_finish["queue_s"] == pytest.approx(1.25)
    assert snap_before_finish["ffmpeg_s"] == pytest.approx(0.5)
    assert snap_before_finish["model_load_s"] == pytest.approx(1.5)
    assert snap_before_finish["asr_s"] == pytest.approx(5.0)
    assert snap_before_finish["vad_s"] == pytest.approx(0.75)
    assert snap_before_finish["diarize_load_s"] == pytest.approx(1.1)
    assert snap_before_finish["diarize_run_s"] == pytest.approx(2.4)
    assert snap_before_finish["postprocess_s"] == 0.0
    assert snap_before_finish["total_s"] == pytest.approx(12.5)
    assert all(isinstance(v, float) for v in snap_before_finish.values())

    jc.begin("postprocess_s")
    clk.advance(0.4)
    final = jc.finish()
    clk.advance(50.0)
    jc.switch("asr_s")
    jc.begin("queue_s")
    jc.end()
    after = jc.snapshot()
    assert final["postprocess_s"] == pytest.approx(0.4)
    assert final["total_s"] == pytest.approx(12.9)
    assert after == final

    with pytest.raises(ValueError):
        jc.begin("unknown_phase")
    with pytest.raises(ValueError):
        jc.switch("unknown_phase")
    with pytest.raises(ValueError):
        jc.add_external("unknown_phase", 1.0)


def test_job_clock_thread_safety():
    jc = rt.JobClock()
    errs: list[Exception] = []

    def worker() -> None:
        try:
            for _ in range(50):
                jc.add_external("asr_s", 0.01)
                jc.snapshot()
        except Exception as exc:  # noqa: BLE001
            errs.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errs
    assert jc.snapshot()["asr_s"] == pytest.approx(2.0, abs=1e-4)


def test_host_memory_status_and_fallbacks(monkeypatch):
    info = rt.host_memory_status()
    expected_keys = {
        "total_bytes",
        "available_bytes",
        "used_bytes",
        "percent",
        "commit_avail_bytes",
        "cuda_free_bytes",
        "cuda_total_bytes",
        "source",
    }
    assert expected_keys.issubset(info.keys())
    if info["total_bytes"] is not None:
        assert info["total_bytes"] > 0
        assert 0 <= info["available_bytes"] <= info["total_bytes"]

    # Test Linux /proc/meminfo parser directly
    proc_text = (
        "MemTotal:       16384000 kB\n"
        "MemFree:         2000000 kB\n"
        "MemAvailable:    8192000 kB\n"
        "CommitLimit:    20000000 kB\n"
        "Committed_AS:    5000000 kB\n"
    )
    linux = rt._parse_proc_meminfo(proc_text)
    assert linux is not None
    assert linux["total_bytes"] == 16384000 * 1024
    assert linux["available_bytes"] == 8192000 * 1024
    assert linux["used_bytes"] == (16384000 - 8192000) * 1024
    assert linux["percent"] == pytest.approx(50.0)
    assert linux["commit_avail_bytes"] == 15000000 * 1024

    # Test macOS vm_stat parser directly
    vm_text = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free:                                    10000.\n"
        "Pages active:                                  50000.\n"
        "Pages inactive:                                20000.\n"
        "Pages speculative:                              5000.\n"
    )
    mac = rt._parse_vm_stat(vm_text, total_bytes=16 * 1024**3)
    assert mac is not None
    assert mac["available_bytes"] == 35000 * 16384
    assert mac["source"] == "darwin-vm_stat"

    # Simulate missing psutil and failing OS probes: must never raise
    orig_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("no psutil")
        if name == "torch":
            raise RuntimeError("torch broken")
        return orig_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    monkeypatch.setattr(rt, "_darwin_memory_status", lambda: None)
    monkeypatch.setattr(rt, "_linux_memory_status", lambda: None)
    monkeypatch.setattr(rt, "_windows_memory_status", lambda: None)

    degraded = rt.host_memory_status()
    assert degraded["source"] == "unavailable"
    assert degraded["available_bytes"] is None
    assert degraded["cuda_free_bytes"] is None
    assert degraded["cuda_total_bytes"] is None

    # Simulate torch.cuda available
    fake_torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(
            is_available=lambda: True,
            device_count=lambda: 1,
            mem_get_info=lambda: (4 * 1024**3, 8 * 1024**3),
        )
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(builtins, "__import__", orig_import)
    cuda_free, cuda_total = rt._cuda_memory_status()
    assert cuda_free == 4 * 1024**3
    assert cuda_total == 8 * 1024**3


def test_check_memory_admission(monkeypatch):
    gib = 1024**3
    monkeypatch.setattr(
        rt,
        "host_memory_status",
        lambda: {"total_bytes": 16 * gib, "available_bytes": 4 * gib},
    )
    ok_res = rt.check_memory_admission(2 * gib, label="ASR", margin_bytes=512 * 1024**2)
    assert ok_res["ok"] is True
    assert ok_res["warning"] == ""
    assert ok_res["recommendation"] == ""

    low_res = rt.check_memory_admission(4 * gib, label="Diarization", margin_bytes=512 * 1024**2)
    assert low_res["ok"] is False
    assert "Diarization" in low_res["warning"]
    assert low_res["recommendation"]

    monkeypatch.setattr(
        rt,
        "host_memory_status",
        lambda: {"total_bytes": None, "available_bytes": None},
    )
    unknown_res = rt.check_memory_admission(8 * gib, label="ASR")
    assert unknown_res["ok"] is True


def test_setup_rotating_log_idempotent_and_dynamic(tmp_path, monkeypatch):
    _cleanup_managed_log_handlers()
    try:
        dir1 = tmp_path / "data1"
        h1 = rt.setup_rotating_log(dir1)
        h2 = rt.setup_rotating_log(dir1)
        assert h1 is h2
        assert isinstance(h1, RotatingFileHandler)
        assert h1.maxBytes == 4 * 1024 * 1024
        assert h1.backupCount == 3
        assert Path(h1.baseFilename).resolve() == (dir1 / "logs" / "app.log").resolve()

        managed = [h for h in logging.getLogger().handlers if getattr(h, "_meeting_notes_rotating", False)]
        assert len(managed) == 1

        logging.getLogger("test.telemetry").info("hello rotating log")
        h1.flush()
        assert "hello rotating log" in (dir1 / "logs" / "app.log").read_text(encoding="utf-8")

        # Dynamic store.DATA resolution when data_dir=None
        dir2 = tmp_path / "data2"
        monkeypatch.setattr(store, "DATA", dir2)
        h3 = rt.setup_rotating_log()
        assert Path(h3.baseFilename).resolve() == (dir2 / "logs" / "app.log").resolve()
        managed = [h for h in logging.getLogger().handlers if getattr(h, "_meeting_notes_rotating", False)]
        assert len(managed) == 1
    finally:
        _cleanup_managed_log_handlers()


def test_export_diagnostics_zip_sanitized_and_bounded(tmp_path):
    data_dir = tmp_path / "diag_data"
    logs_dir = data_dir / "logs"
    logs_dir.mkdir(parents=True)
    (logs_dir / "app.log").write_bytes(b"A" * 100 + b"TAIL_APP_LOG\n")
    (logs_dir / "local-llm.log").write_bytes(b"B" * 100 + b"TAIL_LLM_LOG\n")

    # Sensitive files that must NEVER be exported
    (data_dir / "settings.json").write_text('{"api_key": "sk-top-secret-file"}', encoding="utf-8")
    (data_dir / "meetings" / "m1").mkdir(parents=True)
    (data_dir / "meetings" / "m1" / "audio.wav").write_bytes(b"RIFFSECRET_AUDIO")
    (data_dir / "meetings" / "m1" / "transcript.json").write_text("CONFIDENTIAL TRANSCRIPT", encoding="utf-8")
    (data_dir / "meetings" / "m1" / "notes.md").write_text("PRIVATE NOTES", encoding="utf-8")
    (data_dir / "trash" / "m2").mkdir(parents=True)
    (data_dir / "trash" / "m2" / "audio.mp3").write_bytes(b"ID3TRASH")
    (data_dir / "discarded" / "m3").mkdir(parents=True)
    (data_dir / "discarded" / "m3" / "live.json").write_text("DISCARDED TEXT", encoding="utf-8")

    state_snapshot = {
        "active_provider": "dashscope",
        "api_key": "sk-live-secret-1",
        "nested": {
            "authToken": "tok-abc",
            "client_secret": "sec-xyz",
            "adminPassword": "pw-123",
            "Authorization": "Bearer bearer-999",
            "session_cookie": "sid=cookie-val",
            "safe_count": 42,
        },
        "items": [
            {"token_id": "t1", "status": "ready"},
        ],
    }

    raw_zip = rt.export_diagnostics_zip(
        data_dir=data_dir,
        state_snapshot=state_snapshot,
        max_log_bytes=32,
    )
    with zipfile.ZipFile(io.BytesIO(raw_zip), "r") as zf:
        names = set(zf.namelist())
        assert names == {"diagnostics.json", "logs/app.log", "logs/local-llm.log"}

        diag = json.loads(zf.read("diagnostics.json").decode("utf-8"))
        snap = diag["state_snapshot"]
        assert snap["active_provider"] == "dashscope"
        assert snap["api_key"] == "[REDACTED]"
        assert snap["nested"]["authToken"] == "[REDACTED]"
        assert snap["nested"]["client_secret"] == "[REDACTED]"
        assert snap["nested"]["adminPassword"] == "[REDACTED]"
        assert snap["nested"]["Authorization"] == "[REDACTED]"
        assert snap["nested"]["session_cookie"] == "[REDACTED]"
        assert snap["nested"]["safe_count"] == 42
        assert snap["items"][0]["token_id"] == "[REDACTED]"
        assert snap["items"][0]["status"] == "ready"

        diag_text = json.dumps(diag)
        for secret in ("sk-live-secret-1", "tok-abc", "sec-xyz", "pw-123", "bearer-999", "cookie-val", "sk-top-secret-file"):
            assert secret not in diag_text

        app_tail = zf.read("logs/app.log")
        llm_tail = zf.read("logs/local-llm.log")
        assert len(app_tail) <= 32 and b"TAIL_APP_LOG" in app_tail
        assert len(llm_tail) <= 32 and b"TAIL_LLM_LOG" in llm_tail


def test_store_safe_rmtree_and_sweep_pending_deletes(tmp_path, monkeypatch):
    test_data = tmp_path / "store_data"
    test_meetings = test_data / "meetings"
    test_discarded = test_data / "discarded"
    test_meetings.mkdir(parents=True)
    monkeypatch.setattr(store, "DATA", test_data)
    monkeypatch.setattr(store, "MEETINGS", test_meetings)
    monkeypatch.setattr(store, "DISCARDED", test_discarded)

    # Normal safe_rmtree removes directory cleanly
    victim = test_data / "victim_dir"
    (victim / "sub").mkdir(parents=True)
    (victim / "sub" / "file.txt").write_text("hi", encoding="utf-8")
    assert store.safe_rmtree(victim) is True
    assert not victim.exists()
    assert store.sweep_pending_deletes() == 0

    # Simulated file lock: rmtree fails, directory is atomically moved to .pending-delete
    meta = store.create("Locked meeting", source="mic")
    mid = meta["id"]
    mdir = store.mdir(mid)
    (mdir / "audio.wav").write_bytes(b"RIFF")

    orig_rmtree = shutil.rmtree

    def locked_rmtree(path, *args, **kwargs):
        raise PermissionError("simulated Windows file lock")

    with mock.patch("store.shutil.rmtree", side_effect=locked_rmtree):
        store.delete(mid)

    assert not mdir.exists()
    assert store.get(mid) is None
    pending_root = store._pending_delete_root()
    staged_entries = list(pending_root.iterdir())
    assert len(staged_entries) == 1
    assert (staged_entries[0] / "audio.wav").exists()

    # Subsequent sweep cleans up once lock is gone
    assert store.sweep_pending_deletes() == 1
    assert list(pending_root.iterdir()) == []
    assert store.sweep_pending_deletes() == 0

    # Verify purge_trash and purge_discarded also route through safe_rmtree
    m2 = store.create("Trash test", source="mic")
    store.trash_meeting(m2["id"])
    with mock.patch("store.shutil.rmtree", side_effect=locked_rmtree):
        assert store.purge_trash(m2["id"]) is True
    assert not store._trash_dir(m2["id"]).exists()
    assert len(list(pending_root.iterdir())) == 1
    assert store.sweep_pending_deletes() == 1

    m3 = store.create("Discard test", source="ambient")
    store.recycle(m3["id"], voiced_s=5.0, min_s=20.0)
    d_dir = store._discarded_dir(m3["id"])
    info = store.read_json(d_dir / "discard.json")
    info["discarded_at"] = "2020-01-01T00:00:00"
    store.write_json(d_dir / "discard.json", info)
    with mock.patch("store.shutil.rmtree", side_effect=locked_rmtree):
        gone = store.purge_discarded()
    assert m3["id"] in gone
    assert not d_dir.exists()
    assert len(list(pending_root.iterdir())) == 1
    assert store.sweep_pending_deletes() == 1
    orig_rmtree(test_data, ignore_errors=True)
