"""Runtime telemetry, host memory admission, rotating logs, and sanitized diagnostics export."""

from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import io
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any
import zipfile

_SENSITIVE_KEY_PARTS = (
    "key",
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
)

_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
_LOG_MAX_BYTES = 4 * 1024 * 1024
_LOG_BACKUP_COUNT = 3
_log_lock = threading.RLock()


def _resolve_data_dir(data_dir: Path | str | None = None) -> Path:
    """Resolve the active data directory dynamically without import-time snapshots."""
    if data_dir is not None:
        return Path(data_dir)
    import store

    return Path(store.DATA)


class JobClock:
    """Monotonic per-phase wall-clock timer for transcription and post-processing jobs."""

    PHASES = (
        "queue_s",
        "ffmpeg_s",
        "model_load_s",
        "vad_s",
        "diarize_load_s",
        "diarize_run_s",
        "asr_s",
        "postprocess_s",
    )

    def __init__(self, *, clock=time.perf_counter) -> None:
        self._clock = clock
        self._lock = threading.RLock()
        self._at = float(clock())
        self._phase: str | None = None
        self._stack: list[tuple[str, str | None]] = []
        self._durations: dict[str, float] = dict.fromkeys(self.PHASES, 0.0)
        self._finished = False

    @classmethod
    def _validate_phase(cls, phase: str) -> str:
        if phase not in cls.PHASES:
            raise ValueError(f"Unknown job timing phase: {phase!r}")
        return phase

    def _advance(self) -> None:
        now = float(self._clock())
        if not self._finished and self._phase is not None:
            self._durations[self._phase] += max(0.0, now - self._at)
        self._at = now

    def begin(self, phase: str) -> None:
        """Start timing `phase`, pushing the previous active phase onto the stack."""
        self._validate_phase(phase)
        with self._lock:
            if self._finished:
                return
            self._advance()
            self._stack.append((phase, self._phase))
            self._phase = phase

    def end(self, phase: str | None = None) -> None:
        """End the current phase (or matching stacked phase) and restore the previous one."""
        if phase is not None:
            self._validate_phase(phase)
        with self._lock:
            if self._finished:
                return
            if phase is None:
                if self._stack:
                    _, prev = self._stack.pop()
                    self._advance()
                    self._phase = prev
                elif self._phase is not None:
                    self._advance()
                    self._phase = None
                return

            if self._stack:
                for idx in range(len(self._stack) - 1, -1, -1):
                    if self._stack[idx][0] == phase:
                        _, prev = self._stack[idx]
                        del self._stack[idx:]
                        self._advance()
                        self._phase = prev
                        return
            if self._phase == phase:
                self._advance()
                self._phase = None

    def switch(self, phase: str) -> None:
        """Switch directly to `phase` without pushing onto the begin/end stack."""
        self._validate_phase(phase)
        with self._lock:
            if self._finished:
                return
            self._advance()
            self._phase = phase

    def add_external(self, phase: str, seconds: float) -> None:
        """Accumulate externally measured seconds (e.g., from a worker subprocess)."""
        self._validate_phase(phase)
        val = float(seconds)
        if not math.isfinite(val) or val <= 0.0:
            return
        with self._lock:
            self._durations[phase] += val

    def finish(self) -> dict[str, float]:
        """Finalize timing and freeze further wall-clock phase updates."""
        with self._lock:
            if not self._finished:
                self._advance()
                self._finished = True
                self._phase = None
                self._stack.clear()
            return self._build_snapshot()

    def _build_snapshot(self) -> dict[str, float]:
        out = {phase: round(self._durations[phase], 6) for phase in self.PHASES}
        out["total_s"] = round(sum(self._durations.values()), 6)
        return out

    def snapshot(self) -> dict[str, float]:
        """Return a dict[str, float] of accumulated seconds per phase plus `total_s`."""
        with self._lock:
            self._advance()
            return self._build_snapshot()


