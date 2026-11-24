"""Loop A v1：跨会声纹记忆库（纯本地，基于 CAM++ 质心，按场可逆重算 + 防投毒 + 哨兵护栏）。

不存任何原始音频：每场会议只存 data/meetings/<mid>/spk_embs.json（每位说话人的 192 维质心与一致性统计），
全局库 data/rsi/voiceprints.json 按场记录 sessions[]，改名或删会可确定性撤销重算。
"""
import bisect
import hashlib
import math
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

import minutes_check
import rsi_events
import store

DEFAULT_TAU_AUTO = 0.68
DEFAULT_TAU_SUGGEST = 0.54
MIN_MARGIN_AUTO = 0.10
MERGE_HINT_COS = 0.70
MERGE_HINT_MARGIN = 0.12

MIN_VOICED_S = 15.0
MIN_CHUNKS = 10
MIN_INTRA_COS = 0.55
CONFLICT_SELF_MIN = 0.45
CONFLICT_OTHER_MARGIN = 0.05

MAX_SESSIONS = 16
MAX_CONFLICTS = 50
MAX_OVERRIDES = 100
MAX_AUTO_MEETINGS = 50
SENTINEL_WINDOW = 10
SENTINEL_OVERRIDES = 2

GENERIC_RE = re.compile(r"^说话人\s*\d+$")
GENERIC_NAMES = frozenset({"我", "对方", "主持人", "我方", "参会人", "未知"} | set(minutes_check.OWNER_SKIP))

_lock = threading.RLock()


def _path() -> Path:
    return store.DATA / "rsi" / "voiceprints.json"


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_ts(val: str | None) -> float:
    if not val:
        return datetime.now().timestamp()
    try:
        return datetime.fromisoformat(val).timestamp()
    except (TypeError, ValueError):
        return datetime.now().timestamp()


def _unit_vec(v) -> np.ndarray | None:
    arr = np.asarray(v, dtype=np.float64)
    if arr.ndim != 1 or arr.size == 0 or not np.isfinite(arr).all():
        return None
    n = float(np.linalg.norm(arr))
    if n <= 1e-12:
        return None
    return arr / n


def _union_duration_s(intervals_ms: list[tuple[float, float]]) -> float:
    if not intervals_ms:
        return 0.0
    ordered = sorted((a, b) for a, b in intervals_ms if b > a)
    if not ordered:
        return 0.0
    total = 0.0
    cur_a, cur_b = ordered[0]
    for a, b in ordered[1:]:
        if a <= cur_b:
            if b > cur_b:
                cur_b = b
        else:
            total += cur_b - cur_a
            cur_a, cur_b = a, b
    total += cur_b - cur_a
    return total / 1000.0


def is_generic_name(name: str | None) -> bool:
    s = (name or "").strip()
    if not s:
        return True
    if s in GENERIC_NAMES or GENERIC_RE.fullmatch(s):
        return True
    return False


def compute_meeting_embs(turns: list[tuple], chunks: list, X: np.ndarray, diarizer: str = "campp") -> dict:
    """从已算出的 CAM++ 小块声纹矩阵 X 与 turns 计算每位说话人的纯净质心与簇内一致性。

    跳过与多个不同说话人重叠的小块，避免混人污染质心；voiced_s 按纯净区间并集计算，不因 50% 滑窗重叠翻倍。
    """
    empty = {"version": 1, "diarizer": str(diarizer or "campp"), "dim": 0, "speakers": {}}
    if not turns or not chunks or X is None:
        return empty
    mat = np.asarray(X, dtype=np.float64)
    if mat.ndim != 2 or mat.shape[0] == 0 or mat.shape[1] == 0:
        return empty
    n = min(len(chunks), mat.shape[0])
    dim = int(mat.shape[1])
    tl = sorted((float(a), float(b), int(s)) for a, b, s in turns if float(b) > float(a))
    if not tl:
        return empty
    starts = [t[0] for t in tl]
    # 前缀最大结束时间，用于二分后向左覆盖所有仍可能与 c_start 重叠的嵌套/长 turn
    prefix_max_end: list[float] = []
    mx = -1.0
    for _, te, _ in tl:
        if te > mx:
            mx = te
        prefix_max_end.append(mx)

    spk_vecs: dict[int, list[np.ndarray]] = {}
    spk_spans: dict[int, list[tuple[float, float]]] = {}

    for i in range(n):
        c0 = float(chunks[i][0]) * 1000.0
        c1 = float(chunks[i][1]) * 1000.0
        if c1 <= c0:
            continue
        hi = bisect.bisect_left(starts, c1)
        if hi <= 0:
            continue
        # 向前找到最早仍可能覆盖 c0 的位置
        lo = bisect.bisect_right(prefix_max_end, c0, 0, hi)
        ov_spks: set[int] = set()
        ov_spans: list[tuple[float, float]] = []
        for k in range(lo, hi):
            ts, te, spk = tl[k]
            a, b = max(c0, ts), min(c1, te)
            if b > a:
                ov_spks.add(spk)
                if len(ov_spks) > 1:
                    break
                ov_spans.append((a, b))
        if len(ov_spks) != 1:
            continue
        u = _unit_vec(mat[i])
        if u is None:
            continue
        spk = next(iter(ov_spks))
        spk_vecs.setdefault(spk, []).append(u)
        spk_spans.setdefault(spk, []).extend(ov_spans)

    speakers: dict[str, dict] = {}
    for spk in sorted(spk_vecs):
        U = np.stack(spk_vecs[spk], axis=0)
        centroid = _unit_vec(U.mean(axis=0))
        if centroid is None:
            continue
        cos_vals = np.clip(U @ centroid, -1.0, 1.0)
        voiced_s = _union_duration_s(spk_spans.get(spk) or [])
        speakers[str(spk)] = {
            "centroid": [round(float(v), 6) for v in centroid],
            "n_chunks": int(U.shape[0]),
            "voiced_s": round(voiced_s, 2),
            "intra_cos_mean": round(float(np.mean(cos_vals)), 4),
            "intra_cos_p25": round(float(np.percentile(cos_vals, 25)), 4),
        }
    return {"version": 1, "diarizer": str(diarizer or "campp"), "dim": dim, "speakers": speakers}


