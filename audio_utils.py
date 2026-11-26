"""Audio preprocessing, health checks, lossless/ffmpeg clipping, and content-addressed ASR cache."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

import store

HASH_CHUNK_BYTES = 1024 * 1024  # 1 MiB streaming file hash
MAX_CLIP_DURATION_S = 3600.0
DEFAULT_CACHE_MAX_ENTRIES = 2000
_DB_FLOOR = -120.0
_EPS = 1e-6
_SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_SUPPORTED_CLIP_FMTS = frozenset({"wav", "mp3", "flac", "ogg"})
_FAST_WAV16K_FORMATS = frozenset({"WAV", "FLAC", "OGG"})
_NO_WIN = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}


def _tmp_path(dst: Path, suffix: str) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{dst.name}.", suffix=suffix, dir=dst.parent)
    os.close(fd)
    return Path(name)


def audio_sha256(src: Path | str | np.ndarray) -> str:
    """Compute SHA-256 hex digest of an audio file (1 MiB streaming) or float32 ndarray."""
    h = hashlib.sha256()
    if isinstance(src, np.ndarray):
        arr = np.ascontiguousarray(src, dtype=np.float32)
        h.update(arr.tobytes())
        return h.hexdigest()
    if isinstance(src, (Path, str, os.PathLike)):
        path = Path(src)
        with open(path, "rb") as f:
            while chunk := f.read(HASH_CHUNK_BYTES):
                h.update(chunk)
        return h.hexdigest()
    raise TypeError(f"Unsupported audio_sha256 source type: {type(src).__name__}")


def has_non_finite(x: np.ndarray) -> bool:
    """Return True if array contains any NaN or Inf values."""
    arr = np.asarray(x)
    if arr.size == 0:
        return False
    return bool(not np.isfinite(arr).all())


def validate_audio_array(x: np.ndarray, sr: int) -> np.ndarray:
    """Validate non-empty audio array and positive sample rate, returning finite float32."""
    if not isinstance(sr, (int, np.integer)) or isinstance(sr, bool) or int(sr) <= 0:
        raise ValueError(f"Sample rate must be positive, got {sr!r}")
    arr = np.asarray(x, dtype=np.float32)
    if arr.size == 0:
        raise ValueError("Audio array must not be empty")
    if has_non_finite(arr):
        arr = np.nan_to_num(arr, copy=True, nan=0.0, posinf=0.0, neginf=0.0)
    return arr


def _read_sf_info(src: Path):
    try:
        return sf.info(str(src))
    except (sf.SoundFileError, RuntimeError, OSError):
        return None


def can_skip_ffmpeg_wav16k(src: Path | str) -> bool:
    """Return True if src is already 16000 Hz mono WAV, FLAC, or OGG readable by soundfile."""
    info = _read_sf_info(Path(src))
    if info is None:
        return False
    return (
        info.format in _FAST_WAV16K_FORMATS
        and info.samplerate == 16000
        and info.channels == 1
        and info.frames > 0
    )


def fast_to_wav16k(src: Path | str, dst: Path | str) -> bool:
    """Convert 16kHz mono WAV/FLAC/OGG to 16kHz PCM_16 WAV atomically without ffmpeg.

    Returns True on success, or False when ffmpeg fallback is needed.
    """
    src_p = Path(src)
    dst_p = Path(dst)
    info = _read_sf_info(src_p)
    if info is None or not (
        info.format in _FAST_WAV16K_FORMATS
        and info.samplerate == 16000
        and info.channels == 1
        and info.frames > 0
    ):
        return False

    tmp = _tmp_path(dst_p, ".tmp.wav")
    try:
        if info.format == "WAV" and info.subtype == "PCM_16":
            shutil.copyfile(src_p, tmp)
        else:
            with sf.SoundFile(str(src_p), "r") as fin, sf.SoundFile(
                str(tmp),
                "w",
                samplerate=16000,
                channels=1,
                subtype="PCM_16",
                format="WAV",
            ) as fout:
                while True:
                    block = fin.read(65536, dtype="float32")
                    if len(block) == 0:
                        break
                    fout.write(block)
        os.replace(tmp, dst_p)
        return True
    except (sf.SoundFileError, RuntimeError):
        tmp.unlink(missing_ok=True)
        return False
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _to_db(val: float) -> float:
    return float(20.0 * math.log10(max(float(val), _EPS)))


def _window_silent_stats(
    arr_2d: np.ndarray,
    win: int,
    peak_db: float,
    rms_db: float,
) -> tuple[list[tuple[int, bool]], np.ndarray]:
    """Evaluate dual peak+RMS silence on complete windows; return ([(n_frames, is_silent)], tail_2d)."""
    n_frames = arr_2d.shape[0]
    n_full = n_frames // win
    rem = n_frames % win
    results: list[tuple[int, bool]] = []
    if n_full > 0:
        trimmed = arr_2d[: n_full * win]
        blocks = trimmed.reshape(n_full, win * arr_2d.shape[1])
        peaks = np.max(np.abs(blocks), axis=1)
        rms = np.sqrt(np.mean(np.square(blocks, dtype=np.float64), axis=1))
        peak_dbs = 20.0 * np.log10(np.maximum(peaks, _EPS))
        rms_dbs = 20.0 * np.log10(np.maximum(rms, _EPS))
        silent_flags = (peak_dbs <= peak_db) & (rms_dbs <= rms_db)
        for flag in silent_flags.tolist():
            results.append((win, bool(flag)))
    tail = arr_2d[n_full * win :] if rem > 0 else arr_2d[:0]
    return results, tail


def _single_block_silent(block_2d: np.ndarray, peak_db: float, rms_db: float) -> tuple[int, bool]:
    n_frames = block_2d.shape[0]
    pk = float(np.max(np.abs(block_2d)))
    rm = float(np.sqrt(np.mean(np.square(block_2d, dtype=np.float64))))
    return n_frames, (_to_db(pk) <= peak_db and _to_db(rm) <= rms_db)


def silent_span(
    samples: np.ndarray,
    sr: int,
    win_ms: int = 20,
    peak_db: float = -55.0,
    rms_db: float = -70.0,
) -> dict:
    """Detect silence using a 20ms-window dual peak+RMS detector."""
    if not isinstance(sr, (int, np.integer)) or isinstance(sr, bool) or int(sr) <= 0:
        raise ValueError(f"Sample rate must be positive, got {sr!r}")
    if not isinstance(win_ms, (int, np.integer)) or isinstance(win_ms, bool) or int(win_ms) <= 0:
        raise ValueError(f"win_ms must be positive, got {win_ms!r}")

    arr = np.asarray(samples, dtype=np.float32)
    if arr.size == 0:
        return {
            "max_silent_s": 0.0,
            "silent_ratio": 1.0,
            "is_all_silent": True,
            "peak_db": _DB_FLOOR,
            "rms_db": _DB_FLOOR,
        }
    if has_non_finite(arr):
        arr = np.nan_to_num(arr, copy=True, nan=0.0, posinf=0.0, neginf=0.0)

    arr_2d = arr.reshape(arr.shape[0], -1) if arr.ndim >= 2 else arr[:, None]
    n_frames = arr_2d.shape[0]
    win = max(1, int(round(int(sr) * int(win_ms) / 1000.0)))

    overall_peak = float(np.max(np.abs(arr_2d)))
    overall_rms = float(np.sqrt(np.mean(np.square(arr_2d, dtype=np.float64))))

    win_stats, tail = _window_silent_stats(arr_2d, win, peak_db, rms_db)
    if tail.shape[0] > 0:
        win_stats.append(_single_block_silent(tail, peak_db, rms_db))

    silent_frames = 0
    cur_run = 0
    max_run = 0
    all_silent = True
    for w_frames, is_sil in win_stats:
        if is_sil:
            silent_frames += w_frames
            cur_run += w_frames
            if cur_run > max_run:
                max_run = cur_run
        else:
            all_silent = False
            cur_run = 0

    return {
        "max_silent_s": max_run / float(sr),
        "silent_ratio": silent_frames / float(n_frames),
        "is_all_silent": all_silent,
        "peak_db": _to_db(overall_peak),
        "rms_db": _to_db(overall_rms),
    }


def detect_audio_health(
    wav_path: Path | str,
    chunk_frames: int = 16000 * 30,
    peak_db: float = -55.0,
    rms_db: float = -70.0,
) -> dict:
    """Stream audio in bounded chunks to detect silence, dead stereo channels, and non-finite samples."""
    if not isinstance(chunk_frames, (int, np.integer)) or isinstance(chunk_frames, bool) or int(chunk_frames) <= 0:
        raise ValueError(f"chunk_frames must be positive, got {chunk_frames!r}")

    path = Path(wav_path)
    total_frames = 0
    any_non_finite = False
    all_silent = True
    cur_silent_frames = 0
    max_silent_frames = 0

    with sf.SoundFile(str(path), "r") as f:
        sr = f.samplerate
        channels = f.channels
        win = max(1, int(round(sr * 20 / 1000.0)))
        ch_max_abs = np.zeros(channels, dtype=np.float64)
        ch_sum_sq = np.zeros(channels, dtype=np.float64)
        tail = np.empty((0, channels), dtype=np.float32)

        while True:
            raw_block = f.read(int(chunk_frames), dtype="float32", always_2d=True)
            if len(raw_block) == 0:
                break
            total_frames += raw_block.shape[0]
            if has_non_finite(raw_block):
                any_non_finite = True
                block = np.nan_to_num(raw_block, copy=True, nan=0.0, posinf=0.0, neginf=0.0)
            else:
                block = raw_block

            ch_max_abs = np.maximum(ch_max_abs, np.max(np.abs(block), axis=0))
            ch_sum_sq += np.sum(np.square(block, dtype=np.float64), axis=0)

            combined = np.vstack((tail, block)) if tail.shape[0] > 0 else block
            win_stats, tail = _window_silent_stats(combined, win, peak_db, rms_db)
            for w_frames, is_sil in win_stats:
                if is_sil:
                    cur_silent_frames += w_frames
                    if cur_silent_frames > max_silent_frames:
                        max_silent_frames = cur_silent_frames
                else:
                    all_silent = False
                    cur_silent_frames = 0

        if tail.shape[0] > 0:
            w_frames, is_sil = _single_block_silent(tail, peak_db, rms_db)
            if is_sil:
                cur_silent_frames += w_frames
                if cur_silent_frames > max_silent_frames:
                    max_silent_frames = cur_silent_frames
            else:
                all_silent = False

    duration_s = total_frames / float(sr) if sr > 0 else 0.0
    max_silent_s = max_silent_frames / float(sr) if sr > 0 else 0.0

    dead_channels: list[int] = []
    if total_frames > 0 and channels > 1:
        for ch in range(channels):
            ch_pk_db = _to_db(float(ch_max_abs[ch]))
            ch_rm_db = _to_db(math.sqrt(float(ch_sum_sq[ch]) / float(total_frames)))
            if ch_pk_db <= peak_db and ch_rm_db <= rms_db:
                dead_channels.append(ch)

    warnings: list[str] = []
    if total_frames == 0:
        warnings.append("Audio file is empty (0 frames)")
    elif all_silent:
        warnings.append("Audio is completely silent (all-silent)")
    if dead_channels:
        warnings.append(f"Dead/muted channel(s) detected: {dead_channels}")
    if any_non_finite:
        warnings.append("Non-finite samples (NaN/Inf) detected")

    return {
        "ok": len(warnings) == 0,
        "warnings": warnings,
        "channels": channels,
        "duration_s": duration_s,
        "max_silent_s": max_silent_s,
        "dead_channels": dead_channels,
    }


def _probe_duration(src: Path) -> float:
    info = _read_sf_info(src)
    if info is not None and info.duration > 0:
        return float(info.duration)
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, **_NO_WIN,
        ).stdout.strip()
        val = float(out)
        if val > 0:
            return val
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    try:
        p = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(src)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", **_NO_WIN,
        )
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", p.stderr or "")
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return 0.0


def _lossless_dtype_for_subtype(subtype: str | None) -> str:
    if subtype == "PCM_16":
        return "int16"
    if subtype in ("PCM_24", "PCM_32"):
        return "int32"
    if subtype == "DOUBLE":
        return "float64"
    return "float32"


def crop_audio_clip(
    src_path: Path | str,
    start_s: float,
    end_s: float,
    out_path: Path | str,
    fmt: str = "wav",
) -> Path:
    """Slice [start_s, end_s] from src_path and write atomically to out_path.

    Uses sample-accurate soundfile seek+read for WAV->WAV lossless slicing and
    ffmpeg -ss ... -to ... for MP3 or non-WAV sources.
    """
    src_p = Path(src_path)
    out_p = Path(out_path)
    fmt_norm = (fmt or "wav").strip().lower().lstrip(".")
    if fmt_norm not in _SUPPORTED_CLIP_FMTS:
        raise ValueError(f"Unsupported clip format: {fmt!r}")
    if not (math.isfinite(start_s) and math.isfinite(end_s)):
        raise ValueError("start_s and end_s must be finite numbers")
    if start_s < 0 or start_s >= end_s:
        raise ValueError(f"Invalid clip range: start_s={start_s}, end_s={end_s}")
    if not src_p.exists():
        raise FileNotFoundError(src_p)

    info = _read_sf_info(src_p)
    duration = float(info.duration) if (info is not None and info.duration > 0) else _probe_duration(src_p)
    clamped_end = min(float(end_s), duration) if duration > 0 else float(end_s)
    if clamped_end <= start_s:
        raise ValueError(f"Clip range [{start_s}, {end_s}] is empty after clamping to duration {duration}")
    if clamped_end - start_s > MAX_CLIP_DURATION_S:
        raise ValueError(
            f"Clip duration {clamped_end - start_s:.2f}s exceeds max {MAX_CLIP_DURATION_S:.0f}s"
        )

    tmp = _tmp_path(out_p, f".tmp.{fmt_norm}")
    try:
        if info is not None and info.format == "WAV" and fmt_norm == "wav":
            sr = info.samplerate
            start_frame = max(0, min(info.frames, int(round(start_s * sr))))
            end_frame = max(0, min(info.frames, int(round(clamped_end * sr))))
            remaining = end_frame - start_frame
            if remaining <= 0:
                raise ValueError("Clip range contains 0 audio frames")
            dtype = _lossless_dtype_for_subtype(info.subtype)
            with sf.SoundFile(str(src_p), "r") as fin, sf.SoundFile(
                str(tmp),
                "w",
                samplerate=sr,
                channels=info.channels,
                subtype=info.subtype,
                format="WAV",
            ) as fout:
                fin.seek(start_frame)
                while remaining > 0:
                    chunk = fin.read(min(65536, remaining), dtype=dtype)
                    if len(chunk) == 0:
                        break
                    fout.write(chunk)
                    remaining -= len(chunk)
        else:
            cmd = [
                "ffmpeg", "-loglevel", "error", "-y",
                "-ss", f"{start_s:.6f}",
                "-to", f"{clamped_end:.6f}",
                "-i", str(src_p),
                "-vn",
            ]
            if fmt_norm == "mp3":
                cmd += ["-b:a", "128k"]
            cmd += ["-f", fmt_norm, str(tmp)]
            p = subprocess.run(cmd, capture_output=True, text=True, **_NO_WIN)
            if p.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
                msg = (p.stderr or "").strip()[:300] or f"exit {p.returncode}"
                raise RuntimeError(f"Audio clip export failed: {msg}")
        os.replace(tmp, out_p)
        return out_p
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _is_empty_or_error_entry(data) -> bool:
    if data is None:
        return True
    if isinstance(data, str):
        return not data.strip()
    if isinstance(data, (list, tuple)):
        return len(data) == 0
    if isinstance(data, dict):
        if len(data) == 0:
            return True
        if data.get("error") or data.get("ok") is False:
            return True
        if "segments" in data and not data["segments"] and not str(data.get("text") or "").strip():
            return True
        if "paras" in data and not data["paras"] and not str(data.get("text") or "").strip():
            return True
        if "text" in data and "segments" not in data and "paras" not in data and not str(data.get("text") or "").strip():
            return True
    return False


class AsrSegmentCache:
    """Content-addressed JSON cache for ASR segments bounded by entry count."""

    def __init__(self, cache_dir: Path | str | None = None, max_entries: int = DEFAULT_CACHE_MAX_ENTRIES):
        if max_entries < 0:
            raise ValueError(f"max_entries must be >= 0, got {max_entries}")
        self._cache_dir = Path(cache_dir) if cache_dir is not None else None
        self.max_entries = int(max_entries)

    @property
    def cache_dir(self) -> Path:
        return self._cache_dir if self._cache_dir is not None else store.DATA / "asr_cache"

    @staticmethod
    def make_key(engine: str, rev: str = "", hotword: str = "", audio_hash: str = "") -> str:
        raw = f"v1:{engine}:{rev}:{hotword}:{audio_hash}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _entry_path(self, key: str) -> Path:
        key_s = str(key or "").strip()
        if not key_s or "/" in key_s or "\\" in key_s or ".." in key_s or not _SAFE_KEY_RE.fullmatch(key_s):
            key_s = hashlib.sha256(key_s.encode("utf-8")).hexdigest()
        return self.cache_dir / f"{key_s}.json"

    def get(self, key: str):
        path = self._entry_path(key)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError, json.JSONDecodeError, OSError):
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return data

    def put(self, key: str, data) -> bool:
        if _is_empty_or_error_entry(data) or self.max_entries == 0:
            return False
        root = self.cache_dir
        root.mkdir(parents=True, exist_ok=True)
        path = self._entry_path(key)
        tmp = _tmp_path(path, ".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        self._prune(root)
        return True

    def _prune(self, root: Path) -> None:
        entries: list[tuple[int, str, Path]] = []
        try:
            for p in root.iterdir():
                if p.name.startswith(".") or p.suffix != ".json" or not p.is_file():
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                entries.append((st.st_mtime_ns, p.name, p))
        except OSError:
            return
        excess = len(entries) - self.max_entries
        if excess <= 0:
            return
        entries.sort(key=lambda item: (item[0], item[1]))
        for _, _, victim in entries[:excess]:
            try:
                victim.unlink(missing_ok=True)
            except OSError:
                pass
