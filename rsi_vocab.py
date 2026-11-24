"""Loop B v1：词库规则撤回自降级、改字候选挖掘、疑似热词负反馈与 CTC 毒热词淘汰。

状态保存在 data/rsi/vocab_stats.json（原子写 + 线程锁），不修改用户手写的 vocab.json 原始规则，
仅在规则反复被撤回时把其标记为 suspect_only（由自动替换降级为高亮提示），可随时一键恢复。
"""
import re
import threading
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path

from pypinyin import Style, lazy_pinyin

import rsi_events
import store

MAX_DISMISSED = 500
MAX_CANDIDATES = 200
MAX_CAND_MEETINGS = 50
CTC_MIN_REJECTS = 3
CTC_MAX_REJECT_RATIO = 0.35

_lock = threading.RLock()
_gen = 0

_ASCII_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+.-]{1,11}$")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_PUNCT_STOP_RE = re.compile(r"[，。？！；：、\n\r\t]")
_ASCII_CHAR_RE = re.compile(r"[A-Za-z0-9_+.-]")


def _path() -> Path:
    return store.DATA / "rsi" / "vocab_stats.json"


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def stats_sig() -> tuple:
    """供 vocab.py / app._suspects 缓存键感知词库自学习状态变化。"""
    p = _path()
    try:
        st = p.stat()
        f_sig = (st.st_mtime_ns, st.st_size)
    except OSError:
        f_sig = None
    return (str(p), f_sig, _gen)


def _bump_gen() -> None:
    global _gen
    _gen += 1


def _default_db() -> dict:
    return {
        "rules": {},
        "dismissed_suspects": [],
        "candidates": {},
        "ctc_hotwords": {},
    }


def _load_db() -> dict:
    raw = store.read_json(_path())
    if not isinstance(raw, dict):
        return _default_db()
    db = _default_db()
    if isinstance(raw.get("rules"), dict):
        db["rules"] = raw["rules"]
    if isinstance(raw.get("dismissed_suspects"), list):
        db["dismissed_suspects"] = [x for x in raw["dismissed_suspects"] if isinstance(x, dict)]
    if isinstance(raw.get("candidates"), dict):
        db["candidates"] = raw["candidates"]
    if isinstance(raw.get("ctc_hotwords"), dict):
        db["ctc_hotwords"] = raw["ctc_hotwords"]
    return db


def _save_db(db: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    store.write_json(p, db)
    _bump_gen()


def _term_pattern(term: str) -> re.Pattern:
    pre = r"(?<![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", term) else ""
    post = r"(?![A-Za-z0-9])" if re.search(r"[A-Za-z0-9]$", term) else ""
    return re.compile(f"(?i:{pre}{re.escape(term)}{post})")


def _count_term(text: str, term: str) -> int:
    if not text or not term:
        return 0
    return len(_term_pattern(term).findall(text))


def _py_norm(s: str) -> list[str]:
    out: list[str] = []
    for p in lazy_pinyin(s, style=Style.NORMAL, errors="ignore"):
        p = p.lower()
        p = re.sub(r"^([zcs])h", r"\1", p)
        out.append(re.sub(r"ng$", "n", p))
    return out


def _is_candidate_pair(old: str, new: str) -> bool:
    if not old or not new or old == new:
        return False
    if not (2 <= len(old) <= 12 and 2 <= len(new) <= 12):
        return False
    if _PUNCT_STOP_RE.search(old) or _PUNCT_STOP_RE.search(new):
        return False
    # 1) 目标是英文缩写/专名（如 艾森 -> ASIN, Ason -> ASIN, k8s, SaaS）
    if _ASCII_WORD_RE.fullmatch(new):
        return True
    # 2) 中文/中英混写：拼音读音相近
    if _CJK_RE.search(old) and _CJK_RE.search(new):
        op, np_ = _py_norm(old), _py_norm(new)
        if op and np_:
            if len(op) == len(np_):
                sim = sum(SequenceMatcher(None, a, b).ratio() for a, b in zip(op, np_, strict=True)) / len(op)
                if sim >= 0.55:
                    return True
            joined_sim = SequenceMatcher(None, "".join(op), "".join(np_)).ratio()
            if joined_sim >= 0.60:
                return True
    # 3) 中英混合专名（如 家族ASN -> 家族ASIN）
    if re.search(r"[A-Za-z]{2,}", new) and SequenceMatcher(None, old.lower(), new.lower()).ratio() >= 0.45:
        return True
    return False


