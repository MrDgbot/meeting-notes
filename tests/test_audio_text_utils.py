"""Tests for audio_utils, text_matching, and prompts integration."""
from __future__ import annotations

import hashlib
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

import audio_utils
import prompts
import store
import text_matching


def _sine(freq: float = 440.0, dur_s: float = 1.0, sr: int = 16000, amp: float = 0.25) -> np.ndarray:
    t = np.linspace(0.0, dur_s, int(round(sr * dur_s)), endpoint=False, dtype=np.float32)
    return (amp * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


# ---------- audio_sha256 & validate_audio_array ----------


def test_audio_sha256_file_and_array(tmp_path: Path):
    # > 1 MiB file exercises multi-chunk streaming read
    payload = os.urandom(1024 * 1024 + 12345)
    p = tmp_path / "big.bin"
    p.write_bytes(payload)
    assert audio_utils.audio_sha256(p) == hashlib.sha256(payload).hexdigest()

    arr64 = np.linspace(-0.5, 0.5, 100, dtype=np.float64)
    arr32 = arr64.astype(np.float32)
    assert audio_utils.audio_sha256(arr64) == audio_utils.audio_sha256(arr32)
    assert audio_utils.audio_sha256(arr32[::2]) == audio_utils.audio_sha256(np.ascontiguousarray(arr32[::2]))

    with pytest.raises(TypeError):
        audio_utils.audio_sha256(12345)  # type: ignore[arg-type]
    with pytest.raises(FileNotFoundError):
        audio_utils.audio_sha256(tmp_path / "missing.wav")


def test_validate_audio_array_and_non_finite():
    raw = np.array([0.25, np.nan, np.inf, -np.inf, -0.5], dtype=np.float64)
    assert audio_utils.has_non_finite(raw) is True
    cleaned = audio_utils.validate_audio_array(raw, 16000)
    assert cleaned.dtype == np.float32
    assert audio_utils.has_non_finite(cleaned) is False
    np.testing.assert_allclose(cleaned, np.array([0.25, 0.0, 0.0, 0.0, -0.5], dtype=np.float32))
    # Caller array is not mutated
    assert np.isnan(raw[1])

    assert audio_utils.has_non_finite(np.array([], dtype=np.float32)) is False

    with pytest.raises(ValueError):
        audio_utils.validate_audio_array(np.array([], dtype=np.float32), 16000)
    with pytest.raises(ValueError):
        audio_utils.validate_audio_array(np.ones(10, dtype=np.float32), 0)
    with pytest.raises(ValueError):
        audio_utils.validate_audio_array(np.ones(10, dtype=np.float32), -16000)
    with pytest.raises(ValueError):
        audio_utils.validate_audio_array(np.ones(10, dtype=np.float32), True)  # type: ignore[arg-type]


# ---------- can_skip_ffmpeg_wav16k & fast_to_wav16k ----------


def test_fast_to_wav16k_skips_ffmpeg_for_16k_mono(tmp_path: Path, monkeypatch):
    samples = _sine(440.0, 0.5, 16000, 0.3)

    wav16 = tmp_path / "mono16_pcm16.wav"
    sf.write(wav16, samples, 16000, subtype="PCM_16", format="WAV")
    wav_float = tmp_path / "mono16_float.wav"
    sf.write(wav_float, samples, 16000, subtype="FLOAT", format="WAV")
    flac16 = tmp_path / "mono16.flac"
    sf.write(flac16, samples, 16000, format="FLAC")
    ogg16 = tmp_path / "mono16.ogg"
    sf.write(ogg16, samples, 16000, format="OGG")

    def _forbid_subprocess(*args, **kwargs):
        raise AssertionError("ffmpeg should not be called on fast path")

    monkeypatch.setattr(subprocess, "run", _forbid_subprocess)

    for src, name in [
        (wav16, "out_pcm.wav"),
        (wav_float, "out_float.wav"),
        (flac16, "out_flac.wav"),
        (ogg16, "out_ogg.wav"),
    ]:
        assert audio_utils.can_skip_ffmpeg_wav16k(src) is True
        dst = tmp_path / name
        assert audio_utils.fast_to_wav16k(src, dst) is True
        info = sf.info(str(dst))
        assert info.format == "WAV"
        assert info.subtype == "PCM_16"
        assert info.samplerate == 16000
        assert info.channels == 1
        assert info.frames == len(samples)

    # PCM_16 -> PCM_16 copy is byte-identical
    assert (tmp_path / "out_pcm.wav").read_bytes() == wav16.read_bytes()
    assert not list(tmp_path.glob("*.tmp*"))


def test_fast_to_wav16k_returns_false_when_ffmpeg_needed(tmp_path: Path):
    sr44 = tmp_path / "mono44k.wav"
    sf.write(sr44, _sine(440.0, 0.2, 44100), 44100)
    assert audio_utils.can_skip_ffmpeg_wav16k(sr44) is False
    assert audio_utils.fast_to_wav16k(sr44, tmp_path / "out1.wav") is False

    stereo = tmp_path / "stereo16k.wav"
    mono = _sine(440.0, 0.2, 16000)
    sf.write(stereo, np.column_stack([mono, mono]), 16000)
    assert audio_utils.can_skip_ffmpeg_wav16k(stereo) is False
    assert audio_utils.fast_to_wav16k(stereo, tmp_path / "out2.wav") is False

    mp3 = tmp_path / "clip.mp3"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(sr44), "-b:a", "64k", str(mp3)],
        check=True,
    )
    assert audio_utils.can_skip_ffmpeg_wav16k(mp3) is False
    assert audio_utils.fast_to_wav16k(mp3, tmp_path / "out3.wav") is False
    assert audio_utils.can_skip_ffmpeg_wav16k(tmp_path / "missing.wav") is False


