"""Unit tests for model_manager.py (100% offline using local http.server and tmp_path)."""
from __future__ import annotations

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-mm-"))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import model_manager  # noqa: E402
import store  # noqa: E402


def _make_range_server(files: dict[str, bytes], slow_paths: dict[str, float] | None = None):
    slow_paths = slow_paths or {}
    requests_log: list[dict] = []
    log_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _record(self, method: str, rng: str | None):
            with log_lock:
                requests_log.append({"method": method, "path": self.path, "range": rng})

        def do_HEAD(self):
            rng = self.headers.get("Range")
            self._record("HEAD", rng)
            delay = slow_paths.get(self.path, 0.0)
            if delay > 0:
                time.sleep(delay)
            if self.path not in files:
                self.send_response(404)
                self.end_headers()
                return
            data = files[self.path]
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"test-etag-1"')
            self.end_headers()

        def do_GET(self):
            rng = self.headers.get("Range")
            self._record("GET", rng)
            delay = slow_paths.get(self.path, 0.0)
            if delay > 0:
                time.sleep(delay)
            if self.path not in files:
                self.send_response(404)
                self.end_headers()
                return
            data = files[self.path]
            total = len(data)
            if rng:
                m = re.match(r"bytes=(\d+)-(\d*)", rng)
                if m:
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else total - 1
                    end = min(end, total - 1)
                    if start >= total or start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{total}")
                        self.end_headers()
                        return
                    chunk = data[start : end + 1]
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                    self.send_header("Content-Length", str(len(chunk)))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("ETag", '"test-etag-1"')
                    self.end_headers()
                    self.wfile.write(chunk)
                    return
            self.send_response(200)
            self.send_header("Content-Length", str(total))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"test-etag-1"')
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    return server, base_url, requests_log


@pytest.fixture()
def isolated_env(tmp_path: Path, monkeypatch):
    old_data = store.DATA
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    store.DATA = data_dir
    monkeypatch.setenv("MEETING_DATA", str(data_dir))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf_home"))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.setenv("MODELSCOPE_CACHE", str(tmp_path / "ms_cache"))
    try:
        yield tmp_path
    finally:
        store.DATA = old_data


def test_catalog_contains_all_required_models():
    expected = {
        "fun-asr-nano": "FunAudioLLM/Fun-ASR-Nano-2512",
        "paraformer-zh": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "fsmn-vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "ct-punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
        "cam++": "iic/speech_campplus_sv_zh-cn_16k-common",
        "pyannote-community-1": "pyannote/speaker-diarization-community-1",
        "nemotron-3-diarization": "nvidia/Nemotron-3-Diarization",
    }
    for key, repo in expected.items():
        assert key in model_manager.MODEL_CATALOG
        assert model_manager.MODEL_CATALOG[key]["repo"] == repo


def test_metadata_only_readiness_zero_network_and_no_payload_open(isolated_env: Path):
    net_calls = []

    def deny(*a, **k):
        net_calls.append(a)
        raise OSError("network blocked")

    with mock.patch.object(socket.socket, "connect", deny), \
         mock.patch.object(socket.socket, "connect_ex", deny), \
         mock.patch.object(socket, "create_connection", deny), \
         mock.patch.object(socket, "getaddrinfo", deny):
        assert model_manager.is_model_ready("nemotron-3-diarization") is False
        assert model_manager.is_model_ready("pyannote-community-1") is False

        # Populate HF cache snapshot for Nemotron
        snap = isolated_env / "hf_home" / "hub" / "models--nvidia--Nemotron-3-Diarization" / "snapshots" / "rev1"
        snap.mkdir(parents=True)
        (snap / "config.json").write_text('{"architectures": ["Nemotron"]}', encoding="utf-8")
        weights = snap / "model.safetensors"
        weights.write_bytes(b"FAKE_SAFETENSORS_HEADER_AND_BYTES")

        # Populate ModelScope cache for pyannote (nested segmentation weights)
        pya_dir = isolated_env / "ms_cache" / "hub" / "pyannote" / "speaker-diarization-community-1"
        (pya_dir / "segmentation").mkdir(parents=True)
        (pya_dir / "config.yaml").write_text("version: 1\n", encoding="utf-8")
        (pya_dir / "segmentation" / "pytorch_model.bin").write_bytes(b"FAKE_BIN")

        # Incomplete dir with .partial must NOT be reported ready
        incomplete_dir = isolated_env / "ms_cache" / "hub" / "iic" / "speech_campplus_sv_zh-cn_16k-common"
        incomplete_dir.mkdir(parents=True)
        (incomplete_dir / "model.pt.partial").write_bytes(b"half")
        assert model_manager.is_model_ready("cam++") is False

        # Verify weight payload is NEVER opened during readiness checks
        real_open = open
        opened_paths = []

        def tracking_open(file, *args, **kwargs):
            opened_paths.append(str(file))
            return real_open(file, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=tracking_open):
            assert model_manager.is_model_ready("nemotron-3-diarization") is True
            assert model_manager.find_local_model_dir("nemotron-3-diarization") == snap
            assert model_manager.is_model_ready("pyannote-community-1") is True
            status = model_manager.get_models_status()

        assert not any(p.endswith((".safetensors", ".bin", ".pt", ".gguf")) for p in opened_paths)
        assert status["by_id"]["nemotron-3-diarization"]["ready"] is True
        assert status["by_id"]["pyannote-community-1"]["ready"] is True
        assert status["by_id"]["cam++"]["ready"] is False
    assert net_calls == []