def _extract_replacements(pre_text: str, new_text: str) -> list[tuple[str, str]]:
    if not pre_text or not new_text or pre_text == new_text:
        return []
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    sm = SequenceMatcher(None, pre_text, new_text)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "replace":
            continue
        a1, a2, b1, b2 = i1, i2, j1, j2
        # ASCII 词内局部修改（如 Ason -> ASIN 只标出 son -> SIN）扩展到完整英文词边界
        if (a2 - a1 < 12 and b2 - b1 < 12) and (
            (a1 > 0 and _ASCII_CHAR_RE.match(pre_text[a1 - 1]))
            or (a2 < len(pre_text) and _ASCII_CHAR_RE.match(pre_text[a2]))
            or (b1 > 0 and _ASCII_CHAR_RE.match(new_text[b1 - 1]))
            or (b2 < len(new_text) and _ASCII_CHAR_RE.match(new_text[b2]))
        ):
            while a1 > 0 and _ASCII_CHAR_RE.match(pre_text[a1 - 1]):
                a1 -= 1
            while a2 < len(pre_text) and _ASCII_CHAR_RE.match(pre_text[a2]):
                a2 += 1
            while b1 > 0 and _ASCII_CHAR_RE.match(new_text[b1 - 1]):
                b1 -= 1
            while b2 < len(new_text) and _ASCII_CHAR_RE.match(new_text[b2]):
                b2 += 1
        old = pre_text[a1:a2].strip()
        new = new_text[b1:b2].strip()
        # 中文单字局部改错（如 长伟词 -> 长尾词，SequenceMatcher 只标出 伟 -> 尾）：按前后 1-2 字扩展同长词片
        if len(old) == 1 and len(new) == 1 and _CJK_RE.fullmatch(old) and _CJK_RE.fullmatch(new):
            lo_a, hi_a, lo_b, hi_b = a1, a2, b1, b2
            while lo_a > 0 and lo_b > 0 and pre_text[lo_a - 1] == new_text[lo_b - 1] and _CJK_RE.fullmatch(pre_text[lo_a - 1]) and (hi_a - lo_a) < 4:
                lo_a -= 1
                lo_b -= 1
                break
            while hi_a < len(pre_text) and hi_b < len(new_text) and pre_text[hi_a] == new_text[hi_b] and _CJK_RE.fullmatch(pre_text[hi_a]) and (hi_a - lo_a) < 4:
                hi_a += 1
                hi_b += 1
                break
            cand_old = pre_text[lo_a:hi_a].strip()
            cand_new = new_text[lo_b:hi_b].strip()
            if len(cand_old) >= 2 and len(cand_new) >= 2:
                old, new = cand_old, cand_new
        if _is_candidate_pair(old, new) and (old, new) not in seen:
            seen.add((old, new))
            pairs.append((old, new))
    return pairs


def record_hits(paras: list[dict], fixes: list[dict]) -> None:
    """精转落地后统计各生效词库规则的命中次数（每场仅计一次，不含已手改段落与 suspect_only 规则）。"""
    if rsi_events.is_excluded() or not paras or not fixes:
        return
    with _lock:
        db = _load_db()
        changed = False
        for f in fixes:
            frm = (f.get("from") or "").strip()
            to = (f.get("to") or "").strip()
            if not frm or not to or frm == to:
                continue
            cur = db["rules"].get(frm)
            if cur and cur.get("mode") == "suspect_only":
                continue
            pat = _term_pattern(frm)
            cnt = 0
            for p in paras:
                if p.get("edited"):
                    continue
                cnt += len(pat.findall(p.get("text") or ""))
            if cnt > 0:
                entry = db["rules"].setdefault(frm, {"to": to, "hits": 0, "reverts": 0, "mode": "active"})
                entry["to"] = to
                entry["hits"] = int(entry.get("hits", 0)) + cnt
                changed = True
        if changed:
            _save_db(db)