# ---------- silent_span & detect_audio_health ----------


def test_silent_span_dual_peak_rms():
    sr = 16000
    zeros = np.zeros(sr * 2, dtype=np.float32)
    res_sil = audio_utils.silent_span(zeros, sr)
    assert res_sil["is_all_silent"] is True
    assert res_sil["silent_ratio"] == pytest.approx(1.0)
    assert res_sil["max_silent_s"] == pytest.approx(2.0)
    assert res_sil["peak_db"] <= -55.0
    assert res_sil["rms_db"] <= -70.0

    tone = _sine(440.0, 1.0, sr, amp=0.2)
    res_tone = audio_utils.silent_span(tone, sr)
    assert res_tone["is_all_silent"] is False
    assert res_tone["silent_ratio"] == pytest.approx(0.0)
    assert res_tone["max_silent_s"] == pytest.approx(0.0)

    mixed = np.concatenate([
        np.zeros(sr * 1, dtype=np.float32),
        _sine(440.0, 0.5, sr, amp=0.2),
        np.zeros(sr * 2, dtype=np.float32),
    ])
    res_mix = audio_utils.silent_span(mixed, sr)
    assert res_mix["is_all_silent"] is False
    assert res_mix["max_silent_s"] == pytest.approx(2.0, abs=0.02)
    assert res_mix["silent_ratio"] == pytest.approx(3.0 / 3.5, abs=0.02)

    # Dual peak+RMS: sharp click (high peak, low RMS) is NOT silent
    click = np.zeros(int(sr * 0.04), dtype=np.float32)
    click[10] = 0.05  # peak ~ -26 dB (> -55 dB), 20ms RMS ~ -51 dB; test with tiny amp
    click[10] = 0.005  # peak -46 dB (> -55 dB), 20ms RMS ~ -71 dB (< -70 dB)
    res_click = audio_utils.silent_span(click, sr)
    assert res_click["is_all_silent"] is False
    assert res_click["max_silent_s"] == pytest.approx(0.02, abs=0.001)

    # Empty array
    empty_res = audio_utils.silent_span(np.array([], dtype=np.float32), sr)
    assert empty_res["is_all_silent"] is True
    assert empty_res["max_silent_s"] == 0.0