def _default_db() -> dict:
    return {
        "version": 1,
        "tau_auto": DEFAULT_TAU_AUTO,
        "tau_suggest": DEFAULT_TAU_SUGGEST,
        "persons": {},
        "conflicts": [],
        "overrides": [],
        "auto_meetings": [],
    }


def _load_db() -> dict:
    raw = store.read_json(_path())
    if not isinstance(raw, dict):
        return _default_db()
    db = _default_db()
    db["tau_auto"] = float(raw.get("tau_auto") or DEFAULT_TAU_AUTO)
    db["tau_suggest"] = float(raw.get("tau_suggest") or DEFAULT_TAU_SUGGEST)
    if isinstance(raw.get("persons"), dict):
        db["persons"] = raw["persons"]
    if isinstance(raw.get("conflicts"), list):
        db["conflicts"] = [x for x in raw["conflicts"] if isinstance(x, dict)]
    if isinstance(raw.get("overrides"), list):
        db["overrides"] = [x for x in raw["overrides"] if isinstance(x, dict)]
    if isinstance(raw.get("auto_meetings"), list):
        db["auto_meetings"] = [str(x) for x in raw["auto_meetings"] if x]
    return db


def _save_db(db: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    store.write_json(p, db)


def _weighted_centroid(sessions: list[dict], now_ts: float | None = None) -> np.ndarray | None:
    now_ts = datetime.now().timestamp() if now_ts is None else now_ts
    acc: np.ndarray | None = None
    for s in sessions:
        v = _unit_vec(s.get("centroid"))
        if v is None:
            continue
        if acc is not None and v.shape != acc.shape:
            continue
        voiced_s = max(0.0, float(s.get("voiced_s") or 0.0))
        intra = max(0.01, float(s.get("intra_cos_mean") or 0.5))
        age_days = max(0.0, (now_ts - _parse_ts(s.get("at"))) / 86400.0)
        w = min(voiced_s, 180.0) * intra * math.exp(-age_days / 180.0)
        if w <= 0:
            w = 1e-6
        acc = (v * w) if acc is None else (acc + v * w)
    if acc is None:
        return None
    return _unit_vec(acc)


def _recompute_person(person: dict, now_ts: float | None = None) -> bool:
    sessions = [s for s in (person.get("sessions") or []) if isinstance(s, dict) and s.get("centroid")]
    if not sessions:
        return False
    sessions = sessions[-MAX_SESSIONS:]
    c = _weighted_centroid(sessions, now_ts=now_ts)
    if c is None:
        return False
    person["sessions"] = sessions
    person["centroid"] = [round(float(v), 6) for v in c]
    person["voiced_s"] = round(sum(float(s.get("voiced_s") or 0.0) for s in sessions), 1)
    person["updated_at"] = max((str(s.get("at") or "") for s in sessions), default=_now_iso()) or _now_iso()
    return True


def _extract_spk_entry(spk_embs: dict | None, spk_key: str) -> dict | None:
    if not isinstance(spk_embs, dict):
        return None
    if isinstance(spk_embs.get("speakers"), dict):
        spks = spk_embs["speakers"]
        if spk_key in spks:
            return spks[spk_key]
        if spk_key.isdigit() and int(spk_key) in spks:
            return spks[int(spk_key)]
        return None
    if "centroid" in spk_embs:
        return spk_embs
    if spk_key in spk_embs:
        return spk_embs[spk_key]
    if spk_key.isdigit() and int(spk_key) in spk_embs:
        return spk_embs[int(spk_key)]
    return None


def enroll(mid: str, spk: int | str, name: str, spk_embs: dict | None = None) -> dict:
    """将某场会议某说话人的声纹质心注册到 name 名下。

    经过泛称过滤、质量门禁与防投毒冲突检测；通过后按场 upsert 并确定性重算加权质心。
    """
    clean_name = (name or "").strip()
    spk_key = str(spk)
    if is_generic_name(clean_name):
        return {"status": "skipped", "reason": "generic_name"}
    if spk_embs is None:
        spk_embs = store.load(mid, "spk_embs.json")
    entry = _extract_spk_entry(spk_embs, spk_key)
    if not isinstance(entry, dict) or not entry.get("centroid"):
        return {"status": "skipped", "reason": "no_embedding"}

    voiced_s = float(entry.get("voiced_s") or 0.0)
    n_chunks = int(entry.get("n_chunks") or 0)
    intra_cos_mean = float(entry.get("intra_cos_mean") or 0.0)
    if voiced_s < MIN_VOICED_S or n_chunks < MIN_CHUNKS or intra_cos_mean < MIN_INTRA_COS:
        return {
            "status": "skipped",
            "reason": "quality_gate",
            "voiced_s": voiced_s,
            "n_chunks": n_chunks,
            "intra_cos_mean": intra_cos_mean,
        }

    vec = _unit_vec(entry["centroid"])
    if vec is None:
        return {"status": "skipped", "reason": "invalid_embedding"}

    with _lock:
        db = _load_db()
        persons = db["persons"]
        existing = persons.get(clean_name)
        s_self: float | None = None
        if isinstance(existing, dict):
            other_sess = [
                s for s in (existing.get("sessions") or [])
                if not (s.get("mid") == mid and str(s.get("spk")) == spk_key)
            ]
            if other_sess:
                self_c = _weighted_centroid(other_sess)
                if self_c is not None and self_c.shape == vec.shape:
                    s_self = float(np.dot(vec, self_c))

        best_other_name: str | None = None
        s_other: float | None = None
        for pname, pdata in persons.items():
            if pname == clean_name or not isinstance(pdata, dict):
                continue
            oc = _unit_vec(pdata.get("centroid"))
            if oc is None or oc.shape != vec.shape:
                continue
            sc = float(np.dot(vec, oc))
            if s_other is None or sc > s_other:
                s_other = sc
                best_other_name = pname

        conflict_reason = ""
        if s_self is not None:
            if s_self < CONFLICT_SELF_MIN:
                conflict_reason = "low_self_similarity"
            elif s_other is not None and s_other > s_self + CONFLICT_OTHER_MARGIN:
                conflict_reason = "closer_to_other"

        if conflict_reason:
            conflict = {
                "mid": mid,
                "spk": int(spk_key) if spk_key.isdigit() else spk_key,
                "name": clean_name,
                "s_self": round(float(s_self), 4),
                "other_name": best_other_name,
                "s_other": round(float(s_other), 4) if s_other is not None else None,
                "reason": conflict_reason,
                "at": _now_iso(),
            }
            db["conflicts"].append(conflict)
            db["conflicts"] = db["conflicts"][-MAX_CONFLICTS:]
            _save_db(db)
            rsi_events.emit("voiceprint_conflict", conflict)
            return {"status": "conflict", **conflict}

        # 若该 (mid, spk) 之前注册在别人名下，先确定性剔除并重算
        for pname in list(persons.keys()):
            if pname == clean_name:
                continue
            pdata = persons[pname]
            old_sess = pdata.get("sessions") or []
            kept = [s for s in old_sess if not (s.get("mid") == mid and str(s.get("spk")) == spk_key)]
            if len(kept) != len(old_sess):
                pdata["sessions"] = kept
                if not _recompute_person(pdata):
                    persons.pop(pname, None)

        person = persons.setdefault(clean_name, {"sessions": [], "centroid": [], "voiced_s": 0.0, "updated_at": ""})
        kept_self = [
            s for s in (person.get("sessions") or [])
            if not (s.get("mid") == mid and str(s.get("spk")) == spk_key)
        ]
        now_iso = _now_iso()
        kept_self.append({
            "mid": mid,
            "spk": spk_key,
            "centroid": [round(float(v), 6) for v in vec],
            "voiced_s": round(voiced_s, 2),
            "intra_cos_mean": round(intra_cos_mean, 4),
            "at": now_iso,
        })
        person["sessions"] = kept_self[-MAX_SESSIONS:]
        _recompute_person(person)
        _save_db(db)
        rsi_events.emit("voiceprint_enroll", {
            "mid": mid,
            "spk": spk_key,
            "name": clean_name,
            "sessions": len(person["sessions"]),
            "voiced_s": person["voiced_s"],
        })
        return {
            "status": "enrolled",
            "name": clean_name,
            "sessions": len(person["sessions"]),
            "voiced_s": person["voiced_s"],
        }


def revoke_meeting(mid: str, spk: int | str | None = None) -> int:
    """确定性移除某场会议（或其中某位说话人）的声纹样本并重算受影响人员的质心。"""
    spk_key = None if spk is None else str(spk)
    removed = 0
    with _lock:
        db = _load_db()
        persons = db["persons"]
        for pname in list(persons.keys()):
            pdata = persons[pname]
            old_sess = pdata.get("sessions") or []
            kept = [
                s for s in old_sess
                if not (s.get("mid") == mid and (spk_key is None or str(s.get("spk")) == spk_key))
            ]
            diff = len(old_sess) - len(kept)
            if diff > 0:
                removed += diff
                pdata["sessions"] = kept
                if not _recompute_person(pdata):
                    persons.pop(pname, None)
        old_conf_n = len(db["conflicts"])
        if spk_key is None:
            db["conflicts"] = [c for c in db["conflicts"] if c.get("mid") != mid]
        else:
            db["conflicts"] = [
                c for c in db["conflicts"]
                if not (c.get("mid") == mid and str(c.get("spk")) == spk_key)
            ]
        if removed > 0 or len(db["conflicts"]) != old_conf_n:
            _save_db(db)
            if removed > 0:
                rsi_events.emit("voiceprint_revoke", {"mid": mid, "spk": spk_key, "removed": removed})
    return removed


def delete_person(name: str) -> bool:
    clean_name = (name or "").strip()
    if not clean_name:
        return False
    with _lock:
        db = _load_db()
        if clean_name not in db["persons"]:
            return False
        db["persons"].pop(clean_name, None)
        db["conflicts"] = [c for c in db["conflicts"] if c.get("name") != clean_name]
        _save_db(db)
    rsi_events.emit("voiceprint_delete", {"name": clean_name})
    return True


def person_session_count(name: str) -> int:
    clean_name = (name or "").strip()
    if not clean_name:
        return 0
    with _lock:
        p = (_load_db().get("persons") or {}).get(clean_name) or {}
        return len([s for s in (p.get("sessions") or []) if isinstance(s, dict) and s.get("centroid")])


def list_person_names() -> set[str]:
    with _lock:
        return {
            k
            for k, v in (_load_db().get("persons") or {}).items()
            if isinstance(v, dict) and [s for s in (v.get("sessions") or []) if isinstance(s, dict) and s.get("centroid")]
        }


def rename_person(old_name: str, new_name: str) -> dict:
    """将 old_name 的声纹档案整并迁移至 new_name，同名则按 (mid, spk) 去重并重算质心。"""
    clean_old = (old_name or "").strip()
    clean_new = (new_name or "").strip()
    if not clean_old or not clean_new or clean_old == clean_new or is_generic_name(clean_new):
        return {"moved": 0, "merged": False, "sessions": 0, "migrated_keys": set()}
    with _lock:
        db = _load_db()
        persons = db["persons"]
        old_entry = persons.pop(clean_old, None)
        if not isinstance(old_entry, dict):
            existing = persons.get(clean_new) or {}
            return {
                "moved": 0,
                "merged": clean_new in persons,
                "sessions": len(existing.get("sessions") or []),
                "migrated_keys": set(),
            }
        existed = clean_new in persons
        old_sess = [s for s in (old_entry.get("sessions") or []) if isinstance(s, dict) and s.get("centroid")]
        target = persons.setdefault(
            clean_new,
            {"sessions": [], "centroid": [], "voiced_s": 0.0, "updated_at": _now_iso()},
        )
        by_key: dict[tuple[str, str], dict] = {}
        migrated_keys: set[tuple[str, str]] = set()
        for s in (target.get("sessions") or []) + old_sess:
            if not isinstance(s, dict) or not s.get("centroid"):
                continue
            k = (str(s.get("mid") or ""), str(s.get("spk") or ""))
            prev = by_key.get(k)
            if prev is None or str(s.get("at") or "") >= str(prev.get("at") or ""):
                by_key[k] = s
        for s in old_sess:
            migrated_keys.add((str(s.get("mid") or ""), str(s.get("spk") or "")))
        merged_sess = sorted(by_key.values(), key=lambda x: str(x.get("at") or ""))
        target["sessions"] = merged_sess
        if not _recompute_person(target):
            persons.pop(clean_new, None)
            sessions_cnt = 0
        else:
            sessions_cnt = len(target.get("sessions") or [])
        for c in db["conflicts"]:
            if c.get("name") == clean_old:
                c["name"] = clean_new
        _save_db(db)
    rsi_events.emit("voiceprint_rename", {"old_name": clean_old, "new_name": clean_new, "merged": existed})
    return {"moved": len(old_sess), "merged": existed, "sessions": sessions_cnt, "migrated_keys": migrated_keys}


def record_auto_named(mid: str) -> None:
    if not mid:
        return
    with _lock:
        db = _load_db()
        mids = [m for m in db["auto_meetings"] if m != mid]
        mids.append(mid)
        db["auto_meetings"] = mids[-MAX_AUTO_MEETINGS:]
        _save_db(db)


def record_override(mid: str, spk: int | str, old_name: str, new_name: str) -> dict:
    """记录一次对自动命名的手动改回/撤销；近 10 场自动命名会议中累计 >= 2 次则触发哨兵收紧阈值或退回仅建议。"""
    spk_key = str(spk)
    with _lock:
        db = _load_db()
        if mid and mid not in db["auto_meetings"]:
            db["auto_meetings"].append(mid)
            db["auto_meetings"] = db["auto_meetings"][-MAX_AUTO_MEETINGS:]
        ov = {
            "mid": mid,
            "spk": int(spk_key) if spk_key.isdigit() else spk_key,
            "old_name": (old_name or "").strip(),
            "new_name": (new_name or "").strip(),
            "at": _now_iso(),
            "sentinel_handled": False,
        }
        db["overrides"].append(ov)
        db["overrides"] = db["overrides"][-MAX_OVERRIDES:]

        recent_mids = set(db["auto_meetings"][-SENTINEL_WINDOW:])
        active_overrides = [
            x for x in db["overrides"]
            if not x.get("sentinel_handled") and x.get("mid") in recent_mids
        ]
        sentinel: dict = {"triggered": False}
        if len(active_overrides) >= SENTINEL_OVERRIDES:
            for x in active_overrides:
                x["sentinel_handled"] = True
            cur_tau = float(db["tau_auto"])
            if cur_tau >= 0.80:
                rsi_events.save_config({"auto_name": False})
                sentinel = {"triggered": True, "action": "disable_auto_name", "tau_auto": cur_tau}
                rsi_events.log_registry({
                    "loop": "A",
                    "action": "sentinel_disable_auto_name",
                    "reason": f"近 {SENTINEL_WINDOW} 场自动命名会议中发生 {len(active_overrides)} 次撤回，暂停自动命名改用仅建议",
                    "tau_auto": cur_tau,
                    "overrides": len(active_overrides),
                    "mid": mid,
                })
            else:
                new_tau = min(0.85, round(cur_tau + 0.04, 2))
                db["tau_auto"] = new_tau
                sentinel = {"triggered": True, "action": "raise_tau_auto", "from": cur_tau, "to": new_tau}
                rsi_events.log_registry({
                    "loop": "A",
                    "action": "sentinel_raise_tau_auto",
                    "reason": f"近 {SENTINEL_WINDOW} 场自动命名会议中发生 {len(active_overrides)} 次撤回，自动抬高阈值 {cur_tau:.2f} → {new_tau:.2f}",
                    "from": cur_tau,
                    "to": new_tau,
                    "overrides": len(active_overrides),
                    "mid": mid,
                })
        _save_db(db)
        tau_now = db["tau_auto"]
    rsi_events.emit("voiceprint_override", {
        "mid": mid,
        "spk": spk_key,
        "old_name": (old_name or "").strip(),
        "new_name": (new_name or "").strip(),
        "sentinel": sentinel,
    })
    return {"ok": True, "sentinel": sentinel, "tau_auto": tau_now}


def match_meeting(spk_embs: dict | None, auto_name: bool = True, *, mid: str | None = None) -> dict:
    """将单场会议的说话人质心与声纹库做贪心 1 对 1 匹配，输出 auto / suggest / merge_hints。"""
    empty = {"auto": {}, "suggest": {}, "merge_hints": []}
    if not isinstance(spk_embs, dict):
        return empty
    clusters = spk_embs.get("speakers") if isinstance(spk_embs.get("speakers"), dict) else spk_embs
    if not isinstance(clusters, dict) or not clusters:
        return empty

    with _lock:
        db = _load_db()
        tau_auto = float(db["tau_auto"])
        tau_suggest = float(db["tau_suggest"])
        persons_raw = dict(db["persons"])

    if not persons_raw:
        return empty

    c_vecs: dict[str, np.ndarray] = {}
    for sk, entry in clusters.items():
        if not isinstance(entry, dict):
            continue
        v = _unit_vec(entry.get("centroid"))
        if v is not None:
            c_vecs[str(sk)] = v

    p_vecs: dict[str, tuple[np.ndarray, int]] = {}
    for pname, pdata in persons_raw.items():
        if not isinstance(pdata, dict):
            continue
        v = _unit_vec(pdata.get("centroid"))
        if v is not None:
            p_vecs[pname] = (v, len(pdata.get("sessions") or []))

    if not c_vecs or not p_vecs:
        return empty

    sim: dict[str, dict[str, float]] = {}
    person_merge_hits: dict[str, list[tuple[str, float]]] = {}

    for sk, cv in c_vecs.items():
        scores: dict[str, float] = {}
        for pname, (pv, _) in p_vecs.items():
            if pv.shape != cv.shape:
                continue
            scores[pname] = float(np.dot(cv, pv))
        if not scores:
            continue
        sim[sk] = scores
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        best_p, best_s = ranked[0]
        second_s = ranked[1][1] if len(ranked) > 1 else 0.0
        if best_s >= MERGE_HINT_COS and (best_s - second_s) >= MERGE_HINT_MARGIN:
            person_merge_hits.setdefault(best_p, []).append((sk, best_s))

    merge_hints: list[dict] = []
    for pname, hits in sorted(person_merge_hits.items()):
        if len(hits) < 2:
            continue
        hits_sorted = sorted(hits, key=lambda x: (-x[1], x[0]))
        for i in range(len(hits_sorted)):
            for j in range(i + 1, len(hits_sorted)):
                (s1, sc1), (s2, sc2) = hits_sorted[i], hits_sorted[j]
                id1 = int(s1) if s1.isdigit() else s1
                id2 = int(s2) if s2.isdigit() else s2
                merge_hints.append({
                    "spks": [id1, id2],
                    "name": pname,
                    "scores": [round(sc1, 4), round(sc2, 4)],
                })

    # 贪心 1 对 1 最大余弦匹配
    pairs: list[tuple[float, str, str]] = []
    for sk, scores in sim.items():
        for pname, sc in scores.items():
            if sc >= tau_suggest:
                pairs.append((sc, sk, pname))
    pairs.sort(key=lambda t: (-t[0], t[1], t[2]))

    used_spks: set[str] = set()
    used_persons: set[str] = set()
    auto: dict[str, dict] = {}
    suggest: dict[str, dict] = {}

    for sc, sk, pname in pairs:
        if sk in used_spks or pname in used_persons:
            continue
        other_scores = [v for p, v in sim[sk].items() if p != pname]
        second = max(other_scores) if other_scores else 0.0
        margin = sc - second
        n_sessions = p_vecs[pname][1]
        item = {"name": pname, "score": round(sc, 4), "margin": round(margin, 4)}
        if auto_name and sc >= tau_auto and margin >= MIN_MARGIN_AUTO and n_sessions >= 2:
            auto[sk] = item
        else:
            suggest[sk] = item
        used_spks.add(sk)
        used_persons.add(pname)

    if mid and auto:
        record_auto_named(mid)

    return {"auto": auto, "suggest": suggest, "merge_hints": merge_hints}


def known_names(limit: int = 20) -> list[str]:
    """按确认场次与累计语音时长排序，返回声纹库中已知参会人姓名列表（供热词优先注入）。"""
    with _lock:
        db = _load_db()
    ranked = sorted(
        db["persons"].items(),
        key=lambda kv: (-len(kv[1].get("sessions") or []), -float(kv[1].get("voiced_s") or 0.0), kv[0]),
    )
    out = [name for name, _ in ranked if not is_generic_name(name)]
    return out[:limit] if limit and limit > 0 else out


def summary() -> dict:
    with _lock:
        db = _load_db()
    persons = [
        {
            "name": name,
            "sessions": len(p.get("sessions") or []),
            "voiced_s": round(float(p.get("voiced_s") or 0.0), 1),
            "updated_at": str(p.get("updated_at") or ""),
        }
        for name, p in sorted(
            db["persons"].items(),
            key=lambda kv: (-len(kv[1].get("sessions") or []), -float(kv[1].get("voiced_s") or 0.0), kv[0]),
        )
    ]
    return {
        "tau_auto": db["tau_auto"],
        "tau_suggest": db["tau_suggest"],
        "persons": persons,
        "conflicts": list(reversed(db.get("conflicts") or []))[:20],
    }


def _pick_cluster_samples(members: list[dict], limit: int = 3) -> list[dict]:
    """为未命名声纹簇挑选最多 limit 条单人清晰原声片段，便于用户 30 秒听声认人。"""
    cands: list[tuple[float, dict]] = []
    for mem in members:
        mid = str(mem["mid"])
        spk_k = str(mem["spk"])
        tr = store.load(mid, "transcript.json")
        paras = tr.get("paragraphs") if isinstance(tr, dict) else None
        if not isinstance(paras, list):
            continue
        for p in paras:
            if not isinstance(p, dict) or str(p.get("spk")) != spk_k:
                continue
            spks = p.get("spks")
            if isinstance(spks, list) and len(spks) > 1:
                continue
            text = str(p.get("text") or "").strip()
            if len(text) < 6:
                continue
            s_ms = int(p.get("start") or 0)
            e_ms = int(p.get("end") or 0)
            dur_ms = max(0, e_ms - s_ms)
            if dur_ms < 1500:
                continue
            clipped_end = min(e_ms, s_ms + 12000)
            ideal_diff = abs(dur_ms - 5500)
            score = (10000.0 - min(ideal_diff, 9000.0)) + min(len(text), 40) * 50.0
            cands.append((
                score,
                {
                    "mid": mid,
                    "spk": spk_k,
                    "title": str(mem.get("title") or mid),
                    "created": str(mem.get("created") or ""),
                    "start_ms": s_ms,
                    "end_ms": clipped_end,
                    "text": text[:120],
                },
            ))
    cands.sort(key=lambda t: -t[0])
    out: list[dict] = []
    used_mids: set[str] = set()
    # 先尽量跨场取样本，不够再同场补齐
    for _, sample in cands:
        if sample["mid"] in used_mids:
            continue
        used_mids.add(sample["mid"])
        out.append(sample)
        if len(out) >= limit:
            return out
    for _, sample in cands:
        if any(s["mid"] == sample["mid"] and s["start_ms"] == sample["start_ms"] for s in out):
            continue
        out.append(sample)
        if len(out) >= limit:
            break
    return out


def cluster_unnamed_speakers(days: int = 14, cos_thres: float = 0.70, limit: int = 8) -> dict:
    """把近 N 天高相似的未命名说话人簇聚合成待认人的“常驻面孔”，一键批量突破冷启动。"""
    cutoff = (datetime.now() - timedelta(days=max(1, days))).strftime("%Y-%m-%d") if days and days > 0 else ""
    nodes: list[dict] = []

    for meta in store.list_all():
        mid = str(meta.get("id") or "")
        if not mid or rsi_events.is_excluded(meta):
            continue
        created = str(meta.get("created") or "")
        if cutoff and created[:10] and created[:10] < cutoff:
            continue
        spk_embs = store.load(mid, "spk_embs.json")
        if not isinstance(spk_embs, dict):
            continue
        spks = spk_embs.get("speakers") if isinstance(spk_embs.get("speakers"), dict) else {}
        named_map = meta.get("speakers") or {}
        for sk_raw, entry in spks.items():
            if not isinstance(entry, dict) or not entry.get("centroid"):
                continue
            sk = str(sk_raw)
            cur_name = str(named_map.get(sk) or "").strip()
            if cur_name and not is_generic_name(cur_name):
                continue
            voiced_s = float(entry.get("voiced_s") or 0.0)
            n_chunks = int(entry.get("n_chunks") or 0)
            intra = float(entry.get("intra_cos_mean") or 0.0)
            if voiced_s < 10.0 or n_chunks < 5 or intra < 0.50:
                continue
            vec = _unit_vec(entry["centroid"])
            if vec is None:
                continue
            nodes.append({
                "mid": mid,
                "spk": sk,
                "title": str(meta.get("title") or mid),
                "created": created,
                "voiced_s": round(voiced_s, 1),
                "n_chunks": n_chunks,
                "intra_cos_mean": round(intra, 3),
                "vec": vec,
            })

    nodes.sort(key=lambda x: (-x["voiced_s"], x["created"]))
    clusters: list[dict] = []

    for node in nodes:
        best_cl: dict | None = None
        best_cos = -1.0
        for cl in clusters:
            if any(m["mid"] == node["mid"] for m in cl["members"]):
                continue
            cv = cl["centroid"]
            if cv.shape != node["vec"].shape:
                continue
            sc = float(np.dot(node["vec"], cv))
            if sc >= cos_thres and sc > best_cos:
                best_cos = sc
                best_cl = cl
        if best_cl is None:
            clusters.append({
                "members": [node],
                "sum_vec": node["vec"] * max(1.0, node["voiced_s"]),
                "centroid": node["vec"],
                "pair_scores": [],
            })
        else:
            best_cl["members"].append(node)
            best_cl["sum_vec"] = best_cl["sum_vec"] + node["vec"] * max(1.0, node["voiced_s"])
            norm_c = _unit_vec(best_cl["sum_vec"])
            if norm_c is not None:
                best_cl["centroid"] = norm_c
            best_cl["pair_scores"].append(best_cos)

    out: list[dict] = []
    for cl in clusters:
        members = cl["members"]
        meeting_cnt = len({m["mid"] for m in members})
        total_voiced = round(sum(float(m["voiced_s"]) for m in members), 1)
        if meeting_cnt < 2 and total_voiced < 25.0:
            continue
        avg_cos = (
            round(sum(cl["pair_scores"]) / len(cl["pair_scores"]), 3)
            if cl["pair_scores"]
            else round(float(members[0]["intra_cos_mean"]), 3)
        )
        samples = _pick_cluster_samples(members, limit=3)
        cid_seed = "|".join(f"{m['mid']}:{m['spk']}" for m in sorted(members, key=lambda x: (x["mid"], x["spk"])))
        cid = f"cl-{hashlib.sha1(cid_seed.encode('utf-8')).hexdigest()[:8]}"
        out.append({
            "cluster_id": cid,
            "meeting_count": meeting_cnt,
            "total_voiced_s": total_voiced,
            "avg_cos": avg_cos,
            "members": [
                {
                    "mid": m["mid"],
                    "spk": m["spk"],
                    "title": m["title"],
                    "created": m["created"],
                    "voiced_s": m["voiced_s"],
                }
                for m in sorted(members, key=lambda x: str(x["created"]), reverse=True)
            ],
            "samples": samples,
        })

    out.sort(key=lambda c: (c["meeting_count"] >= 2, c["meeting_count"], c["total_voiced_s"]), reverse=True)
    return {"clusters": out[: max(1, min(20, limit))], "candidate_nodes": len(nodes)}


def batch_name_cluster(name: str, members: list[dict]) -> dict:
    """把同一未知声纹簇中的所有 (mid, spk) 一次命名，并写入声纹记忆库。"""
    clean_name = (name or "").strip()
    if is_generic_name(clean_name):
        raise ValueError("请输入具体的参会人姓名")
    if not isinstance(members, list) or not members:
        raise ValueError("缺少待命名的说话人列表")

    seen: set[tuple[str, str]] = set()
    updated_meetings: list[str] = []
    enrolled = 0
    skipped = 0
    conflicts: list[dict] = []

    for item in members:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("mid") or "").strip()
        spk_k = str(item.get("spk") if item.get("spk") is not None else "").strip()
        if not mid or not spk_k or (mid, spk_k) in seen:
            continue
        seen.add((mid, spk_k))

        with store.locked():
            meta = store.get(mid)
            if not meta:
                continue
            speakers = dict(meta.get("speakers") or {})
            speakers[spk_k] = clean_name
            smeta = dict(meta.get("speaker_meta") or {})
            if isinstance(smeta.get("suggest"), dict):
                sug = dict(smeta["suggest"])
                sug.pop(spk_k, None)
                smeta["suggest"] = sug
            store.update(mid, speakers=speakers, speaker_meta=smeta)
            updated_meetings.append(mid)

        spk_embs = store.load(mid, "spk_embs.json")
        res = enroll(mid, spk_k, clean_name, spk_embs)
        st = res.get("status")
        if st == "enrolled":
            enrolled += 1
        elif st == "conflict":
            conflicts.append(res)
        else:
            skipped += 1

    rsi_events.emit("voiceprint_batch_name", {
        "name": clean_name,
        "meetings": len(updated_meetings),
        "enrolled": enrolled,
        "skipped": skipped,
        "conflicts": len(conflicts),
    })
    return {
        "name": clean_name,
        "updated_meetings": len(updated_meetings),
        "enrolled": enrolled,
        "skipped": skipped,
        "conflicts": conflicts,
    }


def reset() -> None:
    with _lock:
        try:
            _path().unlink(missing_ok=True)
        except OSError:
            pass
