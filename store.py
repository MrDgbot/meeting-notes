import copy
import json
import logging
import os
import random
import re
import secrets
import shutil
import string
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Literal, NamedTuple, TypedDict

log = logging.getLogger("store")

MeetingStatus = Literal["new", "recording", "queued", "transcribing", "ready", "error"]
MeetingSource = Literal["", "mic", "upload", "ambient"]


class MeetingMeta(TypedDict, total=False):
    id: str
    title: str
    title_auto: bool
    created: str
    status: MeetingStatus
    source: MeetingSource
    duration: float
    num_spk: int
    hotword: str
    template: str
    speakers: dict[str, str]
    error: str


class _FileSig(NamedTuple):
    mtime_ns: int
    size: int
    ino: int


class _MetaCacheKey(NamedTuple):
    meetings_dir: str
    mid: str


class _MetaCacheEntry(NamedTuple):
    sig: _FileSig
    meta: dict


BASE = Path(__file__).resolve().parent


def _resolve_data_dir() -> Path:
    env_dir = os.environ.get("MEETING_DATA")
    if env_dir:
        return Path(env_dir)
    if os.environ.get("PYTEST_CURRENT_TEST") or "pytest" in sys.modules:
        raise RuntimeError(
            "Refusing to use real ./data under pytest without MEETING_DATA. "
            "Set MEETING_DATA to a temporary directory before importing store."
        )
    return BASE / "data"


DATA = _resolve_data_dir()
MEETINGS = DATA / "meetings"
MEETINGS.mkdir(parents=True, exist_ok=True)

_lock = threading.RLock()
_MID_RE = re.compile(r"[A-Za-z0-9_-]+")
_DATE_ID_RE = re.compile(r"^\d{8}-")
_meta_cache: dict[_MetaCacheKey, _MetaCacheEntry] = {}


@contextmanager
def locked():
    with _lock:
        yield


def read_json(path: Path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError, json.JSONDecodeError):
        return default


