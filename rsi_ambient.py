"""Loop D v1：全天模式环境声学画像、VAD 误触统计与最短有效发言时长（min_speech_s）建议。

按设备记录环境底噪 p10_db 与对话级 VAD 误触率；基于回收站恢复 / 7天过期清理 / 手动删短录三类反馈，
采用非对称代价（误丢真实对话 = 3 × 留一条杂音）在 [5, 60] 秒内给出步长 ≤ ±5s 的建议，不静默篡改用户配置。
"""
import math
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np

import rsi_events
import store

VALID_OUTCOMES = frozenset({"restored", "purged_7d", "user_deleted_short"})
MAX_NOISE_SAMPLES = 200
MAX_DISCARDS = 500
ADVICE_MIN_SAMPLES = 20
ADVICE_WINDOW_S = 30 * 86400
SENTINEL_WINDOW_S = 7 * 86400
MIN_SPEECH_LO = 5
MIN_SPEECH_HI = 60
MAX_STEP_S = 5.0
FALSE_DISCARD_WEIGHT = 3
FALSE_KEEP_WEIGHT = 1

_lock = threading.RLock()


def _path() -> Path:
    return store.DATA / "rsi" / "acoustic_profiles.json"


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_ts(val: str | None) -> float | None:
    if not val:
        return None
    try:
        return datetime.fromisoformat(val).timestamp()
    except (TypeError, ValueError):
        return None


def _default_db() -> dict:
    return {"devices": {}, "discards": []}


def _load_db() -> dict:
    raw = store.read_json(_path())
    if not isinstance(raw, dict):
        return _default_db()
    db = _default_db()
    if isinstance(raw.get("devices"), dict):
        db["devices"] = raw["devices"]
    if isinstance(raw.get("discards"), list):
        db["discards"] = [x for x in raw["discards"] if isinstance(x, dict)]
    return db