def record_edit(mid: str, orig_text: str, pre_edit_text: str, new_text: str, fixes: list[dict]) -> dict:
    """分析一次段落手改：检测词库规则被撤回（并自动降级 suspect_only）以及挖掘短词纠错候选。"""
    orig_text = orig_text or ""
    pre_edit_text = pre_edit_text or ""
    new_text = new_text or ""
    reverted: list[str] = []
    demoted: list[str] = []
    mined: list[dict] = []

    with _lock:
        db = _load_db()
        changed = False
        reverted_pairs: set[tuple[str, str]] = set()

        for f in fixes or []:
            frm = (f.get("from") or "").strip()
            to = (f.get("to") or "").strip()
            if not frm or not to or frm == to:
                continue
            c_orig_from = _count_term(orig_text, frm)
            c_pre_from = _count_term(pre_edit_text, frm)
            c_pre_to = _count_term(pre_edit_text, to)
            # 规则曾将 orig_text 中的 frm 替换成了 pre_edit_text 中的 to
            if c_orig_from > c_pre_from and c_pre_to > 0:
                c_new_from = _count_term(new_text, frm)
                c_new_to = _count_term(new_text, to)
                if c_new_from > c_pre_from and c_new_to <= c_pre_to:
                    entry = db["rules"].setdefault(frm, {"to": to, "hits": 0, "reverts": 0, "mode": "active"})
                    entry["to"] = to
                    entry["reverts"] = int(entry.get("reverts", 0)) + 1
                    hits = int(entry.get("hits", 0))
                    reverts = entry["reverts"]
                    precision = hits / max(1, hits + reverts)
                    reverted.append(frm)
                    reverted_pairs.add((to, frm))
                    changed = True
                    if entry.get("mode") != "suspect_only" and (
                        reverts >= 2 or (reverts >= 1 and precision < 0.70)
                    ):
                        entry["mode"] = "suspect_only"
                        demoted.append(frm)
                        rsi_events.log_registry({
                            "loop": "B",
                            "action": "sentinel_demote_rule",
                            "from": frm,
                            "to": to,
                            "hits": hits,
                            "reverts": reverts,
                            "precision": round(precision, 3),
                            "reason": f"规则「{frm} → {to}」被撤回 {reverts} 次（准确率 {precision:.0%}），已降级为仅提示",
                            "mid": mid,
                        })

        for old, new in _extract_replacements(pre_edit_text, new_text):
            if (old, new) in reverted_pairs:
                continue
            key = f"{old}\t{new}"
            cand = db["candidates"].setdefault(key, {
                "from": old,
                "to": new,
                "meetings": [],
                "count": 0,
                "dismissed": False,
                "accepted": False,
            })
            if cand.get("dismissed") or cand.get("accepted"):
                continue
            cand["count"] = int(cand.get("count", 0)) + 1
            if mid and mid not in cand["meetings"]:
                cand["meetings"].append(mid)
                cand["meetings"] = cand["meetings"][-MAX_CAND_MEETINGS:]
            mined.append({"from": old, "to": new, "count": cand["count"], "meetings": len(cand["meetings"])})
            changed = True

        if len(db["candidates"]) > MAX_CANDIDATES:
            # 优先淘汰已忽略/已采纳或出现次数最少的旧候选
            keep_keys = [
                k for k, _ in sorted(
                    db["candidates"].items(),
                    key=lambda kv: (
                        bool(kv[1].get("dismissed") or kv[1].get("accepted")),
                        -int(kv[1].get("count", 0)),
                        kv[0],
                    ),
                )[:MAX_CANDIDATES]
            ]
            db["candidates"] = {k: db["candidates"][k] for k in keep_keys}

        if changed:
            _save_db(db)

    if reverted or mined:
        rsi_events.emit("vocab_edit", {
            "mid": mid,
            "reverted": reverted,
            "demoted": demoted,
            "candidates": mined,
        })
    return {"reverted": reverted, "demoted": demoted, "candidates": mined}