def test_detect_audio_health_streaming(tmp_path: Path):
    sr = 16000
    # 1. Healthy mono with 1s pause, streamed with odd chunk_frames (not multiple of 320)
    healthy = tmp_path / "healthy.wav"
    sig = np.concatenate([
        _sine(440.0, 0.5, sr, 0.2),
        np.zeros(sr, dtype=np.float32),
        _sine(550.0, 0.5, sr, 0.2),
    ])
    sf.write(healthy, sig, sr, subtype="PCM_16")
    h = audio_utils.detect_audio_health(healthy, chunk_frames=1000)
    assert h["ok"] is True
    assert h["warnings"] == []
    assert h["channels"] == 1
    assert h["duration_s"] == pytest.approx(2.0)
    assert h["max_silent_s"] == pytest.approx(1.0, abs=0.02)
    assert h["dead_channels"] == []

    # 2. All-silent mono
    all_sil = tmp_path / "silent.wav"
    sf.write(all_sil, np.zeros(sr, dtype=np.float32), sr, subtype="PCM_16")
    hs = audio_utils.detect_audio_health(all_sil, chunk_frames=1000)
    assert hs["ok"] is False
    assert hs["max_silent_s"] == pytest.approx(1.0)
    assert hs["dead_channels"] == []
    assert hs["warnings"]

    # 3. Dead right channel in stereo
    dead_r = tmp_path / "dead_right.wav"
    left = _sine(440.0, 1.0, sr, 0.2)
    right = np.zeros(sr, dtype=np.float32)
    sf.write(dead_r, np.column_stack([left, right]), sr, subtype="PCM_16")
    hr = audio_utils.detect_audio_health(dead_r, chunk_frames=1000)
    assert hr["ok"] is False
    assert hr["channels"] == 2
    assert hr["dead_channels"] == [1]
    assert any("1" in w for w in hr["warnings"])

    # 4. Non-finite samples in FLOAT WAV
    bad_nan = tmp_path / "nan.wav"
    arr = _sine(440.0, 0.5, sr, 0.2)
    arr[1234] = np.nan
    sf.write(bad_nan, arr, sr, subtype="FLOAT")
    hn = audio_utils.detect_audio_health(bad_nan, chunk_frames=500)
    assert hn["ok"] is False
    assert any("NaN" in w or "non-finite" in w.lower() for w in hn["warnings"])

    # 5. Empty 0-frame WAV
    empty_wav = tmp_path / "empty.wav"
    sf.write(empty_wav, np.zeros(0, dtype=np.float32), sr, subtype="PCM_16")
    he = audio_utils.detect_audio_health(empty_wav)
    assert he["ok"] is False
    assert he["duration_s"] == 0.0
    assert he["warnings"]


# ---------- crop_audio_clip ----------


def test_crop_audio_clip_wav_lossless_and_ffmpeg(tmp_path: Path, monkeypatch):
    sr = 16000
    samples = np.arange(sr * 3, dtype=np.int16) % 30000
    src_wav = tmp_path / "src.wav"
    sf.write(src_wav, samples, sr, subtype="PCM_16")

    # Lossless WAV -> WAV without ffmpeg
    out_wav = tmp_path / "clip.wav"
    orig_run = subprocess.run

    def _no_ffmpeg(*args, **kwargs):
        raise AssertionError("WAV->WAV crop must not spawn ffmpeg")

    monkeypatch.setattr(subprocess, "run", _no_ffmpeg)
    res_path = audio_utils.crop_audio_clip(src_wav, 0.5, 1.75, out_wav, fmt="wav")
    assert res_path == out_wav
    got, got_sr = sf.read(str(out_wav), dtype="int16")
    assert got_sr == sr
    np.testing.assert_array_equal(got, samples[int(0.5 * sr) : int(1.75 * sr)])

    # Clamp end_s beyond file duration (also verifies 5000.0 clamps to 3.0 <= 3600.0)
    clamped_wav = tmp_path / "clamped.wav"
    audio_utils.crop_audio_clip(src_wav, 2.0, 5000.0, clamped_wav, fmt="wav")
    got_c, _ = sf.read(str(clamped_wav), dtype="int16")
    np.testing.assert_array_equal(got_c, samples[int(2.0 * sr) :])

    monkeypatch.setattr(subprocess, "run", orig_run)

    # MP3 -> WAV via ffmpeg -ss ... -to ...
    src_mp3 = tmp_path / "src.mp3"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(src_wav), "-b:a", "64k", str(src_mp3)],
        check=True,
    )
    out_from_mp3 = tmp_path / "from_mp3.wav"
    audio_utils.crop_audio_clip(src_mp3, 0.5, 2.0, out_from_mp3, fmt="wav")
    info_mp3 = sf.info(str(out_from_mp3))
    assert info_mp3.duration == pytest.approx(1.5, abs=0.05)

    # WAV -> MP3 via ffmpeg
    out_mp3 = tmp_path / "clip.mp3"
    audio_utils.crop_audio_clip(src_wav, 0.25, 1.5, out_mp3, fmt="mp3")
    assert out_mp3.exists() and out_mp3.stat().st_size > 0
    assert not list(tmp_path.glob("*.tmp*"))