def _save_db(db: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    store.write_json(p, db)


def record_noise_floor(device: str, p10_db: float) -> None:
    if rsi_events.is_excluded():
        return
    try:
        val = float(p10_db)
    except (TypeError, ValueError):
        return
    if not math.isfinite(val):
        return
    dev = (device or "").strip() or "default"
    with _lock:
        db = _load_db()
        d = db["devices"].setdefault(dev, {
            "noise_samples": [],
            "p10_db": None,
            "vad_convs": 0,
            "vad_false_sum": 0.0,
            "updated_at": "",
        })
        samples = [float(x) for x in (d.get("noise_samples") or []) if isinstance(x, (int, float))]
        samples.append(round(val, 2))
        samples = samples[-MAX_NOISE_SAMPLES:]
        d["noise_samples"] = samples
        d["p10_db"] = round(float(np.median(samples)), 1)
        d["updated_at"] = _now_iso()
        _save_db(db)


def record_conv_vad(device: str, speech_ms: float, voiced_ms: float) -> None:
    if rsi_events.is_excluded():
        return
    try:
        sp = float(speech_ms)
        vo = float(voiced_ms)
    except (TypeError, ValueError):
        return
    if sp <= 0 or not math.isfinite(sp) or not math.isfinite(vo):
        return
    dev = (device or "").strip() or "default"
    false_ratio = max(0.0, min(1.0, 1.0 - max(0.0, vo) / sp))
    with _lock:
        db = _load_db()
        d = db["devices"].setdefault(dev, {
            "noise_samples": [],
            "p10_db": None,
            "vad_convs": 0,
            "vad_false_sum": 0.0,
            "updated_at": "",
        })
        d["vad_convs"] = int(d.get("vad_convs") or 0) + 1
        d["vad_false_sum"] = round(float(d.get("vad_false_sum") or 0.0) + false_ratio, 4)
        d["updated_at"] = _now_iso()
        _save_db(db)


def record_discard_outcome(mid: str, voiced_s: float, min_s: float, outcome: str, device: str = "") -> None:
    if rsi_events.is_excluded():
        return
    if outcome not in VALID_OUTCOMES:
        raise ValueError(f"unknown discard outcome: {outcome}")
    dev = (device or "").strip() or "default"
    now = time.time()
    rec = {
        "mid": str(mid),
        "voiced_s": round(max(0.0, float(voiced_s)), 2),
        "min_s": round(max(0.0, float(min_s)), 2),
        "outcome": outcome,
        "device": dev,
        "at": _now_iso(),
    }
    restored_7d = 0
    with _lock:
        db = _load_db()
        discards = db["discards"]
        if any(x.get("mid") == rec["mid"] and x.get("outcome") == outcome for x in discards):
            return
        discards.append(rec)
        db["discards"] = discards[-MAX_DISCARDS:]
        _save_db(db)
        cutoff_7d = now - SENTINEL_WINDOW_S
        restored_7d = sum(
            1 for x in db["discards"]
            if x.get("outcome") == "restored" and (_parse_ts(x.get("at")) or now) >= cutoff_7d
        )
    rsi_events.emit("ambient_discard_outcome", rec)
    if outcome == "restored" and restored_7d >= 2:
        rsi_events.log_registry({
            "loop": "D",
            "action": "sentinel_restore_warning",
            "restored_7d": restored_7d,
            "mid": rec["mid"],
            "reason": f"近 7 天已从回收站恢复 {restored_7d} 段对话，建议调低「最短有效发言时长」以防误丢真实对话",
        })


def _recent_discards(discards: list[dict], window_s: float, now: float) -> list[dict]:
    cutoff = now - window_s
    out = []
    for x in discards:
        ts = _parse_ts(x.get("at"))
        if ts is None or ts >= cutoff:
            out.append(x)
    return out


def advice(current_min_speech_s: float, *, now: float | None = None) -> dict:
    """基于近 30 天回收站与短录反馈计算 min_speech_s 调优建议及 7 天恢复哨兵预警。"""
    now = time.time() if now is None else now
    cur = float(current_min_speech_s)
    with _lock:
        db = _load_db()
    all_discards = db["discards"]
    recent_30d = _recent_discards(all_discards, ADVICE_WINDOW_S, now)
    recent_7d = _recent_discards(all_discards, SENTINEL_WINDOW_S, now)
    restored_7d = sum(1 for x in recent_7d if x.get("outcome") == "restored")
    warning = (
        f"近 7 天已从回收站恢复 {restored_7d} 段对话，建议调低最短有效发言时长以防漏录"
        if restored_7d >= 2
        else ""
    )

    n = len(recent_30d)
    if n < ADVICE_MIN_SAMPLES:
        return {
            "suggested_min_speech_s": None,
            "reason": f"样本不足（当前 {n}/{ADVICE_MIN_SAMPLES} 条），继续积累回收站反馈后将给出建议",
            "warning": warning,
            "samples": n,
            "need_more": ADVICE_MIN_SAMPLES - n,
        }

    def _eval(t: float) -> tuple[int, int, int]:
        false_discards = 0
        false_keeps = 0
        for x in recent_30d:
            v = float(x.get("voiced_s") or 0.0)
            oc = x.get("outcome")
            if oc == "restored" and v < t:
                false_discards += 1
            elif oc in ("purged_7d", "user_deleted_short") and v >= t:
                false_keeps += 1
        loss = FALSE_DISCARD_WEIGHT * false_discards + FALSE_KEEP_WEIGHT * false_keeps
        return loss, false_discards, false_keeps

    best_t = MIN_SPEECH_LO
    best_key: tuple | None = None
    for t in range(MIN_SPEECH_LO, MIN_SPEECH_HI + 1):
        loss, _, _ = _eval(float(t))
        key = (loss, abs(t - cur), t)
        if best_key is None or key < best_key:
            best_key = key
            best_t = t

    lo_step = max(float(MIN_SPEECH_LO), cur - MAX_STEP_S)
    hi_step = min(float(MIN_SPEECH_HI), cur + MAX_STEP_S)
    suggested = float(round(max(lo_step, min(hi_step, float(best_t)))))

    if abs(suggested - cur) < 1.0:
        return {
            "suggested_min_speech_s": None,
            "reason": f"当前阈值 {cur:.0f} 秒已接近最优（近 30 天 {n} 条反馈）",
            "warning": warning,
            "samples": n,
            "need_more": 0,
        }

    direction = "调低" if suggested < cur else "调高"
    _, cur_fd, cur_fk = _eval(cur)
    _, sug_fd, sug_fk = _eval(suggested)
    return {
        "suggested_min_speech_s": suggested,
        "reason": (
            f"近 30 天共 {n} 条反馈：建议将最短有效发言时长从 {cur:.0f}s {direction}至 {suggested:.0f}s"
            f"（误丢 {cur_fd}→{sug_fd}，误留 {cur_fk}→{sug_fk}，最优目标 {best_t}s）"
        ),
        "warning": warning,
        "samples": n,
        "need_more": 0,
    }


def summary(current_min_speech_s: float = 20.0, *, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    with _lock:
        db = _load_db()
    devices = []
    for dev, d in sorted(db["devices"].items()):
        if not isinstance(d, dict):
            continue
        convs = int(d.get("vad_convs") or 0)
        false_sum = float(d.get("vad_false_sum") or 0.0)
        n_samples = len(d.get("noise_samples") or [])
        devices.append({
            "device": dev,
            "p10_db": d.get("p10_db"),
            "noise_floor_p20_db": d.get("p10_db"),
            "noise_samples": n_samples,
            "samples": n_samples,
            "vad_convs": convs,
            "vad_false_ratio": round(false_sum / convs, 3) if convs > 0 else None,
            "updated_at": str(d.get("updated_at") or ""),
        })

    discards = db["discards"]
    recent_7d = _recent_discards(discards, SENTINEL_WINDOW_S, now)
    discard_stats = {
        "restored": sum(1 for x in discards if x.get("outcome") == "restored"),
        "purged_7d": sum(1 for x in discards if x.get("outcome") == "purged_7d"),
        "user_deleted_short": sum(1 for x in discards if x.get("outcome") == "user_deleted_short"),
        "restored_7d": sum(1 for x in recent_7d if x.get("outcome") == "restored"),
    }
    return {
        "devices": devices,
        "discard_stats": discard_stats,
        "advice": advice(current_min_speech_s, now=now),
    }


def reset() -> None:
    with _lock:
        try:
            _path().unlink(missing_ok=True)
        except OSError:
            pass
