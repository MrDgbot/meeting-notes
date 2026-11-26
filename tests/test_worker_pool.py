"""Unit tests for worker_pool.py and --probe / --serve diarizer protocols."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-wp-"))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import diarize_nemotron  # noqa: E402
import diarize_worker  # noqa: E402
from worker_pool import PersistentJsonlWorker, WorkerPool  # noqa: E402


MOCK_WORKER_CODE = r'''
import json
import os
import sys
import time

if sys.argv[1] == "--probe":
    print(json.dumps({"ok": True, "worker": "mock", "device": "cpu", "cached": True}), flush=True)
    raise SystemExit(0)

if sys.argv[1] == "--serve":
    proto_out = sys.stdout
    sys.stdout = sys.stderr

    def emit(obj):
        proto_out.write(json.dumps(obj) + "\n")
        proto_out.flush()

    print("noisy library init banner on stdout redirected to stderr")
    emit({"ready": True, "worker": "mock", "device": "cpu", "load_s": 0.1})
    calls = 0
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        cmd = req.get("cmd")
        if cmd == "ping":
            emit({"id": rid, "ok": True, "pong": True, "pid": os.getpid()})
            continue
        if cmd == "shutdown":
            emit({"id": rid, "ok": True, "shutdown": True})
            break
        wav = req.get("wav", "")
        if "crash" in wav:
            print("fatal boom on stderr", file=sys.stderr, flush=True)
            sys.exit(2)
        if "hang" in wav:
            time.sleep(5.0)
        calls += 1
        print(f"noisy inference print call={calls}")
        emit({
            "id": rid,
            "ok": True,
            "result": {
                "turns": [[0, 500, 0]],
                "device": "cpu",
                "load_s": 0.0,
                "run_s": 0.05,
                "pid": os.getpid(),
                "calls": calls,
                "num_spk": req.get("num_spk", 0),
            },
        })
    raise SystemExit(0)
'''


def _write_mock_worker(tmp_path: Path, name: str = "mock_worker.py") -> Path:
    p = tmp_path / name
    p.write_text(MOCK_WORKER_CODE, encoding="utf-8")
    return p


def test_probe_does_not_start_serve(tmp_path: Path):
    script = _write_mock_worker(tmp_path)
    w = PersistentJsonlWorker("mock", script, idle_timeout_s=30.0)
    try:
        info = w.probe(timeout=10.0)
        assert info == {"ok": True, "worker": "mock", "device": "cpu", "cached": True}
        assert w.is_alive() is False
        assert w.starts == 0
    finally:
        w.close()


def test_lazy_start_warm_reuse_and_stdout_isolation(tmp_path: Path):
    script = _write_mock_worker(tmp_path)
    w = PersistentJsonlWorker("mock", script, idle_timeout_s=60.0)
    try:
        assert w.is_alive() is False
        assert w.starts == 0

        r1 = w.run({"wav": "a.wav", "num_spk": 2}, timeout=10.0)
        assert w.is_alive() is True
        assert w.starts == 1
        assert r1["load_s"] == 0.0
        assert r1["calls"] == 1
        assert r1["num_spk"] == 2
        pid1 = r1["pid"]

        r2 = w.run({"wav": "b.wav", "num_spk": 0}, timeout=10.0)
        assert w.starts == 1
        assert w.requests == 2
        assert r2["pid"] == pid1
        assert r2["calls"] == 2
        assert r2["load_s"] == 0.0

        pong = w.run({"cmd": "ping"}, timeout=5.0)
        assert pong["pong"] is True
        assert pong["pid"] == pid1

        st = w.status()
        assert st["alive"] is True
        assert st["pid"] == pid1
        assert st["device"] == "cpu"
        assert any("noisy inference print" in ln for ln in w.stderr_tail(20))
    finally:
        w.close()
    assert w.is_alive() is False


def test_crash_restart_and_stderr_capture(tmp_path: Path):
    script = _write_mock_worker(tmp_path)
    w = PersistentJsonlWorker("mock", script, idle_timeout_s=60.0)
    try:
        r1 = w.run({"wav": "ok1.wav"}, timeout=10.0)
        pid1 = r1["pid"]

        with pytest.raises(RuntimeError, match="exited unexpectedly"):
            w.run({"wav": "crash.wav"}, timeout=10.0)

        assert w.is_alive() is False
        assert any("fatal boom on stderr" in ln for ln in w.stderr_tail(20))

        r2 = w.run({"wav": "ok2.wav"}, timeout=10.0)
        assert w.is_alive() is True
        assert w.starts == 2
        assert r2["pid"] != pid1
        assert r2["calls"] == 1
    finally:
        w.close()


def test_timeout_kills_and_restarts_cleanly(tmp_path: Path):
    script = _write_mock_worker(tmp_path)
    w = PersistentJsonlWorker("mock", script, idle_timeout_s=60.0)
    try:
        r1 = w.run({"wav": "ok1.wav"}, timeout=10.0)
        with pytest.raises(TimeoutError, match="timed out"):
            w.run({"wav": "hang.wav"}, timeout=0.3)

        assert w.is_alive() is False

        r2 = w.run({"wav": "ok2.wav"}, timeout=10.0)
        assert r2["pid"] != r1["pid"]
        assert w.starts == 2
    finally:
        w.close()


def test_idle_close(tmp_path: Path):
    script = _write_mock_worker(tmp_path)
    w = PersistentJsonlWorker("mock", script, idle_timeout_s=20.0)
    try:
        w.run({"wav": "ok.wav"}, timeout=10.0)
        assert w.is_alive() is True
        assert w.close_if_idle(now=w.last_used + 10.0) is False
        assert w.is_alive() is True
        assert w.close_if_idle(now=w.last_used + 20.5) is True
        assert w.is_alive() is False
        assert w.close_if_idle(now=w.last_used + 30.0) is False
    finally:
        w.close()


def test_concurrent_requests_serialized(tmp_path: Path):
    script = _write_mock_worker(tmp_path)
    w = PersistentJsonlWorker("mock", script, idle_timeout_s=60.0)
    results = []
    errors = []

    def worker_call(idx: int):
        try:
            res = w.run({"wav": f"clip_{idx}.wav", "num_spk": idx}, timeout=10.0)
            results.append((idx, res))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    try:
        threads = [threading.Thread(target=worker_call, args=(i,)) for i in range(1, 5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15.0)
        assert errors == []
        assert len(results) == 4
        assert {idx for idx, _ in results} == {1, 2, 3, 4}
        for idx, res in results:
            assert res["num_spk"] == idx
        assert w.starts == 1
        assert w.requests == 4
    finally:
        w.close()


def test_worker_pool_management(tmp_path: Path):
    p_script = _write_mock_worker(tmp_path, "diarize_worker.py")
    n_script = _write_mock_worker(tmp_path, "diarize_nemotron.py")
    assert p_script.exists() and n_script.exists()

    pool = WorkerPool(idle_timeout_s=15.0, root=tmp_path)
    try:
        res = pool.run_diarizer("pyannote", "meeting.wav", num_spk=3, timeout=10.0)
        assert res["turns"] == [[0, 500, 0]]
        assert res["num_spk"] == 3

        st = pool.status()
        assert st["pyannote"]["alive"] is True
        assert st["nemotron"]["alive"] is False

        closed = pool.close_idle(now=pool.get("pyannote").last_used + 16.0)
        assert closed == ["pyannote"]
        assert pool.get("pyannote").is_alive() is False

        with pytest.raises(ValueError):
            pool.run_diarizer("unknown", "x.wav")
    finally:
        pool.close_all()


def test_real_diarizer_probe_zero_network(tmp_path: Path):
    for script_name, worker_name in (("diarize_worker.py", "pyannote"), ("diarize_nemotron.py", "nemotron")):
        code = (
            "import socket, sys\n"
            "def deny(*a, **k): raise OSError('network blocked')\n"
            "socket.socket.connect = deny\n"
            "socket.create_connection = deny\n"
            "socket.getaddrinfo = deny\n"
            f"sys.argv = [{str(ROOT / script_name)!r}, '--probe']\n"
            f"import {script_name[:-3]} as mod\n"
            "raise SystemExit(mod._probe())\n"
        )
        p = subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=20,
            env={**os.environ, "HOME": str(tmp_path), "HF_HOME": str(tmp_path / "hf"), "MODELSCOPE_CACHE": str(tmp_path / "ms")},
        )
        assert p.returncode == 0, p.stderr
        lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
        assert len(lines) == 1
        data = json.loads(lines[0])
        assert data["ok"] is True
        assert data["worker"] == worker_name
        assert data["device"] in ("cpu", "mps", "cuda")
        assert isinstance(data["cached"], bool)


def test_serve_protocols_in_process_with_mocked_models():
    # Verify diarize_worker._serve JSONL protocol & stdout->stderr redirect
    stdin_pya = io.StringIO(
        json.dumps({"id": "p1", "cmd": "ping"}) + "\n"
        + json.dumps({"id": "d1", "wav": "fake.wav", "num_spk": 2}) + "\n"
        + json.dumps({"id": "s1", "cmd": "shutdown"}) + "\n"
    )
    out_pya = io.StringIO()
    err_pya = io.StringIO()

    def fake_load_pya():
        print("pyannote noisy load")
        return object(), "cpu", 1.2

    def fake_infer_pya(pipe, dev, wav, num_spk=0):
        print("pyannote noisy infer")
        return {"turns": [[0, 1000, 0]], "device": dev, "run_s": 0.2}

    with mock.patch.object(diarize_worker, "_load_pipeline", side_effect=fake_load_pya), \
         mock.patch.object(diarize_worker, "_infer", side_effect=fake_infer_pya), \
         mock.patch.object(sys, "stdin", stdin_pya), \
         mock.patch.object(sys, "stdout", out_pya), \
         mock.patch.object(sys, "stderr", err_pya):
        rc = diarize_worker._serve()

    assert rc == 0
    lines_pya = [json.loads(ln) for ln in out_pya.getvalue().splitlines() if ln.strip()]
    assert lines_pya[0]["ready"] is True and lines_pya[0]["worker"] == "pyannote"
    assert lines_pya[1] == {"id": "p1", "ok": True, "pong": True, "worker": "pyannote", "device": "cpu"}
    assert lines_pya[2] == {"id": "d1", "ok": True, "result": {"turns": [[0, 1000, 0]], "device": "cpu", "run_s": 0.2, "load_s": 0.0}}
    assert lines_pya[3] == {"id": "s1", "ok": True, "shutdown": True}
    assert "pyannote noisy load" in err_pya.getvalue()
    assert "pyannote noisy infer" in err_pya.getvalue()

    # Verify diarize_nemotron._serve JSONL protocol & stdout->stderr redirect
    class FakeNemoModel:
        def to(self, dev):
            return self

        def eval(self):
            return self

    stdin_nemo = io.StringIO(
        json.dumps({"id": "n1", "wav": "fake.wav", "num_spk": 0}) + "\n"
        + json.dumps({"id": "s2", "cmd": "shutdown"}) + "\n"
    )
    out_nemo = io.StringIO()
    err_nemo = io.StringIO()

    def fake_load_nemo(model_id):
        print("nemo noisy load")
        return object(), FakeNemoModel()

    def fake_infer_nemo(proc, model, dev, wav, num_spk=0):
        print("nemo noisy infer")
        return {"turns": [[100, 800, 0]], "device": "cpu", "run_s": 0.3, "speakers": 1}, "cpu"

    with mock.patch.object(diarize_nemotron, "_load_model", side_effect=fake_load_nemo), \
         mock.patch.object(diarize_nemotron, "_detect_device", return_value="cpu"), \
         mock.patch.object(diarize_nemotron, "_infer", side_effect=fake_infer_nemo), \
         mock.patch.object(sys, "stdin", stdin_nemo), \
         mock.patch.object(sys, "stdout", out_nemo), \
         mock.patch.object(sys, "stderr", err_nemo):
        rc2 = diarize_nemotron._serve()

    assert rc2 == 0
    lines_nemo = [json.loads(ln) for ln in out_nemo.getvalue().splitlines() if ln.strip()]
    assert lines_nemo[0]["ready"] is True and lines_nemo[0]["worker"] == "nemotron"
    assert lines_nemo[1]["id"] == "n1" and lines_nemo[1]["ok"] is True
    assert lines_nemo[1]["result"]["load_s"] == 0.0
    assert lines_nemo[2] == {"id": "s2", "ok": True, "shutdown": True}
    assert "nemo noisy load" in err_nemo.getvalue()
    assert "nemo noisy infer" in err_nemo.getvalue()
