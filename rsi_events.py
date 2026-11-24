"""本地自学习（RSI）共享底座：配置、隐私排除、事件流、状态注册表与纪要改稿统计。

所有读写动态基于 store.DATA / "rsi"，测试隔离 MEETING_DATA 时不会污染仓库 data/。
只记录结构化统计与用户操作事件，绝不落盘原始音频，零外网请求。
"""
import json
import os
import re
import threading
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path

import store

DEFAULT_CONFIG = {"paused": False, "auto_name": True}
MAX_EVENT_BYTES = 5 * 1024 * 1024  # 5 MB 轮转，保留最近 1 份历史文件
MAX_REGISTRY = 200

_lock = threading.RLock()
_AUDIO_KEYS = frozenset({"audio", "pcm", "wav", "mp3", "raw_audio", "samples", "bytes"})
_H2_RE = re.compile(r"^##\s+(.+?)\s*$")


def _dir() -> Path:
    return store.DATA / "rsi"


def _config_path() -> Path:
    return _dir() / "config.json"


def _events_path() -> Path:
    return _dir() / "events.jsonl"


def _registry_path() -> Path:
    return _dir() / "registry.json"


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def get_config() -> dict:
    with _lock:
        raw = store.read_json(_config_path())
        if not isinstance(raw, dict):
            return dict(DEFAULT_CONFIG)
        return {
            "paused": bool(raw.get("paused", DEFAULT_CONFIG["paused"])),
            "auto_name": bool(raw.get("auto_name", DEFAULT_CONFIG["auto_name"])),
        }


def save_config(patch: dict) -> dict:
    with _lock:
        cur = get_config()
        if isinstance(patch, dict):
            if "paused" in patch and patch["paused"] is not None:
                cur["paused"] = bool(patch["paused"])
            if "auto_name" in patch and patch["auto_name"] is not None:
                cur["auto_name"] = bool(patch["auto_name"])
        p = _config_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        store.write_json(p, cur)
        return dict(cur)


def is_excluded(meta: dict | None = None) -> bool:
    """全局暂停学习或单场会议开启了「不参与学习」时返回 True。"""
    if get_config().get("paused"):
        return True
    return bool((meta or {}).get("rsi_exclude"))


def _sanitize(obj):
    if isinstance(obj, (bytes, bytearray, memoryview)):
        return None
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            ks = str(k)
            if ks.lower() in _AUDIO_KEYS or isinstance(v, (bytes, bytearray, memoryview)):
                continue
            out[ks] = _sanitize(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [_sanitize(x) for x in obj if not isinstance(x, (bytes, bytearray, memoryview))]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


def emit(kind: str, payload: dict) -> None:
    """加锁追加事件到 data/rsi/events.jsonl；超过 5MB 时轮转，仅保留 1 份历史文件。"""
    record = {
        "t": _now_iso(),
        "kind": str(kind),
        "payload": _sanitize(payload if isinstance(payload, dict) else {"value": payload}),
    }
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _lock:
        p = _events_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            if p.exists() and p.stat().st_size >= MAX_EVENT_BYTES:
                rotated = p.with_name(p.name + ".1")
                os.replace(p, rotated)
        except OSError:
            pass
        with open(p, "a", encoding="utf-8") as f:
            f.write(line)


def _read_registry_raw() -> list[dict]:
    data = store.read_json(_registry_path())
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        return [x for x in data["entries"] if isinstance(x, dict)]
    return []


def log_registry(entry: dict) -> dict:
    """记录一条自进化/哨兵操作到 data/rsi/registry.json（最多保留 200 条）。"""
    item = _sanitize(dict(entry or {}))
    item.setdefault("at", _now_iso())
    item.setdefault("kind", str(item.get("action") or item.get("loop") or "event"))
    item.setdefault("detail", str(item.get("reason") or ""))
    with _lock:
        entries = _read_registry_raw()
        entries.append(item)
        if len(entries) > MAX_REGISTRY:
            entries = entries[-MAX_REGISTRY:]
        p = _registry_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        store.write_json(p, entries)
    return item


def get_registry(limit: int = 30) -> list[dict]:
    """返回最近 limit 条注册表记录（按时间倒序，最新在前）。"""
    with _lock:
        entries = _read_registry_raw()
    entries = list(reversed(entries))
    if limit is not None and limit >= 0:
        return entries[:limit]
    return entries


def _split_h2_sections(md: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    cur = "_header"
    for line in (md or "").splitlines():
        m = _H2_RE.match(line)
        if m:
            cur = m.group(1).strip()
            sections.setdefault(cur, [])
        else:
            if cur == "_header" and not line.strip() and cur not in sections:
                continue
            sections.setdefault(cur, []).append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items() if k != "_header" or "\n".join(v).strip()}


def _norm_dist(a: str, b: str) -> float:
    a, b = a or "", b or ""
    if a == b:
        return 0.0
    if not a or not b:
        return 1.0
    return round(max(0.0, min(1.0, 1.0 - SequenceMatcher(None, a, b).ratio())), 4)


def minutes_edit_stats(orig_md: str, new_md: str) -> dict:
    """计算纪要整体及各 ## 二级标题分节的归一化编辑距离。"""
    orig = orig_md or ""
    new = new_md or ""
    overall = _norm_dist(orig, new)
    s_orig = _split_h2_sections(orig)
    s_new = _split_h2_sections(new)
    order: list[str] = []
    for k in list(s_orig.keys()) + list(s_new.keys()):
        if k not in order:
            order.append(k)
    sec_dists: dict[str, float] = {}
    for title in order:
        if title == "_header":
            continue
        sec_dists[title] = _norm_dist(s_orig.get(title, ""), s_new.get(title, ""))
    return {
        "overall": overall,
        "sections": sec_dists,
        "orig_chars": len(orig),
        "new_chars": len(new),
        "changed": orig != new,
    }


def reset_logs() -> None:
    """清空事件流与注册表日志（保留 config.json 用户隐私偏好）。"""
    with _lock:
        for p in (_events_path(), _events_path().with_name("events.jsonl.1"), _registry_path()):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
