"""Resumable multi-source model manager, metadata-only readiness checker, and custom root scanner."""
from __future__ import annotations

import concurrent.futures
from datetime import datetime
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid

import store

_SSL_CONTEXT = ssl.create_default_context()
_RANGE_RE = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", re.IGNORECASE)
_TOTAL_RANGE_RE = re.compile(r"bytes\s+\*/(\d+)", re.IGNORECASE)

_WEIGHT_EXTS = (".safetensors", ".bin", ".pt", ".pth", ".onnx", ".pb", ".gguf")
_META_FILENAMES = (
    "config.json",
    "configuration.json",
    "config.yaml",
    "hyperparams.yaml",
    "model.yaml",
    "am.mvn",
    "tokenizer.json",
    "preprocessor_config.json",
)
_SKIP_SCAN_DIRS = frozenset({".git", ".cache", "node_modules", "__pycache__", ".venv", "venv"})

MODEL_CATALOG: dict[str, dict] = {
    "fun-asr-nano": {
        "id": "fun-asr-nano",
        "label": "Fun-ASR-Nano-2512",
        "role": "asr",
        "repo": "FunAudioLLM/Fun-ASR-Nano-2512",
        "ms_repo": "FunAudioLLM/Fun-ASR-Nano-2512",
        "hf_repo": "FunAudioLLM/Fun-ASR-Nano-2512",
        "aliases": ("Fun-ASR-Nano-2512",),
        "sources": ("modelscope", "huggingface"),
        "files": [],
    },
    "paraformer-zh": {
        "id": "paraformer-zh",
        "label": "Paraformer-zh",
        "role": "asr",
        "repo": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "ms_repo": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "hf_repo": "funasr/paraformer-zh",
        "aliases": (
            "paraformer-zh",
            "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        ),
        "sources": ("modelscope", "huggingface"),
        "files": [],
    },
    "fsmn-vad": {
        "id": "fsmn-vad",
        "label": "FSMN-VAD",
        "role": "vad",
        "repo": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "ms_repo": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "hf_repo": "",
        "aliases": (
            "fsmn-vad",
            "damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        ),
        "sources": ("modelscope",),
        "files": [],
    },
    "ct-punc": {
        "id": "ct-punc",
        "label": "CT-Punc",
        "role": "punc",
        "repo": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
        "ms_repo": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
        "hf_repo": "",
        "aliases": (
            "ct-punc",
            "damo/punc_ct-transformer_cn-en-common-vocab471067-large",
        ),
        "sources": ("modelscope",),
        "files": [],
    },
    "cam++": {
        "id": "cam++",
        "label": "CAM++",
        "role": "diarization",
        "repo": "iic/speech_campplus_sv_zh-cn_16k-common",
        "ms_repo": "iic/speech_campplus_sv_zh-cn_16k-common",
        "hf_repo": "",
        "aliases": (
            "cam++",
            "damo/speech_campplus_sv_zh-cn_16k-common",
        ),
        "sources": ("modelscope",),
        "files": [],
    },
    "pyannote-community-1": {
        "id": "pyannote-community-1",
        "label": "pyannote community-1",
        "role": "diarization",
        "repo": "pyannote/speaker-diarization-community-1",
        "ms_repo": "pyannote/speaker-diarization-community-1",
        "hf_repo": "pyannote/speaker-diarization-community-1",
        "aliases": ("speaker-diarization-community-1",),
        "sources": ("modelscope", "huggingface"),
        "files": [],
    },
    "nemotron-3-diarization": {
        "id": "nemotron-3-diarization",
        "label": "Nemotron 3 Diarization",
        "role": "diarization",
        "repo": "nvidia/Nemotron-3-Diarization",
        "ms_repo": "nvidia/Nemotron-3-Diarization",
        "hf_repo": "nvidia/Nemotron-3-Diarization",
        "aliases": ("Nemotron-3-Diarization",),
        "sources": ("huggingface", "modelscope"),
        "files": [],
    },
}

_ROOTS_LOCK = threading.RLock()


class DownloadCancelled(RuntimeError):
    """Raised when a resumable download is explicitly cancelled."""


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _data_dir() -> Path:
    return Path(store.DATA)


def _roots_path() -> Path:
    return _data_dir() / "model_roots.json"


def _task_path() -> Path:
    return _data_dir() / "model-task.json"


def _models_store_dir() -> Path:
    return _data_dir() / "models"


def _resolve_spec(model_id: str) -> dict | None:
    if not isinstance(model_id, str):
        return None
    if model_id in MODEL_CATALOG:
        return MODEL_CATALOG[model_id]
    low = model_id.strip().lower()
    for spec in MODEL_CATALOG.values():
        candidates = (spec["id"], spec["repo"], spec.get("ms_repo", ""), spec.get("hf_repo", ""), *spec.get("aliases", ()))
        if any(c and c.lower() == low for c in candidates):
            return spec
    return None


def _model_repo_names(spec: dict) -> list[str]:
    out: list[str] = []
    for cand in (spec.get("repo"), spec.get("ms_repo"), spec.get("hf_repo"), *spec.get("aliases", ()), spec["id"]):
        if cand and cand not in out:
            out.append(cand)
    return out


def _modelscope_cache_dirs() -> list[Path]:
    dirs: list[Path] = []
    env_ms = os.environ.get("MODELSCOPE_CACHE")
    if env_ms:
        dirs.append(Path(env_ms).expanduser())
    default_ms = Path.home() / ".cache" / "modelscope"
    if default_ms not in dirs:
        dirs.append(default_ms)
    return dirs


def _hf_hub_cache_dirs() -> list[Path]:
    dirs: list[Path] = []
    env_hub = os.environ.get("HF_HUB_CACHE")
    if env_hub:
        dirs.append(Path(env_hub).expanduser())
    env_home = os.environ.get("HF_HOME")
    if env_home:
        home_p = Path(env_home).expanduser()
        if (home_p / "hub") not in dirs:
            dirs.append(home_p / "hub")
        if home_p not in dirs:
            dirs.append(home_p)
    default_hf = Path.home() / ".cache" / "huggingface" / "hub"
    if default_hf not in dirs:
        dirs.append(default_hf)
    return dirs


def _is_valid_model_dir(path: Path) -> bool:
    """Metadata-only readiness check: checks non-empty metadata/weight files without reading payloads."""
    try:
        if not path.is_dir():
            return False
    except OSError:
        return False

    has_meta = False
    has_weight = False
    stack: list[tuple[Path, int]] = [(path, 0)]
    seen = 0
    while stack and seen < 1000:
        cur, depth = stack.pop()
        try:
            with os.scandir(cur) as it:
                for entry in it:
                    seen += 1
                    name = entry.name
                    if name.endswith(".partial") or name.endswith(".incomplete"):
                        return False
                    if entry.is_dir(follow_symlinks=False):
                        if depth < 2 and name not in _SKIP_SCAN_DIRS:
                            stack.append((Path(entry.path), depth + 1))
                        continue
                    try:
                        # Follow file symlinks inside HF snapshot directories, but never read contents.
                        if not entry.is_file(follow_symlinks=True):
                            continue
                        size = entry.stat(follow_symlinks=True).st_size
                    except OSError:
                        continue
                    if size <= 0:
                        continue
                    low = name.lower()
                    if low in _META_FILENAMES:
                        has_meta = True
                    if low.endswith(_WEIGHT_EXTS):
                        has_weight = True
        except OSError:
            continue
    return has_weight or has_meta


def _find_in_hf_hub(hub_dir: Path, repos: list[str]) -> Path | None:
    try:
        if not hub_dir.is_dir():
            return None
    except OSError:
        return None
    for repo in repos:
        if "/" not in repo:
            continue
        repo_dir = hub_dir / ("models--" + repo.replace("/", "--"))
        snapshots = repo_dir / "snapshots"
        try:
            if not snapshots.is_dir():
                continue
        except OSError:
            continue
        # Prefer refs/main if present
        ref_main = repo_dir / "refs" / "main"
        candidates: list[Path] = []
        try:
            if ref_main.is_file():
                rev = ref_main.read_text(encoding="utf-8", errors="ignore").strip()
                if rev and "/" not in rev and "\\" not in rev and ".." not in rev:
                    candidates.append(snapshots / rev)
        except OSError:
            pass
        try:
            with os.scandir(snapshots) as it:
                for entry in sorted(it, key=lambda e: e.name, reverse=True):
                    if entry.is_dir(follow_symlinks=False):
                        p = Path(entry.path)
                        if p not in candidates:
                            candidates.append(p)
        except OSError:
            pass
        for cand in candidates:
            if _is_valid_model_dir(cand):
                return cand
    return None


def _find_in_ms_cache(ms_dir: Path, repos: list[str]) -> Path | None:
    try:
        if not ms_dir.is_dir():
            return None
    except OSError:
        return None
    for base in (ms_dir / "hub" / "models", ms_dir / "hub", ms_dir):
        for repo in repos:
            cand = base / repo
            if _is_valid_model_dir(cand):
                return cand
            # Some ModelScope versions replace '.' with '___' in directory names
            if "." in repo:
                cand_alt = base / repo.replace(".", "___")
                if _is_valid_model_dir(cand_alt):
                    return cand_alt
    return None


def _find_in_custom_root(root: Path, spec: dict, repos: list[str]) -> Path | None:
    try:
        if not root.is_dir():
            return None
    except OSError:
        return None
    direct_candidates: list[Path] = []
    for repo in repos:
        direct_candidates.append(root / repo)
        if "/" in repo:
            direct_candidates.append(root / repo.split("/")[-1])
    direct_candidates.append(root / spec["id"])
    if root.name in {spec["id"], *(r.split("/")[-1] for r in repos)}:
        direct_candidates.append(root)
    for cand in direct_candidates:
        if _is_valid_model_dir(cand):
            return cand
    hf_hit = _find_in_hf_hub(root, repos)
    if hf_hit is not None:
        return hf_hit
    return _find_in_ms_cache(root, repos)


def list_roots() -> list[str]:
    """Return configured custom model root directories from store.DATA/model_roots.json."""
    with _ROOTS_LOCK:
        raw = store.read_json(_roots_path(), [])
        if not isinstance(raw, list):
            return []
        seen: set[str] = set()
        out: list[str] = []
        for item in raw:
            if isinstance(item, str) and item.strip():
                norm = item.strip()
                if norm not in seen:
                    seen.add(norm)
                    out.append(norm)
        return out


def add_root(path: str | Path) -> list[str]:
    """Validate and persist a custom model root directory."""
    if not path or not isinstance(path, (str, Path)):
        raise ValueError("Invalid root path")
    p = Path(path).expanduser().resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError(f"Root directory does not exist: {p}")
    norm = str(p)
    with _ROOTS_LOCK:
        roots = list_roots()
        if norm not in roots:
            roots.append(norm)
            rp = _roots_path()
            rp.parent.mkdir(parents=True, exist_ok=True)
            store.write_json(rp, roots)
        return roots


def remove_root(path: str | Path) -> list[str]:
    """Remove a custom model root directory from model_roots.json."""
    raw_str = str(path).strip()
    try:
        resolved_str = str(Path(path).expanduser().resolve())
    except OSError:
        resolved_str = raw_str
    with _ROOTS_LOCK:
        roots = [r for r in list_roots() if r not in (raw_str, resolved_str)]
        rp = _roots_path()
        rp.parent.mkdir(parents=True, exist_ok=True)
        store.write_json(rp, roots)
        return roots


def _match_catalog_dir(dir_path: Path, root: Path) -> str | None:
    try:
        rel = dir_path.relative_to(root).as_posix()
    except ValueError:
        rel = dir_path.name
    name = dir_path.name
    for spec in MODEL_CATALOG.values():
        repos = _model_repo_names(spec)
        for repo in repos:
            if rel == repo or rel.endswith("/" + repo) or name == repo.split("/")[-1]:
                return spec["id"]
            if "/" in repo and name == ("models--" + repo.replace("/", "--")):
                return spec["id"]
    return None


def scan_custom_roots(
    max_depth: int = 5,
    max_entries: int = 20000,
    roots: list[str | Path] | None = None,
) -> dict:
    """Bounded traversal of custom roots discovering ASR/diarization dirs and .gguf files.

    Skips symlinks and `.git`/`.cache`/`node_modules` directories. Zero network calls or payload reads.
    """
    root_strs = [str(r) for r in roots] if roots is not None else list_roots()
    discovered_models: list[dict] = []
    discovered_gguf: list[dict] = []
    seen_model_paths: set[str] = set()
    entries_scanned = 0
    truncated = False

    for root_s in root_strs:
        root_p = Path(root_s).expanduser()
        try:
            if not root_p.exists() or root_p.is_symlink() or not root_p.is_dir():
                continue
        except OSError:
            continue

        stack: list[tuple[Path, int]] = [(root_p, 0)]
        while stack:
            if entries_scanned >= max_entries:
                truncated = True
                break
            cur, depth = stack.pop()
            child_dirs: list[Path] = []
            has_meta = False
            has_weight = False
            try:
                with os.scandir(cur) as it:
                    for entry in it:
                        entries_scanned += 1
                        if entries_scanned > max_entries:
                            truncated = True
                            break
                        if entry.is_symlink():
                            continue
                        ename = entry.name
                        if entry.is_dir(follow_symlinks=False):
                            if ename in _SKIP_SCAN_DIRS:
                                continue
                            if depth < max_depth:
                                child_dirs.append(Path(entry.path))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        if st.st_size <= 0:
                            continue
                        low = ename.lower()
                        if low.endswith(".gguf"):
                            discovered_gguf.append({
                                "name": ename,
                                "path": str(entry.path),
                                "size": st.st_size,
                                "root": str(root_p),
                            })
                        if low in _META_FILENAMES:
                            has_meta = True
                        if low.endswith(_WEIGHT_EXTS) and not low.endswith(".gguf"):
                            has_weight = True
            except OSError:
                continue

            if cur != root_p and (has_weight or has_meta):
                matched_id = _match_catalog_dir(cur, root_p)
                cur_s = str(cur)
                if cur_s not in seen_model_paths and (matched_id is not None or (has_meta and has_weight)):
                    seen_model_paths.add(cur_s)
                    discovered_models.append({
                        "model_id": matched_id,
                        "name": cur.name,
                        "path": cur_s,
                        "root": str(root_p),
                    })

            if not truncated and depth < max_depth:
                for cd in reversed(child_dirs):
                    stack.append((cd, depth + 1))
        if truncated:
            break

    return {
        "roots": root_strs,
        "models": discovered_models,
        "gguf": discovered_gguf,
        "entries_scanned": entries_scanned,
        "truncated": truncated,
    }


def find_local_model_dir(model_id: str) -> Path | None:
    """Locate a locally cached/ready model directory without network calls or payload reads."""
    spec = _resolve_spec(model_id)
    if spec is None:
        return None
    repos = _model_repo_names(spec)

    # 1. Explicit downloaded target inside store.DATA/models/<id>
    managed_dir = _models_store_dir() / spec["id"]
    if _is_valid_model_dir(managed_dir):
        return managed_dir

    # 2. User-configured custom roots
    for root_s in list_roots():
        hit = _find_in_custom_root(Path(root_s).expanduser(), spec, repos)
        if hit is not None:
            return hit

    # 3. ModelScope caches
    for ms_dir in _modelscope_cache_dirs():
        hit = _find_in_ms_cache(ms_dir, repos)
        if hit is not None:
            return hit

    # 4. HuggingFace caches
    for hf_dir in _hf_hub_cache_dirs():
        hit = _find_in_hf_hub(hf_dir, repos)
        if hit is not None:
            return hit

    return None


def is_model_ready(model_id: str) -> bool:
    """Return True if `model_id` is locally cached/ready (zero network, zero payload reads)."""
    return find_local_model_dir(model_id) is not None


def get_models_status() -> dict:
    """Return metadata-only readiness status for all catalog models, custom roots, and GGUF files."""
    models: list[dict] = []
    by_id: dict[str, dict] = {}
    for mid, spec in MODEL_CATALOG.items():
        local_dir = find_local_model_dir(mid)
        entry = {
            "id": mid,
            "label": spec["label"],
            "role": spec["role"],
            "repo": spec["repo"],
            "sources": list(spec["sources"]),
            "ready": local_dir is not None,
            "path": str(local_dir) if local_dir is not None else None,
        }
        models.append(entry)
        by_id[mid] = entry

    roots = list_roots()
    scan = scan_custom_roots(roots=roots) if roots else {"models": [], "gguf": [], "entries_scanned": 0, "truncated": False}
    return {
        "models": models,
        "by_id": by_id,
        "roots": roots,
        "gguf": scan["gguf"],
        "custom_models": scan["models"],
        "task": default_manager().get_task(),
    }


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


class ModelDownloadManager:
    """Coordinates speed-raced source selection, resumable downloads, and persistent task tracking."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._worker_thread: threading.Thread | None = None
        self._cancel_event: threading.Event | None = None
        self._active_task: dict | None = None
        self._active_data_dir: Path | None = None
        self._recover_interrupted_task()

    def _recover_interrupted_task(self) -> dict | None:
        tp = _task_path()
        raw = store.read_json(tp)
        if not isinstance(raw, dict):
            return None
        if raw.get("status") in ("queued", "running"):
            raw = dict(raw)
            raw["status"] = "interrupted"
            raw["error"] = raw.get("error") or "interrupted by restart"
            raw["updated_at"] = _now_iso()
            tp.parent.mkdir(parents=True, exist_ok=True)
            store.write_json(tp, raw)
        return raw

    def _save_task_locked(self, task: dict) -> None:
        self._active_task = dict(task)
        self._active_data_dir = _data_dir()
        tp = _task_path()
        tp.parent.mkdir(parents=True, exist_ok=True)
        store.write_json(tp, self._active_task)

    def get_task(self) -> dict | None:
        """Return current or persisted download task, recovering stale in-progress tasks as `interrupted`."""
        with self._lock:
            cur_dir = _data_dir()
            worker_alive = self._worker_thread is not None and self._worker_thread.is_alive()
            if worker_alive and self._active_task is not None and self._active_data_dir == cur_dir:
                return dict(self._active_task)
            if self._active_task is not None and self._active_data_dir == cur_dir and not worker_alive:
                # Ensure stale in-memory state isn't hiding disk state
                recovered = self._recover_interrupted_task()
                self._active_task = recovered
                return dict(recovered) if recovered is not None else None
            recovered = self._recover_interrupted_task()
            if recovered is not None:
                self._active_task = recovered
                self._active_data_dir = cur_dir
                return dict(recovered)
            return None

    def _open_request(self, url: str, headers: dict[str, str] | None = None, *, method: str = "GET", timeout: float = 30.0):
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "MeetingNotes-ModelManager/1.0", **(headers or {})},
            method=method,
        )
        return urllib.request.urlopen(req, timeout=timeout, context=_SSL_CONTEXT)

    def select_source(self, urls: dict[str, str], timeout: float = 5.0) -> str:
        """Race mirror URLs using HTTP Range/HEAD probes and return the fastest reachable source key."""
        if not isinstance(urls, dict) or not urls:
            raise ValueError("urls must be a non-empty mapping of source -> url")

        def _probe_one(name: str, url: str) -> tuple[str, float, float]:
            t0 = time.monotonic()
            try:
                with self._open_request(url, headers={"Range": "bytes=0-65535"}, method="GET", timeout=timeout) as resp:
                    status = getattr(resp, "status", 200)
                    if status >= 400:
                        raise RuntimeError(f"HTTP {status}")
                    data = resp.read(65536)
                    elapsed = max(time.monotonic() - t0, 1e-6)
                    speed = len(data) / elapsed if data else 1.0 / elapsed
                    return (name, elapsed, speed)
            except urllib.error.HTTPError as e:
                if e.code in (405, 501):
                    t1 = time.monotonic()
                    with self._open_request(url, method="HEAD", timeout=timeout) as resp:
                        status = getattr(resp, "status", 200)
                        if status >= 400:
                            raise RuntimeError(f"HTTP {status}")
                        elapsed = max(time.monotonic() - t1, 1e-6)
                        return (name, elapsed, 1.0 / elapsed)
                raise

        errors: list[str] = []
        results: list[tuple[str, float, float]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(urls))) as pool:
            futs = {pool.submit(_probe_one, name, url): name for name, url in urls.items()}
            for fut in concurrent.futures.as_completed(futs):
                src = futs[fut]
                try:
                    results.append(fut.result())
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{src}: {type(e).__name__}: {e}")

        if not results:
            raise RuntimeError("All download sources failed: " + "; ".join(errors))
        # Prefer fastest response (highest probe throughput, breaking ties by lowest latency)
        best = max(results, key=lambda item: (item[2], -item[1]))
        return best[0]

    def _check_disk_space(self, directory: Path, required_bytes: int) -> None:
        if required_bytes <= 0:
            return
        usage = shutil.disk_usage(directory)
        if usage.free < required_bytes:
            raise OSError(
                errno.ENOSPC,
                f"Insufficient disk space in {directory}: need {required_bytes} bytes, {usage.free} bytes free",
            )

    def download_file_resumable(
        self,
        url: str,
        dst: Path | str,
        expected_sha256: str | None = None,
        cancel_event: threading.Event | None = None,
        on_progress=None,
        *,
        timeout: float = 30.0,
        chunk_size: int = 65536,
    ) -> Path:
        """Download `url` to `dst` with `.partial` + `.download-state.json` Range resume, disk check, and SHA256 verify."""
        dst_path = Path(dst)
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        part_path = dst_path.with_name(dst_path.name + ".partial")
        state_path = dst_path.with_name(dst_path.name + ".download-state.json")

        if expected_sha256 is not None:
            expected_sha256 = expected_sha256.strip().lower()

        if dst_path.exists() and dst_path.is_file() and expected_sha256:
            if _sha256_file(dst_path) == expected_sha256:
                size = dst_path.stat().st_size
                if on_progress is not None:
                    on_progress({"done_bytes": size, "total_bytes": size, "url": url, "dst": str(dst_path)})
                return dst_path

        def _check_cancel() -> None:
            if cancel_event is not None and cancel_event.is_set():
                raise DownloadCancelled("Download cancelled; partial state preserved")

        _check_cancel()

        saved_state = store.read_json(state_path)
        resume_from = 0
        saved_etag = None
        total_bytes: int | None = None
        if isinstance(saved_state, dict) and saved_state.get("url") == url and part_path.exists():
            resume_from = part_path.stat().st_size
            saved_etag = saved_state.get("etag")
            if isinstance(saved_state.get("total_bytes"), int) and saved_state["total_bytes"] > 0:
                total_bytes = saved_state["total_bytes"]
        elif part_path.exists():
            # Orphaned or mismatched .partial without matching state cannot be trusted
            part_path.unlink(missing_ok=True)

        def _save_state(done: int, total: int | None, etag: str | None) -> None:
            store.write_json(
                state_path,
                {
                    "url": url,
                    "dst": str(dst_path),
                    "downloaded_bytes": int(done),
                    "total_bytes": total,
                    "expected_sha256": expected_sha256,
                    "etag": etag,
                    "updated_at": _now_iso(),
                },
            )

        headers: dict[str, str] = {}
        if resume_from > 0:
            headers["Range"] = f"bytes={resume_from}-"

        already_complete = False
        resp = None
        try:
            resp = self._open_request(url, headers=headers, method="GET", timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 416 and resume_from > 0:
                cr = e.headers.get("Content-Range", "") if e.headers else ""
                m_tot = _TOTAL_RANGE_RE.search(cr)
                if m_tot and int(m_tot.group(1)) == resume_from:
                    total_bytes = resume_from
                    already_complete = True
                else:
                    part_path.unlink(missing_ok=True)
                    state_path.unlink(missing_ok=True)
                    resume_from = 0
                    resp = self._open_request(url, headers={}, method="GET", timeout=timeout)
            else:
                raise

        if not already_complete:
            assert resp is not None
            with resp:
                status = getattr(resp, "status", 200)
                resp_headers = getattr(resp, "headers", {}) or {}
                etag = resp_headers.get("ETag") or saved_etag
                if status == 206:
                    cr = resp_headers.get("Content-Range", "")
                    m_cr = _RANGE_RE.search(cr)
                    if m_cr:
                        start = int(m_cr.group(1))
                        tot_tok = m_cr.group(3)
                        if start != resume_from:
                            resume_from = 0
                        if tot_tok != "*":
                            total_bytes = int(tot_tok)
                    if total_bytes is None:
                        cl = resp_headers.get("Content-Length")
                        if cl and cl.isdigit():
                            total_bytes = resume_from + int(cl)
                    mode = "ab" if resume_from > 0 else "wb"
                else:
                    resume_from = 0
                    cl = resp_headers.get("Content-Length")
                    total_bytes = int(cl) if (cl and cl.isdigit()) else None
                    mode = "wb"

                remaining_needed = max(0, (total_bytes - resume_from)) if total_bytes is not None else 0
                self._check_disk_space(dst_path.parent, remaining_needed)

                done = resume_from
                _save_state(done, total_bytes, etag)
                with part_path.open(mode) as fh:
                    while True:
                        _check_cancel()
                        buf = resp.read(chunk_size)
                        if not buf:
                            break
                        fh.write(buf)
                        done += len(buf)
                        fh.flush()
                        _save_state(done, total_bytes, etag)
                        if on_progress is not None:
                            on_progress({
                                "done_bytes": done,
                                "total_bytes": total_bytes or 0,
                                "url": url,
                                "dst": str(dst_path),
                            })

                if total_bytes is not None and done != total_bytes:
                    raise RuntimeError(f"Incomplete download for {dst_path.name}: {done}/{total_bytes} bytes")

        if expected_sha256:
            actual = _sha256_file(part_path)
            if actual != expected_sha256:
                part_path.unlink(missing_ok=True)
                state_path.unlink(missing_ok=True)
                raise ValueError(f"SHA256 mismatch for {dst_path.name}: expected {expected_sha256}, got {actual}")

        os.replace(part_path, dst_path)
        state_path.unlink(missing_ok=True)
        final_size = dst_path.stat().st_size
        if on_progress is not None:
            on_progress({"done_bytes": final_size, "total_bytes": final_size, "url": url, "dst": str(dst_path)})
        return dst_path

    def _run_download_task(
        self,
        spec: dict,
        source: str,
        files: list[dict] | None,
        dst_dir: Path,
        cancel_event: threading.Event,
    ) -> None:
        with self._lock:
            task = dict(self._active_task or {})
            task["status"] = "running"
            task["updated_at"] = _now_iso()
            self._save_task_locked(task)

        try:
            if cancel_event.is_set():
                raise DownloadCancelled("Download cancelled before start")

            file_specs = files if files is not None else list(spec.get("files") or [])
            if file_specs:
                total_all = sum(int(f.get("size") or 0) for f in file_specs)
                completed_prefix = 0
                for row in file_specs:
                    if cancel_event.is_set():
                        raise DownloadCancelled("Download cancelled")
                    urls = row.get("urls") or {}
                    if not urls and row.get("url"):
                        urls = {source if source != "auto" else "direct": row["url"]}
                    if source == "auto" and len(urls) > 1:
                        chosen = self.select_source(urls)
                    elif source != "auto" and source in urls:
                        chosen = source
                    else:
                        chosen = next(iter(urls))
                    url = urls[chosen]
                    rel_name = row["name"]
                    target = dst_dir / rel_name
                    file_size = int(row.get("size") or 0)

                    def _on_prog(ev, prefix=completed_prefix, fsz=file_size, src_name=chosen, fname=rel_name):
                        tot = total_all or int(ev.get("total_bytes") or fsz or 0)
                        done = prefix + int(ev.get("done_bytes") or 0)
                        with self._lock:
                            t = dict(self._active_task or {})
                            t["selected_source"] = src_name
                            t["current_file"] = fname
                            t["done_bytes"] = done
                            t["total_bytes"] = tot
                            t["progress"] = round(min(1.0, done / tot), 4) if tot > 0 else 0.0
                            t["updated_at"] = _now_iso()
                            self._save_task_locked(t)

                    self.download_file_resumable(
                        url,
                        target,
                        expected_sha256=row.get("sha256"),
                        cancel_event=cancel_event,
                        on_progress=_on_prog,
                    )
                    completed_prefix += target.stat().st_size
            else:
                # Repo-level download fallback via ModelScope or HuggingFace
                chosen = source
                if chosen == "auto":
                    probe_urls: dict[str, str] = {}
                    if spec.get("ms_repo"):
                        probe_urls["modelscope"] = (
                            f"https://modelscope.cn/api/v1/models/{spec['ms_repo']}/repo?Revision=master&FilePath=config.json"
                        )
                    if spec.get("hf_repo"):
                        probe_urls["huggingface"] = f"https://huggingface.co/{spec['hf_repo']}/resolve/main/config.json"
                    chosen = self.select_source(probe_urls) if len(probe_urls) > 1 else next(iter(probe_urls))

                with self._lock:
                    t = dict(self._active_task or {})
                    t["selected_source"] = chosen
                    t["updated_at"] = _now_iso()
                    self._save_task_locked(t)

                if chosen == "modelscope":
                    from modelscope import snapshot_download as ms_download
                    ms_download(spec["ms_repo"] or spec["repo"])
                else:
                    from huggingface_hub import snapshot_download as hf_download
                    hf_download(spec["hf_repo"] or spec["repo"])

            with self._lock:
                t = dict(self._active_task or {})
                t["status"] = "completed"
                t["progress"] = 1.0
                t["current_file"] = None
                t["error"] = ""
                t["updated_at"] = _now_iso()
                self._save_task_locked(t)
        except DownloadCancelled as e:
            with self._lock:
                t = dict(self._active_task or {})
                t["status"] = "cancelled"
                t["error"] = str(e)
                t["updated_at"] = _now_iso()
                self._save_task_locked(t)
        except Exception as e:  # noqa: BLE001
            with self._lock:
                t = dict(self._active_task or {})
                t["status"] = "failed"
                t["error"] = f"{type(e).__name__}: {e}"
                t["updated_at"] = _now_iso()
                self._save_task_locked(t)

    def start_download(
        self,
        model_id: str,
        source: str = "auto",
        *,
        files: list[dict] | None = None,
        dst_dir: Path | str | None = None,
    ) -> dict:
        """Start a background single-worker download for `model_id`."""
        spec = _resolve_spec(model_id)
        if spec is None:
            raise ValueError(f"Unknown model_id: {model_id!r}")
        if source not in ("auto", "modelscope", "huggingface"):
            raise ValueError(f"Unsupported download source: {source!r}")

        target_dir = Path(dst_dir) if dst_dir is not None else (_models_store_dir() / spec["id"])
        with self._lock:
            if self._worker_thread is not None and self._worker_thread.is_alive():
                raise RuntimeError("A model download is already in progress")
            cancel_event = threading.Event()
            self._cancel_event = cancel_event
            task = {
                "id": uuid.uuid4().hex[:12],
                "model_id": spec["id"],
                "repo": spec["repo"],
                "source": source,
                "selected_source": None if source == "auto" else source,
                "status": "queued",
                "done_bytes": 0,
                "total_bytes": sum(int(f.get("size") or 0) for f in (files or [])),
                "progress": 0.0,
                "current_file": None,
                "dst_dir": str(target_dir),
                "error": "",
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            }
            self._save_task_locked(task)
            t = threading.Thread(
                target=self._run_download_task,
                args=(spec, source, files, target_dir, cancel_event),
                name=f"model-download-{spec['id']}",
                daemon=True,
            )
            self._worker_thread = t
            t.start()
            return dict(task)

    def cancel_download(self) -> dict | None:
        """Signal cancellation to the active background download task."""
        with self._lock:
            if self._cancel_event is not None:
                self._cancel_event.set()
            return dict(self._active_task) if self._active_task is not None else self.get_task()

    def wait_task(self, timeout: float = 30.0) -> dict | None:
        """Wait for the active background download thread to finish (primarily for tests)."""
        with self._lock:
            t = self._worker_thread
        if t is not None:
            t.join(timeout=timeout)
        return self.get_task()


_DEFAULT_MANAGER: ModelDownloadManager | None = None
_DEFAULT_MANAGER_LOCK = threading.Lock()


def default_manager() -> ModelDownloadManager:
    """Return the process-wide ModelDownloadManager singleton."""
    global _DEFAULT_MANAGER
    with _DEFAULT_MANAGER_LOCK:
        if _DEFAULT_MANAGER is None:
            _DEFAULT_MANAGER = ModelDownloadManager()
        return _DEFAULT_MANAGER
