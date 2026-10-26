"""词库：常用热词（帮助识别）+ 纠错规则（识别后把固定的错写替换成正确写法，如“艾森 → ASIN”）。

纠错在读取转写时套用，不改原始转写：新加的规则对旧记录也立刻生效，删掉规则即恢复原样。
"""
import re
import threading

import store

PATH = store.DATA / "vocab.json"
_lock = threading.Lock()
_cache: dict = {"mtime": None, "vocab": None, "rules": None}
# 模型常把缩写拆成单个字母输出（“S K U”“C P U”），拼回去；读取时也套用，旧记录一并生效
SPELLED_RE = re.compile(r"(?<![A-Za-z])([A-Z]) (?=[A-Z](?![A-Za-z]))")
def split_words(s: str) -> list[str]:
    return [w for w in re.split(r"[\s,，、;；]+", s or "") if w]


def _load() -> tuple[dict, list]:
    mtime = PATH.stat().st_mtime if PATH.exists() else None
    with _lock:
        if _cache["vocab"] is None or _cache["mtime"] != mtime:
            v = store.read_json(PATH) or {}
            vocab = {"hotwords": v.get("hotwords", ""),
                     "fixes": [f for f in v.get("fixes", []) if f.get("from")]}
            _cache.update(mtime=mtime, vocab=vocab, rules=_compile(vocab["fixes"]))
        return _cache["vocab"], _cache["rules"]


def _compile(fixes: list[dict]):
    """所有规则编成一个正则，每个位置取最长的匹配：
    - 错写（from）→ 替换成正确写法；英文不分大小写，且不能是更长单词的一部分（“S”不会匹配到“SKU”里）
    - 正确写法（to）本身也是候选，匹配到就原样保留，避免“预算 → 批预算”把“批预算”改成“批批预算”
    长度相同时保留优先。"""
    if not fixes:
        return None
    alts = []  # (长度, 保留优先, 正则片段, 替换文本或 None)
    for f in fixes:
        a = f["from"]
        pre = r"(?<![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", a) else ""
        post = r"(?![A-Za-z0-9])" if re.search(r"[A-Za-z0-9]$", a) else ""
        alts.append((len(a), 1, f"(?i:{pre}{re.escape(a)}{post})", f["to"]))
        if f["to"]:
            alts.append((len(f["to"]), 0, re.escape(f["to"]), None))
    alts.sort(key=lambda t: (-t[0], t[1]))
    pat = re.compile("|".join(f"(?P<g{i}>{p})" for i, (_, _, p, _) in enumerate(alts)))
    return pat, [t[3] for t in alts]


def get() -> dict:
    v, _ = _load()
    return {"hotwords": v["hotwords"], "fixes": [dict(f) for f in v["fixes"]]}


def save(v: dict) -> dict:
    hot = " ".join(dict.fromkeys(split_words(v.get("hotwords", ""))))
    fixes, seen = [], set()
    for f in v.get("fixes") or []:
        a, b = (f.get("from") or "").strip(), (f.get("to") or "").strip()
        if a and a != b and a not in seen:
            fixes.append({"from": a, "to": b})
            seen.add(a)
    store.write_json(PATH, {"hotwords": hot, "fixes": fixes})
    return get()


def add_fix(a: str, b: str, hotword: bool = False) -> dict:
    v = get()
    v["fixes"] = [f for f in v["fixes"] if f["from"] != a.strip()] + [{"from": a, "to": b}]
    if hotword and b.strip():
        v["hotwords"] = v["hotwords"] + " " + b.strip()
    return save(v)


def hotwords(extra: str = "") -> str:
    """常用热词 + 本场额外热词，去重。"""
    v, _ = _load()
    return " ".join(dict.fromkeys(split_words(v["hotwords"]) + split_words(extra)))


def apply(text: str) -> str:
    _, rules = _load()
    text = SPELLED_RE.sub(r"\1", text or "")
    if not rules or not text:
        return text
    pat, repl = rules

    def sub(m: re.Match) -> str:
        r = repl[int(m.lastgroup[1:])]
        return m.group(0) if r is None else r
    # 多跑几遍让规则可以接力（“家族ASN”→“家族ASIN”→“家族子ASIN”）；最多 3 遍，防止规则互相改来改去
    for _ in range(3):
        new = pat.sub(sub, text)
        if new == text:
            break
        text = new
    return text


def apply_paras(paras: list[dict]) -> list[dict]:
    """手动改过的段落（edited）不再套纠错规则：用户改成什么就是什么（例如把被规则改成 ASIN 的人名“艾森”改回来）。"""
    return [p if p.get("edited") else {**p, "text": apply(p.get("text", ""))} for p in paras]