def _atomic_write(path: Path, writer, *, mode: int | None = None) -> None:
    path = Path(path)
    tmp = path.parent / f".{path.name}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(4)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    create_mode = 0o666 if mode is None else mode
    fd = os.open(str(tmp), flags, create_mode)
    try:
        if mode is not None and os.name != "nt":
            if hasattr(os, "fchmod"):
                os.fchmod(fd, mode)
            else:
                os.chmod(tmp, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd = -1
            writer(f)
            f.flush()
        for attempt in range(12):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 11:
                    raise
                time.sleep(0.005 * (attempt + 1))
    except BaseException:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def write_json(path: Path, obj, *, mode: int | None = None) -> None:
    _atomic_write(path, lambda f: json.dump(obj, f, ensure_ascii=False, indent=1), mode=mode)


def write_text(path: Path, text: str, *, mode: int | None = None) -> None:
    _atomic_write(path, lambda f: f.write(text), mode=mode)


def _stat_sig(path: Path) -> _FileSig | None:
    try:
        st = path.stat()
        return _FileSig(st.st_mtime_ns, st.st_size, st.st_ino)
    except OSError:
        return None


def _cache_key(mid: str) -> _MetaCacheKey:
    return _MetaCacheKey(str(MEETINGS), mid)


def _invalidate_meta(mid: str) -> None:
    with _lock:
        _meta_cache.pop(_cache_key(mid), None)


def _load_meta_cached(d: Path, mid: str) -> dict | None:
    mp = d / "meta.json"
    sig = _stat_sig(mp)
    if sig is None:
        _invalidate_meta(mid)
        return None
    ck = _cache_key(mid)
    with _lock:
        hit = _meta_cache.get(ck)
        if hit is not None and hit.sig == sig:
            return copy.deepcopy(hit.meta)
    m = read_json(mp)
    if not isinstance(m, dict):
        return None
    with _lock:
        if len(_meta_cache) > 4096:
            _meta_cache.clear()
        _meta_cache[ck] = _MetaCacheEntry(sig, copy.deepcopy(m))
    return m


def mdir(mid: str) -> Path:
    if not isinstance(mid, str) or not _MID_RE.fullmatch(mid):
        raise ValueError("记录标识无效")
    base = MEETINGS.resolve()
    target = MEETINGS / mid
    if target.resolve().parent != base:
        raise ValueError("记录标识无效")
    return target


def exists(mid: str) -> bool:
    try:
        return (mdir(mid) / "meta.json").exists()
    except ValueError:
        return False


def create(title: str = "", **fields) -> MeetingMeta:
    with _lock:
        now = datetime.now()
        mid = now.strftime("%Y%m%d-%H%M%S-") + "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
        d = MEETINGS / mid
        d.mkdir(parents=True)
        meta: MeetingMeta = {
            "id": mid,
            "title": title.strip() or f"会议 {now.strftime('%m-%d %H:%M')}",
            "title_auto": not title.strip(),
            "created": now.isoformat(timespec="seconds"),
            "status": "new",
            "source": "",
            "duration": 0.0,
            "num_spk": 0,
            "hotword": "",
            "template": "general",
            "speakers": {},
            "error": "",
        }
        meta.update({k: v for k, v in fields.items() if v is not None})
        mp = d / "meta.json"
        write_json(mp, meta)
        sig = _stat_sig(mp)
        if sig is not None:
            _meta_cache[_cache_key(mid)] = _MetaCacheEntry(sig, copy.deepcopy(meta))
        return meta


def get(mid: str) -> dict | None:
    return _load_meta_cached(mdir(mid), mid)


def update(mid: str, **fields) -> dict:
    with _lock:
        d = mdir(mid)
        meta = _load_meta_cached(d, mid)
        if meta is None:
            raise KeyError(mid)
        meta.update(fields)
        mp = d / "meta.json"
        write_json(mp, meta)
        sig = _stat_sig(mp)
        if sig is not None:
            _meta_cache[_cache_key(mid)] = _MetaCacheEntry(sig, copy.deepcopy(meta))
        else:
            _meta_cache.pop(_cache_key(mid), None)
        return meta


def list_all() -> list[dict]:
    out = []
    seen: set[str] = set()
    try:
        entries = list(os.scandir(MEETINGS))
    except FileNotFoundError:
        return []
    for entry in entries:
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        mid = entry.name
        seen.add(mid)
        m = _load_meta_cached(Path(entry.path), mid)
        if isinstance(m, dict):
            out.append(m)
    base_str = str(MEETINGS)
    with _lock:
        for ck in [k for k in _meta_cache if k.meetings_dir == base_str and k.mid not in seen]:
            _meta_cache.pop(ck, None)
    out.sort(key=lambda m: str(m.get("created") or ""), reverse=True)
    return out


def list_by_date(date: str) -> list[dict]:
    prefix = date.replace("-", "") + "-"
    out = []
    try:
        entries = list(os.scandir(MEETINGS))
    except FileNotFoundError:
        return []
    for entry in entries:
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        name = entry.name
        if _DATE_ID_RE.match(name) and not name.startswith(prefix):
            continue
        m = _load_meta_cached(Path(entry.path), name)
        if isinstance(m, dict) and str(m.get("created") or "")[:10] == date:
            out.append(m)
    out.sort(key=lambda m: str(m.get("created") or ""))
    return out


def _pending_delete_root() -> Path:
    return DATA / ".pending-delete"


def _rmtree_with_retry(target: Path, attempts: int = 3) -> bool:
    for attempt in range(attempts):
        try:
            shutil.rmtree(target, ignore_errors=False)
            return True
        except FileNotFoundError:
            return True
        except OSError as exc:
            if attempt == attempts - 1:
                log.debug("safe_rmtree deferred %s: %s", target, exc)
                return False
            time.sleep(0.005 * (attempt + 1))
    return False


def safe_rmtree(path: Path) -> bool:
    """Atomically stage `path` into `.pending-delete` when possible and remove with retry."""
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return True
    if path.is_symlink() or path.is_file():
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return True
        except OSError as exc:
            log.debug("safe_rmtree unlink failed for %s: %s", path, exc)
            return False

    pending = _pending_delete_root()
    target = path
    try:
        pending.mkdir(parents=True, exist_ok=True)
        staged = pending / f"{path.name}-{uuid.uuid4().hex}"
        path.rename(staged)
        target = staged
    except OSError:
        target = path
    return _rmtree_with_retry(target)


def sweep_pending_deletes() -> int:
    """Retry removing staged directories in `.pending-delete` and return count removed."""
    with _lock:
        root = _pending_delete_root()
        if not root.exists():
            return 0
        removed = 0
        for entry in list(root.iterdir()):
            if entry.is_symlink() or entry.is_file():
                try:
                    entry.unlink()
                    removed += 1
                except FileNotFoundError:
                    removed += 1
                except OSError:
                    pass
            elif entry.is_dir():
                if _rmtree_with_retry(entry):
                    removed += 1
        return removed


def delete(mid: str) -> None:
    with _lock:
        target = mdir(mid)
        _meta_cache.pop(_cache_key(mid), None)
        safe_rmtree(target)


_GENERIC_UPLOAD_RE = re.compile(
    r"^(?:"
    r"(?:img|rec|vid|aud|audio|recording|record|voice|memo|clip|sound|screen|zoom|meeting|微信语音|录音|通话录音|语音)[_\s\-]*\d*"
    r"|\d{4}[\-_]?\d{2}[\-_]?\d{2}(?:[\-_T\s]+\d{2}[\-_:]?\d{2}(?:[\-_:]?\d{2})?)?"
    r"|\d+"
    r")$",
    re.IGNORECASE,
)


def is_generic_upload_name(stem: str) -> bool:
    s = (stem or "").strip()
    if not s or len(s) <= 2:
        return True
    return bool(_GENERIC_UPLOAD_RE.fullmatch(s))


TRASH_KEEP_S = 30 * 86400


def _trash_root() -> Path:
    return DATA / "trash"


def _trash_dir(mid: str) -> Path:
    return _trash_root() / mdir(mid).name


def _trash_ts(d: Path) -> float:
    info = read_json(d / "trash.json") or {}
    raw = info.get("trashed_at")
    if raw:
        try:
            return datetime.fromisoformat(raw).timestamp()
        except (TypeError, ValueError):
            pass
    try:
        return d.stat().st_mtime
    except OSError:
        return time.time()


def purge_expired_trash(now: float | None = None, keep_s: float = TRASH_KEEP_S) -> list[str]:
    root = _trash_root()
    if not root.exists():
        return []
    now = time.time() if now is None else now
    gone = []
    for d in list(root.iterdir()):
        if not d.is_dir():
            continue
        if now - _trash_ts(d) > keep_s:
            shutil.rmtree(d, ignore_errors=True)
            gone.append(d.name)
    return gone


def trash_meeting(mid: str) -> dict:
    with _lock:
        purge_expired_trash()
        src = mdir(mid)
        if not (src / "meta.json").exists():
            raise KeyError(mid)
        meta = read_json(src / "meta.json") or {}
        root = _trash_root()
        root.mkdir(parents=True, exist_ok=True)
        write_json(
            src / "trash.json",
            {
                "id": mid,
                "title": meta.get("title") or "",
                "created": meta.get("created") or "",
                "trashed_at": datetime.now().isoformat(timespec="seconds"),
            },
        )
        dest = _trash_dir(mid)
        if dest.exists():
            shutil.rmtree(dest)
        _meta_cache.pop(_cache_key(mid), None)
        shutil.move(str(src), str(dest))
        return meta


def list_trash() -> list[dict]:
    root = _trash_root()
    if not root.exists():
        return []
    out = []
    for d in root.iterdir():
        if not d.is_dir() or not (d / "meta.json").exists():
            continue
        meta = read_json(d / "meta.json") or {}
        info = read_json(d / "trash.json") or {}
        out.append(
            {
                "id": meta.get("id") or info.get("id") or d.name,
                "title": meta.get("title") or info.get("title") or "未命名会议",
                "created": meta.get("created") or info.get("created") or "",
                "duration": float(meta.get("speech_s") or meta.get("duration") or 0.0),
                "trashed_at": info.get("trashed_at") or "",
            }
        )
    out.sort(key=lambda x: x.get("trashed_at") or "", reverse=True)
    return out


def restore_trash(mid: str) -> dict:
    with _lock:
        src = _trash_dir(mid)
        if not (src / "meta.json").exists():
            raise KeyError(mid)
        dest = mdir(mid)
        if dest.exists():
            raise FileExistsError(mid)
        (src / "trash.json").unlink(missing_ok=True)
        shutil.move(str(src), str(dest))
        _meta_cache.pop(_cache_key(mid), None)
        meta = _load_meta_cached(dest, mid)
        if not meta:
            raise KeyError(mid)
        return meta


def purge_trash(mid: str) -> bool:
    with _lock:
        target = _trash_dir(mid)
        if not target.exists():
            return False
        safe_rmtree(target)
        return True


DISCARDED = DATA / "discarded"
DISCARD_KEEP_S = 7 * 86400


def _discarded_dir(mid: str) -> Path:
    return DISCARDED / mdir(mid).name


def _discarded_ts(d: Path) -> float:
    info = read_json(d / "discard.json") or {}
    raw = info.get("discarded_at")
    if raw:
        try:
            return datetime.fromisoformat(raw).timestamp()
        except (TypeError, ValueError):
            pass
    try:
        return d.stat().st_mtime
    except OSError:
        return time.time()


def _record_discard_telemetry(mid: str, info: dict, outcome: str) -> None:
    try:
        import rsi_ambient
        rsi_ambient.record_discard_outcome(
            mid,
            float(info.get("voiced_s") or 0.0),
            float(info.get("min_s") or 20.0),
            outcome,
            device=str(info.get("device") or ""),
        )
    except (ImportError, OSError, ValueError, TypeError, RuntimeError) as exc:
        log.debug("discard telemetry (%s) skipped for %s: %s", outcome, mid, exc)


def purge_discarded(now: float | None = None, keep_s: float = DISCARD_KEEP_S) -> list[str]:
    if not DISCARDED.exists():
        return []
    now = time.time() if now is None else now
    gone = []
    for d in list(DISCARDED.iterdir()):
        if not d.is_dir():
            continue
        if now - _discarded_ts(d) > keep_s:
            info = read_json(d / "discard.json") or {}
            _record_discard_telemetry(info.get("id") or d.name, info, "purged_7d")
            safe_rmtree(d)
            if not d.exists():
                gone.append(d.name)
    return gone


def recycle(mid: str, *, voiced_s: float, min_s: float, device: str = "") -> None:
    with _lock:
        purge_discarded()
        src = mdir(mid)
        if not (src / "meta.json").exists():
            return
        meta = read_json(src / "meta.json") or {}
        DISCARDED.mkdir(parents=True, exist_ok=True)
        write_json(src / "discard.json", {
            "id": mid,
            "time": meta.get("created") or meta.get("started_at") or "",
            "voiced_s": voiced_s,
            "min_s": min_s,
            "device": device,
            "discarded_at": datetime.now().isoformat(timespec="seconds"),
        })
        dest = _discarded_dir(mid)
        if dest.exists():
            shutil.rmtree(dest)
        _meta_cache.pop(_cache_key(mid), None)
        shutil.move(str(src), str(dest))


def list_discarded() -> list[dict]:
    if not DISCARDED.exists():
        return []
    out = []
    for d in DISCARDED.iterdir():
        if not d.is_dir() or not (d / "meta.json").exists():
            continue
        meta = read_json(d / "meta.json") or {}
        info = read_json(d / "discard.json") or {}
        live = read_json(d / "live.json") or []
        text = ""
        if isinstance(live, list):
            for seg in live:
                if isinstance(seg, dict) and str(seg.get("text") or "").strip():
                    text = str(seg["text"]).strip()
                    break
        out.append({
            "id": meta.get("id") or info.get("id") or d.name,
            "time": info.get("time") or meta.get("created") or "",
            "voiced_s": info.get("voiced_s", 0),
            "text": text,
        })
    out.sort(key=lambda x: x.get("time") or "", reverse=True)
    return out


def restore_discarded(mid: str) -> dict:
    with _lock:
        src = _discarded_dir(mid)
        if not (src / "meta.json").exists():
            raise KeyError(mid)
        dest = mdir(mid)
        if dest.exists():
            raise FileExistsError(mid)
        info = read_json(src / "discard.json") or {}
        (src / "discard.json").unlink(missing_ok=True)
        shutil.move(str(src), str(dest))
        _meta_cache.pop(_cache_key(mid), None)
        meta = _load_meta_cached(dest, mid)
        if not meta:
            raise KeyError(mid)
    _record_discard_telemetry(mid, info, "restored")
    return meta


def load(mid: str, name: str, default=None):
    return read_json(mdir(mid) / name, default)


def save(mid: str, name: str, obj) -> None:
    write_json(mdir(mid) / name, obj)


SETTINGS = DATA / "settings.json"

DEFAULT_SETTINGS = {
    "active": "dashscope",
    "providers": [
        {
            "id": "dashscope",
            "name": "阿里百炼（通义千问）",
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key": "",
            "env_key": "DASHSCOPE_API_KEY",
            "model": "qwen-plus",
            "max_input_chars": 100000,
            "extra_body": {"enable_thinking": False},
        },
        {
            "id": "deepseek",
            "name": "DeepSeek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "",
            "env_key": "DEEPSEEK_API_KEY",
            "model": "deepseek-chat",
            "max_input_chars": 80000,
            "extra_body": {},
        },
        {
            "id": "local",
            "name": "本地 Qwen3.8-Flash-Next（llama-server）",
            "base_url": "http://127.0.0.1:8090/v1",
            "api_key": "local",
            "env_key": "",
            "model": "qwen3.8-flash-next",
            "max_input_chars": 18000,
            "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
        },
    ],
}


def _normalize_settings_schema(raw: object) -> tuple[dict, bool]:
    if not isinstance(raw, dict) or not raw:
        return json.loads(json.dumps(DEFAULT_SETTINGS)), True
    if "providers" not in raw:
        migrated = dict(raw)
        migrated["providers"] = json.loads(json.dumps(DEFAULT_SETTINGS["providers"]))
        migrated.setdefault("active", DEFAULT_SETTINGS["active"])
        return migrated, True
    return raw, False


def get_settings() -> dict:
    with _lock:
        s, dirty = _normalize_settings_schema(read_json(SETTINGS))
        if dirty:
            SETTINGS.parent.mkdir(parents=True, exist_ok=True)
            write_json(SETTINGS, s)
        return s


def save_settings(s: dict) -> None:
    with _lock:
        SETTINGS.parent.mkdir(parents=True, exist_ok=True)
        write_json(SETTINGS, s)


def restore_default_providers() -> int:
    with _lock:
        s = get_settings()
        have = {p["id"] for p in s["providers"]}
        add = [json.loads(json.dumps(p)) for p in DEFAULT_SETTINGS["providers"] if p["id"] not in have]
        s["providers"] += add
        if not any(p["id"] == s.get("active") for p in s["providers"]):
            s["active"] = s["providers"][0]["id"]
        save_settings(s)
        return len(add)


def provider(pid: str | None = None) -> dict:
    s = get_settings()
    if not s["providers"]:
        raise KeyError("还没有配置 AI 模型接口，请在“设置”里添加或恢复默认接口")
    pid = pid or s.get("active")
    for p in s["providers"]:
        if p["id"] == pid:
            p = dict(p)
            if not p.get("api_key") and p.get("env_key"):
                p["api_key"] = os.environ.get(p["env_key"], "")
            return p
    raise KeyError(f"找不到模型接口「{pid}」，可能已被删除，请在“设置”里重新选择")


def now_ts() -> float:
    return time.time()