def test_crop_audio_clip_validation(tmp_path: Path):
    src_wav = tmp_path / "short.wav"
    sf.write(src_wav, _sine(440.0, 2.0, 16000), 16000)

    with pytest.raises(ValueError):
        audio_utils.crop_audio_clip(src_wav, -0.1, 1.0, tmp_path / "a.wav")
    with pytest.raises(ValueError):
        audio_utils.crop_audio_clip(src_wav, 1.0, 1.0, tmp_path / "b.wav")
    with pytest.raises(ValueError):
        audio_utils.crop_audio_clip(src_wav, 5.0, 6.0, tmp_path / "c.wav")
    with pytest.raises(ValueError):
        audio_utils.crop_audio_clip(src_wav, 0.0, 1.0, tmp_path / "d.exe", fmt="exe")

    # Enforce 3600s max clip duration when source exceeds 3600s
    fake_long = tmp_path / "long_hdr.wav"
    fake_long.write_bytes(b"RIFF")
    with pytest.MonkeyPatch.context() as mp:
        class _FakeInfo:
            duration = 7200.0
            format = "WAV"
            subtype = "PCM_16"
            samplerate = 16000
            channels = 1
            frames = 7200 * 16000

        mp.setattr(audio_utils, "_read_sf_info", lambda p: _FakeInfo())
        with pytest.raises(ValueError, match="3600"):
            audio_utils.crop_audio_clip(fake_long, 0.0, 3601.0, tmp_path / "too_long.wav")


# ---------- AsrSegmentCache ----------


def test_asr_segment_cache_dynamic_root_and_pruning(tmp_path: Path, monkeypatch):
    data1 = tmp_path / "data1"
    data2 = tmp_path / "data2"
    monkeypatch.setattr(store, "DATA", data1)

    cache = audio_utils.AsrSegmentCache(max_entries=3)
    assert cache.cache_dir == data1 / "asr_cache"
    monkeypatch.setattr(store, "DATA", data2)
    assert cache.cache_dir == data2 / "asr_cache"

    k1 = cache.make_key("nano", "v1", "热词", "abc")
    expected = hashlib.sha256(b"v1:nano:v1:\xe7\x83\xad\xe8\xaf\x8d:abc").hexdigest()
    assert k1 == expected

    # Empty / error entries are skipped
    assert cache.put(k1, None) is False
    assert cache.put(k1, "") is False
    assert cache.put(k1, []) is False
    assert cache.put(k1, {}) is False
    assert cache.put(k1, {"error": "oom"}) is False
    assert cache.put(k1, {"ok": False, "text": "x"}) is False
    assert cache.put(k1, {"segments": []}) is False
    assert cache.get(k1) is None

    # Put 5 valid entries with ordered mtimes -> oldest 2 pruned
    keys = [cache.make_key("nano", "v1", "", f"h{i}") for i in range(5)]
    base_ns = time.time_ns() - 10_000_000_000
    for i, k in enumerate(keys):
        assert cache.put(k, {"text": f"seg {i}", "segments": [{"text": f"seg {i}"}]}) is True
        p = cache.cache_dir / f"{k}.json"
        os.utime(p, ns=(base_ns + i * 1_000_000_000, base_ns + i * 1_000_000_000))

    # Re-put triggers pruning of oldest entries
    k_last = cache.make_key("nano", "v1", "", "h_final")
    assert cache.put(k_last, {"text": "final", "segments": [{"text": "final"}]}) is True
    json_files = list(cache.cache_dir.glob("*.json"))
    assert len(json_files) == 3
    assert cache.get(keys[0]) is None
    assert cache.get(keys[1]) is None
    assert cache.get(keys[2]) is None
    assert cache.get(keys[3]) == {"text": "seg 3", "segments": [{"text": "seg 3"}]}
    assert cache.get(keys[4]) == {"text": "seg 4", "segments": [{"text": "seg 4"}]}
    assert cache.get(k_last) == {"text": "final", "segments": [{"text": "final"}]}
    assert not list(cache.cache_dir.glob(".*.tmp"))


# ---------- text_matching ----------