def is_suspect_only(frm: str) -> bool:
    if not frm:
        return False
    with _lock:
        db = _load_db()
    st = db["rules"].get(frm.strip())
    return bool(isinstance(st, dict) and st.get("mode") == "suspect_only")


def restore_rule(frm: str) -> bool:
    key = (frm or "").strip()
    if not key:
        return False
    with _lock:
        db = _load_db()
        st = db["rules"].get(key)
        if not isinstance(st, dict):
            return False
        st["mode"] = "active"
        st["reverts"] = 0
        _save_db(db)
    rsi_events.log_registry({
        "loop": "B",
        "action": "restore_rule",
        "from": key,
        "to": st.get("to", ""),
        "reason": f"手动恢复词库规则「{key} → {st.get('to', '')}」自动替换",
    })
    try:
        import vocab
        vocab.invalidate()
    except Exception:  # noqa: BLE001
        pass
    return True


def dismiss_suspect(hotword: str, text: str) -> None:
    hw, txt = (hotword or "").strip(), (text or "").strip()
    if not hw or not txt:
        return
    with _lock:
        db = _load_db()
        items = db["dismissed_suspects"]
        if not any(x.get("hotword") == hw and x.get("text") == txt for x in items):
            items.append({"hotword": hw, "text": txt, "at": _now_iso()})
            db["dismissed_suspects"] = items[-MAX_DISMISSED:]
            _save_db(db)
    rsi_events.emit("suspect_dismiss", {"hotword": hw, "text": txt})


def is_dismissed(hotword: str, text: str) -> bool:
    hw, txt = (hotword or "").strip(), (text or "").strip()
    if not hw or not txt:
        return False
    with _lock:
        db = _load_db()
    return any(x.get("hotword") == hw and x.get("text") == txt for x in db["dismissed_suspects"])


def record_ctc_result(used_hws: list[str], rejected_hws: list[str]) -> None:
    """记录 Fun-ASR-Nano CTC 热词核验通过/拦截结果，淘汰反复诱发幻觉的毒热词。"""
    if rsi_events.is_excluded():
        return
    used = [w.strip() for w in (used_hws or []) if (w or "").strip()]
    rej = [w.strip() for w in (rejected_hws or []) if (w or "").strip()]
    if not used and not rej:
        return
    with _lock:
        db = _load_db()
        ctc = db["ctc_hotwords"]
        for w in used:
            st = ctc.setdefault(w, {"accepts": 0, "rejects": 0})
            st["accepts"] = int(st.get("accepts", 0)) + 1
        for w in rej:
            st = ctc.setdefault(w, {"accepts": 0, "rejects": 0})
            st["rejects"] = int(st.get("rejects", 0)) + 1
            tot = int(st.get("accepts", 0)) + int(st["rejects"])
            ratio = st["rejects"] / max(1, tot)
            if st["rejects"] >= CTC_MIN_REJECTS and ratio > CTC_MAX_REJECT_RATIO and not st.get("demoted_logged"):
                st["demoted_logged"] = True
                rsi_events.log_registry({
                    "loop": "B",
                    "action": "sentinel_demote_ctc_hotword",
                    "word": w,
                    "rejects": st["rejects"],
                    "accepts": int(st.get("accepts", 0)),
                    "reason": f"自动热词「{w}」触发 CTC 拦截 {st['rejects']}/{tot} 次（{ratio:.0%}），已移出自动上下文热词池",
                })
        _save_db(db)