def setup_rotating_log(data_dir: Path | None = None) -> RotatingFileHandler:
    """Attach an idempotent 4 MiB x 3 RotatingFileHandler at `<data_dir>/logs/app.log`."""
    root_dir = _resolve_data_dir(data_dir)
    log_path = root_dir / "logs" / "app.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    target_resolved = log_path.resolve()

    with _log_lock:
        root_logger = logging.getLogger()
        for handler in list(root_logger.handlers):
            if isinstance(handler, RotatingFileHandler):
                try:
                    existing_path = Path(handler.baseFilename).resolve()
                except OSError:
                    existing_path = None
                if existing_path == target_resolved:
                    if not getattr(handler, "_meeting_notes_rotating", False):
                        handler._meeting_notes_rotating = True  # type: ignore[attr-defined]
                    return handler
                if getattr(handler, "_meeting_notes_rotating", False):
                    root_logger.removeHandler(handler)
                    try:
                        handler.close()
                    except OSError:
                        pass

        handler = RotatingFileHandler(
            log_path,
            maxBytes=_LOG_MAX_BYTES,
            backupCount=_LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        handler._meeting_notes_rotating = True  # type: ignore[attr-defined]
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter(_LOG_FORMAT))
        root_logger.addHandler(handler)
        if root_logger.level == logging.NOTSET or root_logger.level > logging.INFO:
            root_logger.setLevel(logging.INFO)
        return handler


def _cuda_memory_status() -> tuple[int | None, int | None]:
    try:
        import torch

        if not torch.cuda.is_available() or torch.cuda.device_count() <= 0:
            return None, None
        free, total = torch.cuda.mem_get_info()
        return int(free), int(total)
    except Exception:  # noqa: BLE001
        return None, None


def _windows_memory_status() -> dict[str, Any] | None:
    if os.name != "nt":
        return None
    try:
        from ctypes import wintypes

        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD),
                ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", wintypes.ULARGE_INTEGER),
                ("ullAvailPhys", wintypes.ULARGE_INTEGER),
                ("ullTotalPageFile", wintypes.ULARGE_INTEGER),
                ("ullAvailPageFile", wintypes.ULARGE_INTEGER),
                ("ullTotalVirtual", wintypes.ULARGE_INTEGER),
                ("ullAvailVirtual", wintypes.ULARGE_INTEGER),
                ("ullAvailExtendedVirtual", wintypes.ULARGE_INTEGER),
            ]

        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(status)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        total = int(status.ullTotalPhys)
        avail = int(status.ullAvailPhys)
        used = max(0, total - avail)
        percent = round((used / total) * 100.0, 1) if total > 0 else None
        return {
            "total_bytes": total,
            "available_bytes": avail,
            "used_bytes": used,
            "percent": percent,
            "commit_avail_bytes": int(status.ullAvailPageFile),
            "source": "windows-globalmemorystatus",
        }
    except Exception:  # noqa: BLE001
        return None


def _parse_proc_meminfo(text: str) -> dict[str, Any] | None:
    values_kb: dict[str, int] = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_()]+):\s+(\d+)", line.strip())
        if m:
            values_kb[m.group(1)] = int(m.group(2))
    total_kb = values_kb.get("MemTotal")
    if not total_kb:
        return None
    avail_kb = values_kb.get("MemAvailable")
    if avail_kb is None:
        if "MemFree" not in values_kb:
            return None
        avail_kb = (
            values_kb.get("MemFree", 0)
            + values_kb.get("Buffers", 0)
            + values_kb.get("Cached", 0)
            + values_kb.get("SReclaimable", 0)
        )
    total = total_kb * 1024
    avail = min(total, max(0, avail_kb * 1024))
    used = max(0, total - avail)
    percent = round((used / total) * 100.0, 1) if total > 0 else None
    commit_avail = None
    if "CommitLimit" in values_kb and "Committed_AS" in values_kb:
        commit_avail = max(0, (values_kb["CommitLimit"] - values_kb["Committed_AS"]) * 1024)
    return {
        "total_bytes": total,
        "available_bytes": avail,
        "used_bytes": used,
        "percent": percent,
        "commit_avail_bytes": commit_avail,
        "source": "linux-procfs",
    }


def _linux_memory_status() -> dict[str, Any] | None:
    try:
        text = Path("/proc/meminfo").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return _parse_proc_meminfo(text)


def _parse_vm_stat(vm_stat_text: str, total_bytes: int | None, page_size_hint: int | None = None) -> dict[str, Any] | None:
    page_size = page_size_hint
    m_page = re.search(r"page size of (\d+) bytes", vm_stat_text)
    if m_page:
        page_size = int(m_page.group(1))
    if not page_size or page_size <= 0:
        return None

    pages: dict[str, int] = {}
    for line in vm_stat_text.splitlines():
        m = re.match(r'^"?([^":]+)"?:\s+(\d+)\.?$', line.strip())
        if m:
            pages[m.group(1).strip()] = int(m.group(2))

    if "Pages free" not in pages and "Pages inactive" not in pages:
        return None

    avail_pages = (
        pages.get("Pages free", 0)
        + pages.get("Pages inactive", 0)
        + pages.get("Pages speculative", 0)
    )
    avail = max(0, avail_pages * page_size)
    if total_bytes is None:
        return None
    avail = min(total_bytes, avail)
    used = max(0, total_bytes - avail)
    percent = round((used / total_bytes) * 100.0, 1) if total_bytes > 0 else None
    return {
        "total_bytes": total_bytes,
        "available_bytes": avail,
        "used_bytes": used,
        "percent": percent,
        "commit_avail_bytes": None,
        "source": "darwin-vm_stat",
    }