def test_custom_roots_and_bounded_scanner(isolated_env: Path):
    root = isolated_env / "custom_models"
    root.mkdir()
    # Valid GGUF and ASR model dir
    (root / "qwen3.gguf").write_bytes(b"GGUF_FAKE_PAYLOAD")
    nano_dir = root / "Fun-ASR-Nano-2512"
    nano_dir.mkdir()
    (nano_dir / "configuration.json").write_text("{}", encoding="utf-8")
    (nano_dir / "model.pt").write_bytes(b"PT")

    # Excluded dirs + symlinks + too-deep file
    (root / ".git").mkdir()
    (root / ".git" / "ignored.gguf").write_bytes(b"NO")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "ignored.gguf").write_bytes(b"NO")
    deep = root / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "too_deep.gguf").write_bytes(b"DEEP")

    real_outside = isolated_env / "outside"
    real_outside.mkdir()
    (real_outside / "symlinked.gguf").write_bytes(b"SYM")
    try:
        (root / "sym_dir").symlink_to(real_outside, target_is_directory=True)
        (root / "sym_file.gguf").symlink_to(real_outside / "symlinked.gguf")
    except OSError:
        pass

    roots = model_manager.add_root(root)
    assert str(root.resolve()) in roots
    assert model_manager.list_roots() == roots
    assert model_manager.is_model_ready("fun-asr-nano") is True

    scan = model_manager.scan_custom_roots(max_depth=2, max_entries=500)
    gguf_names = {g["name"] for g in scan["gguf"]}
    assert "qwen3.gguf" in gguf_names
    assert "ignored.gguf" not in gguf_names
    assert "too_deep.gguf" not in gguf_names
    assert "symlinked.gguf" not in gguf_names
    assert "sym_file.gguf" not in gguf_names
    assert any(m["model_id"] == "fun-asr-nano" for m in scan["models"])

    # Bounded entry limit stops safely
    tiny_scan = model_manager.scan_custom_roots(max_depth=5, max_entries=2)
    assert tiny_scan["truncated"] is True

    after_remove = model_manager.remove_root(root)
    assert after_remove == []


def test_select_source_speed_racing(isolated_env: Path):
    payload = b"x" * 16384
    srv, base, _ = _make_range_server(
        {"/fast/model.bin": payload, "/slow/model.bin": payload},
        slow_paths={"/slow/model.bin": 0.25},
    )
    try:
        mgr = model_manager.ModelDownloadManager()
        winner = mgr.select_source(
            {
                "huggingface": f"{base}/slow/model.bin",
                "modelscope": f"{base}/fast/model.bin",
            },
            timeout=5.0,
        )
        assert winner == "modelscope"

        # Fallback to reachable mirror if one fails
        winner2 = mgr.select_source(
            {
                "huggingface": f"{base}/missing.bin",
                "modelscope": f"{base}/fast/model.bin",
            },
            timeout=5.0,
        )
        assert winner2 == "modelscope"
    finally:
        srv.shutdown()
        srv.server_close()


