"""Tests for Wave 2 engine optimizations in asr_engine.py (offline, zero real model loads)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

import numpy as np
import pytest
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-eng-opt-"))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import asr_engine  # noqa: E402
import model_manager  # noqa: E402
import runtime_telemetry  # noqa: E402
import store  # noqa: E402
import worker_pool  # noqa: E402


def _write_wav(path: Path, samples: np.ndarray, sr: int = 16000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, sr, subtype="PCM_16")
    return path


def _speech_wav(path: Path, duration_s: float = 2.0, sr: int = 16000) -> Path:
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False, dtype=np.float32)
    wave = (0.15 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
    return _write_wav(path, wave, sr=sr)


def test_unload_targets_and_idle_seconds():
    eng = asr_engine.Engine()
    eng.nano = object()
    eng.live_asr = object()
    eng.full = object()
    eng._punc_auto = object()
    eng._spk_auto = object()
    eng._cb_model = object()
    eng.ready = True
    asr_engine._OFFLINE_VADS[("test", 1)] = object()

    pool = mock.MagicMock()
    with mock.patch.object(worker_pool, "default_pool", return_value=pool):
        res_nano = eng.unload("nano")
        assert eng.nano is None
        assert eng.live_asr is not None and eng.full is not None
        assert "nano" in res_nano["unloaded"]
        assert "memory" in res_nano and isinstance(res_nano["memory"], dict)
        assert pool.close_all.call_count == 0

        res_live = eng.unload("live_asr")
        assert eng.live_asr is None
        assert "live_asr" in res_live["unloaded"]

        res_para = eng.unload("paraformer")
        assert eng.full is None
        assert "paraformer" in res_para["unloaded"]

        res_diar = eng.unload("diarizers")
        assert eng._spk_auto is None and eng._cb_model is None
        assert "diarizers" in res_diar["unloaded"]
        assert pool.close_all.call_count == 1

        # Repopulate everything and test unload("all")
        eng.nano = object()
        eng.live_asr = object()
        eng.full = object()
        eng._punc_auto = object()
        eng._spk_auto = object()
        eng._cb_model = object()
        eng.ready = True
        asr_engine._OFFLINE_VADS[("test", 2)] = object()

        res_all = eng.unload("all")
        assert eng.nano is None
        assert eng.live_asr is None
        assert eng.full is None
        assert eng._punc_auto is None
        assert eng._spk_auto is None
        assert eng._cb_model is None
        assert eng.ready is False
        assert len(asr_engine._OFFLINE_VADS) == 0
        assert pool.close_all.call_count == 2
        for expected in ("nano", "live_asr", "paraformer", "punc_auto", "spk_auto", "cb_model", "offline_vads", "diarizers"):
            assert expected in res_all["unloaded"], res_all["unloaded"]

    # Error tracking in _transition_failure
    bad_pool = mock.MagicMock()
    bad_pool.close_all.side_effect = RuntimeError("pool close boom")
    with mock.patch.object(worker_pool, "default_pool", return_value=bad_pool):
        err_res = eng.unload("diarizers")
    assert "pool close boom" in eng._transition_failure
    assert "pool close boom" in err_res.get("error", "")

    with pytest.raises(ValueError):
        eng.unload("unknown_target")

    eng.last_active = time.monotonic() - 12.5
    assert eng.idle_seconds() >= 12.0
    eng._touch()
    assert eng.idle_seconds() < 1.0


def test_split_loading_and_lazy_paraformer_fallback(tmp_path: Path):
    loaded_models: list[dict] = []

    class FakeAuto:
        def __init__(self, **kw):
            loaded_models.append(kw)
            self.kw = kw
            self.model = self
            self.kwargs = {}
            self.punc_model = self
            self.punc_kwargs = {}
            self.spk_model = self
            self.spk_kwargs = {}
            self.cb_model = mock.MagicMock(return_value=np.zeros(4, dtype=int))

        def generate(self, **kw):
            m = self.kw.get("model")
            if m == "paraformer-zh":
                return [{"sentence_info": [{"spk": 0, "start": 0, "end": 1000, "text": "兜底转写结果"}]}]
            if m == "fsmn-vad":
                return [{"value": [[0, 1000]]}]
            return [{"text": "预热", "ctc_text": "预热", "timestamps": []}]

        def inference(self, inp, **kw):
            if self.kw.get("model") == "ct-punc" or kw.get("model") is self:
                if isinstance(inp, str):
                    return [{"text": f"{inp}。"}]
            return [{"spk_embedding": asr_engine.torch.ones(1, 192)} for _ in inp]

    asr_engine._OFFLINE_VADS.clear()
    eng = asr_engine.Engine()
    with (
        mock.patch.object(asr_engine, "AutoModel", FakeAuto),
        mock.patch.object(asr_engine, "asr_mode", return_value="nano"),
    ):
        eng.load()
        assert eng.ready is True
        assert eng.full is None, "nano mode must not eagerly load paraformer-zh (self.full)"
        assert eng._punc_auto is not None
        assert eng._spk_auto is not None
        assert eng._cb_model is not None
        assert eng.nano is not None
        loaded_names = [m["model"] for m in loaded_models]
        assert "paraformer-zh" not in loaded_names
        assert "ct-punc" in loaded_names
        assert "cam++" in loaded_names
        assert asr_engine.NANO in loaded_names

        # repunc & _spk_embeddings work without self.full
        assert eng.repunc("测试标点") == "测试标点。"
        chunks, X = eng._spk_embeddings(np.zeros(16000 * 3, dtype=np.float32), [[0, 3000]])
        assert len(chunks) > 0 and X.shape[1] == 192

        # Fallback from _nano_transcribe failure lazily loads paraformer-zh
        wav = _speech_wav(tmp_path / "fb.wav", 1.5)
        with mock.patch.object(eng, "_nano_transcribe", side_effect=RuntimeError("nano crash")):
            paras = eng.transcribe(wav)
        assert eng.full is not None, "fallback should lazily load self.full"
        assert "paraformer-zh" in [m["model"] for m in loaded_models]
        assert eng.last_info["engine"] == "paraformer"
        assert "nano crash" in eng.last_info.get("nano_failed", "")
        assert paras and "兜底转写结果" in paras[0]["text"]
    asr_engine._OFFLINE_VADS.clear()


def test_job_clock_timings_and_diarizer_pool_fallback(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MEETING_ASR_CACHE", "0")
    monkeypatch.setenv("MEETING_DIARIZE_POOL", "1")
    wav = _speech_wav(tmp_path / "timed.wav", 2.0)

    eng = asr_engine.Engine()
    eng.nano = mock.MagicMock()
    eng.nano.model = None
    eng.nano.generate.return_value = [{"text": "测试计时结果。", "ctc_text": "测试计时结果", "timestamps": []}]
    eng._spk_auto = mock.MagicMock()
    eng._spk_auto.model = None
    eng._spk_auto.kwargs = None
    eng._cb_model = mock.MagicMock()

    pool = mock.MagicMock()
    pool.get.return_value.is_alive.return_value = True
    pool.run_diarizer.return_value = {
        "turns": [[0, 2000, 0]],
        "device": "cpu",
        "load_s": 0.4,
        "run_s": 0.7,
    }

    with (
        mock.patch.object(asr_engine, "asr_mode", return_value="nano"),
        mock.patch.object(asr_engine, "diarizer_mode", return_value="pyannote"),
        mock.patch.object(asr_engine, "duration_of", return_value=2.0),
        mock.patch.object(asr_engine.Engine, "_offline_segs", return_value=[[0, 2000]]),
        mock.patch.object(eng, "_spk_embeddings", return_value=([[0.0, 1.5, np.zeros(24000)]], np.ones((1, 192)))),
        mock.patch.object(worker_pool, "default_pool", return_value=pool),
        mock.patch.object(subprocess, "run", side_effect=AssertionError("pool should handle pyannote")),
    ):
        paras = eng.transcribe(wav)

    assert paras and paras[0]["text"] == "测试计时结果。"
    pool.run_diarizer.assert_called_once()
    for key in ("model_load_s", "vad_s", "diarize_load_s", "diarize_run_s", "asr_s", "postprocess_s", "total_s"):
        assert key in eng.last_timings
        assert key in eng.last_info["timings"]
        assert eng.last_timings[key] >= 0.0
    assert eng.last_timings["diarize_load_s"] == pytest.approx(0.4, abs=1e-6)
    assert eng.last_timings["diarize_run_s"] >= 0.7
    assert eng.last_timings["total_s"] > 0.0

    # Now verify pool failure falls back cleanly to one-shot subprocess.run
    failing_pool = mock.MagicMock()
    failing_pool.get.return_value.is_alive.return_value = False
    failing_pool.run_diarizer.side_effect = RuntimeError("worker crashed on startup")

    def fake_subproc(cmd, **kw):
        Path(cmd[3]).write_text(json.dumps({"turns": [[0, 2000, 0]], "device": "cpu", "load_s": 0.3, "run_s": 0.2}))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with (
        mock.patch.object(worker_pool, "default_pool", return_value=failing_pool),
        mock.patch.object(asr_engine, "duration_of", return_value=2.0),
        mock.patch.object(subprocess, "run", side_effect=fake_subproc) as sub_spy,
    ):
        turns = eng._diarize_nemotron(wav, 0)
    assert turns == [(0, 2000, 0)]
    assert sub_spy.call_count == 1
    assert eng.last_timings["diarize_load_s"] == pytest.approx(0.3, abs=1e-6)
    assert eng.last_timings["diarize_run_s"] == pytest.approx(0.2, abs=1e-6)


def test_incremental_checkpoint_save_and_resume(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MEETING_ASR_CACHE", "0")
    wav = _speech_wav(tmp_path / "long.wav", 6.0)
    ckpt_dir = tmp_path / "ckpt"

    eng = asr_engine.Engine()
    eng._cb_model = mock.MagicMock()
    eng._spk_auto = mock.MagicMock()

    unit_calls: list[int] = []

    class CrashOnSecondNano:
        model = None

        def generate(self, input, **kw):
            unit_calls.append(len(input))
            if len(unit_calls) == 2:
                raise RuntimeError("simulated mid-run crash")
            return [{"text": "第一段内容。", "ctc_text": "第一段内容", "timestamps": []}]

    eng.nano = CrashOnSecondNano()
    diarize_calls = 0

    def fake_diarize(x, segs, num_spk=0, wav=None, clock=None):
        nonlocal diarize_calls
        diarize_calls += 1
        return [(0, 6000, 0)]

    segs = [[200, 1500], [3200, 5000]]
    with (
        mock.patch.object(asr_engine, "asr_mode", return_value="nano"),
        mock.patch.object(asr_engine.Engine, "_offline_segs", return_value=segs),
        mock.patch.object(eng, "_diarize", side_effect=fake_diarize),
    ):
        with pytest.raises(RuntimeError, match="simulated mid-run crash"):
            eng._nano_transcribe(wav, 0, "热词", checkpoint_dir=ckpt_dir)

    turns_file = ckpt_dir / ".transcribe_ckpt_turns.json"
    units_file = ckpt_dir / ".transcribe_ckpt_units.jsonl"
    assert turns_file.is_file()
    assert units_file.is_file()
    saved_lines = [json.loads(ln) for ln in units_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(saved_lines) == 1 and saved_lines[0]["idx"] == 0
    assert diarize_calls == 1 and len(unit_calls) == 2

    # Resume: neither _diarize nor unit 0 should run again; only unit 1 runs
    resumed_calls: list[int] = []

    class ResumedNano:
        model = None

        def generate(self, input, **kw):
            resumed_calls.append(len(input))
            return [{"text": "第二段内容。", "ctc_text": "第二段内容", "timestamps": []}]

    eng.nano = ResumedNano()
    with (
        mock.patch.object(asr_engine, "asr_mode", return_value="nano"),
        mock.patch.object(asr_engine.Engine, "_offline_segs", return_value=segs),
        mock.patch.object(eng, "_diarize", side_effect=fake_diarize),
    ):
        paras = eng.transcribe(wav, 0, "热词", checkpoint_dir=ckpt_dir)

    assert diarize_calls == 1, "diarization turns should resume from checkpoint"
    assert len(resumed_calls) == 1, "unit 0 should resume from checkpoint without re-decoding"
    assert not turns_file.exists() and not units_file.exists(), "checkpoints should be cleaned up on success"
    joined = "".join(p["text"] for p in paras)
    assert "第一段内容" in joined and "第二段内容" in joined


def test_asr_segment_cache_hit_and_context_bypass(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path / "data")
    monkeypatch.setenv("MEETING_ASR_CACHE", "1")

    eng = asr_engine.Engine()
    calls: list[str] = []

    class FakeNano:
        model = None

        def generate(self, input, **kw):
            calls.append("gen")
            return [{
                "text": "缓存命中测试。",
                "ctc_text": "缓存命中测试",
                "timestamps": [{"token": "缓", "start_time": 0.0, "end_time": 0.1}],
            }]

    eng.nano = FakeNano()
    audio = np.linspace(-0.2, 0.2, 16000, dtype=np.float32)

    r1 = eng._nano(audio, hotword="测试词", context="")
    assert r1["text"] == "缓存命中测试。"
    assert len(calls) == 1

    # Second identical call hits AsrSegmentCache without calling nano.generate
    r2 = eng._nano(audio, hotword="测试词", context="")
    assert r2 == r1
    assert len(calls) == 1

    # Contextual call (live decode) must bypass cache
    r3 = eng._nano(audio, hotword="测试词", context="上一句内容")
    assert r3["text"] == "缓存命中测试。"
    assert len(calls) == 2

    # Different hotword misses cache
    eng._nano(audio, hotword="另一个词", context="")
    assert len(calls) == 3

    # Cache disabled via env
    monkeypatch.setenv("MEETING_ASR_CACHE", "0")
    eng._nano(audio, hotword="测试词", context="")
    assert len(calls) == 4

    # Rejected hotword (CTC mismatch) must NOT be cached so CTC rejection accounting runs each time
    monkeypatch.setenv("MEETING_ASR_CACHE", "1")
    import rsi_vocab
    rej_calls: list[str] = []

    class ToxicHotwordNano:
        model = None

        def generate(self, input, **kw):
            rej_calls.append("gen")
            if kw.get("hotwords"):
                return [{"text": "今天说毒热词很好", "ctc_text": "今天天气很好", "timestamps": []}]
            return [{"text": "今天天气很好", "ctc_text": "今天天气很好", "timestamps": []}]

    eng.nano = ToxicHotwordNano()
    for _ in range(3):
        out = eng._nano(audio, hotword="毒热词", context="")
        assert out["text"] == "今天天气很好"
    assert len(rej_calls) == 6
    assert "毒热词" in rsi_vocab.demoted_hotwords()


def test_fast_to_wav16k_skips_ffmpeg(tmp_path: Path):
    src = _speech_wav(tmp_path / "mono16k.wav", 1.0, sr=16000)
    dst = tmp_path / "out.wav"

    with mock.patch.object(subprocess, "run", side_effect=AssertionError("ffmpeg should not run for 16k mono WAV")):
        asr_engine.to_wav16k(src, dst)

    info = sf.info(str(dst))
    assert info.samplerate == 16000 and info.channels == 1 and info.frames == 16000

    # 44.1kHz WAV cannot skip ffmpeg and must fall back to subprocess.run
    src44 = _speech_wav(tmp_path / "mono44k.wav", 0.5, sr=44100)
    dst2 = tmp_path / "out2.wav"
    ok = subprocess.CompletedProcess(["ffmpeg"], 0, stdout="", stderr="")

    def fake_ffmpeg(cmd, **kw):
        _speech_wav(Path(cmd[-1]), 0.5, sr=16000)
        return ok

    with mock.patch.object(subprocess, "run", side_effect=fake_ffmpeg) as spy:
        asr_engine.to_wav16k(src44, dst2)
    assert spy.call_count == 1
    assert dst2.exists()


def test_audio_health_warnings_in_last_info(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MEETING_ASR_CACHE", "0")
    silent_wav = _write_wav(tmp_path / "silent.wav", np.zeros(16000 * 2, dtype=np.float32), sr=16000)

    eng = asr_engine.Engine()
    eng.nano = mock.MagicMock()
    eng.nano.model = None
    eng.nano.generate.return_value = [{"text": "", "ctc_text": "", "timestamps": []}]
    eng._spk_auto = mock.MagicMock()
    eng._cb_model = mock.MagicMock()

    with (
        mock.patch.object(asr_engine, "asr_mode", return_value="nano"),
        mock.patch.object(asr_engine.Engine, "_offline_segs", return_value=[]),
    ):
        paras = eng.transcribe(silent_wav)

    assert paras == []
    health = eng.last_info.get("audio_health")
    assert isinstance(health, dict)
    assert health["ok"] is False
    assert any("silent" in w.lower() for w in health["warnings"])
    assert health["max_silent_s"] >= 1.9
    assert health["dead_channels"] == []


def test_local_only_gate_memory_admission_and_oom_cpu_fallback(monkeypatch):
    # 1. MEETING_LOCAL_ONLY=1 fails fast with clear Chinese error without calling AutoModel
    monkeypatch.setenv("MEETING_LOCAL_ONLY", "1")
    eng = asr_engine.Engine()
    with (
        mock.patch.object(model_manager, "is_model_ready", return_value=False),
        mock.patch.object(asr_engine, "AutoModel", side_effect=AssertionError("AutoModel must not run offline when missing")),
    ):
        with pytest.raises(RuntimeError, match="离线模式已启用"):
            eng.ensure("paraformer")

        eng.load()
        assert eng.ready is False
        assert "离线模式已启用" in eng.error
        assert "离线模式已启用" in eng._transition_failure

    # 2. Host memory admission warning propagated to last_info["memory_warning"]
    monkeypatch.setenv("MEETING_LOCAL_ONLY", "0")
    eng2 = asr_engine.Engine()

    class WarmNano:
        model = None

        def generate(self, **kw):
            return [{"text": "ok"}]

    with (
        mock.patch.object(
            runtime_telemetry,
            "check_memory_admission",
            return_value={"ok": False, "warning": "Low memory for Fun-ASR-Nano: test"},
        ),
        mock.patch.object(asr_engine, "AutoModel", return_value=WarmNano()),
    ):
        mode = eng2.ensure("nano")
    assert mode == "nano"
    assert eng2.last_info["memory_warning"] == "Low memory for Fun-ASR-Nano: test"

    # 3. OOM on MPS/CUDA empties cache, moves model to CPU, and retries
    monkeypatch.setenv("MEETING_ASR_CACHE", "0")
    eng3 = asr_engine.Engine()
    eng3._nano_device = "mps"

    class InnerModel:
        def __init__(self):
            self.device = "mps"

        def to(self, dev):
            self.device = dev

    class OomThenCpuNano:
        def __init__(self):
            self.model = InnerModel()
            self.kwargs = {"device": "mps"}
            self.calls = 0

        def generate(self, **kw):
            self.calls += 1
            if self.model.device != "cpu":
                raise RuntimeError("MPS backend out of memory")
            return [{"text": "CPU回退成功。", "ctc_text": "CPU回退成功", "timestamps": []}]

    eng3.nano = OomThenCpuNano()
    with mock.patch.object(asr_engine, "_empty_device_cache") as empty_spy:
        res = eng3._nano(np.ones(16000, dtype=np.float32) * 0.1)

    assert res["text"] == "CPU回退成功。"
    assert eng3._nano_device == "cpu"
    assert eng3.nano.kwargs["device"] == "cpu"
    assert eng3.last_info["oom_fallback"] == "cpu"
    assert empty_spy.call_count == 1
