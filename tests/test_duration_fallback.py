"""Tests for asr_engine.duration_of fallbacks when ffprobe is absent (bundled standalone)."""
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
import soundfile as sf

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-dur-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asr_engine  # noqa: E402


def _make_wav(tmp_path: Path, seconds: float = 2.5, sr: int = 16000) -> Path:
    wav = tmp_path / "sample.wav"
    samples = np.zeros(int(seconds * sr), dtype=np.float32)
    sf.write(str(wav), samples, sr)
    return wav


def test_duration_of_uses_soundfile_when_ffprobe_missing(tmp_path):
    wav = _make_wav(tmp_path, seconds=2.5)
    with mock.patch.object(asr_engine.subprocess, "run", side_effect=FileNotFoundError("no ffprobe")):
        dur = asr_engine.duration_of(wav)
    assert abs(dur - 2.5) < 0.02


def test_duration_of_uses_ffmpeg_stderr_when_ffprobe_and_soundfile_unavailable(tmp_path):
    dummy = tmp_path / "meeting.m4a"
    dummy.write_bytes(b"")

    def fake_run(cmd, **_kwargs):
        if cmd[0] == "ffprobe":
            raise FileNotFoundError("no ffprobe")
        assert cmd[:4] == ["ffmpeg", "-hide_banner", "-nostdin", "-i"]
        return SimpleNamespace(stdout="", stderr="  Duration: 01:02:03.50, start: 0.000000, bitrate: 64 kb/s")

    with (
        mock.patch.object(asr_engine.subprocess, "run", side_effect=fake_run),
        mock.patch.object(asr_engine.sf, "info", side_effect=RuntimeError("unsupported format")),
    ):
        dur = asr_engine.duration_of(dummy)
    assert abs(dur - 3723.5) < 0.01


def test_duration_of_returns_zero_when_all_probes_fail(tmp_path):
    dummy = tmp_path / "missing.m4a"
    with (
        mock.patch.object(asr_engine.subprocess, "run", side_effect=FileNotFoundError("missing")),
        mock.patch.object(asr_engine.sf, "info", side_effect=RuntimeError("unreadable")),
    ):
        assert asr_engine.duration_of(dummy) == 0.0