def test_resumable_download_cancel_resume_sha256_and_disk_guard(isolated_env: Path):
    payload = os.urandom(64 * 1024)
    good_sha = hashlib.sha256(payload).hexdigest()
    srv, base, reqs = _make_range_server({"/weights.bin": payload})
    mgr = model_manager.ModelDownloadManager()
    dst = isolated_env / "dl" / "weights.bin"
    part = dst.with_name("weights.bin.partial")
    state = dst.with_name("weights.bin.download-state.json")

    try:
        # 1. Cancel after first chunk
        cancel = threading.Event()
        seen_prog = []

        def on_prog(ev):
            seen_prog.append(ev["done_bytes"])
            cancel.set()

        with pytest.raises(model_manager.DownloadCancelled):
            mgr.download_file_resumable(
                f"{base}/weights.bin",
                dst,
                expected_sha256=good_sha,
                cancel_event=cancel,
                on_progress=on_prog,
                chunk_size=8192,
            )

        assert not dst.exists()
        assert part.exists() and 0 < part.stat().st_size < len(payload)
        assert state.exists()
        saved = json.loads(state.read_text(encoding="utf-8"))
        assert saved["downloaded_bytes"] == part.stat().st_size

        # 2. Resume and complete with SHA256 verification
        resumed_from = part.stat().st_size
        out = mgr.download_file_resumable(
            f"{base}/weights.bin",
            dst,
            expected_sha256=good_sha,
            chunk_size=8192,
        )
        assert out == dst
        assert dst.read_bytes() == payload
        assert not part.exists()
        assert not state.exists()
        assert any(r["range"] == f"bytes={resumed_from}-" for r in reqs)

        # 3. Bad SHA256 rejects and cleans up partial
        bad_dst = isolated_env / "dl" / "bad.bin"
        with pytest.raises(ValueError, match="SHA256 mismatch"):
            mgr.download_file_resumable(f"{base}/weights.bin", bad_dst, expected_sha256="0" * 64)
        assert not bad_dst.exists()
        assert not bad_dst.with_name("bad.bin.partial").exists()

        # 4. Insufficient disk space fails before download
        space_dst = isolated_env / "dl" / "space.bin"
        with mock.patch.object(shutil, "disk_usage", return_value=SimpleNamespace(total=1000, used=990, free=10)):
            with pytest.raises(OSError, match="Insufficient disk space"):
                mgr.download_file_resumable(f"{base}/weights.bin", space_dst, expected_sha256=good_sha)
        assert not space_dst.exists()
    finally:
        srv.shutdown()
        srv.server_close()


def test_background_task_and_interrupted_recovery(isolated_env: Path):
    cfg = b'{"model_type": "nemotron"}'
    wt = b"WEIGHTS" * 1024
    srv, base, _ = _make_range_server(
        {
            "/ms/config.json": cfg,
            "/hf/config.json": cfg,
            "/ms/model.safetensors": wt,
            "/hf/model.safetensors": wt,
        },
        slow_paths={"/hf/config.json": 0.15, "/hf/model.safetensors": 0.15},
    )
    try:
        mgr = model_manager.ModelDownloadManager()
        files = [
            {
                "name": "config.json",
                "size": len(cfg),
                "sha256": hashlib.sha256(cfg).hexdigest(),
                "urls": {"modelscope": f"{base}/ms/config.json", "huggingface": f"{base}/hf/config.json"},
            },
            {
                "name": "model.safetensors",
                "size": len(wt),
                "sha256": hashlib.sha256(wt).hexdigest(),
                "urls": {"modelscope": f"{base}/ms/model.safetensors", "huggingface": f"{base}/hf/model.safetensors"},
            },
        ]
        started = mgr.start_download("nemotron-3-diarization", source="auto", files=files)
        assert started["status"] in ("queued", "running")
        done = mgr.wait_task(timeout=10.0)
        assert done is not None
        assert done["status"] == "completed"
        assert done["selected_source"] == "modelscope"
        assert model_manager.is_model_ready("nemotron-3-diarization") is True

        # Simulate crash recovery on startup: previously queued/running task becomes interrupted without network calls
        task_file = store.DATA / "model-task.json"
        store.write_json(task_file, {"id": "old1", "model_id": "pyannote-community-1", "status": "running"})
        with mock.patch.object(socket.socket, "connect", side_effect=OSError("no network")):
            fresh_mgr = model_manager.ModelDownloadManager()
            recovered = fresh_mgr.get_task()
        assert recovered is not None
        assert recovered["status"] == "interrupted"
        assert json.loads(task_file.read_text(encoding="utf-8"))["status"] == "interrupted"
    finally:
        srv.shutdown()
        srv.server_close()