def demoted_hotwords() -> set[str]:
    with _lock:
        db = _load_db()
    out: set[str] = set()
    for w, st in db["ctc_hotwords"].items():
        if not isinstance(st, dict):
            continue
        rej = int(st.get("rejects", 0))
        acc = int(st.get("accepts", 0))
        if rej >= CTC_MIN_REJECTS and rej / max(1, acc + rej) > CTC_MAX_REJECT_RATIO:
            out.add(w)
    return out


def accept_candidate(frm: str, to: str, hotword: bool = False) -> dict:
    a, b = (frm or "").strip(), (to or "").strip()
    if not a or not b or a == b:
        raise ValueError("规则不完整")
    import vocab
    updated_vocab = vocab.add_fix(a, b, hotword=hotword)
    with _lock:
        db = _load_db()
        key = f"{a}\t{b}"
        cand = db["candidates"].setdefault(key, {
            "from": a, "to": b, "meetings": [], "count": 1, "dismissed": False, "accepted": True,
        })
        cand["accepted"] = True
        cand["dismissed"] = False
        # 若此前被降级，用户显式采纳则恢复生效
        if a in db["rules"] and isinstance(db["rules"][a], dict):
            db["rules"][a]["mode"] = "active"
            db["rules"][a]["reverts"] = 0
        _save_db(db)
    vocab.invalidate()
    rsi_events.emit("vocab_candidate_accept", {"from": a, "to": b, "hotword": bool(hotword)})
    return {"ok": True, "vocab": updated_vocab}


def dismiss_candidate(frm: str, to: str) -> bool:
    a, b = (frm or "").strip(), (to or "").strip()
    if not a or not b:
        return False
    with _lock:
        db = _load_db()
        key = f"{a}\t{b}"
        cand = db["candidates"].setdefault(key, {
            "from": a, "to": b, "meetings": [], "count": 0, "dismissed": True, "accepted": False,
        })
        cand["dismissed"] = True
        _save_db(db)
    rsi_events.emit("vocab_candidate_dismiss", {"from": a, "to": b})
    return True


def summary() -> dict:
    with _lock:
        db = _load_db()
    demoted_rules = [
        {
            "from": frm,
            "to": str(st.get("to") or ""),
            "hits": int(st.get("hits") or 0),
            "reverts": int(st.get("reverts") or 0),
        }
        for frm, st in sorted(db["rules"].items())
        if isinstance(st, dict) and st.get("mode") == "suspect_only"
    ]
    candidates = [
        {
            "from": str(c.get("from") or ""),
            "to": str(c.get("to") or ""),
            "count": int(c.get("count") or 0),
            "meetings": len(c.get("meetings") or []),
        }
        for c in sorted(
            db["candidates"].values(),
            key=lambda x: (-int(x.get("count") or 0), -len(x.get("meetings") or []), str(x.get("from") or "")),
        )
        if isinstance(c, dict)
        and not c.get("dismissed")
        and not c.get("accepted")
        and len(c.get("meetings") or []) >= 2
    ]
    ctc_demoted = [
        {
            "word": w,
            "rejects": int(st.get("rejects") or 0),
            "accepts": int(st.get("accepts") or 0),
        }
        for w, st in sorted(db["ctc_hotwords"].items(), key=lambda kv: (-int(kv[1].get("rejects") or 0), kv[0]))
        if isinstance(st, dict)
        and int(st.get("rejects") or 0) >= CTC_MIN_REJECTS
        and int(st.get("rejects") or 0) / max(1, int(st.get("accepts") or 0) + int(st.get("rejects") or 0)) > CTC_MAX_REJECT_RATIO
    ]
    return {
        "demoted_rules": demoted_rules,
        "candidates": candidates,
        "ctc_demoted": ctc_demoted,
        "dismissed_count": len(db.get("dismissed_suspects") or []),
    }


def reset() -> None:
    with _lock:
        try:
            _path().unlink(missing_ok=True)
        except OSError:
            pass
        _bump_gen()
    try:
        import vocab
        vocab.invalidate()
    except Exception:  # noqa: BLE001
        pass