def _darwin_memory_status() -> dict[str, Any] | None:
    total_bytes: int | None = None
    page_size: int | None = None
    try:
        res = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip().isdigit():
            total_bytes = int(res.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass

    if total_bytes is None and hasattr(os, "sysconf"):
        try:
            psize = int(os.sysconf("SC_PAGE_SIZE"))
            pcount = int(os.sysconf("SC_PHYS_PAGES"))
            if psize > 0 and pcount > 0:
                total_bytes = psize * pcount
                page_size = psize
        except (OSError, ValueError):
            pass

    if page_size is None and hasattr(os, "sysconf"):
        try:
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError):
            page_size = None

    try:
        vm_res = subprocess.run(
            ["vm_stat"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if vm_res.returncode == 0:
            parsed = _parse_vm_stat(vm_res.stdout, total_bytes, page_size)
            if parsed is not None:
                return parsed
    except (OSError, subprocess.SubprocessError):
        pass

    if total_bytes is not None:
        return {
            "total_bytes": total_bytes,
            "available_bytes": None,
            "used_bytes": None,
            "percent": None,
            "commit_avail_bytes": None,
            "source": "darwin-sysctl",
        }
    return None


def _psutil_memory_status() -> dict[str, Any] | None:
    try:
        import psutil
    except ImportError:
        return None
    try:
        vm = psutil.virtual_memory()
        total = int(vm.total)
        avail = int(vm.available)
        used = max(0, total - avail)
        commit_avail = None
        if os.name == "nt":
            win = _windows_memory_status()
            if win is not None:
                commit_avail = win.get("commit_avail_bytes")
        elif sys.platform.startswith("linux"):
            lin = _linux_memory_status()
            if lin is not None:
                commit_avail = lin.get("commit_avail_bytes")
        return {
            "total_bytes": total,
            "available_bytes": avail,
            "used_bytes": used,
            "percent": round(float(vm.percent), 1),
            "commit_avail_bytes": commit_avail,
            "source": "psutil",
        }
    except Exception:  # noqa: BLE001
        return None


def host_memory_status() -> dict[str, Any]:
    """Return host RAM and optional CUDA memory status using psutil or stdlib OS fallbacks."""
    info = _psutil_memory_status()
    if info is None:
        if os.name == "nt":
            info = _windows_memory_status()
        elif sys.platform == "darwin":
            info = _darwin_memory_status()
        elif sys.platform.startswith("linux"):
            info = _linux_memory_status()

    if info is None:
        info = {
            "total_bytes": None,
            "available_bytes": None,
            "used_bytes": None,
            "percent": None,
            "commit_avail_bytes": None,
            "source": "unavailable",
        }

    cuda_free, cuda_total = _cuda_memory_status()
    info["cuda_free_bytes"] = cuda_free
    info["cuda_total_bytes"] = cuda_total
    return info


def _fmt_gib(num_bytes: int | None) -> str:
    if num_bytes is None:
        return "unknown"
    return f"{num_bytes / (1024 ** 3):.2f} GiB"


def check_memory_admission(
    need_bytes: int,
    label: str = "model",
    margin_bytes: int = 512 * 1024 * 1024,
    *,
    memory_status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Check whether available host memory accommodates `need_bytes + margin_bytes`."""
    need = max(0, int(need_bytes))
    margin = max(0, int(margin_bytes))
    label_str = str(label or "model")
    status = memory_status if memory_status is not None else host_memory_status()
    avail = status.get("available_bytes")
    total = status.get("total_bytes")

    if avail is None or need <= 0:
        return {
            "ok": True,
            "available_bytes": avail,
            "total_bytes": total,
            "need_bytes": need,
            "margin_bytes": margin,
            "warning": "",
            "recommendation": "",
        }

    required = need + margin
    if int(avail) < required:
        warning = (
            f"Low memory for {label_str}: need ~{_fmt_gib(need)} + {_fmt_gib(margin)} margin "
            f"({_fmt_gib(required)} total), but only {_fmt_gib(int(avail))} is available."
        )
        recommendation = (
            "Close memory-heavy applications, unload idle local models, or switch to a smaller/cloud model."
        )
        return {
            "ok": False,
            "available_bytes": int(avail),
            "total_bytes": total,
            "need_bytes": need,
            "margin_bytes": margin,
            "warning": warning,
            "recommendation": recommendation,
        }

    return {
        "ok": True,
        "available_bytes": int(avail),
        "total_bytes": total,
        "need_bytes": need,
        "margin_bytes": margin,
        "warning": "",
        "recommendation": "",
    }


def _is_sensitive_key(key: Any) -> bool:
    lower = str(key).lower()
    return any(part in lower for part in _SENSITIVE_KEY_PARTS)


def redact_sensitive(obj: Any) -> Any:
    """Recursively redact values whose dict key contains sensitive credential tokens."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            key_str = str(k)
            if _is_sensitive_key(key_str):
                out[key_str] = "[REDACTED]"
            else:
                out[key_str] = redact_sensitive(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [redact_sensitive(item) for item in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    if isinstance(obj, Path):
        return str(obj)
    return str(obj)


def _disk_status(target_dir: Path) -> dict[str, int] | None:
    probe = target_dir
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(str(probe))
        return {
            "total_bytes": int(usage.total),
            "used_bytes": int(usage.used),
            "free_bytes": int(usage.free),
        }
    except OSError:
        return None


def _torch_summary() -> dict[str, Any]:
    try:
        import torch

        mps_avail = False
        if hasattr(torch.backends, "mps"):
            try:
                mps_avail = bool(torch.backends.mps.is_available())
            except Exception:  # noqa: BLE001
                mps_avail = False
        return {
            "available": True,
            "version": getattr(torch, "__version__", ""),
            "cuda_available": bool(torch.cuda.is_available()),
            "cuda_version": getattr(torch.version, "cuda", None),
            "mps_available": mps_avail,
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": str(exc)}


def collect_diagnostics(
    state_snapshot: dict[str, Any] | None = None,
    *,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    """Collect sanitized runtime diagnostics without reading meetings, audio, or settings."""
    root = _resolve_data_dir(data_dir)
    logs_dir = root / "logs"
    log_files: dict[str, dict[str, Any]] = {}
    for name in ("app.log", "local-llm.log"):
        p = logs_dir / name
        if p.is_file():
            try:
                log_files[name] = {"exists": True, "size_bytes": int(p.stat().st_size)}
            except OSError:
                log_files[name] = {"exists": True, "size_bytes": None}
        else:
            log_files[name] = {"exists": False, "size_bytes": 0}

    return {
        "schema": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "platform": platform.platform(),
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
        "executable": sys.executable,
        "pid": os.getpid(),
        "memory": host_memory_status(),
        "disk": _disk_status(root),
        "torch": _torch_summary(),
        "ffmpeg_available": shutil.which("ffmpeg") is not None,
        "logs": log_files,
        "state_snapshot": redact_sensitive(state_snapshot) if state_snapshot is not None else {},
    }


def _read_tail_bytes(path: Path, max_bytes: int) -> bytes:
    limit = max(0, int(max_bytes))
    if limit == 0:
        return b""
    size = path.stat().st_size
    with path.open("rb") as f:
        if size > limit:
            f.seek(size - limit)
        data = f.read()
    # Skip leading UTF-8 continuation bytes when slicing in the middle of a multibyte char.
    idx = 0
    while idx < min(3, len(data)) and (data[idx] & 0xC0) == 0x80:
        idx += 1
    return data[idx:]


def export_diagnostics_zip(
    data_dir: Path | None = None,
    state_snapshot: dict[str, Any] | None = None,
    max_log_bytes: int = 128 * 1024,
) -> bytes:
    """Build an in-memory sanitized support.zip excluding meetings, audio, notes, and settings."""
    root = _resolve_data_dir(data_dir)
    diag = collect_diagnostics(state_snapshot=state_snapshot, data_dir=root)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "diagnostics.json",
            json.dumps(diag, ensure_ascii=False, indent=2, default=str),
        )
        for name in ("app.log", "local-llm.log"):
            log_path = root / "logs" / name
            if log_path.is_file():
                try:
                    zf.writestr(f"logs/{name}", _read_tail_bytes(log_path, max_log_bytes))
                except OSError:
                    pass
    return buf.getvalue()