def test_spoken_normalize_and_contextual_span():
    norm, idx = text_matching.spoken_normalize("「ＡＩ」ﬁle，123！")
    assert norm == "aifile123"
    assert idx == [1, 2, 4, 4, 5, 6, 8, 9, 10]

    hay = "昨天开会说：预算，先批十万；今天补充：预算先批二十万！最后确认：预算 先批 十万。"
    span1 = text_matching.contextual_span(hay, "预算先批十万")
    assert span1 == (6, 13)
    assert hay[span1[0] : span1[1]] == "预算，先批十万"

    # Hint closer to the second occurrence of "预算先批十万"
    second_pos = hay.rfind("预算")
    span2 = text_matching.contextual_span(hay, "预算，先批十万！", hint_idx=second_pos)
    assert span2 is not None
    assert hay[span2[0] : span2[1]] == "预算 先批 十万"

    # NFKC + case + ligature
    hay2 = "Check the ﬁnal ＡＰＩ spec."
    span3 = text_matching.contextual_span(hay2, "final api")
    assert span3 is not None
    assert hay2[span3[0] : span3[1]] == "ﬁnal ＡＰＩ"

    assert text_matching.contextual_span(hay2, "missing") is None
    assert text_matching.contextual_span(hay2, "...") is None


def test_split_text_safe_preserves_tokens_and_preferences():
    # Abbreviations and decimals are never split across/within chunks
    text = (
        "Dr. Smith met Prof. Lee at 3.14 p.m. in the U.S.A. "
        "Please check e.g. Mr. Chen, Mrs. Wu, i.e. Acme Inc. vs. No. 5 Ltd."
    )
    chunks = text_matching.split_text_safe(text, max_chars=38)
    assert chunks
    assert all(len(c) <= 38 for c in chunks)
    joined = " ".join(chunks)
    for token in ("Dr.", "Prof.", "3.14", "p.m.", "U.S.A.", "e.g.", "Mr.", "Mrs.", "i.e.", "Inc.", "vs.", "No."):
        assert token in joined

    # Sentence boundary preferred over clause boundary
    cn = "第一句话很短。第二句话很长，有很多逗号，在这里断，还有内容。第三句。"
    cn_chunks = text_matching.split_text_safe(cn, max_chars=24)
    assert all(len(c) <= 24 for c in cn_chunks)
    assert cn_chunks[0] == "第一句话很短。"

    # Mid-Latin word protection
    mixed = "今天重点评审了authentication和authorization模块"
    m_chunks = text_matching.split_text_safe(mixed, max_chars=22)
    assert all(len(c) <= 22 for c in m_chunks)
    assert "authentication" in m_chunks[1] or "authentication" in m_chunks[0]
    assert not any(c.endswith("authentica") for c in m_chunks)

    assert text_matching.split_text_safe("", 10) == []
    assert text_matching.split_text_safe("short", 10) == ["short"]
    with pytest.raises(ValueError):
        text_matching.split_text_safe("abc", 0)


# ---------- prompts.py integration ----------


def test_prompts_chunk_lines_and_check_name_candidates():
    normal = ["[00:01] 说话人1：你好", "[00:05] 说话人2：世界"]
    assert prompts.chunk_lines(normal, 50) == [normal]

    long_line = "[00:10] 说话人1：" + "今天确认了 Dr. Lee 的 3.14 方案。接下来推进测试上线。" * 3
    chunks = prompts.chunk_lines(["[00:01] 短行", long_line], 45)
    assert len(chunks) > 1
    for ch in chunks:
        assert len("\n".join(ch)) <= 45
    assert "Dr." in " ".join(sum(chunks, []))
    assert "3.14" in " ".join(sum(chunks, []))

    paras = [
        {"start": 0, "end": 5000, "spk": 0, "text": "我是Ａｌｉｃｅ，负责前端开发"},
        {"start": 6000, "end": 10000, "spk": 1, "text": "好的，收到"},
    ]
    raw = [
        {
            "spk": 1,
            "name": "Alice",
            "confidence": "高",
            "reason": "自我介绍",
            "evidence": [{"ts": "00:01", "quote": "我是alice负责前端开发"}],
        }
    ]
    res = prompts.check_name_candidates(raw, paras)
    assert len(res) == 1
    assert res[0]["name"] == "Alice"
    assert res[0]["spk"] == 0
